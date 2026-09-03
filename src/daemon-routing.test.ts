import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchHttpRoute, matchWebSocketRoute, parseDaemonRequestTarget } from "./daemon-routing.js";

const HOST = "127.0.0.1:19090";

function target(raw: string) {
  return parseDaemonRequestTarget(raw, HOST);
}

describe("daemon request-target parsing", () => {
  it("canonicalizes dot segments without decoding encoded slash data", () => {
    assert.deepEqual(target("/core/api/a/../proxies/a%2Fb?name=x%2Fy"), {
      pathname: "/core/api/proxies/a%2Fb",
      routePathname: "/core/api/proxies/a%2Fb",
      search: "?name=x%2Fy",
      searchParams: new URLSearchParams("name=x%2Fy"),
    });
    assert.equal(target("/sash/status///").routePathname, "/sash/status");
  });

  it("rejects non-origin and cross-authority request-target forms", () => {
    for (const raw of [
      "http://127.0.0.1:19090/sash/health",
      "//127.0.0.1:19090/sash/health",
      "?fresh=1",
      "127.0.0.1:19090",
      "*",
      "/\\attacker.example/sash/health",
      "/sash/health#fragment",
    ]) {
      assert.throws(() => target(raw), Error, raw);
    }
  });
});

describe("daemon HTTP route matching", () => {
  it("matches every explicit fixed alias", () => {
    const cases: Array<[string, string, string]> = [
      ["GET", "/sash/health", "health"],
      ["GET", "/health", "health"],
      ["GET", "/sash/status", "status"],
      ["GET", "/status", "status"],
      ["GET", "/sash/proxy", "proxyStatus"],
      ["GET", "/proxy", "proxyStatus"],
      ["POST", "/sash/proxy/enable", "proxyEnable"],
      ["POST", "/proxy/enable", "proxyEnable"],
      ["POST", "/sash/proxy/disable", "proxyDisable"],
      ["POST", "/proxy/disable", "proxyDisable"],
      ["GET", "/sash/settings", "settingsRead"],
      ["PATCH", "/sash/settings", "settingsUpdate"],
      ["PATCH", "/settings", "settingsUpdate"],
      ["POST", "/sash/maintenance/shutdown", "maintenanceShutdown"],
      ["POST", "/sash/shutdown", "shutdown"],
      ["POST", "/shutdown", "shutdown"],
      ["POST", "/core/start", "coreStart"],
      ["POST", "/core/stop", "coreStop"],
      ["POST", "/core/restart", "coreRestart"],
      ["POST", "/core/config/reload", "coreConfigReload"],
      ["POST", "/config/reload", "coreConfigReload"],
    ];
    for (const [method, raw, kind] of cases) {
      assert.equal(matchHttpRoute(method, target(raw)).kind, kind, `${method} ${raw}`);
    }
  });

  it("matches dynamic profile routes without accepting lookalikes", () => {
    const cases: Array<[string, string]> = [
      ["GET", "/sash/profiles"],
      ["POST", "/sash/profiles"],
      ["POST", "/sash/profiles/import"],
      ["PUT", "/sash/profiles/active"],
      ["POST", "/sash/profiles/update-all"],
      ["POST", "/sash/profiles/123/update"],
      ["GET", "/sash/profiles/123/content"],
      ["PUT", "/sash/profiles/123/content"],
      ["DELETE", "/sash/profiles/123"],
    ];
    for (const [method, raw] of cases) {
      assert.equal(matchHttpRoute(method, target(raw)).kind, "profiles", `${method} ${raw}`);
    }
    for (const raw of ["/sash/profilesX", "/sash/profiles/not-a-number", "/profiles"]) {
      assert.equal(matchHttpRoute("GET", target(raw)).kind, "notFound", raw);
    }
  });

  it("returns deterministic Allow metadata for method mismatches", () => {
    assert.deepEqual(matchHttpRoute("POST", target("/sash/settings")), {
      kind: "methodNotAllowed",
      allow: ["GET", "PATCH"],
    });
    assert.deepEqual(matchHttpRoute("GET", target("/settings")), {
      kind: "methodNotAllowed",
      allow: ["PATCH"],
    });
    assert.deepEqual(matchHttpRoute("GET", target("/core/start")), {
      kind: "methodNotAllowed",
      allow: ["POST"],
    });
    assert.deepEqual(matchHttpRoute("POST", target("/")), {
      kind: "methodNotAllowed",
      allow: ["GET", "HEAD"],
    });
  });

  it("distinguishes root, UI redirect, static UI, and lookalike paths", () => {
    assert.equal(matchHttpRoute("GET", target("/?tab=general")).kind, "rootRedirect");
    assert.equal(matchHttpRoute("HEAD", target("/ui?tab=general")).kind, "uiRedirect");
    assert.equal(matchHttpRoute("GET", target("/ui/")).kind, "staticUi");
    assert.equal(matchHttpRoute("GET", target("/ui/profiles/")).kind, "staticUi");
    assert.equal(matchHttpRoute("GET", target("/uiX")).kind, "notFound");
  });

  it("builds one canonical Core target with a query exactly once", () => {
    assert.deepEqual(matchHttpRoute("GET", target("/core/api?x=1")), {
      kind: "coreGateway",
      target: "/?x=1",
    });
    assert.deepEqual(matchHttpRoute("GET", target("/core/api///?x=1")), {
      kind: "coreGateway",
      target: "/?x=1",
    });
    assert.deepEqual(matchHttpRoute("GET", target("/core/api/a/../version?x=1")), {
      kind: "coreGateway",
      target: "/version?x=1",
    });
    assert.deepEqual(matchHttpRoute("GET", target("/core/api/proxies/a%2Fb?x=%2F")), {
      kind: "coreGateway",
      target: "/proxies/a%2Fb?x=%2F",
    });
    assert.deepEqual(matchHttpRoute("DELETE", target("/connections/123?force=1")), {
      kind: "coreGateway",
      target: "/connections/123?force=1",
    });
  });

  it("does not let encoded dot segments or lookalikes split auth and forwarding", () => {
    assert.equal(matchHttpRoute("GET", target("/core/api/%2e%2e/version")).kind, "notFound");
    for (const raw of ["/core/apiX", "/versions", "/proxiesX", "/proxy"]) {
      assert.notEqual(matchHttpRoute("GET", target(raw)).kind, "coreGateway", raw);
    }
  });
});

describe("daemon WebSocket route matching", () => {
  it("shares canonical Core targets but keeps the smaller stream allowlist", () => {
    assert.deepEqual(matchWebSocketRoute("GET", target("/core/api/logs?level=info")), {
      kind: "coreGateway",
      target: "/logs?level=info",
    });
    assert.deepEqual(matchWebSocketRoute("GET", target("/traffic?interval=1000")), {
      kind: "coreGateway",
      target: "/traffic?interval=1000",
    });
    assert.equal(matchWebSocketRoute("GET", target("/logs")).kind, "coreGateway");
    assert.equal(matchWebSocketRoute("GET", target("/connections")).kind, "notFound");
    assert.equal(matchWebSocketRoute("GET", target("/core/apiX/logs")).kind, "notFound");
  });

  it("allows only GET on recognized WebSocket routes", () => {
    assert.deepEqual(matchWebSocketRoute("POST", target("/core/api/logs")), {
      kind: "methodNotAllowed",
      allow: ["GET"],
    });
    assert.deepEqual(matchWebSocketRoute("POST", target("/unknown")), { kind: "notFound" });
  });
});
