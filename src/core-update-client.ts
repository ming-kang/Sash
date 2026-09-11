import { setTimeout as delay } from "node:timers/promises";
import type { CoreUpdateResponse } from "./contracts.js";
import type { CoreUpdateProgress, CoreUpdateStage } from "./core-update-progress.js";
import type { SashDaemonClient } from "./daemon-client.js";

const STAGE_TEXT: Record<CoreUpdateStage, string> = {
  checking: "Checking Core installation",
  resolving: "Checking the Core release",
  downloading: "Downloading Core",
  extracting: "Extracting Core",
  verifying: "Verifying the Core executable",
  validating: "Validating the runtime configuration",
  waiting: "Waiting for pending operations",
  installing: "Installing and verifying Core; restoring runtime state",
};

export function coreUpdateProgressText(progress: CoreUpdateProgress): string {
  const target = progress.target ? ` (${progress.target})` : "";
  const bytes = progress.downloading
    ? `: ${(progress.downloaded / 1048576).toFixed(1)}${progress.total ? ` / ${(progress.total / 1048576).toFixed(1)}` : ""} MiB`
    : "";
  return `${STAGE_TEXT[progress.stage]}${target}${bytes}`;
}

/** Supplemental progress reads never retry or determine the outcome of the mutation. */
export async function updateCoreWithProgress(
  client: Pick<SashDaemonClient, "updateCore" | "coreUpdateProgress">,
  version?: string,
  onProgress?: (progress: CoreUpdateProgress) => void,
): Promise<CoreUpdateResponse> {
  if (!onProgress) return client.updateCore(version);
  const controller = new AbortController();
  const updating = client.updateCore(version);
  const watching = (async () => {
    while (!controller.signal.aborted) {
      try {
        await delay(500, undefined, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) return;
        throw error;
      }
      try {
        const progress = await client.coreUpdateProgress();
        if (!controller.signal.aborted && progress) onProgress(progress);
      } catch {
        // Progress errors do not affect the update request.
      }
    }
  })();
  try {
    return await updating;
  } finally {
    controller.abort();
    await watching;
  }
}
