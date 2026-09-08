import fs from "node:fs";
import path from "node:path";
import type { AutostartContext } from "./context.js";
import { assertLauncherValue } from "./context.js";

const INSTALL_HINT =
  "Autostart requires a direct global installation. Install with npm install -g @astralyn/sash.";

/** Verify the package layout and its npm bin shim without invoking npm or changing it. */
export function installationIssue(ctx: AutostartContext): string | null {
  try {
    for (const value of [ctx.nodePath, ctx.entryPath, ctx.dataDir]) assertLauncherValue(value);
    if (!path.isAbsolute(ctx.nodePath) || !path.isAbsolute(ctx.entryPath)) return INSTALL_HINT;
    const parts = path.resolve(ctx.packageRoot).replaceAll("\\", "/").toLowerCase().split("/");
    if (parts.some((part) => ["_npx", ".pnpm", ".yarn", ".bun"].includes(part)))
      return INSTALL_HINT;
    const scope = path.dirname(ctx.packageRoot);
    const modules = path.dirname(scope);
    if (
      path.basename(ctx.packageRoot).toLowerCase() !== "sash" ||
      path.basename(scope) !== "@astralyn" ||
      path.basename(modules).toLowerCase() !== "node_modules"
    ) {
      return INSTALL_HINT;
    }
    for (const directory of [ctx.packageRoot, scope, modules]) {
      if (!fs.lstatSync(directory).isDirectory()) return INSTALL_HINT;
    }
    const parent = path.dirname(modules);
    const prefix = parent;
    for (const marker of ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
      if (fs.existsSync(path.join(prefix, marker))) return INSTALL_HINT;
    }
    const cli = path.join(ctx.packageRoot, "dist", "cli.js");
    for (const file of [ctx.nodePath, ctx.entryPath, cli]) {
      if (!fs.statSync(file).isFile()) return INSTALL_HINT;
    }
    const shim = path.join(prefix, "sash.cmd");
    const stat = fs.lstatSync(shim);
    if (!stat.isFile() || stat.size > 64 * 1024) return INSTALL_HINT;
    const contents = fs.readFileSync(shim, "utf8").replaceAll("/", "\\").toLowerCase();
    if (!contents.includes("node_modules\\@astralyn\\sash\\dist\\cli.js")) return INSTALL_HINT;
    return null;
  } catch {
    return INSTALL_HINT;
  }
}
