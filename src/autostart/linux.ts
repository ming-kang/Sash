import path from "node:path";
import { findExecutableOnPath } from "../process.js";
import { requireCommandSuccess } from "./command.js";
import {
  type AutostartBackend,
  type AutostartContext,
  assertLauncherValue,
  launcherFilesExist,
} from "./context.js";
import { readRegistration, registerFile, removeRegistration } from "./files.js";

const UNIT = "sash.service";
const DISABLED_STATES =
  /^(?:enabled-runtime|disabled|masked(?:-runtime)?|not-found|static|indirect|linked(?:-runtime)?|alias|generated|transient)$/;

function quote(value: string, commandArgument = false): string {
  assertLauncherValue(value);
  let result = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  if (commandArgument) result = result.replaceAll("$", () => "$$");
  return `"${result}"`;
}

export function systemdUnitContents(node: string, entry: string, dataDir: string): string {
  return [
    "[Unit]",
    "Description=Start Sash at login",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    "TimeoutStartSec=0",
    // Sash owns the daemon and Core. Disabling this launcher must not kill either.
    "KillMode=process",
    `Environment=${quote(`SASH_HOME=${dataDir}`)}`,
    `ExecStart=${quote(node, true)} ${quote(entry, true)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function linuxAutostart(ctx: AutostartContext): AutostartBackend {
  const file = path.join(ctx.configHome, "systemd", "user", UNIT);
  const command = findExecutableOnPath("systemctl", ctx.env) ?? "/usr/bin/systemctl";
  const run = (args: string[]) => ctx.run(command, ["--user", ...args], { LC_ALL: "C" });
  const enabled = async () => {
    const result = await run(["is-enabled", UNIT]);
    const state = result.stdout.trim();
    if (result.code === 0 && state === "enabled") return true;
    if (DISABLED_STATES.test(state)) return false;
    requireCommandSuccess(result);
    throw new Error(`Unrecognized systemd autostart state: ${state}`);
  };
  return {
    async inspect() {
      const current = readRegistration(file);
      if (current === undefined) return "off";
      if (
        !launcherFilesExist(ctx) ||
        current.toString("utf8") !== systemdUnitContents(ctx.nodePath, ctx.entryPath, ctx.dataDir)
      ) {
        return "stale";
      }
      return (await enabled()) ? "on" : "disabled";
    },
    async set(next) {
      const before = readRegistration(file);
      if (!next) {
        if (before === undefined) return;
        requireCommandSuccess(await run(["disable", UNIT]));
        removeRegistration(file);
        return;
      }
      const wasEnabled = before !== undefined && (await enabled());
      await registerFile(
        file,
        systemdUnitContents(ctx.nodePath, ctx.entryPath, ctx.dataDir),
        async () => {
          requireCommandSuccess(await run(["enable", file]));
          if (!(await enabled())) throw new Error("The OS did not enable Sash autostart");
        },
        async () => {
          requireCommandSuccess(await run(wasEnabled ? ["enable", file] : ["disable", UNIT]));
        },
      );
    },
  };
}
