import fs from "node:fs";
import { assertAbsolutePath, inspectInstallation } from "../installation.js";
import type { AutostartContext } from "./context.js";
import { assertLauncherValue } from "./context.js";

const INSTALL_HINT =
  "Autostart requires a direct global installation. Install with npm install -g @astralyn/sash.";

/** Verify the package layout and its npm bin shim without invoking npm or changing it. */
export function installationIssue(ctx: AutostartContext): string | null {
  try {
    for (const value of [ctx.nodePath, ctx.entryPath, ctx.dataDir]) assertLauncherValue(value);
    assertAbsolutePath(ctx.entryPath);
    if (inspectInstallation(ctx).kind !== "npm-global" || !fs.statSync(ctx.entryPath).isFile())
      return INSTALL_HINT;
    return null;
  } catch {
    return INSTALL_HINT;
  }
}
