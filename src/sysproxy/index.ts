import { linuxSystemProxyBackend } from "./linux.js";
import { macosSystemProxyBackend } from "./macos.js";
import type { SystemProxyBackend } from "./types.js";
import { windowsSystemProxyBackend } from "./windows.js";

export function createSystemProxyBackend(platform = process.platform): SystemProxyBackend {
  switch (platform) {
    case "win32":
      return windowsSystemProxyBackend();
    case "darwin":
      return macosSystemProxyBackend();
    case "linux":
      return linuxSystemProxyBackend();
    default: {
      const unavailable = async (): Promise<never> => {
        throw new Error("System proxy integration is not available on this platform");
      };
      return { supported: false, capture: unavailable, apply: unavailable };
    }
  }
}
