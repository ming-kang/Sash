import { assertCoreInstallationConsistent } from "../core.js";
import { recoverCoreInstallTransaction } from "../core-install-transaction.js";
import { atomicWriteFileSync } from "../fs-atomic.js";
import {
  readManagedStateTransactionStatus,
  recoverManagedStateTransaction,
} from "../managed-state-transaction.js";
import { type SashLayout, sashLayout } from "../paths.js";
import { clearPidRecord } from "../process.js";
import { migrateProfileState } from "../profile-migration.js";
import { reconcileOrphanedRuntime } from "../runtime-recovery.js";
import { loadSettings } from "../settings.js";
import { acquireStateLock, StateMutationQueue } from "../state-lock.js";
import { createDaemonServer } from "./server.js";

export interface DaemonPidRecord {
  pid: number;
  token: string;
  port: number;
  startedAt: string;
}

/**
 * Production daemon entrypoint. Reconciles stale state, starts the HTTP
 * listener, writes the daemon PID record, and handles termination signals.
 */
export async function runDaemon(opts: { layout?: SashLayout } = {}): Promise<void> {
  const layout = opts.layout ?? sashLayout();
  const daemonLease = await acquireStateLock(layout.daemonLeaseFile, {
    purpose: "sashd singleton",
    timeoutMs: 0,
  });
  let onSignal: (() => void) | undefined;

  try {
    const initialization = new StateMutationQueue(layout.mutationLockFile);
    const settings = await initialization.run("initialize daemon state", async () => {
      recoverCoreInstallTransaction(layout);
      const managed = readManagedStateTransactionStatus(layout);
      if (managed?.coordination !== "core-update") {
        recoverManagedStateTransaction(layout);
      }

      let loaded = loadSettings(layout);
      // Restore proxy ownership and terminate only a verified stale Core before
      // touching an executable rollback slot. Coordinated managed snapshots may
      // remain published when the candidate still needs a managed start.
      const pendingUpdate = await reconcileOrphanedRuntime({ layout, settings: loaded });
      assertCoreInstallationConsistent(layout);
      loaded = loadSettings(layout);
      if (!pendingUpdate) {
        // Give the legacy URL priority. An unmanaged config.yaml is imported
        // only if the URL migration did not create an index.
        await migrateProfileState(loaded, layout);
      }
      return loaded;
    });

    const instance = createDaemonServer({ layout, settings });
    const serverClosed = new Promise<void>((resolve) => instance.server.once("close", resolve));

    const port = settings.daemonPort;
    await new Promise<void>((resolve, reject) => {
      instance.server.listen(port, "127.0.0.1", () => resolve());
      instance.server.once("error", reject);
    });

    const pidRecord: DaemonPidRecord = {
      pid: process.pid,
      token: instance.token,
      port,
      startedAt: new Date().toISOString(),
    };
    atomicWriteFileSync(layout.daemonPidFile, `${JSON.stringify(pidRecord, null, 2)}\n`);

    onSignal = () => {
      void instance.close().catch((err) => {
        console.error(`[sashd] shutdown blocked: ${(err as Error).message}`);
      });
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);

    await serverClosed;
  } finally {
    if (onSignal) {
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGINT", onSignal);
    }
    clearPidRecord(layout.daemonPidFile);
    daemonLease.release();
  }
}
