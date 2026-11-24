import assert from "node:assert/strict";
import { it } from "vitest";
import {
  allowedControllerTarget,
  controllerPatchBody,
  controllerSelectBody,
} from "./controller-policy.js";

it("allows the required reads, monitoring streams, and narrow mutations", () => {
  for (const path of [
    "/version",
    "/configs",
    "/proxies",
    "/group",
    "/rules",
    "/connections",
    "/proxies/a%20b/delay",
    "/group/g/delay",
    "/providers/proxies",
    "/providers/rules",
    "/providers/proxies/p/healthcheck",
    "/providers/proxies/p/n/healthcheck",
  ]) {
    assert.ok(allowedControllerTarget("GET", path), path);
  }
  for (const path of ["/traffic", "/memory", "/logs?level=info", "/connections?interval=1000"]) {
    assert.ok(allowedControllerTarget("GET", path), path);
  }
  for (const path of ["/proxies/g", "/providers/proxies/p", "/providers/rules/r"]) {
    assert.ok(allowedControllerTarget("PUT", path), path);
  }
  assert.ok(allowedControllerTarget("DELETE", "/connections"));
  assert.ok(allowedControllerTarget("DELETE", "/connections/id"));
  assert.ok(allowedControllerTarget("DELETE", "/proxies/g"));
  assert.ok(allowedControllerTarget("POST", "/cache/dns/flush"));
  assert.ok(allowedControllerTarget("GET", "/dns/query?name=example.com&type=A"));
  assert.ok(allowedControllerTarget("PUT", "/storage/dashboard"));
  assert.equal(allowedControllerTarget("PATCH", "/configs/")?.action, "patch");
  assert.equal(allowedControllerTarget("POST", "/restart/")?.action, "restart");
  assert.equal(allowedControllerTarget("GET", "/logs?token=test")?.path, "/logs");
});

it("denies privilege-sensitive routes, ambiguous paths, and path parameters", () => {
  for (const [method, path] of [
    ["PUT", "/configs"],
    ["PUT", "/%63onfigs/"],
    ["POST", "/configs/geo"],
    ["POST", "/upgrade"],
    ["GET", "/upgrade/ui"],
    ["POST", "/restart/extra"],
    ["GET", "/debug"],
    ["GET", "/%64ebug/pprof/"],
    ["GET", "/storage/data?targetPath=%2Fetc%2Fconfig"],
    ["PUT", "/proxies/%2f..%2fconfigs"],
    ["PUT", "/proxies/%252f..%252fconfigs"],
    ["PUT", "/proxies/%2e%2e"],
    ["GET", "//version"],
    ["GET", "/group/g/delay?url=file%3A%2F%2F%2Fetc%2Fconfig"],
  ] as const) {
    assert.equal(allowedControllerTarget(method, path), undefined, `${method} ${path}`);
  }
  assert.equal(controllerSelectBody('{"name":"Sash"}'), '{"name":"Sash"}');
  for (const body of ['{"name":1}', '{"name":"Sash","path":"config.yaml"}', "[]", "{}"])
    assert.throws(() => controllerSelectBody(body));
});

it("accepts only validated runtime options in PATCH /configs", () => {
  assert.deepEqual(
    JSON.parse(controllerPatchBody('{"mode":"global","ipv6":true,"tun":{"enable":true}}')),
    {
      mode: "global",
      ipv6: true,
      tun: { enable: true },
    },
  );
  for (const body of [
    '{"mode":"unknown"}',
    '{"external-ui":"anything"}',
    '{"geoxurl":{"geoip":"/tmp/db"}}',
    '{"tuic-server":{"certificate":"/tmp/cert"}}',
    '{"tun":{"enable":false}}',
    '{"tun":{"enable":true,"file-descriptor":10}}',
    '{"tun":{"enable":true,"device":"tun2"}}',
  ])
    assert.throws(() => controllerPatchBody(body));
});
