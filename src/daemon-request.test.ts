import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { useDaemonTestHarness } from "./testing/daemon-harness.js";

describe("daemon server", () => {
  const h = useDaemonTestHarness();

  describe("request target and method boundary", () => {
    it("rejects an unsupported request-target form and keeps serving", async () => {
      // Every rejected form is covered by the router unit test.
      await h.startServer();
      assert.match(await h.rawHttpRequest("http://"), /^HTTP\/1\.1 400 /);

      const health = await h.apiRequest("/sash/daemon/health", { token: "" });
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

      const health = await h.apiRequest("/sash/daemon/health", { token: "" });
      assert.equal(health.statusCode, 200);
    });

    it("preserves root queries in the dashboard redirect", async () => {
      await h.startServer();

      const redirect = await h.rawHttpRequest("/?tab=proxies");
      assert.match(redirect, /^HTTP\/1\.1 302 /);
      assert.match(redirect, /\r\nLocation: \/ui\/\?tab=proxies\r\n/i);
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
        const message = (response.data as { error: { message: string } }).error.message;
        assert.doesNotMatch(message, /TypeError|Cannot read/i, rawBody);
      }

      const health = await h.apiRequest("/sash/daemon/health", { token: "" });
      assert.equal(health.statusCode, 200);
    });

    it("returns 413 for an oversized JSON object and keeps serving", async () => {
      await h.startServer();
      const response = await h.apiRequest("/sash/settings", {
        method: "PATCH",
        body: { key: "tun", padding: "x".repeat(1024 * 1024) },
      });
      assert.equal(response.statusCode, 413);
      assert.match(
        (response.data as { error: { message: string } }).error.message,
        /Request body too large/,
      );

      const health = await h.apiRequest("/sash/daemon/health", { token: "" });
      assert.equal(health.statusCode, 200);
    });
  });

  describe("authentication and namespaces", () => {
    it("allows unauthenticated GET /sash/health returning token and pid", async () => {
      await h.startServer();
      const res = await h.apiRequest("/sash/daemon/health", { token: "" });
      assert.equal(res.statusCode, 200);
      const data = res.data as { token: string; pid: number };
      assert.equal(typeof data.token, "string");
      assert.equal(data.pid, process.pid);
    });

    it("allows public status reads without exposing control secrets", async () => {
      await h.startServer();
      const res = await h.apiRequest("/sash/daemon/status", { token: "" });
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

    it("rejects unauthenticated mutations and accepts a minted WebUI session token", async () => {
      const inst = await h.startServer();
      const denied = await h.apiRequest("/sash/core/start", { method: "POST", token: "" });
      assert.equal(denied.statusCode, 401);

      // The public per-boot health token is an identity nonce, not a credential.
      const bootTokenDenied = await h.apiRequest("/sash/settings", {
        method: "PATCH",
        token: "",
        webToken: inst.token,
        body: { systemProxy: false },
      });
      assert.equal(bootTokenDenied.statusCode, 401);

      const allowed = await h.apiRequest("/sash/settings", {
        method: "PATCH",
        token: "",
        webToken: await h.mintWebSession(),
        body: { systemProxy: false },
      });
      assert.equal(allowed.statusCode, 200);
    });

    it("rejects browser mutations from non-loopback Origins", async () => {
      await h.startServer();
      const denied = await h.apiRequest("/sash/core/start", {
        method: "POST",
        origin: "https://attacker.example",
      });
      assert.equal(denied.statusCode, 403);
      assert.deepEqual(denied.data, {
        error: { code: "unauthorized", message: "Invalid Origin header" },
      });
    });
  });
});
