import { streamDaemonEvents } from "./events.js";
import { sashApiRoutes } from "./handlers.js";
import { forwardToCore } from "./proxy.js";
import type { RouteDef } from "./router.js";
import { serveUiAsset, serveUiIndexOrRedirect } from "./static.js";

const CORE_API_PREFIX = "/core/api";

export function buildRoutes(): readonly RouteDef[] {
  return [
    ...sashApiRoutes(),
    {
      methods: ["GET"],
      path: "/sash/events",
      auth: "control",
      raw: streamDaemonEvents,
    },
    // The Core gateway proxies everything under /core/api/* straight to the
    // external controller; two paths because a find-my-way wildcard does not
    // match the bare prefix itself.
    {
      methods: "*",
      path: CORE_API_PREFIX,
      auth: "gateway",
      raw: forwardToCore,
    },
    {
      methods: "*",
      path: `${CORE_API_PREFIX}/*`,
      auth: "gateway",
      raw: forwardToCore,
    },
    {
      methods: ["GET", "HEAD"],
      path: "/",
      auth: "public",
      handler: (_ctx, req) => ({ status: 302, location: `/ui/${req.search}` }),
    },
    {
      methods: ["GET", "HEAD"],
      path: "/ui",
      auth: "public",
      raw: serveUiIndexOrRedirect,
    },
    {
      methods: ["GET", "HEAD"],
      path: "/ui/*",
      auth: "public",
      raw: serveUiAsset,
    },
  ];
}
