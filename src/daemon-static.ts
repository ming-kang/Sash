import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { SashLayout } from "./paths.js";
import { resolveUiDir } from "./webui.js";

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
  _req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  layout: SashLayout,
): boolean {
  if (pathname !== "/ui" && !pathname.startsWith("/ui/")) {
    return false;
  }

  const uiRoot = resolveUiDir(layout);
  if (!uiRoot) {
    return false;
  }

  let relative = pathname.startsWith("/ui/") ? pathname.slice("/ui/".length) : "";
  if (!relative || relative === "ui") relative = "index.html";

  // Prevent path traversal
  if (relative.split(/[\\/]/).includes("..")) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return true;
  }

  const candidate = path.join(uiRoot, relative);
  const hasExt = Boolean(path.extname(relative));

  let targetFile: string | null = null;
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    targetFile = candidate;
  } else if (!hasExt) {
    targetFile = path.join(uiRoot, "index.html");
  }

  if (targetFile && fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
    const ext = path.extname(targetFile);
    const mime = MIME_TYPES[ext] ?? "application/octet-stream";
    const headers: Record<string, string> = { "Content-Type": mime };
    if (ext === ".html") {
      headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
      headers.Pragma = "no-cache";
      headers.Expires = "0";
    }
    res.writeHead(200, headers);
    fs.createReadStream(targetFile).pipe(res);
    return true;
  }

  return false;
}
