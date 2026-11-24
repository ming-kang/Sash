import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  inspectProtectedPair,
  LINUX_HELPER_INSTALL_SCRIPT,
  LINUX_HELPER_UNINSTALL_SCRIPT,
  linuxTunPlatform,
  packagedCoreBinary,
  packagedHelperBinary,
} from "./linux.js";

const tempDirs: string[] = [];
function tempRoot(t: { onTestFinished: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-linux-test-"));
  tempDirs.push(dir);
  t.onTestFinished(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

describe("packaged binaries", () => {
  // Linux binaries carry no .exe suffix; this assertion is only meaningful on unix hosts.
  it.skipIf(process.platform === "win32")(
    "pairs the helper and Core names by platform and arch",
    () => {
      const root = "/opt/sash";
      expect(packagedHelperBinary(root)).toBe(
        path.join(root, "dist", `sash-helper-${process.platform}-${process.arch}`),
      );
      expect(packagedCoreBinary(root)).toBe(
        path.join(root, "dist", `sash-tun-core-${process.platform}-${process.arch}`),
      );
    },
  );
});

describe("install script", () => {
  it("runs the consented install instead of copying the Core itself", () => {
    expect(LINUX_HELPER_INSTALL_SCRIPT).toContain("--install-consent");
    // The packaged helper is staged root-owned and re-hashed before any
    // privileged execution; the staged copy, not the user-writable path, runs.
    expect(LINUX_HELPER_INSTALL_SCRIPT).toContain("$BIN/.sash-helper.new");
    expect(LINUX_HELPER_INSTALL_SCRIPT).toContain('install -m 0755 -o root -g root "$HELPER_SRC"');
    expect(LINUX_HELPER_INSTALL_SCRIPT).toContain('"$BIN/.sash-helper.new" --bin-dir');
    // An upgrade stops the old service and runs the old helper's cleanup
    // before the new pair is published.
    const stopIndex = LINUX_HELPER_INSTALL_SCRIPT.indexOf("systemctl stop sash-helper.service");
    const cleanupIndex = LINUX_HELPER_INSTALL_SCRIPT.indexOf("--cleanup");
    const consentIndex = LINUX_HELPER_INSTALL_SCRIPT.indexOf("--install-consent");
    expect(stopIndex).toBeGreaterThan(-1);
    expect(cleanupIndex).toBeGreaterThan(stopIndex);
    expect(consentIndex).toBeGreaterThan(cleanupIndex);
    expect(LINUX_HELPER_INSTALL_SCRIPT).not.toContain("--publish-core");
    expect(LINUX_HELPER_INSTALL_SCRIPT).not.toContain("mv -f");
    expect(LINUX_HELPER_INSTALL_SCRIPT).not.toContain('"$HELPER_SRC" --bin-dir');
  });
});

describe("uninstall script", () => {
  it("aborts when the service or cleanup fails", () => {
    expect(LINUX_HELPER_UNINSTALL_SCRIPT).toContain("--cleanup");
    expect(LINUX_HELPER_UNINSTALL_SCRIPT).toContain("exit 5");
  });
});

describe("linuxTunPlatform.install", () => {
  it("fails fast when packaged binaries are missing", async (t) => {
    tempRoot(t);
    const platform = linuxTunPlatform({ packageRoot: tempRoot(t) });
    await expect(platform.install({} as never)).rejects.toThrow(/Packaged TUN binaries/);
  });

  it("inspect reports not installed when the protected pair is absent", async () => {
    const platform = linuxTunPlatform({ statFile: async () => false });
    const state = await platform.inspect({} as never);
    expect(state).toEqual({ installed: false, coreSynced: null });
  });
});

describe("inspectProtectedPair", () => {
  async function setup(t: { onTestFinished: (fn: () => void) => void }) {
    const root = tempRoot(t);
    const dist = path.join(root, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(packagedHelperBinary(root), "helper-v1");
    fs.writeFileSync(packagedCoreBinary(root), "core-v1");
    const install = path.join(root, "protected");
    fs.mkdirSync(install, { recursive: true });
    const paths = {
      unit: path.join(install, "unit"),
      helper: path.join(install, "sash-helper"),
      manifest: path.join(install, "manifest"),
      core: path.join(install, "mihomo"),
    };
    const writePair = (helper: string, core: string | null) => {
      fs.writeFileSync(paths.unit, "u");
      fs.writeFileSync(paths.helper, helper);
      fs.writeFileSync(paths.manifest, "m");
      if (core === null) {
        if (fs.existsSync(paths.core)) fs.rmSync(paths.core);
      } else {
        fs.writeFileSync(paths.core, core);
      }
    };
    const statFile = async (file: string) => fs.existsSync(file);
    const versionOf = async () => "0.6.1";
    return { root, paths, writePair, statFile, versionOf };
  }

  it("reports a verified pair without reconsent", async (t) => {
    const { root, paths, writePair, statFile, versionOf } = await setup(t);
    writePair("helper-v1", "core-v1");
    const state = await inspectProtectedPair(paths, {
      packageRoot: root,
      statFile,
      versionOf,
    });
    expect(state).toMatchObject({ installed: true, coreSynced: true });
    expect(state.needsReconsent).toBe(false);
  });

  it("flags reconsent when the paired Core drifted at the same version", async (t) => {
    const { root, paths, writePair, statFile, versionOf } = await setup(t);
    writePair("helper-v1", "core-tampered");
    const state = await inspectProtectedPair(paths, {
      packageRoot: root,
      statFile,
      versionOf,
    });
    expect(state.installed).toBe(true);
    expect(state.coreSynced).toBe(false);
    expect(state.needsReconsent).toBe(true);
  });

  it("flags reconsent when the paired Core is missing entirely", async (t) => {
    const { root, paths, writePair, statFile, versionOf } = await setup(t);
    writePair("helper-v1", null);
    const state = await inspectProtectedPair(paths, {
      packageRoot: root,
      statFile,
      versionOf,
    });
    expect(state.installed).toBe(true);
    expect(state.coreSynced).toBe(false);
    expect(state.needsReconsent).toBe(true);
  });

  it("flags reconsent when the helper cannot report its version", async (t) => {
    const { root, paths, writePair, statFile } = await setup(t);
    writePair("helper-v1", "core-v1");
    const state = await inspectProtectedPair(paths, {
      packageRoot: root,
      statFile,
      versionOf: async () => null,
    });
    expect(state.needsReconsent).toBe(true);
  });

  it("reports an absent install without drift signals", async (t) => {
    const { root, paths, statFile, versionOf } = await setup(t);
    const state = await inspectProtectedPair(paths, {
      packageRoot: root,
      statFile,
      versionOf,
    });
    expect(state).toEqual({ installed: false, coreSynced: null });
  });
});
