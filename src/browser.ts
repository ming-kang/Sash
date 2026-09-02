import { type SpawnOptions, spawn } from "node:child_process";
import { buildSanitizedEnv, findExecutableOnPath, windowsSystemExecutable } from "./process.js";

export function buildBrowserSpawnOptions(sourceEnv: NodeJS.ProcessEnv = process.env): SpawnOptions {
  return {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: buildSanitizedEnv(sourceEnv),
  };
}

/** Open a URL in the default browser without blocking; tolerant of headless envs. */
export function openInBrowser(url: string): void {
  const command =
    process.platform === "win32"
      ? { cmd: windowsSystemExecutable("rundll32.exe"), args: ["url.dll,FileProtocolHandler", url] }
      : process.platform === "darwin"
        ? { cmd: "/usr/bin/open", args: [url] }
        : { cmd: findExecutableOnPath("xdg-open") ?? "xdg-open", args: [url] };
  try {
    const child = spawn(command.cmd, command.args, buildBrowserSpawnOptions());
    child.on("error", () => {
      // headless environment: caller already printed the URL
    });
    child.unref();
  } catch {
    // ignore: URL is printed by the caller as fallback
  }
}
