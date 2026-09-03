import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { request } from "undici";
import { useDaemonTestHarness } from "./daemon-test-harness.test.js";

describe("daemon server", () => {
  const h = useDaemonTestHarness();

  describe("web UI serving", () => {
    it("redirects GET /ui to /ui/ preserving the query string", async () => {
      await h.startServer();
      const res = await request(`http://127.0.0.1:${h.boundPort}/ui?tab=proxies`);
      await res.body.text();
      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.location, "/ui/?tab=proxies");
    });

    it("serves index.html at /ui/ without a redirect", async () => {
      fs.mkdirSync(h.layout.uiDir, { recursive: true });
      fs.writeFileSync(path.join(h.layout.uiDir, "index.html"), "<html>ui</html>");
      await h.startServer();
      const res = await request(`http://127.0.0.1:${h.boundPort}/ui/`);
      const text = await res.body.text();
      assert.equal(res.statusCode, 200);
      assert.match(text, /<html>ui<\/html>/);
    });

    it("isolates dashboard documents, SPA fallbacks, and assets from framing", async () => {
      fs.mkdirSync(h.layout.uiDir, { recursive: true });
      fs.writeFileSync(path.join(h.layout.uiDir, "index.html"), "<html>ui</html>");
      fs.writeFileSync(path.join(h.layout.uiDir, "app.js"), "export {};\n");
      await h.startServer();

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
      fs.mkdirSync(h.layout.uiDir, { recursive: true });
      fs.writeFileSync(path.join(h.layout.uiDir, "index.html"), "<html>ui</html>");
      await h.startServer();
      const res = await request(`http://127.0.0.1:${h.boundPort}/ui/`, { method: "HEAD" });
      assert.equal(res.statusCode, 200);
      assert.equal(await res.body.text(), "");
    });
  });
});
