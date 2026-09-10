import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiErrorCode } from "../contracts.js";
import {
  isControlMutation,
  isControlRequestAuthorized,
  isLoopbackHostHeader,
  isLoopbackOriginHeader,
} from "./auth.js";
import type { DaemonContext } from "./context.js";
import { errorToHttp } from "./errors.js";
import { streamDaemonEvents } from "./events.js";
import {
  activateProfile,
  addProfile,
  continueWebSession,
  coreUpdateProgress,
  createWebBootstrap,
  daemonStatus,
  health,
  importProfile,
  listProfiles,
  patchSettings,
  proxyStatus,
  readAutostart,
  readProfileContent,
  readSettings,
  redeemWebBootstrap,
  removeProfile,
  renameProfile,
  reorderProfiles,
  restartCore,
  setCoreMode,
  shutdownDaemon,
  startCore,
  stopCore,
  testCoreDelay,
  updateAllProfiles,
  updateCore,
  updateProfile,
  writeAutostart,
  writeProfileContent,
} from "./handlers.js";
import { type JsonObject, parseJsonObjectBody, sendError, sendJson } from "./http.js";
import { forwardHttpToCore } from "./proxy.js";
import { serveStaticUi } from "./static.js";

/* ====================================================================== */
/* Request target parsing                                                  */
/* ====================================================================== */

export interface ParsedDaemonRequestTarget {
  /** WHATWG-canonical pathname; percent-encoded slash remains encoded. */
  pathname: string;
  /** Pathname used for route matching, with trailing slashes removed. */
  routePathname: string;
  search: string;
  searchParams: URLSearchParams;
}

/**
 * Parse only HTTP origin-form request targets. Absolute-, authority-,
 * asterisk-, network-path and cross-authority backslash forms are rejected so
 * authentication and forwarding always consume one canonical pathname.
 */
export function parseDaemonRequestTarget(
  rawTarget: string,
  hostHeader: string,
): ParsedDaemonRequestTarget {
  if (!rawTarget.startsWith("/") || rawTarget.startsWith("//")) {
    throw new Error("Unsupported HTTP request-target form");
  }
  const base = new URL(`http://${hostHeader}`);
  const url = new URL(rawTarget, base);
  if (url.origin !== base.origin || url.hash) {
    throw new Error("Invalid HTTP origin-form request target");
  }
  return {
    pathname: url.pathname,
    routePathname: url.pathname.replace(/\/+$/, "") || "/",
    search: url.search,
    searchParams: url.searchParams,
  };
}

/** Map a /core/api/* request target to the upstream Core path plus query. */
export function coreApiTarget(target: ParsedDaemonRequestTarget): string {
  const prefix = "/core/api";
  const suffix = target.pathname.slice(prefix.length);
  const upstreamPath = suffix ? `/${suffix.replace(/^\/+/, "")}` : "/";
  return `${upstreamPath}${target.search}`;
}

/* ====================================================================== */
/* Route table                                                             */
/* ====================================================================== */

/** public: no credential. control: CLI bearer or WebUI session token. gateway: same, then proxied to Core. */
export type RouteAuth = "public" | "control" | "gateway";

export interface RouteRequest {
  authorized: boolean;
  method: string;
  pathname: string;
  params: Record<string, string | undefined>;
  search: string;
  searchParams: URLSearchParams;
  raw: IncomingMessage;
  signal: AbortSignal;
  readJson(maxBytes?: number): Promise<JsonObject>;
}

export type RouteResponse = {
  status: number;
  json?: unknown;
  location?: string;
  /** Runs once after the response has finished streaming. */
  after?: () => void;
};

type JsonRouteHandler = (
  ctx: DaemonContext,
  req: RouteRequest,
) => Promise<RouteResponse> | RouteResponse;

type RawRouteHandler = (
  ctx: DaemonContext,
  req: IncomingMessage,
  res: ServerResponse,
  target: ParsedDaemonRequestTarget,
) => void | Promise<void>;

export interface RouteDef {
  readonly methods: readonly string[] | "*";
  readonly pattern: URLPattern;
  readonly auth: RouteAuth;
  readonly handler?: JsonRouteHandler;
  readonly raw?: RawRouteHandler;
}

function path(pathname: string): URLPattern {
  return new URLPattern({ pathname });
}

const CORE_API_PREFIX = "/core/api";

/** The whole daemon HTTP surface, in matching order. */
export function buildRoutes(): readonly RouteDef[] {
  return [
    {
      methods: ["POST"],
      pattern: path("/sash/web/continue"),
      auth: "public",
      handler: continueWebSession,
    },
    { methods: ["GET"], pattern: path("/sash/daemon/health"), auth: "public", handler: health },
    { methods: ["GET"], pattern: path("/sash/events"), auth: "control", raw: streamDaemonEvents },
    {
      methods: ["GET"],
      pattern: path("/sash/daemon/status"),
      auth: "public",
      handler: daemonStatus,
    },
    {
      methods: ["POST"],
      pattern: path("/sash/daemon/shutdown"),
      auth: "control",
      handler: shutdownDaemon,
    },
    {
      methods: ["POST"],
      pattern: path("/sash/web/bootstrap"),
      auth: "control",
      handler: createWebBootstrap,
    },
    // The bootstrap exchange itself is public: the one-time token in the
    // request body is the credential being redeemed.
    {
      methods: ["POST"],
      pattern: path("/sash/web/session"),
      auth: "public",
      handler: redeemWebBootstrap,
    },
    { methods: ["POST"], pattern: path("/sash/core/start"), auth: "control", handler: startCore },
    { methods: ["PUT"], pattern: path("/sash/core/mode"), auth: "control", handler: setCoreMode },
    {
      methods: ["POST"],
      pattern: path("/sash/core/delay"),
      auth: "control",
      handler: testCoreDelay,
    },
    { methods: ["POST"], pattern: path("/sash/core/stop"), auth: "control", handler: stopCore },
    {
      methods: ["POST"],
      pattern: path("/sash/core/restart"),
      auth: "control",
      handler: restartCore,
    },
    {
      methods: ["POST"],
      pattern: path("/sash/core/update"),
      auth: "control",
      handler: updateCore,
    },
    {
      methods: ["GET"],
      pattern: path("/sash/core/update"),
      auth: "control",
      handler: coreUpdateProgress,
    },
    { methods: ["GET"], pattern: path("/sash/proxy"), auth: "public", handler: proxyStatus },
    { methods: ["GET"], pattern: path("/sash/autostart"), auth: "control", handler: readAutostart },
    {
      methods: ["PUT"],
      pattern: path("/sash/autostart"),
      auth: "control",
      handler: writeAutostart,
    },
    { methods: ["GET"], pattern: path("/sash/settings"), auth: "control", handler: readSettings },
    {
      methods: ["PATCH"],
      pattern: path("/sash/settings"),
      auth: "control",
      handler: patchSettings,
    },
    { methods: ["GET"], pattern: path("/sash/profiles"), auth: "control", handler: listProfiles },
    { methods: ["POST"], pattern: path("/sash/profiles"), auth: "control", handler: addProfile },
    {
      methods: ["PUT"],
      pattern: path("/sash/profiles/order"),
      auth: "control",
      handler: reorderProfiles,
    },
    {
      methods: ["POST"],
      pattern: path("/sash/profiles/import"),
      auth: "control",
      handler: importProfile,
    },
    {
      methods: ["POST"],
      pattern: path("/sash/profiles/update-all"),
      auth: "control",
      handler: updateAllProfiles,
    },
    {
      methods: ["PUT"],
      pattern: path("/sash/profiles/active"),
      auth: "control",
      handler: activateProfile,
    },
    {
      methods: ["POST"],
      pattern: path("/sash/profiles/:id([0-9]+)/update"),
      auth: "control",
      handler: updateProfile,
    },
    {
      methods: ["GET", "PUT"],
      pattern: path("/sash/profiles/:id([0-9]+)/content"),
      auth: "control",
      handler: (ctx, req) =>
        req.method === "PUT" ? writeProfileContent(ctx, req) : readProfileContent(ctx, req),
    },
    {
      methods: ["PATCH", "DELETE"],
      pattern: path("/sash/profiles/:id([0-9]+)"),
      auth: "control",
      handler: (ctx, req) =>
        req.method === "DELETE" ? removeProfile(ctx, req) : renameProfile(ctx, req),
    },
    // The Core gateway proxies everything under /core/api/* straight to the
    // external controller. Two patterns: URLPattern wildcards do not match the
    // bare prefix itself.
    {
      methods: "*",
      pattern: path(CORE_API_PREFIX),
      auth: "gateway",
      raw: forwardToCore,
    },
    {
      methods: "*",
      pattern: path(`${CORE_API_PREFIX}/*`),
      auth: "gateway",
      raw: forwardToCore,
    },
    {
      methods: ["GET", "HEAD"],
      pattern: path("/"),
      auth: "public",
      handler: (_ctx, req) => ({ status: 302, location: `/ui/${req.search}` }),
    },
    // /ui redirects to /ui/; /ui/ itself must serve index.html, so the
    // redirect decision uses the unnormalized pathname (route matching strips
    // trailing slashes and could not tell the two apart).
    {
      methods: ["GET", "HEAD"],
      pattern: path("/ui"),
      auth: "public",
      raw: serveUiIndexOrRedirect,
    },
    {
      methods: ["GET", "HEAD"],
      pattern: path("/ui/*"),
      auth: "public",
      raw: serveUiAsset,
    },
  ];
}

async function forwardToCore(
  ctx: DaemonContext,
  req: IncomingMessage,
  res: ServerResponse,
  target: ParsedDaemonRequestTarget,
): Promise<void> {
  const method = req.method?.toUpperCase() ?? "GET";
  const pathname = coreApiTarget(target).split("?")[0] ?? "/";
  const allowedMutation =
    (method === "PUT" && /^\/proxies\/[^/]+$/.test(pathname)) ||
    (method === "DELETE" && /^\/connections(?:\/[^/]+)?$/.test(pathname));
  if (isControlMutation(method) && !allowedMutation) {
    sendError(res, 403, "conflict", "Use Sash controls to change managed Core configuration");
    return;
  }
  const runtime = ctx.settings.runtime();
  const forward = () =>
    forwardHttpToCore(req, res, coreApiTarget(target), runtime.controller, runtime.secret);
  if (isControlMutation(method)) await ctx.gate.runLiveMutation(forward);
  else await forward();
}

function serveUiIndexOrRedirect(
  ctx: DaemonContext,
  req: IncomingMessage,
  res: ServerResponse,
  target: ParsedDaemonRequestTarget,
): void {
  if (target.pathname === "/ui") {
    res.writeHead(302, { Location: `/ui/${target.search}` });
    res.end();
    return;
  }
  serveUiAsset(ctx, req, res, target);
}

function serveUiAsset(
  ctx: DaemonContext,
  req: IncomingMessage,
  res: ServerResponse,
  target: ParsedDaemonRequestTarget,
): void {
  if (!serveStaticUi(req, res, target.pathname, ctx.layout)) {
    sendError(res, 404, "not_found", `Not found: ${req.method} ${target.routePathname}`);
  }
}

/* ====================================================================== */
/* Dispatch                                                                */
/* ====================================================================== */

const METHOD_ORDER = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

function methodOrder(method: string): number {
  const index = METHOD_ORDER.indexOf(method as (typeof METHOD_ORDER)[number]);
  return index < 0 ? METHOD_ORDER.length : index;
}

function writeResponse(res: ServerResponse, response: RouteResponse): void {
  if (response.after) {
    const after = response.after;
    let ran = false;
    const run = (): void => {
      if (ran) return;
      ran = true;
      after();
    };
    res.once("finish", run);
    res.once("close", run);
  }
  if (response.json !== undefined) {
    sendJson(res, response.status, response.json);
    return;
  }
  if (response.location !== undefined) {
    res.writeHead(response.status, { Location: response.location });
    res.end();
    return;
  }
  res.writeHead(response.status);
  res.end();
}

export type RouteMatch =
  | { kind: "matched"; route: RouteDef; params: Record<string, string | undefined> }
  | { kind: "methodNotAllowed"; allow: readonly string[] }
  | { kind: "notFound" };

/** Pure route-table matching, including method-mismatch Allow metadata. */
export function matchRoute(
  routes: readonly RouteDef[],
  method: string,
  pathname: string,
): RouteMatch {
  const allowed = new Set<string>();
  let found = false;
  for (const route of routes) {
    const result = route.pattern.exec({ pathname });
    if (!result) continue;
    found = true;
    if (route.methods === "*" || route.methods.includes(method))
      return { kind: "matched", route, params: result.pathname.groups };
    for (const allowedMethod of route.methods) allowed.add(allowedMethod);
  }
  if (!found) return { kind: "notFound" };
  const allow = [...allowed].sort((left, right) => methodOrder(left) - methodOrder(right));
  return { kind: "methodNotAllowed", allow };
}

export interface RequestBoundaryFailure {
  status: 403 | 421;
  code: ApiErrorCode;
  message: string;
}

/** Loopback Host and Origin policy shared by HTTP dispatch and WebSocket upgrades. */
export function checkLoopbackBoundary(req: IncomingMessage): RequestBoundaryFailure | undefined {
  if (!isLoopbackHostHeader(req.headers.host))
    return { status: 421, code: "http", message: "Invalid Host header" };
  if (!isLoopbackOriginHeader(req.headers.origin))
    return { status: 403, code: "unauthorized", message: "Invalid Origin header" };
  return undefined;
}

export type RequestTargetResult =
  | { ok: true; target: ParsedDaemonRequestTarget }
  | { ok: false; message: string };

/** Parse the origin-form request target, reporting a message instead of throwing. */
export function parseRequestTarget(req: IncomingMessage): RequestTargetResult {
  try {
    return {
      ok: true,
      target: parseDaemonRequestTarget(req.url ?? "/", req.headers.host ?? ""),
    };
  } catch {
    return { ok: false, message: "Invalid request target" };
  }
}

/** Match, authorize, and execute one HTTP request against the route table. */
export async function dispatch(
  ctx: DaemonContext,
  routes: readonly RouteDef[],
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const boundary = checkLoopbackBoundary(req);
  if (boundary) {
    sendError(res, boundary.status, boundary.code, boundary.message);
    return;
  }

  const parsed = parseRequestTarget(req);
  if (!parsed.ok) {
    sendError(res, 400, "http", parsed.message);
    return;
  }
  const target = parsed.target;
  const method = req.method?.toUpperCase() ?? "GET";
  const pathname = target.routePathname;
  const match = matchRoute(routes, method, pathname);
  const route = match.kind === "matched" ? match.route : undefined;

  // Any non-loopback Origin is rejected outright, not just on mutations: the
  // daemon never participates in cross-origin browser flows. Authentication
  // covers protected routes plus any mutation, so unauthenticated probes
  // cannot distinguish unknown paths from existing ones.
  const requiresAuth = route ? route.auth !== "public" : isControlMutation(method);
  const authorized = isControlRequestAuthorized(req, {
    daemonSecret: ctx.settings.committed().daemonSecret,
    isSessionToken: (token) => ctx.webAuth.isSession(token),
  });
  if (requiresAuth && !authorized) {
    const token = req.headers["x-sash-token"];
    if (typeof token === "string" && ctx.webAuth.isContinuationToken(token)) {
      sendError(res, 409, "conflict", "Sash upgraded; reconnect this browser session");
      return;
    }
    sendError(res, 401, "unauthorized", "Unauthorized control request");
    return;
  }

  if (ctx.gate.isClosing && isControlMutation(method)) {
    sendError(res, 503, "shutting_down", "sashd is shutting down");
    return;
  }

  if (!route || match.kind !== "matched") {
    if (match.kind === "methodNotAllowed") {
      res.setHeader("Allow", match.allow.join(", "));
      sendError(res, 405, "http", "Method Not Allowed");
      return;
    }
    sendError(res, 404, "not_found", `Not found: ${method} ${pathname}`);
    return;
  }

  try {
    if (isControlMutation(method)) ctx.gate.assertMutable();
    if (route.raw) {
      await route.raw(ctx, req, res, target);
      return;
    }
    if (!route.handler) throw new Error(`Route has no handler: ${method} ${pathname}`);
    const controller = new AbortController();
    const disconnect = (): void => controller.abort();
    res.once("close", disconnect);
    if (res.destroyed) disconnect();
    const request: RouteRequest = {
      authorized,
      method,
      pathname,
      params: match.params,
      search: target.search,
      searchParams: target.searchParams,
      raw: req,
      signal: controller.signal,
      readJson: async (maxBytes) => {
        const body = await parseJsonObjectBody(req, maxBytes);
        if (isControlMutation(method)) ctx.gate.assertMutable();
        return body;
      },
    };
    try {
      writeResponse(res, await route.handler(ctx, request));
    } finally {
      res.removeListener("close", disconnect);
    }
  } catch (err) {
    if (res.writableEnded || res.destroyed) return;
    const mapping = errorToHttp(err);
    if (mapping.status >= 500) {
      console.error(`[sashd] unhandled error in ${method} ${pathname}:`, err);
    }
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendError(res, mapping.status, mapping.code, mapping.message);
  }
}

/* ====================================================================== */
/* WebSocket upgrade matching                                              */
/* ====================================================================== */

export type WebSocketRouteMatch =
  | { kind: "gateway"; target: string }
  | { kind: "methodNotAllowed"; allow: readonly ["GET"] }
  | { kind: "notFound" };

/** WebSocket streams reuse the route table: only gateway rows, GET only. */
export function matchWebSocketUpgrade(
  routes: readonly RouteDef[],
  method: string,
  target: ParsedDaemonRequestTarget,
): WebSocketRouteMatch {
  const gateway = routes.some(
    (route) => route.auth === "gateway" && route.pattern.test({ pathname: target.routePathname }),
  );
  if (!gateway) return { kind: "notFound" };
  if (method.toUpperCase() !== "GET") return { kind: "methodNotAllowed", allow: ["GET"] };
  return { kind: "gateway", target: coreApiTarget(target) };
}
