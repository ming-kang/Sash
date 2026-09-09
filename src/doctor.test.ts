import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { writeInstallRecord } from "./core-install-record.js";
import { diagnoseSash, inspectListenerPort } from "./doctor.js";
import { sashLayout } from "./paths.js";
import type { StatusObservationDependencies } from "./status.js";
import { createTestState } from "./test-state.test.js";
import { writeFixturePackage } from "./upgrade-test-fixture.test.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sash-doctor-"));
  const packageRoot = writeFixturePackage(path.join(root, "prefix"), "1.0.0");
  const dist = path.join(packageRoot, "dist");
  for (const entry of ["daemon-entry.js", "upgrade-probe-entry.js", "upgrade-worker.LICENSE.md"])
    fs.writeFileSync(path.join(dist, entry), "fixture");
  const ui = path.join(dist, "ui");
  fs.mkdirSync(path.join(ui, "assets"), { recursive: true });
  fs.mkdirSync(path.join(ui, ".vite"));
  fs.writeFileSync(
    path.join(ui, "index.html"),
    '<script src="./assets/app.js"></script><link href="./assets/app.css">',
  );
  fs.writeFileSync(path.join(ui, "assets", "app.js"), "fixture");
  fs.writeFileSync(path.join(ui, "assets", "app.css"), "fixture");
  fs.writeFileSync(
    path.join(ui, ".vite", "manifest.json"),
    JSON.stringify({ "index.html": { file: "assets/app.js", css: ["assets/app.css"] } }),
  );
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
    cleanup: async () => {
      assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
      await fs.promises.rm(root, { recursive: true, force: true });
    },
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
    assert.equal(ports.length, 3);
    assert.equal(fs.existsSync(f.layout.root), false);
  } finally {
    await f.cleanup();
  }
});

it("reports corrupt settings and changed Core bytes independently without repairing either", async () => {
  const f = fixture();
  try {
    createTestState(f.layout);
    fs.writeFileSync(f.layout.settingsFile, "{ malformed");
    fs.mkdirSync(f.layout.binDir, { recursive: true });
    fs.writeFileSync(f.layout.coreExe, "changed bytes");
    writeInstallRecord(
      {
        coreVersion: "v1.0.0",
        installedAt: "2026-09-09T00:00:00.000Z",
        sha256: crypto.hash("sha256", "original bytes"),
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
    assert.equal(result.checks.find((check) => check.id === "core")?.status, "error");
    assert.equal(fs.readFileSync(f.layout.settingsFile, "utf8"), "{ malformed");
    assert.equal(fs.readFileSync(f.layout.coreExe, "utf8"), "changed bytes");
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
        installedAt: "2026-09-09T00:00:00.000Z",
        sha256: crypto.hash("sha256", "known bytes"),
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
