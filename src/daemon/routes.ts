import { streamDaemonEvents } from "./events.js";
import { sashApiRoutes } from "./handlers.js";
import { routePath } from "./http.js";
import { forwardToCore } from "./proxy.js";
import type { RouteDef } from "./router.js";
import { serveUiAsset, serveUiIndexOrRedirect } from "./static.js";

const CORE_API_PREFIX = "/core/api";

/**
 * The whole daemon HTTP surface, in matching order; the dispatch engine
 * lives in router.ts.
 */
export function buildRoutes(): readonly RouteDef[] {
  return [
    ...sashApiRoutes(),
    {
      methods: ["GET"],
      pattern: routePath("/sash/events"),
      auth: "control",
      raw: streamDaemonEvents,
    },
    // The Core gateway proxies everything under /core/api/* straight to the
    // external controller; two patterns because URLPattern wildcards do not
    // match the bare prefix itself.
    {
      methods: "*",
      pattern: routePath(CORE_API_PREFIX),
      auth: "gateway",
      raw: forwardToCore,
    },
    {
      methods: "*",
      pattern: routePath(`${CORE_API_PREFIX}/*`),
      auth: "gateway",
      raw: forwardToCore,
    },
    {
      methods: ["GET", "HEAD"],
      pattern: routePath("/"),
      auth: "public",
      handler: (_ctx, req) => ({ status: 302, location: `/ui/${req.search}` }),
    },
    {
      methods: ["GET", "HEAD"],
      pattern: routePath("/ui"),
      auth: "public",
      raw: serveUiIndexOrRedirect,
    },
    {
      methods: ["GET", "HEAD"],
      pattern: routePath("/ui/*"),
      auth: "public",
      raw: serveUiAsset,
    },
  ];
}
