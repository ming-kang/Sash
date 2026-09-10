import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseDaemonStatus,
  parseHealthInfo,
  parseWebBootstrapInfo,
  parseWebSessionInfo,
} from "./contracts.js";
import { useDaemonTestHarness } from "./testing/daemon-harness.js";

describe("daemon browser authorization", () => {
  const h = useDaemonTestHarness();

  it("never accepts the public identity as an HTTP or WebSocket credential", async () => {
    await h.startServer();
    const health = parseHealthInfo((await h.apiRequest("/sash/daemon/health", { token: "" })).data);
    for (const [method, pathname] of [
      ["POST", "/sash/profiles"],
      ["POST", "/sash/profiles/import"],
      ["PATCH", "/sash/settings"],
      ["POST", "/sash/core/start"],
      ["POST", "/sash/daemon/shutdown"],
      ["POST", "/sash/web/bootstrap"],
      ["GET", "/sash/autostart"],
      ["GET", "/sash/settings"],
      ["GET", "/sash/profiles"],
      ["GET", "/sash/daemon/status?fresh=1"],
      ["GET", "/sash/proxy?fresh=1"],
      ["GET", "/core/api/version"],
    ]) {
      assert.ok(method && pathname);
      for (const credentials of [
        { token: "" },
        { token: health.token },
        { webToken: health.token },
      ]) {
        const result = await h.apiRequest(pathname, { method, body: {}, ...credentials });
        assert.equal(result.statusCode, 401, `${method} ${pathname}`);
      }
    }
    const upgrade = await h.rawWebSocketUpgrade("/core/api/logs", {
      "Sec-WebSocket-Protocol": `sash, sash-token.${health.token}`,
    });
    assert.match(upgrade, /^HTTP\/1\.1 401 /);
  });

  it("keeps subscription credentials private while CLI and browser reads remain authorized", async () => {
    const url = "https://example.test/subscription?token=private-query";
    await h.startServer({
      fetchProfile: async () => ({ doc: { proxies: [] }, yamlText: "proxies: []\n" }),
    });
    assert.equal(
      (await h.apiRequest("/sash/profiles", { method: "POST", body: { url, activate: true } }))
        .statusCode,
      200,
    );
    assert.equal((await h.apiRequest("/sash/core/start", { method: "POST" })).statusCode, 200);
    const publicStatus = await h.apiRequest("/sash/daemon/status", { token: "" });
    assert.equal(publicStatus.statusCode, 200);
    assert.ok(!JSON.stringify(publicStatus.data).includes("private-query"));
    const redacted = parseDaemonStatus(publicStatus.data);
    assert.equal(redacted.activeProfile?.url, "");
    assert.equal(redacted.configuration.appliedProfile?.url, "");
    const session = await h.mintWebSession();
    for (const credentials of [{ token: h.settings.daemonSecret }, { webToken: session }]) {
      for (const endpoint of ["/sash/settings", "/sash/profiles"]) {
        assert.equal((await h.apiRequest(endpoint, credentials)).statusCode, 200);
      }
      const status = parseDaemonStatus(
        (await h.apiRequest("/sash/daemon/status", credentials)).data,
      );
      assert.equal(status.activeProfile?.url, url);
      assert.equal(status.configuration.appliedProfile?.url, url);
    }
  });

  it("issues non-cacheable credentials and redeems each bootstrap once under concurrency", async () => {
    const instance = await h.startServer();
    const raw = await h.rawHttpRequest("/sash/web/bootstrap", {
      method: "POST",
      headers: { Authorization: `Bearer ${h.settings.daemonSecret}` },
    });
    assert.match(raw, /\r\nCache-Control: no-store\r\n/i);
    const bootstrap = parseWebBootstrapInfo(JSON.parse(raw.split("\r\n\r\n")[1] ?? ""));
    assert.notEqual(bootstrap.token, instance.token);
    const responses = await Promise.all(
      [0, 1].map(() =>
        h.apiRequest("/sash/web/session", {
          method: "POST",
          token: "",
          body: { token: bootstrap.token },
        }),
      ),
    );
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 401]);
    const success = responses.find((response) => response.statusCode === 200);
    assert.ok(success);
    const session = parseWebSessionInfo(success.data);
    assert.equal(session.daemonToken, instance.token);
    assert.notEqual(session.token, bootstrap.token);
    assert.equal(
      (await h.apiRequest("/sash/autostart", { webToken: session.token })).statusCode,
      200,
    );
    assert.equal(
      (await h.apiRequest("/sash/autostart", { webToken: bootstrap.token })).statusCode,
      401,
    );
  });

  it("rejects malformed exchanges and cross-origin redemption without consuming the bootstrap", async () => {
    await h.startServer();
    for (const body of [{}, { token: "" }, { token: 1 }, { token: "unknown" }]) {
      assert.equal(
        (await h.apiRequest("/sash/web/session", { method: "POST", token: "", body })).statusCode,
        401,
      );
    }
    assert.equal(
      (await h.apiRequest("/sash/web/session", { method: "POST", token: "", rawBody: "null" }))
        .statusCode,
      400,
    );
    assert.equal(
      (
        await h.apiRequest("/sash/web/session", {
          method: "POST",
          token: "",
          body: { token: "x".repeat(1024) },
        })
      ).statusCode,
      413,
    );
    const bootstrap = parseWebBootstrapInfo(
      (await h.apiRequest("/sash/web/bootstrap", { method: "POST" })).data,
    );
    assert.equal(
      (
        await h.apiRequest("/sash/web/session", {
          method: "POST",
          token: "",
          body: bootstrap,
          origin: "https://example.com",
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await h.apiRequest("/sash/web/session", { method: "POST", token: "", body: bootstrap }))
        .statusCode,
      200,
    );
  });

  it("invalidates pending grants and browser sessions across daemon restarts", async () => {
    const before = await h.startServer();
    const session = await h.mintWebSession();
    const bootstrap = parseWebBootstrapInfo(
      (await h.apiRequest("/sash/web/bootstrap", { method: "POST" })).data,
    );
    await before.close();
    const after = await h.startServer();
    assert.notEqual(after.token, before.token);
    assert.equal((await h.apiRequest("/sash/autostart", { webToken: session })).statusCode, 401);
    assert.equal(
      (await h.apiRequest("/sash/web/session", { method: "POST", token: "", body: bootstrap }))
        .statusCode,
      401,
    );
    assert.equal(
      (await h.apiRequest("/sash/autostart", { webToken: await h.mintWebSession() })).statusCode,
      200,
    );
  });
});
