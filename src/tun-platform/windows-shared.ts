import { execFileSync } from "node:child_process";
import path from "node:path";
import { z } from "zod";

export const HELPER_SERVICE_NAME = "SashTunHelper";
export const HELPER_PIPE_NAME = "sash-helper";
export const HELPER_EXE_NAME = "sash-helper.exe";
export const WINTUN_VERSION = "0.14.1";
export const WINTUN_URL = `https://www.wintun.net/builds/wintun-${WINTUN_VERSION}.zip`;
export const WINTUN_SHA256 = {
  // wintun.zip contains wintun/bin/{amd64,arm64}/wintun.dll — each arch pinned.
  x64: "e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce",
  arm64: "f7ba89005544be9d85231a9e0d5f23b2d15b3311667e2dad0debd344918a3f80",
} as const;
export const HELPER_MANIFEST_NAME = "helper-manifest.json";

export const SID_PATTERN = /^S-1-\d+(-\d+)+$/;

/**
 * The system Known Folder for shared application data (FOLDERID_ProgramData).
 * Resolved through the shell, never `%ProgramData%`: an unprivileged caller
 * can rewrite its own environment and aim the protected root anywhere.
 */
let programDataCache: string | undefined;
export function programDataDir(env: NodeJS.ProcessEnv = process.env): string {
  // Test isolation only — the override is ignored outside NODE_ENV=test.
  const override = env.SASH_PROGRAMDATA_DIR?.trim();
  if (override && env.NODE_ENV === "test" && path.win32.isAbsolute(override)) {
    return path.win32.resolve(override);
  }
  if (programDataCache) return programDataCache;
  try {
    const resolved = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Environment]::GetFolderPath('CommonApplicationData')",
      ],
      { encoding: "utf8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    if (path.win32.isAbsolute(resolved)) {
      programDataCache = resolved;
      return resolved;
    }
  } catch {}
  return "C:\\ProgramData";
}

/** The test suite overrides the protected root; production must not. */
export function helperProtectedDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SASH_HELPER_DIR?.trim();
  if (override && env.NODE_ENV === "test" && path.win32.isAbsolute(override))
    return path.win32.resolve(override);
  return path.win32.join(programDataDir(env), "Sash", "core");
}

export function helperBinDir(env?: NodeJS.ProcessEnv): string {
  return path.win32.join(helperProtectedDir(env), "bin");
}

export function helperPipePath(name = HELPER_PIPE_NAME): string {
  return `\\\\.\\pipe\\${name}`;
}

export function resolveHelperDistExe(
  packageRoot: string,
  arch: NodeJS.Architecture = process.arch,
): string {
  return path.join(packageRoot, "dist", `sash-helper-win32-${arch}.exe`);
}

const CORE_SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const helperManifestSchema = z.strictObject({
  version: z.literal(1),
  installerSid: z.string().regex(SID_PATTERN),
  coreSha256: z.string().regex(CORE_SHA256_PATTERN),
  helperSha256: z.string().regex(CORE_SHA256_PATTERN),
  helperVersion: z.string().min(1).max(64),
  winswSha256: z.string().regex(CORE_SHA256_PATTERN).optional(),
  wintunSha256: z.string().regex(CORE_SHA256_PATTERN),
  coreVersion: z.string().min(1).max(64),
  installedAt: z.string().min(1).max(64),
});

export type HelperManifest = z.output<typeof helperManifestSchema>;

export function helperManifestPath(protectedDir: string): string {
  return path.win32.join(protectedDir, HELPER_MANIFEST_NAME);
}
