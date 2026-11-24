import { type TunPlatform, unsupportedTunPlatform } from "../tun-service.js";
import { linuxTunPlatform } from "./linux.js";
import { macosTunPlatform } from "./macos.js";
import { windowsTunPlatform } from "./windows.js";

export function createTunPlatform(platform = process.platform): TunPlatform {
  switch (platform) {
    case "win32":
      return windowsTunPlatform();
    case "darwin":
      return macosTunPlatform();
    case "linux":
      return linuxTunPlatform();
    default:
      return unsupportedTunPlatform();
  }
}
