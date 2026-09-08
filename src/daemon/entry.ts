import { atomicWriteFileSync, durableRemoveFileSync } from "../fs-atomic.js";
import { canonicalPath, installationId } from "../installation.js";
import {
  type InstallationInstance,
  installationRegistryPaths,
  registerInstallationInstance,
  unregisterInstallationInstance,
} from "../installation-registry.js";
import { currentPackageRoot } from "../package-info.js";
import { type SashLayout, sashLayout } from "../paths.js";
import { acquireStateLock, withStateLock } from "../state-lock.js";
import {
  authorizeUpgrade,
  readUpgradeAuthorization,
  takeUpgradeStartupAccess,
} from "../upgrade-access.js";
import type { DaemonInstance } from "./server.js";

export interface DaemonPidRecord {
  pid: number;
  token: string;
  port: number;
  startedAt: string;
}

/** The sole application writer; registration shares the installation startup gate. */
export async function runDaemon(opts: { layout?: SashLayout } = {}): Promise<void> {
  const layout = opts.layout ?? sashLayout();
  const packageRoot = canonicalPath(currentPackageRoot());
  const registry = installationRegistryPaths(installationId(packageRoot));
  const upgradeAccess = takeUpgradeStartupAccess(installationId(packageRoot));
  const lease = await acquireStateLock(layout.daemonLeaseFile, {
    purpose: "sashd singleton",
    timeoutMs: 0,
  });
  let onSignal: (() => void) | undefined;
  let published = false;
  let registered: InstallationInstance | undefined;
  let instance: DaemonInstance | undefined;
  try {
    const start = async () => {
      if (upgradeAccess) authorizeUpgrade(upgradeAccess, layout.root);
      else if (readUpgradeAuthorization(installationId(packageRoot)))
        throw new Error("A Sash upgrade is unfinished; run sash upgrade to recover it");
      // Load application code only after startup admission is acquired.
      const { SashStateStore, readState } = await import("../app-state.js");
      const { createDaemonServer } = await import("./server.js");
      if (upgradeAccess && !readState(layout))
        throw new Error("Sash upgrade state file is missing; recovery files preserved");
      const state = new SashStateStore(layout);
      const current = createDaemonServer({ layout, state, packageRoot });
      instance = current;
      if (upgradeAccess) await current.upgrade.restoreStartup(upgradeAccess);
      else await current.lifecycle.recoverStartup();
      const closed = new Promise<void>((resolve) => current.server.once("close", resolve));
      const port = state.snapshot().settings.daemonPort;
      await new Promise<void>((resolve, reject) => {
        current.server.once("error", reject);
        current.server.listen(port, "127.0.0.1", () => {
          current.server.removeListener("error", reject);
          current.server.on("error", (error) =>
            console.error("[sashd] HTTP listener error:", error),
          );
          resolve();
        });
      });
      const record: DaemonPidRecord = {
        pid: process.pid,
        token: current.token,
        port,
        startedAt: current.startedAt,
      };
      registered = registerInstallationInstance({
        schemaVersion: 1,
        installationId: current.installationId,
        packageRoot,
        dataDir: canonicalPath(layout.root),
        nodePath: process.execPath,
        sashVersion: current.version,
        pid: process.pid,
        bootId: current.token,
        port,
        startedAt: current.startedAt,
      });
      atomicWriteFileSync(layout.daemonPidFile, `${JSON.stringify(record, null, 2)}\n`);
      published = true;
      return { current, closed };
    };
    // An authenticated helper owns startup admission while it restores all instances.
    const started = upgradeAccess
      ? await start()
      : await withStateLock(
          registry.startupLock,
          { purpose: "start Sash instance", timeoutMs: 30_000 },
          start,
        );
    onSignal = () => {
      void started.current
        .close()
        .catch((error: unknown) =>
          console.error(
            `[sashd] shutdown blocked: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    await started.closed;
  } catch (error) {
    if (instance) await instance.close();
    throw error;
  } finally {
    if (onSignal) {
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGINT", onSignal);
    }
    try {
      if (registered) unregisterInstallationInstance(registered);
      if (published) durableRemoveFileSync(layout.daemonPidFile);
    } finally {
      lease.release();
    }
  }
}
