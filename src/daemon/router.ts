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
import {
  type JsonObject,
  type ParsedDaemonRequestTarget,
  parseJsonObjectBody,
  parseRequestTarget,
  sendError,
  sendJson,
} from "./http.js";
import { coreApiTarget } from "./proxy.js";

/* ====================================================================== */
/* Route types                                                             */
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

type RouteMatch =
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
    sendError(res, 401, "unauthorized", "Unauthorized control request");
    return;
  }

  if (ctx.gate.isClosing && isControlMutation(method)) {
    sendError(res, 503, "shutting_down", "Sash is shutting down");
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
