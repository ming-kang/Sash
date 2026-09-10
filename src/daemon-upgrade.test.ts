import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { describe, it } from "node:test";
import { readState } from "./app-state.js";
import { parseDaemonStatus, parseHealthInfo } from "./contracts.js";
import { canonicalPath } from "./installation.js";
import { useDaemonTestHarness } from "./testing/daemon-harness.js";
import { deferred, FakeCoreSupervisor } from "./testing/state.js";
import { type UpgradeAccess, writeUpgradeAuthorization } from "./upgrade-access.js";
import { readUpgradeHandoff, upgradeHandoffPath, writeUpgradeHandoff } from "./upgrade-handoff.js";

describe("daemon self-upgrade handoff", () => {
  const h = useDaemonTestHarness();

  function packageManifest(version: string): string {
    const root = path.join(h.layout.root, "package");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "@astralyn/sash",
        version,
        bin: { sash: "dist/cli.js" },
        engines: { node: ">=24" },
      }),
    );
    return root;
  }

  function authorization(): UpgradeAccess {
    const instance = h.instance;
    assert.ok(instance);
    const access = {
      transactionId: crypto.randomBytes(16).toString("hex"),
      installationId: instance.installationId,
      grant: crypto.randomBytes(32).toString("hex"),
    };
    writeUpgradeAuthorization({
      ...access,
      protocol: 1,
      sourceVersion: instance.version,
      targetVersion: "1.1.0",
      instances: [{ dataDir: canonicalPath(h.layout.root), sourceBootId: instance.token }],
    });
    return access;
  }

  async function stop(access: UpgradeAccess): Promise<void> {
    const instance = h.instance;
    assert.ok(instance);
    const closed = new Promise<void>((resolve) => instance.server.once("close", resolve));
    assert.equal(
      (await h.apiRequest("/sash/upgrade/stop", { method: "POST", body: access })).statusCode,
      204,
    );
    await closed;
    h.instance = undefined;
  }

  async function controller() {
    let mode = "rule";
    const selections = new Map([
      ["__proto__", "DIRECT"],
      ["节点 / west", "DIRECT"],
    ]);
    let beforeSelection: (() => Promise<void>) | undefined;
    await h.startMockCore((req, res) => {
      void (async () => {
        let body = "";
        for await (const chunk of req) body += String(chunk);
        if (req.method === "GET" && req.url === "/configs") res.end(JSON.stringify({ mode }));
        else if (req.method === "PATCH" && req.url === "/configs") {
          mode = (JSON.parse(body) as { mode: string }).mode;
          res.writeHead(204);
          res.end();
        } else if (req.method === "GET" && req.url === "/proxies")
          res.end(
            JSON.stringify({
              proxies: Object.fromEntries(
                [...selections].map(([name, now]) => [name, { type: "Selector", now }]),
              ),
            }),
          );
        else if (req.method === "PUT" && req.url?.startsWith("/proxies/")) {
          await beforeSelection?.();
          selections.set(
            decodeURIComponent(req.url.slice("/proxies/".length)),
            (JSON.parse(body) as { name: string }).name,
          );
          res.writeHead(204);
          res.end();
        } else {
          res.writeHead(404);
          res.end();
        }
      })().catch(() => res.destroy());
    });
    return {
      selections,
      mode: () => mode,
      reset: () => {
        mode = "rule";
        for (const name of selections.keys()) selections.set(name, "DIRECT");
      },
      delaySelection: (callback: () => Promise<void>) => {
        beforeSelection = callback;
      },
    };
  }

  it("restores actual Core state and proxy while preserving unapplied edits, including rollback browser sessions", async () => {
    const remote = await controller();
    h.settings.systemProxy = true;
    const root = packageManifest("1.0.0");
    await h.startServer({ packageRoot: root });
    const imported = await h.apiRequest("/sash/profiles/import", {
      method: "POST",
      body: { name: "original", content: "rules: ['MATCH,DIRECT']\n" },
    });
    assert.equal(imported.statusCode, 200);
    const profileId = (imported.data as { profile: { id: string } }).profile.id;
    assert.equal((await h.apiRequest("/sash/core/start", { method: "POST" })).statusCode, 200);
    assert.equal(
      (await h.apiRequest("/sash/core/mode", { method: "PUT", body: { mode: "global" } }))
        .statusCode,
      204,
    );
    remote.selections.set("__proto__", "REJECT");
    remote.selections.set("节点 / west", "another node");
    const originalYaml = fs.readFileSync(h.layout.configFile, "utf8");
    const oldPort = h.settings.mixedPort;
    assert.equal(
      (await h.apiRequest("/sash/settings", { method: "PATCH", body: { mixedPort: oldPort + 10 } }))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await h.apiRequest(`/sash/profiles/${profileId}/content`, {
          method: "PUT",
          body: { content: "rules: ['MATCH,REJECT']\n", revision: 1 },
        })
      ).statusCode,
      200,
    );
    const saved = fs.readFileSync(h.layout.settingsFile, "utf8");
    const sourceBoot = h.instance?.token;
    assert.ok(sourceBoot);
    const oldSession = await h.mintWebSession();
    const access = authorization();
    assert.equal(
      (await h.apiRequest("/sash/upgrade/reserve", { method: "POST", body: access })).statusCode,
      200,
    );
    assert.equal(
      (await h.apiRequest("/sash/settings", { method: "PATCH", body: { allowLan: true } }))
        .statusCode,
      409,
    );
    const snapshot = readUpgradeHandoff(h.layout, access);
    assert.ok(snapshot?.runtime.configuration);
    const malicious = structuredClone(snapshot);
    assert.ok(malicious.runtime.configuration);
    malicious.runtime.configuration.generated.yaml =
      malicious.runtime.configuration.generated.yaml.replace("enable: false", "enable: true");
    assert.throws(
      () => writeUpgradeHandoff(h.layout, malicious, access),
      /managed configuration constraints/,
    );
    assert.equal(snapshot?.runtime.configuration?.settings.mixedPort, oldPort);
    assert.equal(
      Object.getOwnPropertyDescriptor(snapshot?.runtime.core?.selections ?? {}, "__proto__")?.value,
      "REJECT",
    );
    assert.equal(snapshot?.runtime.systemProxyApplied, true);
    assert.equal(fs.readFileSync(upgradeHandoffPath(h.layout), "utf8").includes(oldSession), false);
    assert.equal(
      fs.readFileSync(upgradeHandoffPath(h.layout), "utf8").includes(access.grant),
      false,
    );
    await stop(access);

    packageManifest("1.1.0");
    remote.reset();
    const target = await h.startServer({ packageRoot: root });
    await target.upgrade.restoreStartup(access);
    assert.equal(remote.mode(), "global");
    assert.equal(remote.selections.get("节点 / west"), "another node");
    assert.equal(fs.readFileSync(h.layout.configFile, "utf8"), originalYaml);
    assert.equal(fs.readFileSync(h.layout.settingsFile, "utf8"), saved);
    const status = parseDaemonStatus((await h.apiRequest("/sash/daemon/status")).data);
    assert.equal(status.configuration.pending, true);
    assert.equal(status.configuration.appliedProfile?.revision, 1);
    assert.equal(status.configuration.appliedSettings?.mixedPort, oldPort);
    assert.equal(status.settings.mixedPort, oldPort + 10);
    assert.equal(status.systemProxy.applied, true);
    assert.equal((await h.apiRequest("/sash/profiles", { webToken: oldSession })).statusCode, 409);
    const health = parseHealthInfo((await h.apiRequest("/sash/daemon/health")).data);
    assert.equal(health.version, "1.1.0");
    assert.deepEqual(health.webContinuation?.bootIds, [sourceBoot]);
    const continued = await h.apiRequest("/sash/web/continue", {
      method: "POST",
      token: "",
      body: { token: oldSession, daemonToken: sourceBoot },
    });
    assert.equal(continued.statusCode, 200);
    const candidateSession = (continued.data as { token: string }).token;
    const candidateBoot = target.token;
    await stop(access);

    packageManifest("1.0.0");
    remote.reset();
    const restored = await h.startServer({ packageRoot: root });
    await restored.upgrade.restoreStartup(access);
    assert.equal(remote.mode(), "global");
    assert.equal(fs.readFileSync(h.layout.settingsFile, "utf8"), saved);
    for (const [token, daemonToken] of [
      [oldSession, sourceBoot],
      [candidateSession, candidateBoot],
    ]) {
      assert.equal(
        (
          await h.apiRequest("/sash/web/continue", {
            method: "POST",
            token: "",
            body: { token, daemonToken },
          })
        ).statusCode,
        200,
      );
    }
    assert.equal(
      (await h.apiRequest("/sash/upgrade/commit", { method: "POST", body: access })).statusCode,
      200,
    );
    assert.equal(
      (await h.apiRequest("/sash/upgrade/cleanup", { method: "POST", body: access })).statusCode,
      204,
    );
    assert.equal(fs.existsSync(upgradeHandoffPath(h.layout)), false);
    assert.equal(
      (await h.apiRequest("/sash/settings", { method: "PATCH", body: { allowLan: true } }))
        .statusCode,
      200,
    );
  });

  it("drains an already forwarded selector change before capturing it", async () => {
    const remote = await controller();
    const entered = deferred();
    const release = deferred();
    remote.delaySelection(async () => {
      entered.resolve();
      await release.promise;
    });
    await h.startServer({ packageRoot: packageManifest("1.0.0") });
    await h.apiRequest("/sash/core/start", { method: "POST" });
    const mutation = h.apiRequest("/core/api/proxies/__proto__", {
      method: "PUT",
      body: { name: "REJECT" },
    });
    await entered.promise;
    const access = authorization();
    let completed = false;
    const reservation = h.instance?.upgrade.reserve(access).then(() => {
      completed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completed, false);
    release.resolve();
    assert.equal((await mutation).statusCode, 204);
    await reservation;
    assert.equal(
      Object.getOwnPropertyDescriptor(
        readUpgradeHandoff(h.layout, access)?.runtime.core?.selections ?? {},
        "__proto__",
      )?.value,
      "REJECT",
    );
    await h.instance?.upgrade.release(access);
  });

  it("rejects a subscription body that finishes after reservation without starting a download", async () => {
    let downloads = 0;
    await h.startServer({
      packageRoot: packageManifest("1.0.0"),
      installCore: false,
      fetchProfile: async () => {
        downloads += 1;
        throw new Error("must not fetch");
      },
    });
    const access = authorization();
    const entered = deferred();
    h.instance?.server.once("request", () => entered.resolve());
    const body = JSON.stringify({ url: "https://example.test/profile" });
    let request: http.ClientRequest | undefined;
    const response = new Promise<number>((resolve, reject) => {
      request = http.request(
        {
          hostname: "127.0.0.1",
          port: h.boundPort,
          path: "/sash/profiles",
          method: "POST",
          headers: {
            Authorization: `Bearer ${h.settings.daemonSecret}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      request.on("error", reject);
      request.flushHeaders();
    });
    await entered.promise;
    await h.instance?.upgrade.reserve(access);
    assert.ok(request);
    request.end(body);
    assert.equal(await response, 409);
    assert.equal(downloads, 0);
    await h.instance?.upgrade.release(access);
  });

  it("restores management-only state without starting Core and rejects tampered saved state before effects", async () => {
    const root = packageManifest("1.0.0");
    await h.startServer({ packageRoot: root, installCore: false });
    const access = authorization();
    await h.instance?.upgrade.reserve(access);
    const saved = fs.readFileSync(h.layout.settingsFile);
    await stop(access);
    const handoff = fs.readFileSync(upgradeHandoffPath(h.layout));
    packageManifest("1.1.0");
    const core = new FakeCoreSupervisor(h.layout, h.settings);
    const target = await h.startServer({ packageRoot: root, installCore: false, supervisor: core });
    fs.writeFileSync(h.layout.settingsFile, `${saved.toString()} `);
    await assert.rejects(target.upgrade.restoreStartup(access), /state changed|State changed/i);
    assert.equal(core.stops, 0);
    assert.deepEqual(fs.readFileSync(upgradeHandoffPath(h.layout)), handoff);
    fs.writeFileSync(h.layout.settingsFile, saved);
    await target.upgrade.restoreStartup(access);
    assert.equal(core.starts, 0);
    assert.equal(readState(h.layout)?.revision, 0);
    await target.upgrade.commit(access);
    await target.upgrade.cleanup(access);
  });

  it("authenticates the handoff before any runtime action", async () => {
    const root = packageManifest("1.0.0");
    await h.startServer({ packageRoot: root, installCore: false });
    const access = authorization();
    await h.instance?.upgrade.reserve(access);
    await stop(access);
    const file = upgradeHandoffPath(h.layout);
    const text = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, text.replace('"stateRevision":0', '"stateRevision":9'));
    const core = new FakeCoreSupervisor(h.layout, h.settings);
    const target = await h.startServer({ packageRoot: root, installCore: false, supervisor: core });
    await assert.rejects(target.upgrade.restoreStartup(access), /authentication failed/);
    assert.equal(core.starts, 0);
    assert.equal(core.stops, 0);
    assert.equal(
      fs.readFileSync(file, "utf8"),
      text.replace('"stateRevision":0', '"stateRevision":9'),
    );
  });
});
