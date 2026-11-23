import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { DaemonStatus, HealthInfo } from "./contracts.js";
import { useDaemonTestHarness } from "./testing/daemon-harness.js";

function statusCode(raw: string): number {
  return Number(/^HTTP\/1\.1 (\d{3}) /.exec(raw)?.[1]);
}

describe("daemon browser authorization", () => {
  const h = useDaemonTestHarness();

  it("never accepts missing headers or the public identity as control authorization", async () => {
    await h.startServer();
    const health = (await h.apiRequest("/sash/daemon/health", { token: "" })).data as HealthInfo;
    for (const [method, pathname] of [
      ["POST", "/sash/profiles"],
      ["POST", "/sash/profiles/import"],
      ["PATCH", "/sash/settings"],
      ["POST", "/sash/core/start"],
      ["POST", "/sash/daemon/shutdown"],
      ["GET", "/sash/autostart"],
      ["GET", "/sash/settings"],
      ["GET", "/sash/profiles"],
      ["GET", "/sash/events"],
      ["GET", "/sash/daemon/status?fresh=1"],
      ["GET", "/sash/proxy?fresh=1"],
      ["GET", "/core/api/version"],
    ]) {
      assert.ok(method && pathname);
      for (const token of ["", health.bootId]) {
        const result = await h.apiRequest(pathname, { method, body: {}, token });
        assert.equal(result.statusCode, 401, `${method} ${pathname}`);
      }
    }
    assert.match(await h.rawWebSocketUpgrade("/core/api/logs"), /^HTTP\/1\.1 401 /);
  });

  it("admits a page on its own origin without any credential", async () => {
    await h.startServer();
    for (const endpoint of ["/sash/settings", "/sash/profiles", "/sash/autostart"]) {
      assert.equal((await h.apiRequest(endpoint, { browser: true })).statusCode, 200, endpoint);
    }
    const patched = await h.apiRequest("/sash/settings", {
      method: "PATCH",
      browser: true,
      body: { allowLan: true },
    });
    assert.equal(patched.statusCode, 200);
    const viaLocalhost = await h.rawHttpRequest("/sash/settings", {
      headers: { Host: `localhost:${h.boundPort}`, Origin: `http://localhost:${h.boundPort}` },
    });
    assert.equal(statusCode(viaLocalhost), 200, "localhost serves its own origin too");
  });

  it("refuses pages on other origins, including other loopback ports", async () => {
    await h.startServer();
    for (const origin of [
      `http://127.0.0.1:${h.boundPort + 1}`,
      `http://localhost:${h.boundPort}`,
      `https://127.0.0.1:${h.boundPort}`,
    ]) {
      const result = await h.apiRequest("/sash/settings", {
        method: "PATCH",
        token: "",
        origin,
        body: { allowLan: true },
      });
      assert.equal(result.statusCode, 401, origin);
      assert.match(
        await h.rawWebSocketUpgrade("/core/api/logs", { Origin: origin }),
        /^HTTP\/1\.1 401 /,
        origin,
      );
    }
    for (const site of ["same-site", "cross-site", "none"]) {
      const raw = await h.rawHttpRequest("/sash/settings", { headers: { "Sec-Fetch-Site": site } });
      assert.equal(statusCode(raw), 401, site);
    }
    const sandboxed = await h.apiRequest("/sash/core/start", {
      method: "POST",
      token: "",
      origin: "null",
    });
    assert.equal(sandboxed.statusCode, 403, "file:// and sandboxed pages carry an opaque Origin");
  });

  it("keeps subscription credentials private while CLI and dashboard reads remain authorized", async () => {
    const url = "https://example.test/subscription?token=private-query";
    await h.startServer({
      fetchProfile: async () => ({ yamlText: "proxies: []\n" }),
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
    const redacted = publicStatus.data as DaemonStatus;
    assert.equal(redacted.activeProfile?.url, "");
    assert.equal(redacted.configuration.appliedProfile?.url, "");
    for (const credentials of [{ token: h.settings.daemonSecret }, { browser: true }]) {
      for (const endpoint of ["/sash/settings", "/sash/profiles"]) {
        assert.equal((await h.apiRequest(endpoint, credentials)).statusCode, 200);
      }
      const status = (await h.apiRequest("/sash/daemon/status", credentials)).data as DaemonStatus;
      assert.equal(status.activeProfile?.url, url);
      assert.equal(status.configuration.appliedProfile?.url, url);
    }
  });
});
