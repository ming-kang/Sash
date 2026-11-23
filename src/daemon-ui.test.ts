import assert from "node:assert/strict";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { request } from "undici";
import { describe, it, vi } from "vitest";
import { serveStaticUi } from "./daemon/static.js";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { useDaemonTestHarness } from "./testing/daemon-harness.js";

describe("daemon server", () => {
  const h = useDaemonTestHarness();

  /** A dashboard build injected in place of the package's own `dist/ui`. */
  function dashboard(files: Record<string, string> = {}): string {
    const uiDir = path.join(h.layout.root, "dashboard");
    for (const [name, content] of Object.entries({ "index.html": "<html>ui</html>", ...files })) {
      fs.mkdirSync(path.dirname(path.join(uiDir, name)), { recursive: true });
      fs.writeFileSync(path.join(uiDir, name), content);
    }
    return uiDir;
  }

  describe("web UI serving", () => {
    it("uses one descriptor for the asset size and body across an atomic path replacement", async () => {
      const uiDir = dashboard({ "asset.js": "original", "previous.js": "original" });
      const file = path.join(uiDir, "asset.js");
      const previous = path.join(uiDir, "previous.js");
      await h.startServer({ uiDir });
      const open = fs.openSync;
      let opens = 0;
      vi.spyOn(fs, "openSync").mockImplementation(
        (target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
          // Model a descriptor bound to the previous inode. Windows may forbid
          // replacing an actually open destination, unlike POSIX rename.
          const fd = open(String(target) === file ? previous : target, flags, mode);
          if (String(target) === file) {
            opens++;
            atomicWriteFileSync(file, "replacement with a different length");
          }
          return fd;
        },
      );
      const response = await request(`http://127.0.0.1:${h.boundPort}/ui/asset.js`);
      assert.equal(await response.body.text(), "original");
      assert.equal(response.headers["content-length"], "8");
      assert.equal(opens, 1);
    });

    it("explains missing dashboard assets with a 404", async () => {
      await h.startServer();
      const exists = fs.existsSync;
      vi.spyOn(fs, "existsSync").mockImplementation((file: fs.PathLike) =>
        String(file).endsWith("index.html") ? false : exists(file),
      );
      const response = await request(`http://127.0.0.1:${h.boundPort}/ui/`);
      assert.equal(response.statusCode, 404);
      assert.match(await response.body.text(), /Dashboard assets are missing/);
    });

    it("ignores a ui folder left in the data folder", async () => {
      fs.mkdirSync(path.join(h.layout.root, "ui"), { recursive: true });
      fs.writeFileSync(path.join(h.layout.root, "ui", "index.html"), "<html>stale</html>");
      await h.startServer();
      const res = await request(`http://127.0.0.1:${h.boundPort}/ui/`);
      assert.doesNotMatch(await res.body.text(), /stale/);
    });

    it("redirects GET /ui to /ui/ preserving the query string", async () => {
      await h.startServer();
      const res = await request(`http://127.0.0.1:${h.boundPort}/ui?tab=proxies`);
      await res.body.text();
      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.location, "/ui/?tab=proxies");
    });

    it("serves index.html at /ui/ without a redirect", async () => {
      await h.startServer({ uiDir: dashboard() });
      const res = await request(`http://127.0.0.1:${h.boundPort}/ui/`);
      const text = await res.body.text();
      assert.equal(res.statusCode, 200);
      assert.match(text, /<html>ui<\/html>/);
    });

    it("isolates dashboard documents, SPA fallbacks, and assets from framing", async () => {
      await h.startServer({ uiDir: dashboard({ "app.js": "export {};\n" }) });

      for (const pathname of ["/ui/", "/ui/profiles", "/ui/app.js"]) {
        const res = await request(`http://127.0.0.1:${h.boundPort}${pathname}`);
        await res.body.text();
        assert.equal(res.statusCode, 200, pathname);
        assert.equal(res.headers["content-security-policy"], "frame-ancestors 'none'", pathname);
        assert.equal(res.headers["x-frame-options"], "DENY", pathname);
        assert.equal(res.headers["x-content-type-options"], "nosniff", pathname);
        assert.equal(res.headers["referrer-policy"], "no-referrer", pathname);
      }
    });

    it("supports HEAD for dashboard assets without streaming a body", async () => {
      await h.startServer({ uiDir: dashboard() });
      const res = await request(`http://127.0.0.1:${h.boundPort}/ui/`, { method: "HEAD" });
      assert.equal(res.statusCode, 200);
      assert.equal(await res.body.text(), "");
    });

    it("caches fingerprinted assets immutably and bounds everything else", async () => {
      const uiDir = dashboard({
        "assets/index-AbCdEf12.js": "export {};\n",
        "assets/chunk-x8vWq2Yz.woff2": "font",
        "assets/branding/sash-cat.png": "png",
      });
      await h.startServer({ uiDir });

      const cases: Array<[string, string]> = [
        ["/ui/", "no-cache, no-store, must-revalidate"],
        ["/ui/assets/index-AbCdEf12.js", "public, max-age=31536000, immutable"],
        ["/ui/assets/chunk-x8vWq2Yz.woff2", "public, max-age=31536000, immutable"],
        ["/ui/assets/branding/sash-cat.png", "public, max-age=3600"],
      ];
      for (const [pathname, expected] of cases) {
        const res = await request(`http://127.0.0.1:${h.boundPort}${pathname}`);
        await res.body.text();
        assert.equal(res.statusCode, 200, pathname);
        assert.equal(res.headers["cache-control"], expected, pathname);
        const size = fs.statSync(
          path.join(uiDir, pathname === "/ui/" ? "index.html" : pathname.slice("/ui/".length)),
        ).size;
        assert.equal(res.headers["content-length"], String(size), pathname);
      }
    });
  });

  /**
   * WHATWG parsing already collapses "/ui/../x" before routing, so these
   * pathnames cannot arrive over HTTP today. The asset root containment is
   * asserted directly against the handler so it keeps holding if the request
   * pipeline ever stops normalizing for us.
   */
  describe("dashboard asset root containment", () => {
    function capture(pathname: string, uiRoot: string, method = "GET") {
      const chunks: string[] = [];
      let statusCode = 0;
      const res = {
        setHeader: () => undefined,
        writeHead: (code: number) => {
          statusCode = code;
          return res;
        },
        end: (body?: string) => {
          if (body) chunks.push(body);
        },
        once: () => res,
        off: () => res,
        on: () => res,
        headersSent: false,
        destroyed: false,
        destroy: () => undefined,
      };
      const handled = serveStaticUi(
        { method } as IncomingMessage,
        res as unknown as ServerResponse,
        pathname,
        uiRoot,
      );
      return { handled, statusCode, body: chunks.join("") };
    }

    it("refuses to serve files resolved outside the asset root", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-ui-root-"));
      try {
        const uiRoot = path.join(root, "ui");
        fs.mkdirSync(uiRoot, { recursive: true });
        fs.writeFileSync(path.join(uiRoot, "index.html"), "<html>ui</html>");
        fs.writeFileSync(path.join(root, "sashd.state.json"), "top secret");

        const escaped = capture("/ui/../sashd.state.json", uiRoot);
        assert.equal(escaped.handled, true);
        assert.equal(escaped.statusCode, 403);
        assert.doesNotMatch(escaped.body, /top secret/);

        const absolute = capture("/ui//sashd.state.json", uiRoot);
        assert.equal(absolute.handled, false);
        assert.equal(absolute.statusCode, 0);
        assert.doesNotMatch(absolute.body, /top secret/);

        assert.equal(capture("/ui/", uiRoot, "HEAD").statusCode, 200);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
