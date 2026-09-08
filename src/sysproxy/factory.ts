import { snapshotsCompatible, snapshotsEquivalent } from "./snapshot.js";
import type { SystemProxyBackend } from "./types.js";
import {
  applyWindowsSnapshot,
  captureWindowsSnapshot,
  createWindowsTarget,
  windowsState,
} from "./windows.js";

export function createSystemProxyBackend(
  platform: NodeJS.Platform = process.platform,
): SystemProxyBackend {
  if (platform === "win32")
    return {
      supported: true,
      capture: captureWindowsSnapshot,
      createTarget: createWindowsTarget,
      apply: applyWindowsSnapshot,
      equivalent: snapshotsEquivalent,
      compatible: snapshotsCompatible,
      state: windowsState,
    };
  const unavailable = (): never => {
    throw new Error("System proxy integration is available on Windows only");
  };
  return {
    supported: false,
    capture: async () => unavailable(),
    createTarget: unavailable,
    apply: async () => unavailable(),
    equivalent: snapshotsEquivalent,
    compatible: snapshotsCompatible,
    state: () => ({
      supported: false,
      enabled: false,
      details: "System proxy integration is available on Windows only",
    }),
  };
}
