import { isSystemProxySupported } from "./common.js";
import {
  applyDarwinSnapshot,
  captureDarwinSnapshot,
  createDarwinTarget,
  darwinState,
} from "./darwin.js";
import {
  applyLinuxSnapshot,
  captureLinuxSnapshot,
  createLinuxTarget,
  linuxState,
} from "./gnome.js";
import { parseSystemProxySnapshot, snapshotsCompatible, snapshotsEquivalent } from "./snapshot.js";
import type {
  EnableOptions,
  SystemProxyBackend,
  SystemProxySnapshot,
  SystemProxyState,
} from "./types.js";
import {
  applyWindowsSnapshot,
  captureWindowsSnapshot,
  createWindowsTarget,
  windowsState,
} from "./windows.js";

interface SupportedBackendOperations {
  capture(): Promise<SystemProxySnapshot>;
  createTarget(original: SystemProxySnapshot, opts: EnableOptions): SystemProxySnapshot;
  apply(snapshot: SystemProxySnapshot): Promise<void>;
  state(snapshot: SystemProxySnapshot): SystemProxyState;
}

function createSupportedBackend(operations: SupportedBackendOperations): SystemProxyBackend {
  return {
    supported: true,
    capture: () => operations.capture(),
    createTarget: (original, opts) => operations.createTarget(original, opts),
    apply: (snapshot) => operations.apply(snapshot),
    equivalent: snapshotsEquivalent,
    compatible: snapshotsCompatible,
    state: (snapshot) => operations.state(snapshot),
  };
}

class UnsupportedSystemProxyBackend implements SystemProxyBackend {
  readonly supported = false;

  constructor(readonly details: string) {}

  async capture(): Promise<SystemProxySnapshot> {
    throw new Error(this.details);
  }

  createTarget(_original: SystemProxySnapshot, _opts: EnableOptions): SystemProxySnapshot {
    throw new Error(this.details);
  }

  async apply(_snapshot: SystemProxySnapshot): Promise<void> {
    throw new Error(this.details);
  }

  equivalent(a: SystemProxySnapshot, b: SystemProxySnapshot): boolean {
    return snapshotsEquivalent(a, b);
  }

  compatible(
    _current: SystemProxySnapshot,
    _original: SystemProxySnapshot,
    _target: SystemProxySnapshot,
  ): boolean {
    return false;
  }

  state(snapshot: SystemProxySnapshot): SystemProxyState {
    parseSystemProxySnapshot(snapshot);
    return { supported: false, enabled: false, details: this.details };
  }
}

/** Create a backend for the current platform (or a supplied platform in tests). */
export function createSystemProxyBackend(
  platform: NodeJS.Platform = process.platform,
): SystemProxyBackend {
  switch (platform) {
    case "win32":
      return createSupportedBackend({
        capture: captureWindowsSnapshot,
        createTarget: createWindowsTarget,
        apply: applyWindowsSnapshot,
        state: windowsState,
      });
    case "darwin":
      return createSupportedBackend({
        capture: captureDarwinSnapshot,
        createTarget: createDarwinTarget,
        apply: applyDarwinSnapshot,
        state: darwinState,
      });
    case "linux":
      return isSystemProxySupported("linux")
        ? createSupportedBackend({
            capture: captureLinuxSnapshot,
            createTarget: createLinuxTarget,
            apply: applyLinuxSnapshot,
            state: linuxState,
          })
        : new UnsupportedSystemProxyBackend(
            "gsettings not available; desktop proxy configuration unsupported",
          );
    default:
      return new UnsupportedSystemProxyBackend(`unsupported platform: ${platform}`);
  }
}
