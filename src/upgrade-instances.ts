import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readState } from "./app-state.js";
import type { UpgradeRuntimeStatus } from "./contracts.js";
import { SashDaemonClient } from "./daemon-client.js";
import { evaluateDaemon, readDaemonPidRecord } from "./daemon-lifecycle.js";
import { type NpmInstallation, pathsEqual } from "./installation.js";
import { type InstallationInstance, listInstallationInstances } from "./installation-registry.js";
import { type SashPackageInfo, supportsNode, UPGRADE_PROTOCOL } from "./package-info.js";
import { sashLayout } from "./paths.js";
import {
  classifyProcessIdentity,
  commandLineContains,
  isProcessAlive,
  killProcessGracefully,
  withPrivateAppendLogFds,
} from "./process.js";
import { readStateLockRecord } from "./state-lock.js";
import type { UpgradeAccess } from "./upgrade-access.js";
import { runUpgradeCommand, upgradeChildEnv } from "./upgrade-command.js";
import { isInsideDirectory } from "./upgrade-files.js";
import type { UpgradeInstanceReference } from "./upgrade-journal.js";
import { assertNoUnknownSashDaemons, observeUpgradeProcesses } from "./upgrade-processes.js";

export async function verifyUpgradeInstance(
  record: InstallationInstance,
  options: { processIdentity?: boolean } = {},
): Promise<SashDaemonClient> {
  const layout = sashLayout(record.dataDir);
  const state = readState(layout);
  if (!state) throw new Error(`Sash instance state is missing: ${record.dataDir}`);
  const pid = readDaemonPidRecord(layout);
  const lease = readStateLockRecord(layout.daemonLeaseFile);
  if (
    pid?.pid !== record.pid ||
    pid.token !== record.bootId ||
    lease?.pid !== record.pid ||
    (options.processIdentity !== false &&
      (classifyProcessIdentity(record.pid, record.nodePath) !== "match" ||
        !commandLineContains(record.pid, path.join(record.packageRoot, "dist", "daemon-entry.js"))))
  )
    throw new Error(`Cannot verify Sash daemon PID ${record.pid}; it was left running`);
  const client = new SashDaemonClient(record.port, state.settings.daemonSecret);
  const health = await client.health();
  if (
    health.pid !== record.pid ||
    health.token !== record.bootId ||
    health.startedAt !== record.startedAt ||
    health.version !== record.sashVersion ||
    health.installationId !== record.installationId ||
    health.upgradeProtocol !== UPGRADE_PROTOCOL
  )
    throw new Error(
      `Sash daemon PID ${record.pid} has a changed identity or incompatible upgrade protocol`,
    );
  await client.getSettings();
  return client;
}

export async function discoverUpgradeInstances(
  installation: NpmInstallation,
  target: SashPackageInfo,
  signal?: AbortSignal,
): Promise<UpgradeInstanceReference[]> {
  const live = listInstallationInstances(installation.id, installation.packageRoot).filter(
    (record) => isProcessAlive(record.pid),
  );
  const versions = new Map<string, string>();
  const result: UpgradeInstanceReference[] = [];
  for (const source of live) {
    signal?.throwIfAborted();
    if (
      pathsEqual(source.dataDir, installation.packageRoot) ||
      isInsideDirectory(installation.packageRoot, source.dataDir)
    )
      throw new Error(
        `SASH_HOME is inside the package directory; move it outside the installation before upgrading: ${source.dataDir}`,
      );
    await verifyUpgradeInstance(source);
    let nodeVersion = versions.get(source.nodePath);
    if (!nodeVersion) {
      nodeVersion = (
        await runUpgradeCommand(source.nodePath, ["--version"], {
          cwd: source.dataDir,
          purpose: "Check instance Node compatibility",
          signal,
        })
      ).trim();
      versions.set(source.nodePath, nodeVersion);
    }
    result.push({
      source,
      restoreNodePath: supportsNode(target, nodeVersion) ? source.nodePath : installation.nodePath,
    });
  }
  assertNoUnknownSashDaemons(
    await observeUpgradeProcesses(),
    installation.packageRoot,
    [installation.nodePath, ...live.map((record) => record.nodePath)],
    new Set(live.map((record) => record.pid)),
  );
  return result;
}

export interface UpgradeRuntimeAdapter {
  current(instance: UpgradeInstanceReference): Promise<InstallationInstance | undefined>;
  status(record: InstallationInstance, access: UpgradeAccess): Promise<UpgradeRuntimeStatus>;
  verify(record: InstallationInstance, access: UpgradeAccess): Promise<void>;
  reserve(record: InstallationInstance, access: UpgradeAccess): Promise<void>;
  release(record: InstallationInstance, access: UpgradeAccess): Promise<void>;
  stop(record: InstallationInstance, access: UpgradeAccess): Promise<void>;
  restore(
    instance: UpgradeInstanceReference,
    access: UpgradeAccess,
    version: string,
  ): Promise<InstallationInstance>;
  commit(record: InstallationInstance, access: UpgradeAccess): Promise<void>;
  cleanup(record: InstallationInstance, access: UpgradeAccess): Promise<void>;
  cleanupStopped(
    instance: UpgradeInstanceReference,
    access: UpgradeAccess,
    version: string,
  ): Promise<void>;
  assertVacant(installation: NpmInstallation): Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createUpgradeRuntimeAdapter(): UpgradeRuntimeAdapter {
  const current = async (
    instance: UpgradeInstanceReference,
  ): Promise<InstallationInstance | undefined> => {
    const source = instance.source;
    const layout = sashLayout(source.dataDir);
    const deadline = Date.now() + 60_000;
    do {
      const records = listInstallationInstances(source.installationId, source.packageRoot);
      const record = records.find(
        (record) => pathsEqual(record.dataDir, source.dataDir) && isProcessAlive(record.pid),
      );
      const published = readDaemonPidRecord(layout);
      if (record && published?.pid === record.pid && published.token === record.bootId) {
        await verifyUpgradeInstance(record, { processIdentity: false });
        return record;
      }
      const lease = readStateLockRecord(layout.daemonLeaseFile);
      const pid = readDaemonPidRecord(layout);
      if ((!lease || !isProcessAlive(lease.pid)) && (!pid || !isProcessAlive(pid.pid)))
        return undefined;
      await wait(200);
    } while (Date.now() < deadline);
    throw new Error(`Sash instance has a live unverified owner: ${source.dataDir}`);
  };
  const stop = async (record: InstallationInstance, access: UpgradeAccess): Promise<void> => {
    const client = await verifyUpgradeInstance(record);
    await client.upgradeRuntimeAction("stop", access);
    const deadline = Date.now() + 30_000;
    while (isProcessAlive(record.pid) && Date.now() < deadline) await wait(100);
    if (isProcessAlive(record.pid))
      throw new Error(`Sash daemon PID ${record.pid} did not exit; its package was preserved`);
  };
  return {
    current,
    status: async (record, access) =>
      (await verifyUpgradeInstance(record, { processIdentity: false })).upgradeRuntime(
        "status",
        access,
      ),
    verify: async (record, access) => {
      await (await verifyUpgradeInstance(record, { processIdentity: false })).upgradeRuntime(
        "verify",
        access,
      );
    },
    reserve: async (record, access) => {
      await (await verifyUpgradeInstance(record)).upgradeRuntime("reserve", access);
    },
    release: async (record, access) => {
      await (await verifyUpgradeInstance(record)).upgradeRuntimeAction("release", access);
    },
    stop,
    commit: async (record, access) => {
      await (await verifyUpgradeInstance(record, { processIdentity: false })).upgradeRuntime(
        "commit",
        access,
      );
    },
    cleanup: async (record, access) => {
      await (await verifyUpgradeInstance(record, { processIdentity: false })).upgradeRuntimeAction(
        "cleanup",
        access,
      );
    },
    cleanupStopped: async (instance, access, version) => {
      const source = instance.source;
      if (await current(instance))
        throw new Error("Cannot clean a stopped handoff while a daemon owns it");
      const nodePath = version === source.sashVersion ? source.nodePath : instance.restoreNodePath;
      const child = spawn(nodePath, [path.join(source.packageRoot, "dist", "daemon-entry.js")], {
        cwd: source.dataDir,
        env: {
          ...upgradeChildEnv(),
          SASH_HOME: source.dataDir,
          SASH_UPGRADE_TRANSACTION: access.transactionId,
          SASH_UPGRADE_GRANT: access.grant,
          SASH_UPGRADE_CLEANUP: "1",
        },
        windowsHide: true,
        stdio: "ignore",
      });
      const timer = setTimeout(() => {
        if (child.pid)
          void killProcessGracefully(child.pid, {
            timeoutMs: 5000,
            verify: () =>
              child.exitCode === null && child.signalCode === null ? "match" : "mismatch",
          });
      }, 30_000);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        if (code !== 0) throw new Error(`Sash handoff cleanup failed for ${source.dataDir}`);
      } finally {
        clearTimeout(timer);
      }
    },
    assertVacant: async (installation) => {
      const live = listInstallationInstances(installation.id, installation.packageRoot).filter(
        (record) => isProcessAlive(record.pid),
      );
      if (live.length)
        throw new Error(
          `Sash instances are still running: ${live.map((record) => record.pid).join(", ")}`,
        );
      assertNoUnknownSashDaemons(
        await observeUpgradeProcesses(),
        installation.packageRoot,
        [installation.nodePath],
        new Set(),
      );
    },
    restore: async (instance, access, version) => {
      const existing = await current(instance);
      if (existing) {
        const status = await (await verifyUpgradeInstance(existing)).upgradeRuntime(
          "status",
          access,
        );
        if (status.version === version && status.phase === "restored") return existing;
        throw new Error(
          `Sash instance must stop before runtime restoration: ${instance.source.dataDir}`,
        );
      }
      const source = instance.source;
      const layout = sashLayout(source.dataDir);
      const state = readState(layout);
      if (!state) throw new Error("Sash saved state is missing during restoration");
      const observed = await evaluateDaemon(layout, state.settings);
      if (observed.kind !== "stopped")
        throw new Error("Sash instance ownership changed before restore");
      fs.mkdirSync(layout.logsDir, { recursive: true });
      const nodePath = version === source.sashVersion ? source.nodePath : instance.restoreNodePath;
      const child: ChildProcess = withPrivateAppendLogFds(
        layout.daemonLogFile,
        layout.daemonErrLogFile,
        ({ stdoutFd, stderrFd }) =>
          spawn(nodePath, [path.join(source.packageRoot, "dist", "daemon-entry.js")], {
            cwd: source.dataDir,
            env: {
              ...upgradeChildEnv(),
              SASH_HOME: source.dataDir,
              SASH_UPGRADE_TRANSACTION: access.transactionId,
              SASH_UPGRADE_GRANT: access.grant,
            },
            windowsHide: true,
            detached: true,
            stdio: ["ignore", stdoutFd, stderrFd],
          }),
      );
      let spawnError: Error | undefined;
      child.once("error", (error) => {
        spawnError = error;
      });
      child.unref();
      const pid = child.pid;
      if (!pid) throw new Error("Sash restore did not create a daemon process");
      const deadline = Date.now() + 120_000;
      try {
        while (Date.now() < deadline) {
          if (spawnError) throw spawnError;
          if (child.exitCode !== null || child.signalCode !== null || !isProcessAlive(pid))
            throw new Error(
              `Sash restore exited before readiness; check ${layout.daemonErrLogFile}`,
            );
          const record = listInstallationInstances(source.installationId, source.packageRoot).find(
            (record) => record.pid === pid && pathsEqual(record.dataDir, source.dataDir),
          );
          const published = readDaemonPidRecord(layout);
          if (record && published?.pid === pid && published.token === record.bootId) {
            const client = await verifyUpgradeInstance(record);
            const status = await client.upgradeRuntime("status", access);
            if (status.version !== version || status.phase !== "restored")
              throw new Error("Restored daemon reported an unexpected Sash version or phase");
            return record;
          }
          await wait(200);
        }
        throw new Error(`Sash restore did not become ready; check ${layout.daemonErrLogFile}`);
      } catch (error) {
        const stopped = await killProcessGracefully(pid, {
          timeoutMs: 5000,
          verify: () =>
            child.pid === pid && child.exitCode === null && child.signalCode === null
              ? "match"
              : "mismatch",
        });
        if (!stopped)
          throw new Error(
            `Sash restore cleanup could not confirm PID ${pid} stopped; recovery files preserved`,
            { cause: error },
          );
        throw error;
      }
    },
  };
}
