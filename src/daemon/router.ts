import type { IncomingMessage, ServerResponse } from "node:http";
import FindMyWay from "find-my-way";
import type { ApiErrorCode } from "../contracts.js";
import { isLoopbackHostHeader, isLoopbackOriginHeader } from "./auth.js";
import type { DaemonContext } from "./context.js";
import type { JsonObject, ParsedDaemonRequestTarget } from "./http.js";
import { coreApiTarget } from "./proxy.js";

// "public" serves unauthenticated GET/HEAD responses; "control" requires the
// CLI bearer or a same-origin dashboard request; "gateway" proxies to the Core
// controller — it requires the same control authorization, then injects the
// Core secret upstream so the WebUI never has to know it.
export type RouteAuth = "public" | "control" | "gateway";

export interface DaemonRequest {
  readonly authorized: boolean;
  readonly method: string;
  readonly originalPathname: string;
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
  req: IncomingMessage,
  res: ServerResponse,
  target: ParsedDaemonRequestTarget,
) => void | Promise<void>;

export interface RouteDef {
  readonly methods: readonly string[] | "*";
  /** Route path in find-my-way syntax: statics, `:param(regex)`, `*` wildcard. */
  readonly path: string;
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

interface RouteLookupHit {
  defs: readonly RouteDef[];
  params: Record<string, string | undefined>;
}

// find-my-way keys matches on (method, path). Mirroring the route table into a
// shadow tree under one sentinel method lets a single find() answer "which
// route defs own this pathname?" — the 405 Allow decision and the WebSocket
// upgrade check both need exactly that, while Fastify does real dispatch.
const LOOKUP_METHOD = "ACL";
const lookupHandler = (): void => undefined;

function buildRouteLookup(routes: readonly RouteDef[]) {
  const router = FindMyWay();
  const byPath = new Map<string, RouteDef[]>();
  for (const def of routes) {
    const group = byPath.get(def.path);
    if (group) {
      group.push(def);
    } else {
      const defs = [def];
      byPath.set(def.path, defs);
      router.on(LOOKUP_METHOD, def.path, lookupHandler, { defs });
    }
  }
  return (pathname: string): RouteLookupHit | undefined => {
    const found = router.find(LOOKUP_METHOD, pathname);
    if (!found) return undefined;
    return {
      defs: (found.store as { defs: readonly RouteDef[] }).defs,
      params: found.params,
    };
  };
}

const routeLookups = new WeakMap<readonly RouteDef[], ReturnType<typeof buildRouteLookup>>();

function routeLookup(routes: readonly RouteDef[]): ReturnType<typeof buildRouteLookup> {
  let lookup = routeLookups.get(routes);
  if (!lookup) {
    lookup = buildRouteLookup(routes);
    routeLookups.set(routes, lookup);
  }
  return lookup;
}

export function matchRoute(
  routes: readonly RouteDef[],
  method: string,
  pathname: string,
): RouteMatch {
  const hit = routeLookup(routes)(pathname);
  if (!hit) return { kind: "notFound" };
  const allowed = new Set<string>();
  for (const route of hit.defs) {
    if (route.methods === "*" || route.methods.includes(method))
      return { kind: "matched", route, params: hit.params };
    for (const allowedMethod of route.methods) allowed.add(allowedMethod);
  }
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
  const hit = routeLookup(routes)(target.routePathname);
  const gateway = hit?.defs.some((route) => route.auth === "gateway") ?? false;
  if (!gateway) return { kind: "notFound" };
  if (method.toUpperCase() !== "GET") return { kind: "methodNotAllowed", allow: ["GET"] };
  return { kind: "gateway", target: coreApiTarget(target) };
}
