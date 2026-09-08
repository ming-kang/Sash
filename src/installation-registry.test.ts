import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { installationId } from "./installation.js";
import {
  type InstallationInstance,
  installationRegistryPaths,
  listInstallationInstances,
  registerInstallationInstance,
  unregisterInstallationInstance,
} from "./installation-registry.js";

describe("installation instance registry", () => {
  let root: string;
  let packageRoot: string;
  let id: string;
  const originalLocal = process.env.LOCALAPPDATA;
  const originalState = process.env.XDG_STATE_HOME;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-registry-test-"));
    process.env.LOCALAPPDATA = path.join(root, "local");
    process.env.XDG_STATE_HOME = path.join(root, "state");
    packageRoot = path.join(root, "package");
    fs.mkdirSync(packageRoot);
    id = installationId(packageRoot);
  });
  afterEach(() => {
    if (originalLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocal;
    if (originalState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = originalState;
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  function record(name: string): InstallationInstance {
    const dataDir = path.join(root, name);
    fs.mkdirSync(dataDir, { recursive: true });
    return {
      schemaVersion: 1,
      installationId: id,
      packageRoot,
      dataDir,
      nodePath: process.execPath,
      sashVersion: "1.2.3",
      pid: process.pid,
      bootId: "a".repeat(48),
      port: 27891,
      startedAt: "2026-09-09T00:00:00.000Z",
    };
  }

  it("tracks multiple data directories independently and preserves a replacement boot", () => {
    const first = registerInstallationInstance(record("first"));
    const second = registerInstallationInstance(record("second"));
    assert.equal(listInstallationInstances(id, packageRoot).length, 2);
    const replacement = registerInstallationInstance({ ...first, bootId: "b".repeat(48) });
    unregisterInstallationInstance(first);
    assert.ok(
      listInstallationInstances(id, packageRoot).some((item) => item.bootId === replacement.bootId),
    );
    unregisterInstallationInstance(replacement);
    unregisterInstallationInstance(second);
    assert.deepEqual(listInstallationInstances(id, packageRoot), []);
  });

  it("keeps records readable while the active package slot is absent", () => {
    const instance = registerInstallationInstance(record("data"));
    fs.renameSync(packageRoot, `${packageRoot}.bak`);
    assert.deepEqual(listInstallationInstances(id, packageRoot), [instance]);
    unregisterInstallationInstance(instance);
  });

  it("rejects corrupt and misattributed registry records without erasing them", () => {
    registerInstallationInstance(record("data"));
    const directory = installationRegistryPaths(id).instancesDir;
    const name = fs.readdirSync(directory)[0];
    assert.ok(name);
    const file = path.join(directory, name);
    const original = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, "{ malformed");
    assert.throws(() => listInstallationInstances(id, packageRoot), /Invalid JSON/);
    assert.equal(fs.readFileSync(file, "utf8"), "{ malformed");
    fs.writeFileSync(file, original);
    fs.renameSync(file, path.join(directory, `${"0".repeat(64)}.json`));
    assert.throws(() => listInstallationInstances(id, packageRoot), /mismatched owner/);
  });
});
