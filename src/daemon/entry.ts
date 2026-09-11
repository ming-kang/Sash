import { errorMessage } from "../error-utils.js";
import { atomicWriteFileSync, durableRemoveFileSync } from "../fs-atomic.js";
import { canonicalPath } from "../installation.js";
import { currentPackageRoot } from "../package-info.js";
import { type SashLayout, sashLayout } from "../paths.js";
import { acquireStateLock } from "../state-lock.js";
import type { DaemonInstance } from "./server.js";

export interface DaemonPidRecord {
  pid: number;
  token: string;
  port: number;
}

/** The sole application writer. The data-directory lease admits one daemon at a time. */
export async function runDaemon(opts: { layout?: SashLayout } = {}): Promise<void> {
  const layout = opts.layout ?? sashLayout();
  const packageRoot = canonicalPath(currentPackageRoot());
  const lease = await acquireStateLock(layout.daemonLeaseFile, {
    purpose: "sashd singleton",
    timeoutMs: 0,
  });
  let onSignal: (() => void) | undefined;
  let published = false;
  let instance: DaemonInstance | undefined;
  try {
    // Load application code only after startup admission is acquired.
    const { SashStateStore } = await import("../app-state.js");
    const { createDaemonServer } = await import("./server.js");
    const state = new SashStateStore(layout);
    const current = createDaemonServer({ layout, state, packageRoot });
    instance = current;
    await current.lifecycle.recoverStartup();
    const closed = new Promise<void>((resolve) => current.server.once("close", resolve));
    const port = state.snapshot().settings.daemonPort;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        reject(
          error.code === "EADDRINUSE"
            ? new Error(
                `Daemon port ${port} is already in use by another process. Free the port, or choose a different one: edit "daemonPort" in ${layout.settingsFile} while Sash is stopped, or change it in the dashboard settings.`,
                { cause: error },
              )
            : error,
        );
      };
      current.server.once("error", onError);
      current.server.listen(port, "127.0.0.1", () => {
        current.server.removeListener("error", onError);
        current.server.on("error", (error) => console.error("[sashd] HTTP listener error:", error));
        resolve();
      });
    });
    const record: DaemonPidRecord = {
      pid: process.pid,
      token: current.token,
      port,
    };
    atomicWriteFileSync(layout.daemonPidFile, `${JSON.stringify(record, null, 2)}\n`);
    published = true;
    onSignal = () => {
      void current
        .close()
        .catch((error: unknown) =>
          console.error(`[sashd] shutdown blocked: ${errorMessage(error)}`),
        );
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    await closed;
  } catch (error) {
    if (instance) await instance.close();
    throw error;
  } finally {
    if (onSignal) {
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGINT", onSignal);
    }
    try {
      if (published) durableRemoveFileSync(layout.daemonPidFile);
    } finally {
      lease.release();
    }
  }
}
