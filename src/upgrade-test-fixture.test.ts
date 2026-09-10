import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UpgradeRuntimeStatus } from "./contracts.js";
import { inspectInstallation, npmPackageRoot, npmShimPaths } from "./installation.js";
import type { InstallationInstance } from "./installation-registry.js";
import { createSashUpgradeJournal } from "./self-upgrade.js";
import type { UpgradeRuntimeAdapter } from "./upgrade-instances.js";
import type { UpgradeInstanceReference } from "./upgrade-journal.js";
import type { SashNpmTarget } from "./upgrade-npm.js";

export function writeFixturePackage(prefix: string, version: string): string {
  const root = npmPackageRoot(prefix);
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@astralyn/sash",
      version,
      type: "module",
      bin: { sash: "dist/cli.js" },
      engines: { node: ">=24" },
      sashUpgradeProtocol: 1,
    }),
  );
  fs.writeFileSync(
    path.join(root, "dist", "cli.js"),
    `process.stdout.write(${JSON.stringify(version)} + "\\n");\n`,
  );
  fs.writeFileSync(
    path.join(root, "dist", "upgrade-worker.mjs"),
    'process.stdout.write(JSON.stringify({ upgradeProtocol: 1 }) + "\\n");\n',
  );
  for (const entry of ["autostart-entry.js", "autostart-upgrade-entry.js"])
    fs.writeFileSync(path.join(root, "dist", entry), "// isolated fixture entry\n");
  for (const shim of npmShimPaths(prefix)) {
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    if (process.platform === "win32")
      fs.writeFileSync(shim, `npm fixture: node_modules/@astralyn/sash/dist/cli.js\n${version}\n`);
    else fs.symlinkSync("../lib/node_modules/@astralyn/sash/dist/cli.js", shim);
  }
  return root;
}

export function upgradeFixture(worker?: Buffer) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "sash-upgrade-test-"));
  const prefix = path.join(root, "prefix 中文 with spaces");
  writeFixturePackage(prefix, "1.0.0");
  if (worker)
    fs.writeFileSync(path.join(npmPackageRoot(prefix), "dist", "upgrade-worker.mjs"), worker);
  const installation = inspectInstallation({ packageRoot: npmPackageRoot(prefix) });
  assert.equal(installation.kind, "npm-global");
  if (installation.kind !== "npm-global") throw new Error("Fixture installation is invalid");
  const journal = createSashUpgradeJournal(installation, "2.0.0");
  const target: SashNpmTarget = {
    name: "@astralyn/sash",
    version: "2.0.0",
    nodeRange: ">=24",
    upgradeProtocol: 1,
  };
  return {
    root,
    prefix,
    installation,
    journal,
    target,
    cleanup: () => {
      assert.equal(path.dirname(fs.realpathSync(root)), parent);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function fakeUpgradeRuntimes(
  root: string,
  installation: ReturnType<typeof upgradeFixture>["installation"],
  count = 2,
) {
  const events: string[] = [];
  const references: UpgradeInstanceReference[] = [];
  const states = new Map<
    string,
    { record: InstallationInstance; phase: UpgradeRuntimeStatus["phase"] }
  >();
  let nextPid = 20_000;
  let failReserve: string | undefined;
  let failRestore: string | undefined;
  for (let i = 0; i < count; i += 1) {
    const dataDir = path.join(root, `data-${i}`);
    fs.mkdirSync(dataDir);
    const record: InstallationInstance = {
      schemaVersion: 1,
      installationId: installation.id,
      packageRoot: installation.packageRoot,
      dataDir,
      nodePath: installation.nodePath,
      sashVersion: "1.0.0",
      pid: ++nextPid,
      bootId: crypto.randomBytes(24).toString("hex"),
      port: 28000 + i,
      startedAt: new Date().toISOString(),
    };
    references.push({ source: record, restoreNodePath: installation.nodePath });
    states.set(dataDir, { record, phase: "none" });
  }
  const state = (record: InstallationInstance) => {
    const value = states.get(record.dataDir);
    assert.ok(value);
    assert.equal(value.record.bootId, record.bootId);
    return value;
  };
  const runtime: UpgradeRuntimeAdapter = {
    current: async (instance) => states.get(instance.source.dataDir)?.record,
    status: async (record, access) => ({
      transactionId: access.transactionId,
      bootId: record.bootId,
      version: record.sashVersion,
      phase: state(record).phase,
      running: true,
    }),
    reserve: async (record) => {
      events.push(`reserve:${path.basename(record.dataDir)}`);
      if (record.dataDir === failReserve) throw new Error("reservation failed");
      state(record).phase = "reserved";
    },
    release: async (record) => {
      events.push(`release:${path.basename(record.dataDir)}`);
      assert.equal(state(record).phase, "reserved");
      state(record).phase = "none";
    },
    stop: async (record) => {
      events.push(`stop:${path.basename(record.dataDir)}`);
      assert.notEqual(state(record).phase, "none");
      states.delete(record.dataDir);
    },
    restore: async (instance, _access, version) => {
      events.push(`restore:${path.basename(instance.source.dataDir)}:${version}`);
      if (version === "2.0.0" && instance.source.dataDir === failRestore)
        throw new Error("candidate failed health");
      const record = {
        ...instance.source,
        pid: ++nextPid,
        bootId: crypto.randomBytes(24).toString("hex"),
        sashVersion: version,
      };
      states.set(record.dataDir, { record, phase: "restored" });
      return record;
    },
    verify: async (record) => {
      events.push(`verify:${path.basename(record.dataDir)}`);
      assert.equal(state(record).phase, "restored");
    },
    commit: async (record) => {
      events.push(`commit:${path.basename(record.dataDir)}`);
      state(record).phase = "committed";
    },
    cleanup: async (record) => {
      events.push(`cleanup:${path.basename(record.dataDir)}`);
      assert.equal(state(record).phase, "committed");
      state(record).phase = "none";
    },
    cleanupStopped: async () => {},
    assertVacant: async () => {
      events.push("vacant");
      assert.equal(states.size, 0);
    },
  };
  return {
    runtime,
    references,
    states,
    events,
    failReservation: (index: number) => {
      failReserve = references[index]?.source.dataDir;
    },
    failRestoration: (index: number) => {
      failRestore = references[index]?.source.dataDir;
    },
  };
}
