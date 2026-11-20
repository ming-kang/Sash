import type { IncomingMessage } from "node:http";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiErrorCode } from "../contracts.js";
import { isLoopbackHostHeader, isLoopbackOriginHeader } from "./auth.js";
import type { DaemonContext } from "./context.js";
import type { JsonObject, ParsedDaemonRequestTarget } from "./http.js";
import { coreApiTarget } from "./proxy.js";

export type RouteAuth = "public" | "control" | "gateway";

/** The parsed request view JSON handlers see; mirrors the legacy RouteRequest. */
export interface DaemonRequest {
  readonly authorized: boolean;
  readonly method: string;
  readonly pathname: string;
  readonly routePathname: string;
  readonly params: Record<string, string | undefined>;
  readonly search: string;
  readonly searchParams: URLSearchParams;
  readonly raw: IncomingMessage;
  readonly signal: AbortSignal;
  readonly target: ParsedDaemonRequestTarget;
  readJson(): Promise<JsonObject>;
}

export type RouteResponse = {
  status: number;
  json?: unknown;
  location?: string;
  after?: () => void;
};

export type JsonRouteHandler = (
  ctx: DaemonContext,
  req: DaemonRequest,
) => Promise<RouteResponse> | RouteResponse;

export type RawRouteHandler = (
  ctx: DaemonContext,
  request: FastifyRequest,
  reply: FastifyReply,
) => void | Promise<void>;

export interface RouteDef {
  readonly methods: readonly string[] | "*";
  readonly pattern: URLPattern;
  readonly auth: RouteAuth;
  readonly bodyLimit?: number;
  readonly handler?: JsonRouteHandler;
  readonly raw?: RawRouteHandler;
}

const METHOD_ORDER = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

function methodOrder(method: string): number {
  const index = METHOD_ORDER.indexOf(method as (typeof METHOD_ORDER)[number]);
  return index < 0 ? METHOD_ORDER.length : index;
}

type RouteMatch =
  | { kind: "matched"; route: RouteDef; params: Record<string, string | undefined> }
  | { kind: "methodNotAllowed"; allow: readonly string[] }
  | { kind: "notFound" };

// Fastify performs actual routing; this matcher survives so 405 Allow headers
// keep their deterministic ordering and tests can inspect the route table.
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

export function checkLoopbackBoundary(req: IncomingMessage): RequestBoundaryFailure | undefined {
  if (!isLoopbackHostHeader(req.headers.host))
    return { status: 421, code: "http", message: "Invalid Host header" };
  if (!isLoopbackOriginHeader(req.headers.origin))
    return { status: 403, code: "unauthorized", message: "Invalid Origin header" };
  return undefined;
}

export type WebSocketRouteMatch =
  | { kind: "gateway"; target: string }
  | { kind: "methodNotAllowed"; allow: readonly ["GET"] }
  | { kind: "notFound" };

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
