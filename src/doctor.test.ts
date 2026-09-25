import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { writeInstallRecord } from "./core.js";
import { diagnoseSash, inspectListenerPort } from "./doctor.js";
import type { DownloadTransport } from "./http.js";
import { sashLayout } from "./paths.js";
import { npmPackageRoot } from "./sash-installation.js";
import type { StatusObservationDependencies } from "./status.js";
import { createTestState, testStatus } from "./testing/state.js";

/** Minimal npm-global package layout; the doctor dashboard check only needs these four files. */
function writeSashPackage(prefix: string, version: string): string {
  const packageRoot = npmPackageRoot(prefix);
  fs.mkdirSync(path.join(packageRoot, "dist", "ui"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@astralyn/sash",
      version,
      bin: { sash: "dist/cli.js" },
      engines: { node: ">=24" },
    }),
  );
  fs.writeFileSync(path.join(packageRoot, "dist", "cli.js"), "// fixture CLI\n");
  fs.writeFileSync(path.join(packageRoot, "dist", "daemon-entry.js"), "// fixture daemon\n");
  fs.writeFileSync(path.join(packageRoot, "dist", "ui", "index.html"), "<!doctype html>\n");
  return packageRoot;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sash-doctor-"));
  const packageRoot = writeSashPackage(path.join(root, "prefix"), "1.0.0");
  const status: StatusObservationDependencies = {
    evaluateDaemon: async () => ({ kind: "stopped", running: false, healthy: false }),
    inspectSystemProxy: async () => ({
      applied: false,
      appliedKnown: true,
      stateKnown: true,
      state: { supported: true, enabled: false },
    }),
    inspectAutostart: async () => ({ state: "off", canEnable: true, reason: null }),
    installedCoreVersion: () => "",
    activeProfile: () => null,
    hasUi: () => true,
  };
  return {
    root,
    packageRoot,
    status,
    layout: sashLayout(path.join(root, "data")),
    inspectProxyConnections: async () => ({ supported: true as const, additionalRecords: 0 }),
    probeReachability: async () => true,
    cleanup: async () => {
      assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
      await fs.promises.rm(root, { recursive: true, force: true });
    },
  };
}

/** A healthy daemon that reports the transport Core downloads would leave through. */
function runningStatus(downloadTransport?: DownloadTransport): StatusObservationDependencies {
  return {
    evaluateDaemon: async () => ({
      kind: "healthy",
      running: true,
      healthy: true,
      pid: 7,
      port: 19090,
    }),
    inspectSystemProxy: async () => ({
      applied: false,
      appliedKnown: true,
      stateKnown: true,
      state: { supported: true, enabled: false },
    }),
    inspectAutostart: async () => ({ state: "off", canEnable: true, reason: null }),
    installedCoreVersion: () => "1.0.0",
    activeProfile: () => null,
    hasUi: () => true,
    queryDaemonStatus: async () =>
      ({
        ...testStatus(),
        daemon: {
          pid: 7,
          bootId: "boot",
          startedAt: "2026-01-01T00:00:00.000Z",
          port: 19090,
          version: "1.0.0",
        },
        ...(downloadTransport ? { downloadTransport } : {}),
      }) as never,
  };
}

it("diagnoses an uninitialized installation without creating application data", async () => {
  const f = fixture();
  const ports: number[] = [];
  try {
    const result = await diagnoseSash({
      ...f,
      inspectPort: async (_host, port) => {
        ports.push(port);
        return { available: true };
      },
    });
    assert.equal(result.healthy, true);
    assert.equal(result.complete, true);
    assert.equal(result.checks.find((check) => check.id === "manifest")?.status, "info");
    assert.equal(result.checks.find((check) => check.id === "core")?.status, "info");
    assert.equal(
      result.checks.some((check) => check.id === "login-start"),
      false,
    );
    assert.equal(ports.length, 3);
    assert.equal(fs.existsSync(f.layout.root), false);
  } finally {
    await f.cleanup();
  }
});

it("reports the last login start when start at login is on", async () => {
  const f = fixture();
  try {
    createTestState(f.layout);
    const autostartOn: StatusObservationDependencies = {
      ...f.status,
      inspectAutostart: async () => ({ state: "on", canEnable: true, reason: null }),
    };
    const withoutRecord = await diagnoseSash({ ...f, status: autostartOn });
    const loginCheck = withoutRecord.checks.find((check) => check.id === "login-start");
    assert.equal(loginCheck?.status, "info");
    assert.equal(loginCheck?.message, "no login start recorded yet");

    fs.mkdirSync(f.layout.stateDir, { recursive: true });
    fs.writeFileSync(
      f.layout.loginStartFile,
      JSON.stringify({
        at: "2026-09-15T00:00:00.000Z",
        ok: false,
        attempts: 4,
        error: "network is not ready",
      }),
    );
    const failed = await diagnoseSash({ ...f, status: autostartOn });
    const failedCheck = failed.checks.find((check) => check.id === "login-start");
    assert.equal(failedCheck?.status, "error");
    assert.match(failedCheck?.message ?? "", /last login start failed: network is not ready/);
    assert.match(failedCheck?.advice ?? "", /sash logs/);

    fs.writeFileSync(
      f.layout.loginStartFile,
      JSON.stringify({ at: "2026-09-15T01:00:00.000Z", ok: true, attempts: 2 }),
    );
    const recovered = await diagnoseSash({ ...f, status: autostartOn });
    const okCheck = recovered.checks.find((check) => check.id === "login-start");
    assert.equal(okCheck?.status, "ok");
    assert.match(okCheck?.message ?? "", /last login start succeeded/);
  } finally {
    await f.cleanup();
  }
});

it("reports geodata files and download-source reachability", async () => {
  const f = fixture();
  try {
    const first = await diagnoseSash({ ...f });
    assert.equal(first.checks.find((check) => check.id === "geodata")?.status, "info");
    const network = first.checks.find((check) => check.id === "network");
    assert.equal(network?.status, "ok");
    assert.match(
      network?.message ?? "",
      /reachable via a direct connection: github\.com, api\.github\.com, ghfast\.top/,
    );

    fs.mkdirSync(f.layout.root, { recursive: true });
    fs.writeFileSync(path.join(f.layout.root, "geosite.dat"), "db");
    const withData = await diagnoseSash({ ...f });
    assert.match(
      withData.checks.find((check) => check.id === "geodata")?.message ?? "",
      /geodata present: geosite.dat/,
    );

    const apiDown = await diagnoseSash({
      ...f,
      probeReachability: async (url) => !url.includes("api.github.com"),
    });
    const apiCheck = apiDown.checks.find((check) => check.id === "network");
    assert.equal(apiCheck?.status, "warning");
    assert.match(apiCheck?.message ?? "", /release API is unreachable/);

    const allDown = await diagnoseSash({ ...f, probeReachability: async () => false });
    const allCheck = allDown.checks.find((check) => check.id === "network");
    assert.equal(allCheck?.status, "warning");
    assert.match(allCheck?.message ?? "", /No Core download source is reachable/);

    const mirrorDown = await diagnoseSash({
      ...f,
      probeReachability: async (url) => !url.includes("ghfast.top"),
    });
    const mirrorCheck = mirrorDown.checks.find((check) => check.id === "network");
    assert.equal(mirrorCheck?.status, "ok");
    assert.match(
      mirrorCheck?.message ?? "",
      /mirrors are unreachable via a direct connection: ghfast\.top/,
    );
  } finally {
    await f.cleanup();
  }
});

it("reports corrupt settings while independently inspecting installed Core", async () => {
  const f = fixture();
  try {
    createTestState(f.layout);
    fs.writeFileSync(f.layout.settingsFile, "{ malformed");
    fs.mkdirSync(f.layout.binDir, { recursive: true });
    fs.writeFileSync(f.layout.coreExe, "Core executable");
    writeInstallRecord(
      {
        coreVersion: "v1.0.0",
      },
      f.layout,
    );
    const result = await diagnoseSash({
      ...f,
      inspectPort: async () => {
        throw new Error("must not probe ports from corrupt state");
      },
    });
    assert.equal(result.healthy, false);
    assert.equal(result.complete, false);
    assert.equal(result.checks.find((check) => check.id === "manifest")?.status, "error");
    assert.equal(result.checks.find((check) => check.id === "core")?.status, "ok");
    assert.equal(fs.readFileSync(f.layout.settingsFile, "utf8"), "{ malformed");
    assert.equal(fs.readFileSync(f.layout.coreExe, "utf8"), "Core executable");
  } finally {
    await f.cleanup();
  }
});

it("points corrupt-manifest recovery advice at an existing state backup", async () => {
  const f = fixture();
  try {
    createTestState(f.layout);
    fs.writeFileSync(f.layout.settingsFile, "{ malformed");
    for (const backup of [undefined, "{ anything"]) {
      if (backup === undefined) fs.rmSync(f.layout.settingsBackupFile, { force: true });
      else fs.writeFileSync(f.layout.settingsBackupFile, backup);
      const result = await diagnoseSash({
        ...f,
        inspectPort: async () => {
          throw new Error("must not probe ports from corrupt state");
        },
      });
      const check = result.checks.find((check) => check.id === "manifest");
      assert.equal(check?.status, "error");
      if (backup === undefined) {
        assert.equal(
          check?.advice,
          "Preserve the file and restore a valid schema-2 manifest before starting Sash",
        );
      } else {
        assert.match(check?.advice ?? "", /copy .*sash\.json\.bak/);
        assert.match(check?.advice ?? "", /restore the most recently committed/);
      }
    }
    assert.equal(fs.readFileSync(f.layout.settingsFile, "utf8"), "{ malformed");
  } finally {
    await f.cleanup();
  }
});

it("reports port conflicts and unknown proxy observations alongside verified Core metadata", async () => {
  const f = fixture();
  try {
    createTestState(f.layout);
    fs.mkdirSync(f.layout.binDir, { recursive: true });
    fs.writeFileSync(f.layout.coreExe, "known bytes");
    writeInstallRecord(
      {
        coreVersion: "v1.0.0",
      },
      f.layout,
    );
    const saved = fs.readFileSync(f.layout.settingsFile);
    const result = await diagnoseSash({
      ...f,
      status: {
        ...f.status,
        inspectSystemProxy: async () => ({
          applied: false,
          appliedKnown: false,
          stateKnown: false,
          queryError: "access denied",
          state: { supported: true, enabled: false },
        }),
      },
      inspectPort: async (_host, port) => ({
        available: port !== 18780,
        reason: port === 18780 ? "EADDRINUSE" : undefined,
      }),
    });
    assert.equal(result.checks.find((check) => check.id === "core")?.status, "ok");
    assert.equal(result.checks.find((check) => check.id === "mixed-port")?.status, "error");
    assert.equal(result.checks.find((check) => check.id === "proxy")?.status, "warning");
    assert.equal(result.complete, false);
    assert.deepEqual(fs.readFileSync(f.layout.settingsFile), saved);
  } finally {
    await f.cleanup();
  }
});

it("distinguishes an occupied loopback port from a free one", async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  assert.ok(![7890, 9090, 19090].includes(address.port));
  try {
    assert.equal((await inspectListenerPort("127.0.0.1", address.port)).available, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.equal((await inspectListenerPort("127.0.0.1", address.port)).available, true);
});

it("warns when the running daemon still executes an older installed version", async () => {
  const f = fixture();
  try {
    const running = await diagnoseSash({
      ...f,
      status: {
        ...f.status,
        evaluateDaemon: async () => ({
          kind: "healthy",
          running: true,
          healthy: true,
          pid: 7,
          port: 19090,
        }),
        queryDaemonStatus: async () =>
          ({
            ...testStatus(),
            daemon: {
              pid: 7,
              bootId: "boot",
              startedAt: "2026-01-01T00:00:00.000Z",
              port: 19090,
              version: "0.0.1",
            },
          }) as never,
      },
    });
    const check = running.checks.find((item) => item.id === "sash-version");
    assert.equal(check?.status, "warning");
    // The fixture package is 1.0.0; the daemon claims 0.0.1.
    assert.match(
      check?.message ?? "",
      /Sash 1\.0\.0 is installed; the running Sash is still 0\.0\.1/,
    );
    assert.match(check?.advice ?? "", /sash stop && sash start/);
  } finally {
    await f.cleanup();
  }
});

it("reports connection-specific proxy limitations without claiming active settings or changing state", async () => {
  const f = fixture();
  try {
    for (const inspect of [
      async () => ({ supported: true as const, additionalRecords: 2 }),
      async () => {
        throw new Error("access denied with private registry output");
      },
    ]) {
      const result = await diagnoseSash({
        ...f,
        inspectProxyConnections: inspect,
        inspectPort: async () => ({ available: true }),
      });
      const check = result.checks.find((check) => check.id === "proxy-connections");
      assert.equal(check?.status, "warning");
      assert.match(check?.advice ?? "", /per-connection/);
      assert.doesNotMatch(JSON.stringify(check), /private registry output/);
      assert.equal(result.complete, false);
      assert.equal(fs.existsSync(f.layout.root), false);
    }
  } finally {
    await f.cleanup();
  }
});

it("probes download sources through the transport the daemon would use", async () => {
  const f = fixture();
  try {
    createTestState(f.layout);
    const coreTransport: DownloadTransport = {
      uri: `http://127.0.0.1:${testStatus().configuration.appliedSettings?.mixedPort ?? 0}`,
      source: "core",
    };
    // A spread, not the array itself: assert.deepEqual narrows what it is given.
    const transports: Array<DownloadTransport | undefined> = [];
    const viaCore = await diagnoseSash({
      ...f,
      status: runningStatus(coreTransport),
      inspectPort: async () => ({ available: true }),
      probeReachability: async (_url, transport) => {
        transports.push(transport);
        return true;
      },
    });
    assert.equal(transports.length, 3);
    assert.deepEqual([...transports], [coreTransport, coreTransport, coreTransport]);
    // The result must name the path it measured, or a failure points nowhere.
    assert.match(
      viaCore.checks.find((check) => check.id === "network")?.message ?? "",
      new RegExp(
        `reachable via Sash's own Core proxy: ${coreTransport.uri}: github\\.com, api\\.github\\.com, ghfast\\.top`,
      ),
    );

    transports.length = 0;
    const viaEnvironment = await diagnoseSash({
      ...f,
      status: runningStatus({ uri: "http://127.0.0.1:1080", source: "environment" }),
      inspectPort: async () => ({ available: true }),
      probeReachability: async (_url, transport) => {
        transports.push(transport);
        return false;
      },
    });
    assert.equal(transports.length, 3);
    const unreachable = viaEnvironment.checks.find((check) => check.id === "network");
    assert.equal(unreachable?.status, "warning");
    assert.match(
      unreachable?.message ?? "",
      /No Core download source is reachable via the proxy environment variable: http:\/\/127\.0\.0\.1:1080/,
    );
    assert.match(unreachable?.advice ?? "", /Check whether http:\/\/127\.0\.0\.1:1080 is running/);
  } finally {
    await f.cleanup();
  }
});

it("falls back to a direct probe when the daemon did not answer", async () => {
  const f = fixture();
  try {
    const seen: Array<DownloadTransport | undefined> = [];
    const result = await diagnoseSash({
      ...f,
      status: {
        ...f.status,
        evaluateDaemon: async () => ({
          kind: "healthy",
          running: true,
          healthy: true,
          pid: 7,
          port: 19090,
        }),
        queryDaemonStatus: async () => {
          throw new Error("local API request failed");
        },
      },
      inspectPort: async () => ({ available: true }),
      probeReachability: async (_url, transport) => {
        seen.push(transport);
        return true;
      },
    });
    assert.deepEqual(seen, [undefined, undefined, undefined]);
    // A stopped or unanswering Sash downloads direct, so that is what was measured.
    assert.match(
      result.checks.find((check) => check.id === "network")?.message ?? "",
      /reachable via a direct connection: github\.com, api\.github\.com, ghfast\.top/,
    );
    assert.equal(result.checks.find((check) => check.id === "runtime")?.status, "warning");
  } finally {
    await f.cleanup();
  }
});
