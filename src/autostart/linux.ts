import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { atomicWriteFileSync, durableRemoveFileSync } from "../fs-atomic.js";
import {
  type AutostartBackend,
  type AutostartContext,
  assertLauncherValue,
  launcherFilesExist,
} from "./context.js";
import type { RegisteredAutostartState } from "./contract.js";

// XDG autostart entry; on a headless session the file is still managed — it simply never fires.
export function linuxAutostartFile(ctx: AutostartContext): string {
  const configHome =
    ctx.env.XDG_CONFIG_HOME && path.isAbsolute(ctx.env.XDG_CONFIG_HOME)
      ? ctx.env.XDG_CONFIG_HOME
      : path.join(ctx.homedir, ".config");
  return path.join(configHome, "autostart", "sash.desktop");
}

function expectedExec(ctx: AutostartContext): string {
  const quote = (value: string) => {
    assertLauncherValue(value);
    if (/[\s"\\$`!]/.test(value)) {
      return `"${value.replace(/(["\\$`!])/g, "\\$1")}"`;
    }
    return value;
  };
  // env carries the data dir so a custom SASH_HOME session starts that same
  // instance at login, matching the Windows launcher's SASH_HOME handling.
  return `${quote("/usr/bin/env")} ${quote(`SASH_HOME=${ctx.dataDir}`)} ${quote(ctx.nodePath)} ${quote(ctx.entryPath)}`;
}

export function linuxDesktopEntry(ctx: AutostartContext): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    "Name=Sash",
    "Comment=Sash network toolbox daemon",
    `Exec=${expectedExec(ctx)}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

interface ParsedDesktopFile {
  exec: string | null;
  hidden: boolean;
}

function parseDesktopFile(text: string): ParsedDesktopFile {
  let exec: string | null = null;
  let hidden = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (key === "Exec") exec = value;
    if (key === "Hidden") hidden = value.toLowerCase() === "true";
  }
  return { exec, hidden };
}

export function linuxAutostart(ctx: AutostartContext): AutostartBackend {
  const file = linuxAutostartFile(ctx);
  return {
    async inspect(): Promise<RegisteredAutostartState> {
      let text: string;
      try {
        text = await fsp.readFile(file, "utf8");
      } catch {
        return "off";
      }
      const parsed = parseDesktopFile(text);
      if (parsed.hidden) return "disabled";
      if (parsed.exec === null || parsed.exec !== expectedExec(ctx)) return "stale";
      return "on";
    },
    async set(enabled: boolean): Promise<void> {
      if (!enabled) {
        durableRemoveFileSync(file);
        return;
      }
      if (!launcherFilesExist(ctx)) {
        throw new Error("Autostart entry point is missing; reinstall or rebuild Sash");
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      atomicWriteFileSync(file, linuxDesktopEntry(ctx), 0o644);
    },
  };
}
