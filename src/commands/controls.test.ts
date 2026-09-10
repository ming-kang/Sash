import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { sashLayout } from "../paths.js";
import { isProcessAlive, runSanitizedCommandAsync } from "../process.js";
import type { ProfilesIndex } from "../profile-model.js";
import { publicSettings } from "../settings.js";
import { acquireStateLockSync } from "../state-lock.js";
import { createTestState, testProfile, testSettings } from "../testing/state.js";

describe("profile and runtime CLI controls", () => {
  const parent = fs.realpathSync(os.tmpdir());
  let root: string;
  let server: http.Server;
  let release: () => void;
  let requests: Array<{ method: string; url: string; body: Record<string, unknown> }>;
  let profiles: ProfilesIndex;
  let proxyEnabled: boolean;
  let failUpdate: boolean;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(parent, "sash-cli-controls-"));
    const layout = sashLayout(root);
    const settings = testSettings();
    const lease = acquireStateLockSync(layout.daemonLeaseFile, { purpose: "CLI control fixture" });
    release = () => lease.release();
    profiles = { activeId: "1", profiles: [{ ...testProfile("1"), name: "primary" }] };
    proxyEnabled = false;
    failUpdate = false;
    requests = [];
    server = http.createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += String(chunk);
      const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
      const url = req.url ?? "";
      const method = req.method ?? "GET";
      requests.push({ method, url, body });
      if (url !== "/sash/daemon/health")
        assert.equal(req.headers.authorization, `Bearer ${settings.daemonSecret}`);
      let result: unknown;
      if (url === "/sash/daemon/health")
        result = {
          ok: true,
          pid: process.pid,
          token: lease.record.token,
          startedAt: "2026-09-09T00:00:00.000Z",
        };
      else if (url === "/sash/profiles" && method === "GET") result = profiles;
      else if (url === "/sash/profiles" && method === "POST") {
        const profile = { ...testProfile("2"), name: String(body.name), url: String(body.url) };
        profiles.profiles.push(profile);
        const activated = body.activate === true;
        if (activated) profiles.activeId = profile.id;
        result = { profile, activated };
      } else if (url === "/sash/profiles/active") {
        profiles.activeId = body.id === null ? null : String(body.id);
        result = { activeId: profiles.activeId, proxyCount: 0 };
      } else if (url === "/sash/profiles/update-all")
        result = {
          updated: failUpdate ? 0 : profiles.profiles.length,
          failed: failUpdate ? [{ id: "1", name: "primary", error: "provider unavailable" }] : [],
        };
      else if (/^\/sash\/profiles\/\d+\/update$/.test(url)) {
        const profile = profiles.profiles.find((profile) => profile.id === url.split("/")[3]);
        assert.ok(profile);
        profile.revision += 1;
        result = { profile };
      } else if (/^\/sash\/profiles\/\d+$/.test(url)) {
        const id = url.split("/")[3];
        const profile = profiles.profiles.find((profile) => profile.id === id);
        assert.ok(profile);
        if (method === "PATCH") {
          profile.name = String(body.name);
          result = { profile };
        } else {
          result = { wasActive: profiles.activeId === id };
          if (profiles.activeId === id) profiles.activeId = null;
          profiles.profiles = profiles.profiles.filter((profile) => profile.id !== id);
        }
      } else if (url === "/sash/settings") {
        proxyEnabled = body.systemProxy === true;
        result = {
          revision: 1,
          restartRequired: false,
          settings: publicSettings({ ...settings, systemProxy: proxyEnabled }),
        };
      } else if (url === "/sash/proxy")
        result = {
          supported: true,
          enabled: proxyEnabled,
          desired: proxyEnabled,
          applied: proxyEnabled,
          appliedKnown: true,
          stateKnown: true,
        };
      else if (url === "/sash/core/update") {
        result = method === "GET" ? null : { version: String(body.version ?? "v2.0.0") };
      } else if (url === "/sash/core/mode" || url === "/sash/core/stop") {
        res.writeHead(204);
        res.end();
        return;
      } else {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    createTestState(layout, settings);
    fs.writeFileSync(
      layout.daemonPidFile,
      JSON.stringify({
        pid: process.pid,
        token: lease.record.token,
        port: address.port,
        startedAt: "2026-09-09T00:00:00.000Z",
      }),
    );
  });
  afterEach(async () => {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal(path.dirname(fs.realpathSync(root)), parent);
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  async function cli(args: string[], data = root): Promise<string> {
    return runSanitizedCommandAsync(
      process.execPath,
      ["--import", "tsx", path.resolve("src/cli.ts"), ...args],
      {
        timeoutMs: 15_000,
        sourceEnv: { ...process.env, SASH_HOME: data },
      },
    );
  }

  it("sends every profile mutation through the API without applying Core or writing local state", async () => {
    const file = sashLayout(root).settingsFile;
    const saved = fs.readFileSync(file);
    const listed = JSON.parse(await cli(["profile", "list", "--json"])) as ProfilesIndex;
    assert.equal(listed.activeId, "1");
    await cli([
      "profile",
      "add",
      "https://example.test/second",
      "--name",
      "secondary",
      "--use",
      "--json",
    ]);
    assert.equal(profiles.activeId, "2");
    await cli(["profile", "use", "primary", "--json"]);
    assert.equal(profiles.activeId, "1");
    await cli(["profile", "update", "--json"]);
    assert.equal(profiles.profiles[0]?.revision, 2);
    await cli(["profile", "rename", "2", "renamed", "--json"]);
    await cli(["profile", "remove", "renamed", "--json"]);
    assert.equal(profiles.profiles.length, 1);
    await cli(["profile", "use", "--default", "--json"]);
    assert.equal(profiles.activeId, null);
    assert.equal(JSON.parse(await cli(["profile", "update", "--all", "--json"])).updated, 1);
    assert.equal(
      requests.some((request) => request.url.startsWith("/sash/core/")),
      false,
    );
    assert.deepEqual(fs.readFileSync(file), saved);
  });

  it("uses runtime mode, settings proxy intent and Core-only stop without shutting down management", async () => {
    assert.equal(JSON.parse(await cli(["mode", "global", "--json"])).mode, "global");
    assert.equal(JSON.parse(await cli(["proxy", "on", "--json"])).desired, true);
    assert.equal(JSON.parse(await cli(["proxy", "status", "--json"])).enabled, true);
    assert.equal(JSON.parse(await cli(["proxy", "off", "--json"])).desired, false);
    assert.match(await cli(["stop", "--core"]), /management remains available/);
    assert.deepEqual(requests.find((request) => request.url === "/sash/core/mode")?.body, {
      mode: "global",
    });
    assert.ok(requests.some((request) => request.url === "/sash/core/stop"));
    assert.equal(
      requests.some((request) => request.url === "/sash/daemon/shutdown"),
      false,
    );
    assert.equal(isProcessAlive(process.pid), true);
  });

  it("leaves absent data untouched for profile list and an already stopped Core", async () => {
    const data = path.join(root, "unused-data");
    assert.deepEqual(JSON.parse(await cli(["profile", "list", "--json"], data)), {
      activeId: null,
      profiles: [],
    });
    assert.match(await cli(["stop", "--core"], data), /Core is stopped/);
    assert.equal(fs.existsSync(data), false);
  });

  it("returns a failing exit status when a batch profile update is incomplete", async () => {
    failUpdate = true;
    await assert.rejects(cli(["profile", "update", "--all"]), /provider unavailable/);
  });

  it("accepts a positional Core tag and produces a single JSON result", async () => {
    assert.deepEqual(JSON.parse(await cli(["update", "v2.0.0", "--json"])), { version: "v2.0.0" });
    assert.deepEqual(requests.find((request) => request.url === "/sash/core/update")?.body, {
      version: "v2.0.0",
    });
    await assert.rejects(cli(["update", "--version", "v2.0.0"]), /unknown option.*--version/i);
  });
});
