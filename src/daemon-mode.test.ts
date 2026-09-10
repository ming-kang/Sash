import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { describe, it } from "node:test";
import { useDaemonTestHarness } from "./testing/daemon-harness.js";
import { deferred } from "./testing/state.js";

describe("runtime routing mode", () => {
  const h = useDaemonTestHarness();
  for (const stop of [false, true]) {
    it(`does not hold the mutation queue during a controller request (stop=${stop})`, async () => {
      const entered = deferred();
      const release = deferred();
      let body = "";
      h.mockCoreServer = http.createServer((req, res) => {
        assert.equal(req.method, "PATCH");
        assert.equal(req.url, "/configs");
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
          body += chunk;
        });
        req.on("end", () => {
          entered.resolve();
          void release.promise.then(() => {
            res.writeHead(204);
            res.end();
          });
        });
      });
      await new Promise<void>((resolve) => h.mockCoreServer?.listen(0, "127.0.0.1", resolve));
      const address = h.mockCoreServer.address();
      assert.ok(address && typeof address === "object");
      h.settings.controller = `127.0.0.1:${address.port}`;
      await h.startServer();
      assert.equal((await h.apiRequest("/sash/core/start", { method: "POST" })).statusCode, 200);
      const mode = h.apiRequest("/sash/core/mode", { method: "PUT", body: { mode: "global" } });
      await entered.promise;
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("mode request blocked the mutation queue")),
          2000,
        );
      });
      try {
        const other = await Promise.race([
          stop
            ? h.apiRequest("/sash/core/stop", { method: "POST" })
            : h.apiRequest("/sash/settings", { method: "PATCH", body: { allowLan: true } }),
          deadline,
        ]);
        assert.equal(other.statusCode, stop ? 204 : 200);
        const saved = fs.readFileSync(h.layout.settingsFile, "utf8");
        release.resolve();
        assert.equal((await mode).statusCode, stop ? 409 : 204);
        assert.equal(fs.readFileSync(h.layout.settingsFile, "utf8"), saved);
        assert.deepEqual(JSON.parse(body), { mode: "global" });
      } finally {
        clearTimeout(timer);
        release.resolve();
        await mode;
      }
    });
  }
  it("rejects a mode change when Core ownership is absent", async () => {
    await h.startServer();
    assert.equal(
      (await h.apiRequest("/sash/core/mode", { method: "PUT", body: { mode: "rule" } })).statusCode,
      409,
    );
  });
});
