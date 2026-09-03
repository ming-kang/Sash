import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { useDaemonTestHarness } from "./daemon-test-harness.test.js";

describe("daemon server", () => {
  const h = useDaemonTestHarness();

  describe("request target and method boundary", () => {
    it("rejects unsupported HTTP request-target forms and keeps serving", async () => {
      await h.startServer();

      for (const target of [
        "http://",
        `http://127.0.0.1:${h.boundPort}/sash/health`,
        `//127.0.0.1:${h.boundPort}/sash/health`,
        "?fresh=1",
        "*",
      ]) {
        const response = await h.rawHttpRequest(target);
        assert.match(response, /^HTTP\/1\.1 400 /, target);
      }

      const health = await h.apiRequest("/sash/health", { token: "" });
      assert.equal(health.statusCode, 200);
    });

    it("rejects unsupported WebSocket targets and non-GET upgrades", async () => {
      await h.startServer();
      const authorization = { Authorization: `Bearer ${h.settings.daemonSecret}` };

      for (const target of [
        "http://",
        `http://127.0.0.1:${h.boundPort}/core/api/logs`,
        `//127.0.0.1:${h.boundPort}/core/api/logs`,
      ]) {
        const response = await h.rawWebSocketUpgrade(target, authorization);
        assert.match(response, /^HTTP\/1\.1 400 /, target);
        assert.match(response, /Invalid request target/, target);
      }

      const wrongMethod = await h.rawWebSocketUpgrade("/core/api/logs", authorization, "POST");
      assert.match(wrongMethod, /^HTTP\/1\.1 405 Method Not Allowed/);
      assert.match(wrongMethod, /\r\nAllow: GET\r\n/i);

      const health = await h.apiRequest("/sash/health", { token: "" });
      assert.equal(health.statusCode, 200);
    });

    it("preserves root queries and reports method mismatches with Allow", async () => {
      await h.startServer();

      const redirect = await h.rawHttpRequest("/?tab=proxies");
      assert.match(redirect, /^HTTP\/1\.1 302 /);
      assert.match(redirect, /\r\nLocation: \/ui\/\?tab=proxies\r\n/i);

      const rootPost = await h.rawHttpRequest("/", {
        method: "POST",
        headers: { Authorization: `Bearer ${h.settings.daemonSecret}` },
      });
      assert.match(rootPost, /^HTTP\/1\.1 405 Method Not Allowed/);
      assert.match(rootPost, /\r\nAllow: GET, HEAD\r\n/i);

      const coreStartGet = await h.rawHttpRequest("/core/start");
      assert.match(coreStartGet, /^HTTP\/1\.1 405 Method Not Allowed/);
      assert.match(coreStartGet, /\r\nAllow: POST\r\n/i);
    });
  });

  describe("JSON request contracts", () => {
    it("returns 400 for malformed and non-object JSON without leaking TypeErrors", async () => {
      await h.startServer();

      for (const rawBody of ["{", "null", "[]", '"value"']) {
        const response = await h.apiRequest("/sash/settings", {
          method: "PATCH",
          rawBody,
        });
        assert.equal(response.statusCode, 400, rawBody);
        const message = (response.data as { error: string }).error;
        assert.doesNotMatch(message, /TypeError|Cannot read/i, rawBody);
      }

      const health = await h.apiRequest("/sash/health", { token: "" });
      assert.equal(health.statusCode, 200);
    });

    it("returns 413 for an oversized JSON object and keeps serving", async () => {
      await h.startServer();
      const response = await h.apiRequest("/sash/settings", {
        method: "PATCH",
        body: { key: "tun", padding: "x".repeat(1024 * 1024) },
      });
      assert.equal(response.statusCode, 413);
      assert.match((response.data as { error: string }).error, /Request body too large/);

      const health = await h.apiRequest("/sash/health", { token: "" });
      assert.equal(health.statusCode, 200);
    });
  });

  describe("authentication and namespaces", () => {
    it("allows unauthenticated GET /sash/health returning token and pid", async () => {
      await h.startServer();
      const res = await h.apiRequest("/sash/health", { token: "" });
      assert.equal(res.statusCode, 200);
      const data = res.data as { ok: boolean; token: string; pid: number };
      assert.equal(data.ok, true);
      assert.equal(typeof data.token, "string");
      assert.equal(data.pid, process.pid);
    });

    it("allows public status reads without exposing control secrets", async () => {
      await h.startServer();
      const res = await h.apiRequest("/sash/status", { token: "" });
      assert.equal(res.statusCode, 200);
      const data = res.data as {
        daemon: { pid: number };
        settings: Record<string, unknown>;
        systemProxy: { appliedKnown: boolean; stateKnown: boolean };
      };
      assert.equal(data.daemon.pid, process.pid);
      assert.equal(data.systemProxy.appliedKnown, true);
      assert.equal(data.systemProxy.stateKnown, true);
      assert.equal("secret" in data.settings, false);
      assert.equal("daemonSecret" in data.settings, false);
    });

    it("rejects unauthenticated mutations and accepts the per-boot WebUI token", async () => {
      const inst = await h.startServer();
      const denied = await h.apiRequest("/core/start", { method: "POST", token: "" });
      assert.equal(denied.statusCode, 401);

      const allowed = await h.apiRequest("/sash/proxy/disable", {
        method: "POST",
        token: "",
        webToken: inst.token,
      });
      assert.equal(allowed.statusCode, 200);
    });

    it("rejects browser mutations from non-loopback Origins", async () => {
      await h.startServer();
      const denied = await h.apiRequest("/core/start", {
        method: "POST",
        origin: "https://attacker.example",
      });
      assert.equal(denied.statusCode, 403);
      assert.deepEqual(denied.data, { error: "Invalid Origin header" });
    });
  });
});
