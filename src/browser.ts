import { spawn } from "node:child_process";

/** Open a URL in the default browser without blocking; tolerant of headless envs. */
export function openInBrowser(url: string): void {
  const command =
    process.platform === "win32"
      ? { cmd: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }
      : process.platform === "darwin"
        ? { cmd: "open", args: [url] }
        : { cmd: "xdg-open", args: [url] };
  try {
    const child = spawn(command.cmd, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {
      // headless environment: caller already printed the URL
    });
    child.unref();
  } catch {
    // ignore: URL is printed by the caller as fallback
  }
}
