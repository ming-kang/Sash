import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRoutes,
  coreApiTarget,
  matchRoute,
  matchWebSocketUpgrade,
  parseDaemonRequestTarget,
} from "./router.js";

const HOST = "127.0.0.1:19090";

function target(raw: string) {
  return parseDaemonRequestTarget(raw, HOST);
}

const routes = buildRoutes();

describe("daemon request-target parsing", () => {
  it("canonicalizes dot segments without decoding encoded slash data", () => {
    assert.deepEqual(target("/core/api/a/../proxies/a%2Fb?name=x%2Fy"), {
      pathname: "/core/api/proxies/a%2Fb",
      routePathname: "/core/api/proxies/a%2Fb",
      search: "?name=x%2Fy",
      searchParams: new URLSearchParams("name=x%2Fy"),
    });
    assert.equal(target("/sash/daemon/status///").routePathname, "/sash/daemon/status");
  });

  it("rejects non-origin and cross-authority request-target forms", () => {
    for (const raw of [
      "http://127.0.0.1:19090/sash/daemon/health",
      "//127.0.0.1:19090/sash/daemon/health",
      "?fresh=1",
      "127.0.0.1:19090",
      "*",
      "/\\attacker.example/sash/daemon/health",
      "/sash/daemon/health#fragment",
    ]) {
      assert.throws(() => target(raw), Error, raw);
    }
  });
});

describe("daemon HTTP route matching", () => {
  function matchedAuth(method: string, raw: string): string {
    const match = matchRoute(routes, method, target(raw).routePathname);
    assert.equal(match.kind, "matched", `${method} ${raw}`);
    return match.kind === "matched" ? match.route.auth : "";
  }

  it("matches every namespaced route with its auth class", () => {
    const cases: Array<[string, string, string]> = [
      ["GET", "/sash/daemon/health", "public"],
      ["GET", "/sash/daemon/status", "public"],
      ["POST", "/sash/daemon/shutdown", "control"],
      ["POST", "/sash/core/start", "control"],
      ["POST", "/sash/core/stop", "control"],
      ["POST", "/sash/core/restart", "control"],
      ["POST", "/sash/core/reload", "control"],
      ["GET", "/sash/proxy", "public"],
      ["GET", "/sash/settings", "public"],
      ["PATCH", "/sash/settings", "control"],
      ["GET", "/sash/settings/file", "control"],
      ["PUT", "/sash/settings/file", "control"],
      ["GET", "/sash/profiles", "public"],
      ["POST", "/sash/profiles", "public"],
      ["POST", "/sash/profiles/import", "control"],
      ["POST", "/sash/profiles/update-all", "control"],
      ["PUT", "/sash/profiles/active", "control"],
      ["POST", "/sash/profiles/123/update", "control"],
      ["GET", "/sash/profiles/123/content", "control"],
      ["PUT", "/sash/profiles/123/content", "control"],
      ["PATCH", "/sash/profiles/123", "control"],
      ["DELETE", "/sash/profiles/123", "control"],
    ];
    for (const [method, raw, auth] of cases) {
      assert.equal(matchedAuth(method, raw), auth, `${method} ${raw}`);
    }
  });

  it("rejects deleted aliases and lookalike paths", () => {
    for (const raw of [
      "/health",
      "/status",
      "/proxy",
      "/sash/health",
      "/sash/status",
      "/sash/shutdown",
      "/sash/maintenance/shutdown",
      "/sash/proxy/enable",
      "/sash/proxy/disable",
      "/core/start",
      "/core/stop",
      "/core/restart",
      "/core/config/reload",
      "/config/reload",
      "/settings",
      "/sash/profilesX",
      "/sash/profiles/not-a-number",
      "/sash/profiles/import/x",
      "/uiX",
    ]) {
      assert.equal(matchRoute(routes, "GET", target(raw).routePathname).kind, "notFound", raw);
    }
    // Non-numeric ids never reach the profile handlers.
    assert.equal(
      matchRoute(routes, "DELETE", target("/sash/profiles/import").routePathname).kind,
      "methodNotAllowed",
    );
  });

  it("exposes route params from the matched pattern", () => {
    const match = matchRoute(routes, "GET", "/sash/profiles/42/content");
    assert.equal(match.kind, "matched");
    if (match.kind === "matched") assert.equal(match.params.id, "42");
  });

  it("returns deterministic Allow metadata for method mismatches", () => {
    assert.deepEqual(matchRoute(routes, "POST", "/sash/settings"), {
      kind: "methodNotAllowed",
      allow: ["GET", "PATCH"],
    });
    assert.deepEqual(matchRoute(routes, "GET", "/sash/core/start"), {
      kind: "methodNotAllowed",
      allow: ["POST"],
    });
    assert.deepEqual(matchRoute(routes, "POST", "/"), {
      kind: "methodNotAllowed",
      allow: ["GET", "HEAD"],
    });
    assert.deepEqual(matchRoute(routes, "POST", "/sash/daemon/health"), {
      kind: "methodNotAllowed",
      allow: ["GET"],
    });
  });

  it("matches the Core gateway on the bare prefix and nested paths", () => {
    for (const raw of ["/core/api", "/core/api/", "/core/api/proxies", "/core/api/logs"]) {
      const match = matchRoute(routes, "GET", target(raw).routePathname);
      assert.equal(match.kind, "matched", raw);
      if (match.kind === "matched") assert.equal(match.route.auth, "gateway", raw);
    }
    assert.equal(matchRoute(routes, "GET", "/core/apiX").kind, "notFound");
    assert.equal(matchRoute(routes, "DELETE", "/connections/123").kind, "notFound");
    assert.equal(matchRoute(routes, "GET", "/version").kind, "notFound");
  });

  it("builds one canonical Core target with a query exactly once", () => {
    assert.equal(coreApiTarget(target("/core/api?x=1")), "/?x=1");
    assert.equal(coreApiTarget(target("/core/api///?x=1")), "/?x=1");
    assert.equal(coreApiTarget(target("/core/api/a/../version?x=1")), "/version?x=1");
    assert.equal(coreApiTarget(target("/core/api/proxies/a%2Fb?x=%2F")), "/proxies/a%2Fb?x=%2F");
  });
});

describe("daemon WebSocket route matching", () => {
  it("matches only gateway rows and derives the canonical Core target", () => {
    assert.deepEqual(matchWebSocketUpgrade(routes, "GET", target("/core/api/logs?level=info")), {
      kind: "gateway",
      target: "/logs?level=info",
    });
    assert.equal(matchWebSocketUpgrade(routes, "GET", target("/core/api/traffic")).kind, "gateway");
    assert.equal(matchWebSocketUpgrade(routes, "GET", target("/traffic")).kind, "notFound");
    assert.equal(matchWebSocketUpgrade(routes, "GET", target("/logs")).kind, "notFound");
    assert.equal(matchWebSocketUpgrade(routes, "GET", target("/core/apiX/logs")).kind, "notFound");
    assert.equal(
      matchWebSocketUpgrade(routes, "GET", target("/sash/daemon/status")).kind,
      "notFound",
    );
  });

  it("allows only GET on recognized WebSocket routes", () => {
    assert.deepEqual(matchWebSocketUpgrade(routes, "POST", target("/core/api/logs")), {
      kind: "methodNotAllowed",
      allow: ["GET"],
    });
    assert.deepEqual(matchWebSocketUpgrade(routes, "POST", target("/unknown")), {
      kind: "notFound",
    });
  });
});
