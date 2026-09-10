import assert from "node:assert/strict";
import type { AutostartCommand } from "../autostart/context.js";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const APPROVAL_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";

export interface FakeWindowsRegistration {
  command: string | null;
  approval: Buffer | null;
}

/**
 * Answer AutostartContext.run calls the way the real Windows helpers respond:
 * `reg.exe query` text output for inspections, the PowerShell environment
 * contract for writes. State lives in the passed object so tests can plant
 * OS-side changes between calls.
 */
export function fakeWindowsRegistryRun(
  state: FakeWindowsRegistration,
  onWrite?: () => void,
): AutostartCommand {
  return async (_command, args, env) => {
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.NPM_TOKEN, undefined);
    assert.equal(env.npm_config_userconfig, undefined);
    if (args[0] === "query") {
      const key = args[1];
      assert.ok(key === RUN_KEY || key === APPROVAL_KEY, `Unexpected registry query: ${key}`);
      const header = key.replace(/^HKCU/, "HKEY_CURRENT_USER");
      if (key === RUN_KEY && state.command !== null) {
        return {
          code: 0,
          stdout: `\r\n${header}\r\n    Sash    REG_SZ    ${state.command}\r\n\r\n`,
          stderr: "",
        };
      }
      if (key === APPROVAL_KEY && state.approval !== null) {
        return {
          code: 0,
          stdout: `\r\n${header}\r\n    Sash    REG_BINARY    ${state.approval.toString("hex").toUpperCase()}\r\n\r\n`,
          stderr: "",
        };
      }
      return {
        code: 1,
        stdout: "",
        stderr: "ERROR: The system was unable to find the specified registry key or value.",
      };
    }
    assert.equal(args[2], "-EncodedCommand");
    assert.ok(env.SASH_AUTOSTART_MODE);
    state.command = env.SASH_AUTOSTART_MODE === "on" ? (env.SASH_AUTOSTART_COMMAND ?? "") : null;
    state.approval = null;
    onWrite?.();
    return { code: 0, stdout: "", stderr: "" };
  };
}
