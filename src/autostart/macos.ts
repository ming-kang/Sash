import path from "node:path";
import { requireCommandSuccess } from "./command.js";
import {
  type AutostartBackend,
  type AutostartContext,
  assertLauncherValue,
  launcherFilesExist,
} from "./context.js";
import { readRegistration, registerFile, removeRegistration } from "./files.js";

const LABEL = "com.astralyn.sash";

function xml(value: string): string {
  assertLauncherValue(value);
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function launchAgentContents(node: string, entry: string, dataDir: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${LABEL}</string>`,
    "<key>ProgramArguments</key><array>",
    `<string>${xml(node)}</string>`,
    `<string>${xml(entry)}</string>`,
    "</array>",
    "<key>EnvironmentVariables</key><dict>",
    `<key>SASH_HOME</key><string>${xml(dataDir)}</string>`,
    "</dict>",
    "<key>RunAtLoad</key><true/>",
    "<key>KeepAlive</key><false/>",
    "<key>AbandonProcessGroup</key><true/>",
    "</dict></plist>",
    "",
  ].join("\n");
}

export function macAutostart(ctx: AutostartContext): AutostartBackend {
  const file = path.join(ctx.homedir, "Library", "LaunchAgents", `${LABEL}.plist`);
  const domain = () => {
    if (ctx.uid === undefined) throw new Error("Cannot determine the login user ID");
    return `gui/${ctx.uid}`;
  };
  const disabled = async () => {
    const result = await ctx.run("/bin/launchctl", ["print-disabled", domain()]);
    requireCommandSuccess(result);
    if (!/^\s*(?:disabled services\s*=\s*)?\{[\s\S]*\}\s*$/.test(result.stdout)) {
      throw new Error("Unrecognized launchctl autostart state");
    }
    const match = /"com\.astralyn\.sash"\s*=>\s*([^\s,;}]+)/.exec(result.stdout);
    return match !== null && !["false", "enabled"].includes((match[1] ?? "").toLowerCase());
  };
  return {
    async inspect() {
      const current = readRegistration(file);
      if (current === undefined) return "off";
      if (
        !launcherFilesExist(ctx) ||
        current.toString("utf8") !== launchAgentContents(ctx.nodePath, ctx.entryPath, ctx.dataDir)
      ) {
        return "stale";
      }
      return (await disabled()) ? "disabled" : "on";
    },
    async set(enabled) {
      if (!enabled) {
        removeRegistration(file);
        return;
      }
      const wasDisabled = await disabled();
      await registerFile(
        file,
        launchAgentContents(ctx.nodePath, ctx.entryPath, ctx.dataDir),
        async () => {
          requireCommandSuccess(
            await ctx.run("/bin/launchctl", ["enable", `${domain()}/${LABEL}`]),
          );
        },
        async () => {
          if (wasDisabled) {
            requireCommandSuccess(
              await ctx.run("/bin/launchctl", ["disable", `${domain()}/${LABEL}`]),
            );
          }
        },
      );
    },
  };
}
