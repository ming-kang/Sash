import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { SashLayout } from "./paths.js";
import { resolveUiDir } from "./webui.js";

const UI_SECURITY_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

/**
 * Vite emits fingerprinted bundles and font chunks as `assets/<name>-<hash>.<ext>`;
 * those URLs change with their content, so clients may cache them forever.
 * Unfingerprinted files (favicon, branding art) get a short bounded lifetime.
 */
const FINGERPRINTED_ASSET = /^assets\/.+-[A-Za-z0-9_-]{8}\.[^/\\]+$/;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Handle static file serving for /ui and /ui/* endpoints.
 * Returns true if the request was handled, false otherwise.
 */
export function serveStaticUi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  layout: SashLayout,
): boolean {
  if (pathname !== "/ui" && !pathname.startsWith("/ui/")) {
    return false;
  }

  const uiRoot = resolveUiDir(layout);
  if (!uiRoot) {
    res.writeHead(404, { ...UI_SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    res.end(
      "Dashboard assets are missing. Reinstall Sash, or run npm run build in a source checkout.",
    );
    return true;
  }

  let relative = pathname.startsWith("/ui/") ? pathname.slice("/ui/".length) : "";
  if (!relative || relative === "ui") relative = "index.html";

  // Prevent path traversal
  if (relative.split(/[\\/]/).includes("..")) {
    res.writeHead(403, { ...UI_SECURITY_HEADERS, "Content-Type": "text/plain" });
    res.end("Forbidden");
    return true;
  }

  const candidate = path.join(uiRoot, relative);
  const hasExt = Boolean(path.extname(relative));

  const openFile = (file: string): { fd: number; stats: fs.Stats } | null => {
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, "r");
      const stats = fs.fstatSync(fd);
      if (stats.isFile()) return { fd, stats };
    } catch {
      // Missing assets and non-files may fall back to the SPA document below.
    }
    if (fd !== undefined) fs.closeSync(fd);
    return null;
  };

  let targetFile = candidate;
  let opened = openFile(targetFile);
  if (!opened && !hasExt) {
    targetFile = path.join(uiRoot, "index.html");
    opened = openFile(targetFile);
  }

  if (opened) {
    const ext = path.extname(targetFile);
    const mime = MIME_TYPES[ext] ?? "application/octet-stream";
    const headers: Record<string, string> = {
      ...UI_SECURITY_HEADERS,
      "Content-Type": mime,
      "Content-Length": String(opened.stats.size),
    };
    if (ext === ".html") {
      headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
      headers.Pragma = "no-cache";
      headers.Expires = "0";
    } else if (FINGERPRINTED_ASSET.test(relative)) {
      headers["Cache-Control"] = "public, max-age=31536000, immutable";
    } else {
      headers["Cache-Control"] = "public, max-age=3600";
    }
    if (req.method === "HEAD") {
      try {
        res.writeHead(200, headers);
        res.end();
      } finally {
        fs.closeSync(opened.fd);
      }
      return true;
    }
    let stream: fs.ReadStream;
    try {
      stream = fs.createReadStream(targetFile, { fd: opened.fd, autoClose: true });
    } catch (error) {
      fs.closeSync(opened.fd);
      throw error;
    }
    const disconnected = (): void => {
      stream.destroy();
    };
    res.once("close", disconnected);
    stream.once("close", () => res.off("close", disconnected));
    stream.once("error", () => {
      if (!res.headersSent) {
        res.writeHead(500, {
          ...UI_SECURITY_HEADERS,
          "Content-Type": "text/plain; charset=utf-8",
        });
        res.end("Failed to read dashboard asset");
      } else {
        res.destroy();
      }
    });
    res.writeHead(200, headers);
    stream.pipe(res);
    return true;
  }

  return false;
}
