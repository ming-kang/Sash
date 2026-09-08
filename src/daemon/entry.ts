import { SashStateStore } from "../app-state.js";
import { atomicWriteFileSync, durableRemoveFileSync } from "../fs-atomic.js";
import { type SashLayout, sashLayout } from "../paths.js";
import { acquireStateLock } from "../state-lock.js";
import { createDaemonServer } from "./server.js";

export interface DaemonPidRecord {
  pid: number;
  token: string;
  port: number;
  startedAt: string;
}

/** The only production state owner. Initialization and recovery precede the listener. */
export async function runDaemon(opts: { layout?: SashLayout } = {}): Promise<void> {
  const layout = opts.layout ?? sashLayout();
  const lease = await acquireStateLock(layout.daemonLeaseFile, {
    purpose: "sashd singleton",
    timeoutMs: 0,
  });
  let onSignal: (() => void) | undefined;
  let published = false;
  try {
    const state = new SashStateStore(layout);
    const instance = createDaemonServer({ layout, state });
    await instance.lifecycle.recoverStartup();
    const closed = new Promise<void>((resolve) => instance.server.once("close", resolve));
    const port = state.snapshot().settings.daemonPort;
    await new Promise<void>((resolve, reject) => {
      instance.server.once("error", reject);
      instance.server.listen(port, "127.0.0.1", resolve);
    });
    const record: DaemonPidRecord = {
      pid: process.pid,
      token: instance.token,
      port,
      startedAt: new Date().toISOString(),
    };
    atomicWriteFileSync(layout.daemonPidFile, `${JSON.stringify(record, null, 2)}\n`);
    published = true;
    onSignal = () => {
      void instance
        .close()
        .catch((error: unknown) =>
          console.error(
            `[sashd] shutdown blocked: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    await closed;
  } finally {
    if (onSignal) {
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGINT", onSignal);
    }
    if (published) durableRemoveFileSync(layout.daemonPidFile);
    lease.release();
  }
}
