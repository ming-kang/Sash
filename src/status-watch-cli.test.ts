import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { useDaemonTestHarness } from "./daemon-test-harness.test.js";
import { atomicWriteFileSync } from "./fs-atomic.js";
import {
  buildSanitizedEnv,
  classifyProcessIdentity,
  commandLineContains,
  killProcessGracefully,
} from "./process.js";
import { acquireStateLockSync } from "./state-lock.js";
import type { CliRuntimeStatus } from "./status.js";
import { deferredValue } from "./test-state.test.js";

const harness = useDaemonTestHarness();

it("streams CLI NDJSON from an isolated daemon and exits 0 on a closed output pipe", {
  timeout: 15_000,
}, async (t) => {
  const instance = await harness.startServer();
  const lease = acquireStateLockSync(harness.layout.daemonLeaseFile, {
    purpose: "CLI watch fixture",
  });
  t.after(() => lease.release());
  atomicWriteFileSync(
    harness.layout.daemonPidFile,
    JSON.stringify({
      pid: process.pid,
      token: instance.token,
      port: harness.boundPort,
      startedAt: instance.startedAt,
    }),
  );
  const preload = path.join(harness.layout.root, "watch-cli-preload.mjs");
  fs.writeFileSync(
    preload,
    [
      `import { AutostartService } from ${JSON.stringify(new URL("./autostart.ts", import.meta.url).href)};`,
      `import { SystemProxyManager } from ${JSON.stringify(new URL("./system-proxy-manager.ts", import.meta.url).href)};`,
      'AutostartService.prototype.inspect = async () => ({ state: "off", canEnable: true, reason: null });',
      "SystemProxyManager.prototype.inspect = async () => ({ applied: false, appliedKnown: true, stateKnown: true, state: { supported: true, enabled: false } });",
    ].join("\n"),
    { mode: 0o600 },
  );
  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
      "--import",
      pathToFileURL(preload).href,
      fileURLToPath(new URL("./cli.ts", import.meta.url)),
      "status",
      "--watch",
      "--json",
    ],
    {
      cwd: harness.layout.root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...buildSanitizedEnv(),
        SASH_HOME: harness.layout.root,
        LOCALAPPDATA: path.join(harness.layout.root, "local"),
        XDG_STATE_HOME: path.join(harness.layout.root, "state-root"),
      },
    },
  );
  t.after(async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const pid = child.pid;
      assert.equal(
        await killProcessGracefully(pid, {
          timeoutMs: 4000,
          verify: () =>
            classifyProcessIdentity(pid, process.execPath) === "match" &&
            commandLineContains(pid, pathToFileURL(preload).href)
              ? "match"
              : "unknown",
        }),
        true,
        "fixture child cleanup must verify its identity",
      );
    }
  });
  const ready = deferredValue<CliRuntimeStatus>();
  const changed = deferredValue<CliRuntimeStatus>();
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  let output = "";
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    errors += text;
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text: string) => {
    output += text;
    let end = output.indexOf("\n");
    while (end >= 0) {
      const line = output.slice(0, end);
      output = output.slice(end + 1);
      try {
        const value = JSON.parse(line) as CliRuntimeStatus;
        assert.equal(value.schemaVersion, 2);
        ready.resolve(value);
        if (value.activeProfile?.name === "cli-watch") changed.resolve(value);
      } catch (error) {
        ready.reject(error);
        changed.reject(error);
      }
      end = output.indexOf("\n");
    }
  });
  child.on("error", (error) => {
    ready.reject(error);
    changed.reject(error);
  });
  t.signal.addEventListener(
    "abort",
    () => {
      ready.reject(t.signal.reason);
      changed.reject(t.signal.reason);
    },
    { once: true },
  );
  assert.equal((await ready.promise).daemon.state, "healthy", errors);
  const added = await harness.apiRequest("/sash/profiles/import", {
    method: "POST",
    body: { name: "cli-watch", content: "proxies: []\nrules: [MATCH,DIRECT]\n" },
  });
  assert.equal(added.statusCode, 200);
  const status = await changed.promise;
  assert.equal(status.core.running, false);
  child.stdout.destroy();
  assert.ok(status.activeProfile);
  await harness.apiRequest(`/sash/profiles/${status.activeProfile.id}`, {
    method: "PATCH",
    body: { name: "pipe-closed" },
  });
  assert.equal(await exited, 0, errors);
});
