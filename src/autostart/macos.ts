import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../error-utils.js";
import { atomicWriteFile } from "../fs-atomic.js";
import type { AutostartBackend, AutostartContext } from "./context.js";
import { assertLauncherValue, launcherFilesExist, requireCommandSuccess } from "./context.js";
import type { RegisteredAutostartState } from "./contract.js";

export const MACOS_AUTOSTART_LABEL = "dev.astralyn.sash";
const LAUNCHCTL = "/bin/launchctl";

function plistPath(ctx: AutostartContext): string {
  return path.join(ctx.homedir, "Library", "LaunchAgents", `${MACOS_AUTOSTART_LABEL}.plist`);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function macosPlistContents(ctx: AutostartContext): string {
  for (const value of [ctx.nodePath, ctx.entryPath, ctx.dataDir]) {
    assertLauncherValue(value);
    if (!path.isAbsolute(value)) throw new Error("Autostart paths must be absolute");
  }
  const logFile = path.join(ctx.dataDir, "logs", "autostart.out.log");
  const errFile = path.join(ctx.dataDir, "logs", "autostart.err.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
<key>Label</key>
<string>${MACOS_AUTOSTART_LABEL}</string>
<key>ProgramArguments</key>
<array>
<string>${escapeXml(ctx.nodePath)}</string>
<string>${escapeXml(ctx.entryPath)}</string>
</array>
<key>EnvironmentVariables</key>
<dict>
<key>SASH_HOME</key>
<string>${escapeXml(ctx.dataDir)}</string>
</dict>
<key>RunAtLoad</key>
<true/>
<key>ProcessType</key>
<string>Background</string>
<key>StandardOutPath</key>
<string>${escapeXml(logFile)}</string>
<key>StandardErrorPath</key>
<string>${escapeXml(errFile)}</string>
</dict>
</plist>
`;
}

async function launchctlUid(ctx: AutostartContext): Promise<number> {
  if (typeof process.getuid === "function") return process.getuid();
  const result = await ctx.run("/usr/bin/id", ["-u"]);
  requireCommandSuccess(result);
  return Number.parseInt(result.stdout.trim(), 10);
}

/**
 * Tri-state registration probe. `launchctl print` exits non-zero both when
 * the service was never loaded AND on GUI-domain/permission errors — only
 * the "service not found" family means absent; anything else is an error
 * the caller must see, never silently "not registered".
 */
async function launchctlPrint(ctx: AutostartContext, uid: number): Promise<"loaded" | "absent"> {
  const result = await ctx.run(LAUNCHCTL, ["print", `gui/${uid}/${MACOS_AUTOSTART_LABEL}`]);
  if (result.code === 0) return "loaded";
  const detail = `${result.stdout}\n${result.stderr}`;
  if (/could not find service|service not found|no such process|not loaded/i.test(detail)) {
    return "absent";
  }
  throw new Error(`launchctl print failed (exit ${result.code}): ${detail.trim().slice(0, 300)}`);
}

/**
 * null when print-disabled itself failed — the caller must NOT treat an
 * undeterminable state as "not disabled".
 */
async function launchctlDisabled(ctx: AutostartContext, uid: number): Promise<boolean | null> {
  const result = await ctx.run(LAUNCHCTL, ["print-disabled", `gui/${uid}`]);
  if (result.code !== 0) return null;
  const pattern = new RegExp(
    `["']?${MACOS_AUTOSTART_LABEL.replace(/\./g, "\\.")}["']?\\s*=>?\\s*(disabled|true|1)`,
  );
  return pattern.test(result.stdout);
}

export function macosAutostart(ctx: AutostartContext): AutostartBackend {
  const file = plistPath(ctx);
  return {
    async inspect(): Promise<RegisteredAutostartState> {
      if (!fs.existsSync(file)) return "off";
      let contents: string;
      try {
        contents = fs.readFileSync(file, "utf8");
      } catch {
        return "stale";
      }
      if (!launcherFilesExist(ctx)) return "stale";
      let generated: string;
      try {
        generated = macosPlistContents(ctx);
      } catch {
        return "stale";
      }
      if (contents !== generated) return "stale";
      const uid = await launchctlUid(ctx);
      const disabled = await launchctlDisabled(ctx, uid);
      if (disabled === true) return "disabled";
      if (disabled === null) return "stale";
      // A plist that matches and is not disabled is registered at next login
      // even if launchctl has not loaded it in the current gui session yet.
      return "on";
    },
    async set(enabled) {
      const uid = await launchctlUid(ctx);
      if (!enabled) {
        const before = await launchctlPrint(ctx, uid);
        const bootout = await ctx.run(LAUNCHCTL, [
          "bootout",
          `gui/${uid}/${MACOS_AUTOSTART_LABEL}`,
        ]);
        if (bootout.code !== 0 && before === "loaded") {
          requireCommandSuccess(bootout); // failed AND still loaded: report
        }
        await fsp.rm(file, { force: true });
        return;
      }
      // Snapshot the existing registration BEFORE touching anything: plist
      // contents, loaded state, and disabled state. A state that cannot be
      // determined means nothing is changed — never guess and roll forward.
      let previousContents: string | null;
      try {
        previousContents = await fsp.readFile(file, "utf8");
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") {
          previousContents = null;
        } else {
          throw new Error(
            `Could not read the existing LaunchAgent plist; leaving the registration unchanged: ${errorMessage(readError)}`,
          );
        }
      }
      const wasLoaded = await launchctlPrint(ctx, uid);
      // print-disabled works without a plist: a disabled override survives
      // plist removal, so it must be recorded (and restored) either way.
      const wasDisabled = await launchctlDisabled(ctx, uid);
      if (wasDisabled === null) {
        throw new Error(
          "Could not determine the LaunchAgent's disabled state; leaving the existing registration unchanged",
        );
      }
      const contents = macosPlistContents(ctx);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await atomicWriteFile(file, contents, 0o644);
      try {
        // Drop any disabled override left by a previous launchctl disable
        // before the bootstrap, otherwise the agent would stay off. Its
        // exit code matters: a failed enable leaves the agent disabled.
        requireCommandSuccess(
          await ctx.run(LAUNCHCTL, ["enable", `gui/${uid}/${MACOS_AUTOSTART_LABEL}`]),
        );
        // Bootout only a service that is actually loaded; a failure against
        // an absent service is expected, against a loaded one is an error.
        if ((await launchctlPrint(ctx, uid)) === "loaded") {
          requireCommandSuccess(
            await ctx.run(LAUNCHCTL, ["bootout", `gui/${uid}/${MACOS_AUTOSTART_LABEL}`]),
          );
        }
        requireCommandSuccess(await ctx.run(LAUNCHCTL, ["bootstrap", `gui/${uid}`, file]));
        if ((await launchctlPrint(ctx, uid)) !== "loaded") {
          throw new Error("LaunchAgent was written but launchctl did not load it");
        }
      } catch (error) {
        // Roll back only what was actually changed, and report rollback
        // failures separately instead of swallowing them.
        const rollbackErrors: string[] = [];
        const rollbackRun = async (args: string[], tolerateAbsent = false) => {
          const result = await ctx.run(LAUNCHCTL, args);
          const detail = `${result.stdout}\n${result.stderr}`;
          if (
            result.code !== 0 &&
            !(
              tolerateAbsent &&
              /could not find service|service not found|no such process/i.test(detail)
            )
          ) {
            rollbackErrors.push(
              `launchctl ${args[0]} failed (exit ${result.code}): ${detail.trim().slice(0, 200)}`,
            );
          }
        };
        await rollbackRun(["bootout", `gui/${uid}/${MACOS_AUTOSTART_LABEL}`], true);
        if (previousContents !== null) {
          try {
            await atomicWriteFile(file, previousContents, 0o644);
          } catch (writeError) {
            rollbackErrors.push(`restore plist failed: ${errorMessage(writeError)}`);
          }
          if (wasLoaded === "loaded") {
            await rollbackRun(["bootstrap", `gui/${uid}`, file]);
          }
        } else {
          await fsp
            .rm(file, { force: true })
            .catch((rmError) =>
              rollbackErrors.push(`remove plist failed: ${errorMessage(rmError)}`),
            );
          if (wasLoaded === "loaded") {
            rollbackErrors.push(
              "previous registration was loaded without our plist; it cannot be restored",
            );
          }
        }
        // A disabled override persists in the gui domain without a plist:
        // restore it whenever the service was disabled before, whether or
        // not a plist existed.
        if (wasDisabled === true) {
          await rollbackRun(["disable", `gui/${uid}/${MACOS_AUTOSTART_LABEL}`]);
        }
        throw rollbackErrors.length > 0
          ? new Error(`${errorMessage(error)}; rollback errors: ${rollbackErrors.join("; ")}`)
          : error;
      }
    },
  };
}
