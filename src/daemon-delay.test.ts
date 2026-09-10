import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { describe, it } from "node:test";
import { MihomoApi } from "./api.js";
import { CORE_DELAY_TIMEOUT_MS, CORE_DELAY_URL, validateDelayTarget } from "./core-delay.js";
import { createDaemonClient } from "./daemon-client.js";
import { useDaemonTestHarness } from "./testing/daemon-harness.js";
import { deferred, type FakeCoreSupervisor } from "./testing/state.js";

describe("explicit Core delay probes", () => {
  const h = useDaemonTestHarness();

  async function controller(handler: http.RequestListener): Promise<void> {
    h.mockCoreServer = http.createServer(handler);
    await new Promise<void>((resolve) => h.mockCoreServer?.listen(0, "127.0.0.1", resolve));
    const address = h.mockCoreServer.address();
    assert.ok(address && typeof address === "object");
    h.settings.controller = `127.0.0.1:${address.port}`;
  }

  it("authenticates one exact node/group probe and leaves saved state and selection unchanged", async () => {
    const name = "香港 / #?% +组";
    let requests = 0;
    await controller((req, res) => {
      requests += 1;
      const url = new URL(req.url ?? "", "http://127.0.0.1");
      assert.equal(req.method, "GET");
      assert.equal(url.pathname, `/proxies/${encodeURIComponent(name)}/delay`);
      assert.equal(url.searchParams.get("url"), CORE_DELAY_URL);
      assert.equal(url.searchParams.get("timeout"), String(CORE_DELAY_TIMEOUT_MS));
      assert.equal(url.searchParams.get("expected"), "204");
      assert.equal(req.headers.authorization, `Bearer ${h.settings.secret}`);
      res.end(JSON.stringify({ delay: 42 }));
    });
    const instance = await h.startServer();
    await h.apiRequest("/sash/core/start", { method: "POST" });
    const saved = fs.readFileSync(h.layout.settingsFile, "utf8");
    await h.apiRequest("/sash/daemon/status");
    assert.equal(requests, 0, "ordinary status must not probe any outbound");
    const result = await createDaemonClient(h.boundPort, h.settings.daemonSecret).testDelay(name);
    assert.equal(result.name, name);
    assert.equal(result.state, "ok");
    assert.equal(result.delayMs, 42);
    assert.equal(result.error, null);
    assert.equal(new Date(result.testedAt).toISOString(), result.testedAt);
    assert.equal(requests, 1);
    assert.equal(fs.readFileSync(h.layout.settingsFile, "utf8"), saved);
    assert.equal((instance.supervisor as FakeCoreSupervisor).starts, 1);
  });

  it("rejects unauthenticated, invalid and stopped-Core requests before probing", async () => {
    await controller(() => assert.fail("invalid request reached Core"));
    await h.startServer();
    assert.equal(
      (
        await h.apiRequest("/sash/core/delay", {
          method: "POST",
          token: "",
          body: { name: "DIRECT" },
        })
      ).statusCode,
      401,
    );
    for (const body of [
      {},
      { name: " " },
      { name: ".." },
      { name: "DIRECT", url: "http://example.test" },
    ]) {
      assert.equal(
        (await h.apiRequest("/sash/core/delay", { method: "POST", body })).statusCode,
        400,
      );
    }
    assert.equal(
      (
        await h.apiRequest("/sash/core/delay", {
          method: "POST",
          body: { name: "DIRECT" },
        })
      ).statusCode,
      409,
    );
    assert.throws(() => validateDelayTarget("bad\u001bname"));
    assert.throws(() => validateDelayTarget("bad\ud800"));
    assert.equal(validateDelayTarget("节点\u{1f600}"), "节点\u{1f600}");
  });

  it("distinguishes timeout, missing name, failure and malformed measurements without retries or redirects", async () => {
    let response = { code: 504, body: JSON.stringify({ message: "Timeout" }) };
    let requests = 0;
    await controller((_req, res) => {
      requests += 1;
      res.writeHead(response.code, { Location: "/must-not-follow" });
      res.end(response.body);
    });
    const api = new MihomoApi(h.settings.controller, h.settings.secret);
    assert.equal((await api.delay("DIRECT")).state, "timeout");
    response = { code: 404, body: "missing" };
    assert.equal((await api.delay("DIRECT")).state, "not_found");
    response = { code: 503, body: "connection failed" };
    assert.equal((await api.delay("DIRECT")).state, "failed");
    response = { code: 307, body: "redirect" };
    assert.match((await api.delay("DIRECT")).error ?? "", /HTTP 307/);
    response = { code: 403, body: "x".repeat(33 * 1024) };
    assert.match((await api.delay("DIRECT")).error ?? "", /HTTP 403/);
    for (const body of [
      "credential-bearing invalid JSON",
      "null",
      '{"delay":0}',
      '{"delay":-1}',
      '{"delay":"12"}',
    ]) {
      response = { code: 200, body };
      const result = await api.delay("DIRECT");
      assert.equal(result.state, "failed");
      assert.equal(result.delayMs, null);
      assert.doesNotMatch(result.error ?? "", /credential-bearing/);
    }
    assert.equal(requests, 10);
  });

  for (const stop of [false, true]) {
    it(`keeps the mutation queue responsive and rejects stale ownership (stop=${stop})`, {
      timeout: 5000,
    }, async () => {
      const entered = deferred();
      const release = deferred();
      await controller((_req, res) => {
        entered.resolve();
        void release.promise.then(() => res.end('{"delay":12}'));
      });
      await h.startServer();
      await h.apiRequest("/sash/core/start", { method: "POST" });
      const pending = h.apiRequest("/sash/core/delay", {
        method: "POST",
        body: { name: "DIRECT" },
      });
      try {
        await entered.promise;
        const other = await (stop
          ? h.apiRequest("/sash/core/stop", { method: "POST" })
          : h.apiRequest("/sash/settings", { method: "PATCH", body: { allowLan: true } }));
        assert.equal(other.statusCode, stop ? 204 : 200);
      } finally {
        release.resolve();
      }
      assert.equal((await pending).statusCode, stop ? 409 : 200);
    });
  }

  it("cancels the daemon and controller requests when the CLI reader disconnects", {
    timeout: 5000,
  }, async () => {
    const entered = deferred();
    const closed = deferred();
    await controller((_req, res) => {
      res.once("close", () => closed.resolve());
      entered.resolve();
    });
    await h.startServer();
    await h.apiRequest("/sash/core/start", { method: "POST" });
    const cancellation = new AbortController();
    const pending = createDaemonClient(h.boundPort, h.settings.daemonSecret).testDelay(
      "DIRECT",
      cancellation.signal,
    );
    const rejected = assert.rejects(pending, /abort/i);
    await entered.promise;
    cancellation.abort();
    await rejected;
    await closed.promise;
  });
});
