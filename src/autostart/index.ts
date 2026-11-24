import type { AutostartBackend, AutostartContext } from "./context.js";
import { linuxAutostart } from "./linux.js";
import { macosAutostart } from "./macos.js";
import { windowsAutostart } from "./windows.js";

export function createAutostartBackend(context: AutostartContext): AutostartBackend | undefined {
  switch (context.platform) {
    case "win32":
      return windowsAutostart(context);
    case "darwin":
      return macosAutostart(context);
    case "linux":
      return linuxAutostart(context);
  }
}
