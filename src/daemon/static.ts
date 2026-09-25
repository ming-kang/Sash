import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { ApiErrorCode } from "../contracts.js";
import type { SashLayout } from "../paths.js";
import { resolveUiDir } from "../webui.js";
import type { DaemonContext } from "./context.js";
import { type ParsedDaemonRequestTarget, sendError } from "./http.js";

const UI_SECURITY_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

/**
 * Vite emits fingerprinted bundles and font chunks as `assets/<name>-<hash>.<ext>`;
 * those URLs change with their content, so clients may cache them forever.
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

/** UI error responses keep the dashboard's framing and sniffing isolation. */
function sendUiError(
  res: ServerResponse,
  statusCode: number,
  code: ApiErrorCode,
  message: string,
): void {
  for (const [name, value] of Object.entries(UI_SECURITY_HEADERS)) res.setHeader(name, value);
  sendError(res, statusCode, code, message);
}

export function serveUiIndexOrRedirect(
  ctx: DaemonContext,
  req: IncomingMessage,
  res: ServerResponse,
  target: ParsedDaemonRequestTarget,
): void {
  // Route matching strips trailing slashes, so the redirect decision uses the
  // unnormalized pathname to tell /ui and /ui/ apart.
  if (target.pathname === "/ui") {
    res.writeHead(302, { Location: `/ui/${target.search}` });
    res.end();
    return;
  }
  serveUiAsset(ctx, req, res, target);
}

export function serveUiAsset(
  ctx: DaemonContext,
  req: IncomingMessage,
  res: ServerResponse,
  target: ParsedDaemonRequestTarget,
): void {
  if (!serveStaticUi(req, res, target.pathname, ctx.layout)) {
    sendError(res, 404, "not_found", `Not found: ${req.method} ${target.routePathname}`);
  }
}

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
    sendUiError(
      res,
      404,
      "not_found",
      "Dashboard assets are missing. Reinstall Sash, or run npm run build in a source checkout.",
    );
    return true;
  }

  let relative = pathname.startsWith("/ui/") ? pathname.slice("/ui/".length) : "";
  if (!relative || relative === "ui") relative = "index.html";

  // Serve only what resolves inside the asset root. path.join normalizes any
  // traversal away and treats a leading slash as a relative segment, so the
  // resolved result is compared against the root rather than pattern-matched
  // against the request.
  const root = path.resolve(uiRoot);
  const candidate = path.resolve(path.join(root, relative));
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    sendUiError(res, 403, "unauthorized", "Forbidden");
    return true;
  }

  const hasExt = Boolean(path.extname(relative));

  const openFile = (file: string): { fd: number; stats: fs.Stats } | null => {
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, "r");
      const stats = fs.fstatSync(fd);
      if (stats.isFile()) return { fd, stats };
    } catch {}
    if (fd !== undefined) fs.closeSync(fd);
    return null;
  };

  let targetFile = candidate;
  let opened = openFile(targetFile);
  if (!opened && !hasExt) {
    targetFile = path.join(root, "index.html");
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
        sendUiError(res, 500, "internal", "Failed to read dashboard asset");
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
