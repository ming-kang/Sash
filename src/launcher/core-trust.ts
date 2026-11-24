import path from "node:path";

export function protectedCorePath(binDir: string): string {
  return path.join(binDir, process.platform === "win32" ? "mihomo.exe" : "mihomo");
}

export function protectedHelperPath(binDir: string): string {
  return path.join(binDir, process.platform === "win32" ? "sash-helper.exe" : "sash-helper");
}
