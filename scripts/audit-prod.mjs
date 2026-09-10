import { spawnSync } from "node:child_process";

// npm run forwards --allow-scripts as npm_config_allow_scripts to children, and
// project-scoped npm commands reject that flag (EALLOWSCRIPTS). Run the audit
// with that single variable scrubbed so `npm run audit:prod` behaves like a
// direct invocation. All dependencies are bundled into dist, so audit covers
// the full tree (no --omit=dev).
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^npm_config_allow[-_]scripts$/i.test(key)),
);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["audit", "--audit-level=moderate", "--ignore-scripts"], {
  env,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
