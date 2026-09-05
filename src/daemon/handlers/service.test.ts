import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import type { PublicServiceStatus } from "../../contracts.js";
import { sashLayout } from "../../paths.js";
import { buildRoutes, matchRoute } from "../router.js";
import { createServiceStatusHandler } from "./service.js";

it("exposes only a public GET service route, not administrative mutations", () => {
  const routes = buildRoutes();
  const get = matchRoute(routes, "GET", "/sash/service");
  assert.equal(get.kind, "matched");
  if (get.kind === "matched") assert.equal(get.route.auth, "public");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.deepEqual(matchRoute(routes, method, "/sash/service"), {
      kind: "methodNotAllowed",
      allow: ["GET"],
    });
  }
  assert.equal(matchRoute(routes, "POST", "/sash/service/install").kind, "notFound");
});

it("coalesces service discovery and projects only public status without touching native services", async () => {
  let calls = 0;
  type Observation = PublicServiceStatus & { root: string; secret: string };
  let resolve: ((value: Observation) => void) | undefined;
  const pending = new Promise<Observation>((done) => {
    resolve = done;
  });
  const ctx = { layout: sashLayout(path.join(os.tmpdir(), "sash-service-handler-no-io")) };
  const handler = createServiceStatusHandler(async (layout) => {
    calls++;
    assert.equal(layout, ctx.layout);
    return pending;
  });
  const first = handler(ctx);
  const second = handler(ctx);
  assert.equal(first, second);
  assert(resolve);
  resolve({
    supported: true,
    state: "ready",
    version: "0.1.0",
    coreVersion: "v1.19.30",
    root: "private enrollment",
    secret: "private controller secret",
  });
  assert.deepEqual(await first, {
    status: 200,
    json: { supported: true, state: "ready", version: "0.1.0", coreVersion: "v1.19.30" },
  });
  await handler(ctx);
  assert.equal(calls, 1);
  await handler({ layout: ctx.layout });
  assert.equal(calls, 2, "a new daemon context must not adopt the old observation");
});
