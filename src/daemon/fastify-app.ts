import type { IncomingMessage } from "node:http";
import { METHODS } from "node:http";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { apiErrorBody } from "../contracts.js";
import type { ControlAuthorization } from "./auth.js";
import { isControlMutation, isControlRequestAuthorized } from "./auth.js";
import type { DaemonContext } from "./context.js";
import { errorToHttp } from "./errors.js";
import { daemonTargetOf, type JsonObject, parseJsonObjectBody } from "./http.js";
import { type DaemonRequest, matchRoute, type RouteDef, type RouteResponse } from "./router.js";

export const JSON_BODY_LIMIT_DEFAULT = 1024 * 1024;

// Fastify's own bodyLimit rejects oversized Content-Length headers before the
// body stream is drained. The legacy parser drains first (so keep-alive
// connections survive a 413), so route limits live in config and the Fastify
// precheck is disabled with a ceiling that can never trigger.
const NO_FASTIFY_PRECHECK = Number.MAX_SAFE_INTEGER;

// Fastify does not register wildcard methods: the gateway used to accept
// anything Node could parse, so the full llhttp method set keeps the surface
// equal. CONNECT is excluded because Node dispatches it to the "connect"
// event, never to "request".
const GATEWAY_METHODS = METHODS.filter((method) => method !== "CONNECT");

// Methods Fastify routes out of the box; the remaining llhttp methods are
// registered via addHttpMethod so gateway routes can claim them.
const FASTIFY_BUILTIN_METHODS = new Set([
  "GET",
  "HEAD",
  "TRACE",
  "DELETE",
  "OPTIONS",
  "PATCH",
  "PUT",
  "POST",
  "QUERY",
]);

declare module "fastify" {
  interface FastifyRequest {
    authorized: boolean;
  }
}

interface DaemonRouteConfig {
  auth?: string;
  daemonRaw?: boolean;
  daemonBodyLimit?: number;
}

function writeResponse(reply: FastifyReply, response: RouteResponse): void {
  if (response.after) {
    const after = response.after;
    let ran = false;
    const run = (): void => {
      if (ran) return;
      ran = true;
      after();
    };
    reply.raw.once("finish", run);
    reply.raw.once("close", run);
  }
  if (response.json !== undefined) {
    void reply.code(response.status).send(response.json);
    return;
  }
  if (response.location !== undefined) {
    void reply.code(response.status).header("Location", response.location).send();
    return;
  }
  void reply.code(response.status).send();
}

/**
 * Map a URLPattern pathname onto a find-my-way path. Constrained params like
 * `:id([0-9]+)` need `^…$` anchors because find-my-way matches the whole
 * segment and legacy patterns carried their own anchors.
 */
function fastifyPathOf(pattern: URLPattern): string {
  return pattern.pathname.replace(/:(\w+)\(([^)]+)\)/g, (_match, name: string, re: string) => {
    const inner = re.replace(/^\^+/, "").replace(/\$+$/, "");
    return `:${name}(^${inner}$)`;
  });
}

function controlAuthorization(ctx: DaemonContext): ControlAuthorization {
  return {
    daemonSecret: ctx.settings.committed().daemonSecret,
    isSessionToken: (token) => ctx.webAuth.isSession(token),
  };
}

function unauthorized(reply: FastifyReply): FastifyReply {
  return reply.code(401).send(apiErrorBody("unauthorized", "Unauthorized control request"));
}

function sendGateClosed(reply: FastifyReply): FastifyReply {
  return reply.code(503).send(apiErrorBody("shutting_down", "Sash is shutting down"));
}

async function invokeJson(
  ctx: DaemonContext,
  def: RouteDef,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const controller = new AbortController();
  const disconnect = (): void => controller.abort();
  reply.raw.once("close", disconnect);
  if (reply.raw.destroyed) disconnect();
  const method = request.method.toUpperCase();
  const target = daemonTargetOf(request.raw);
  const daemonRequest: DaemonRequest = {
    authorized: request.authorized,
    method,
    pathname: target.pathname,
    routePathname: target.routePathname,
    params: request.params as Record<string, string | undefined>,
    search: target.search,
    searchParams: target.searchParams,
    raw: request.raw,
    signal: controller.signal,
    target,
    readJson: async () => {
      const body = (request.body ?? {}) as JsonObject;
      if (isControlMutation(method)) ctx.gate.assertMutable();
      return body;
    },
  };
  try {
    const handler = def.handler;
    if (!handler) throw new Error(`Route has no handler: ${method} ${target.routePathname}`);
    writeResponse(reply, await handler(ctx, daemonRequest));
  } finally {
    reply.raw.removeListener("close", disconnect);
  }
}

export function buildDaemonApp(ctx: DaemonContext, routes: readonly RouteDef[]): FastifyInstance {
  const app = Fastify({
    logger: false,
    exposeHeadRoutes: false,
    requestIdHeader: false,
    bodyLimit: NO_FASTIFY_PRECHECK,
  });

  app.decorateRequest("authorized", false);

  for (const method of GATEWAY_METHODS) {
    if (!FASTIFY_BUILTIN_METHODS.has(method)) app.addHttpMethod(method, { hasBody: true });
  }

  // Any Content-Type may carry a JSON object body, exactly like the legacy
  // reader; raw routes leave the stream untouched so the proxy can pipe it.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("*", (request, payload, done) => {
    const config = request.routeOptions.config as DaemonRouteConfig | undefined;
    if (config?.daemonRaw) {
      done(null, undefined);
      return;
    }
    parseJsonObjectBody(
      payload as IncomingMessage,
      config?.daemonBodyLimit ?? JSON_BODY_LIMIT_DEFAULT,
    ).then((body) => done(null, body), done);
  });

  app.addHook("onRequest", async (request, reply) => {
    request.authorized = isControlRequestAuthorized(request.raw, controlAuthorization(ctx));
    const config = request.routeOptions.config as DaemonRouteConfig | undefined;
    // Authentication covers protected routes plus any mutation, so
    // unauthenticated probes cannot distinguish unknown paths from existing
    // ones.
    const requiresAuth =
      config?.auth === undefined ? isControlMutation(request.method) : config.auth !== "public";
    if (requiresAuth && !request.authorized) return unauthorized(reply);
    if (isControlMutation(request.method) && ctx.gate.isClosing) return sendGateClosed(reply);
  });

  app.addHook("preHandler", async (request) => {
    if (isControlMutation(request.method)) ctx.gate.assertMutable();
  });

  // API responses are never cacheable; raw handlers own their own headers.
  app.addHook("onSend", async (_request, reply) => {
    if (!reply.hasHeader("cache-control")) reply.header("Cache-Control", "no-store");
  });

  app.setNotFoundHandler((request, reply) => {
    const method = request.method.toUpperCase();
    const target = daemonTargetOf(request.raw);
    if (isControlMutation(method) && !request.authorized) return unauthorized(reply);
    if (isControlMutation(method) && ctx.gate.isClosing) return sendGateClosed(reply);
    const match = matchRoute(routes, method, target.routePathname);
    if (match.kind === "methodNotAllowed") {
      return reply
        .code(405)
        .header("Allow", match.allow.join(", "))
        .send(apiErrorBody("http", "Method Not Allowed"));
    }
    return reply
      .code(404)
      .send(apiErrorBody("not_found", `Not found: ${method} ${target.routePathname}`));
  });

  app.setErrorHandler((error, request, reply) => {
    if (reply.raw.destroyed) return;
    if (reply.raw.headersSent) {
      reply.raw.destroy();
      return;
    }
    const mapping = errorToHttp(error);
    if (mapping.status >= 500) {
      let routePathname: string | undefined;
      try {
        routePathname = daemonTargetOf(request.raw).routePathname;
      } catch {
        routePathname = request.url;
      }
      console.error(`[sashd] unhandled error in ${request.method} ${routePathname}:`, error);
    }
    void reply.code(mapping.status).send(apiErrorBody(mapping.code, mapping.message));
  });

  for (const def of routes) {
    const raw = def.raw;
    app.route({
      method: def.methods === "*" ? GATEWAY_METHODS : [...def.methods],
      url: fastifyPathOf(def.pattern),
      config: {
        auth: def.auth,
        daemonRaw: raw !== undefined,
        daemonBodyLimit: def.bodyLimit ?? JSON_BODY_LIMIT_DEFAULT,
      },
      handler: raw
        ? (request, reply) => raw(ctx, request, reply)
        : (request, reply) => invokeJson(ctx, def, request, reply),
    });
  }

  return app;
}
