import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// `npm run` forwards --allow-scripts as npm_config_allow_scripts, which
// project-scoped npm commands reject (EALLOWSCRIPTS).
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^npm_config_allow[-_]scripts$/i.test(key)),
);

/**
 * `npm.cmd` cannot be spawned without a shell on Windows (EINVAL), so run npm's
 * own CLI script through this Node executable instead.
 */
function findNpmCli() {
  const candidates = [
    env.npm_execpath?.trim(),
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (candidate && /\.(cjs|mjs|js)$/i.test(candidate) && fs.existsSync(candidate))
      return candidate;
  }
  return undefined;
}

const npmCli = findNpmCli();
const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const args = [...(npmCli ? [npmCli] : []), "audit", "--audit-level=moderate", "--ignore-scripts"];

const result = spawnSync(command, args, { env, stdio: "inherit" });
if (result.error && !result.status) {
  console.error(`[audit:prod] could not run npm audit: ${result.error.message}`);
}
process.exit(result.status ?? 1);
