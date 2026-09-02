import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sash-package-smoke-"));

function sanitizedEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  const fixedKeys = new Set([
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_PAT",
    "GITHUB_ACCESS_TOKEN",
    "GH_PAT",
    "NPM_TOKEN",
    "NPM_AUTH_TOKEN",
    "NODE_AUTH_TOKEN",
    "NPM_ID_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
  ]);
  for (const key of Object.keys(env)) {
    const lower = key.toLowerCase();
    if (
      fixedKeys.has(key.toUpperCase()) ||
      (lower.startsWith("npm_config_") &&
        (lower.includes("authtoken") ||
          lower.includes("auth_token") ||
          lower.endsWith("_auth") ||
          lower.includes("password") ||
          lower.includes("username") ||
          lower === "npm_config_userconfig" ||
          lower === "npm_config_globalconfig"))
    ) {
      delete env[key];
    }
  }
  const noProxy = [env.NO_PROXY, env.no_proxy, "127.0.0.1", "localhost", "::1"]
    .filter(Boolean)
    .join(",");
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;
  return env;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: sanitizedEnv(options.env),
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function runNpm(args, options = {}) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && fs.existsSync(npmExecPath)) {
    return run(process.execPath, [npmExecPath, ...args], options);
  }
  return run(process.platform === "win32" ? "npm.cmd" : "npm", args, options);
}

function assertNonEmptyFile(file) {
  const stat = fs.statSync(file);
  assert.equal(stat.isFile(), true, `${file} is not a regular file`);
  assert.ok(stat.size > 0, `${file} is empty`);
}

function walkFiles(directory, base = directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(file, base);
    if (entry.isFile()) return [path.relative(base, file).replaceAll(path.sep, "/")];
    return [];
  });
}

function assertBuiltTree() {
  assertNonEmptyFile(path.join(root, "dist", "cli.js"));
  assertNonEmptyFile(path.join(root, "dist", "ui", "index.html"));
  const assetsDir = path.join(root, "dist", "ui", "assets");
  const assets = fs.readdirSync(assetsDir);
  assert.ok(
    assets.some((file) => file.endsWith(".js")),
    "built UI has no JavaScript asset",
  );
  assert.ok(
    assets.some((file) => file.endsWith(".css")),
    "built UI has no CSS asset",
  );
  for (const asset of assets) assertNonEmptyFile(path.join(assetsDir, asset));
}

function assertPackedFiles(files) {
  const byPath = new Map(files.map((entry) => [entry.path.replaceAll("\\", "/"), entry]));
  const required = [
    "package.json",
    "LICENSE",
    "README.md",
    "CHANGELOG.md",
    "THIRD_PARTY_NOTICES.md",
    "docs/usage.md",
    "docs/backend.md",
    "docs/frontend.md",
    "docs/remix-icon-license.txt",
    "dist/cli.js",
    "dist/webui.js",
    "dist/ui/index.html",
  ];
  for (const file of required) {
    const entry = byPath.get(file);
    assert.ok(entry, `tarball is missing ${file}`);
    assert.ok(entry.size > 0, `tarball contains empty ${file}`);
  }

  const uiAssets = [...byPath.values()].filter((entry) =>
    /^dist\/ui\/assets\/.*\.(?:css|js)$/.test(entry.path),
  );
  assert.ok(uiAssets.some((entry) => entry.path.endsWith(".js") && entry.size > 0));
  assert.ok(uiAssets.some((entry) => entry.path.endsWith(".css") && entry.size > 0));

  const allowedTopLevel = new Set([
    "package.json",
    "LICENSE",
    "README.md",
    "CHANGELOG.md",
    "THIRD_PARTY_NOTICES.md",
    "dist",
    "docs",
  ]);
  for (const file of byPath.keys()) {
    const first = file.split("/")[0];
    assert.ok(allowedTopLevel.has(first), `unexpected top-level tarball path: ${file}`);
    assert.doesNotMatch(file, /(^|\/)(?:node_modules|src|web|scripts|test|tests)(\/|$)/i);
    assert.doesNotMatch(file, /(?:^|\.)test\.[cm]?[jt]sx?$/i);
    assert.doesNotMatch(file, /(^|\/)(?:profiles|state|logs|bin)(\/|$)/i);
    assert.doesNotMatch(file, /(^|\/)(?:sash\.json|config\.ya?ml|\.npmrc|\.env(?:\..*)?)$/i);
    assert.doesNotMatch(file, /\.(?:exe|dll|dylib|so|zip|gz|tgz|tar|bak|pid|lock)$/i);
  }
}

try {
  assertBuiltTree();
  const packDir = path.join(tempRoot, "pack");
  const installDir = path.join(tempRoot, "install");
  const homeDir = path.join(tempRoot, "home");
  fs.mkdirSync(packDir, { recursive: true });

  const packOutput = JSON.parse(runNpm(["pack", "--json", "--pack-destination", packDir]));
  assert.equal(packOutput.length, 1, "npm pack produced an unexpected result count");
  const packed = packOutput[0];
  assertPackedFiles(packed.files);
  const tarball = path.join(packDir, packed.filename);
  assertNonEmptyFile(tarball);

  runNpm(["install", "--prefix", installDir, "--omit=dev", "--no-audit", "--no-fund", tarball]);
  const installedRoot = path.join(installDir, "node_modules", "@astralyn", "sash");
  assert.equal(fs.statSync(installedRoot).isDirectory(), true);
  const installedFiles = walkFiles(installedRoot).sort();
  const packedFiles = packed.files.map((entry) => entry.path.replaceAll("\\", "/")).sort();
  assert.deepEqual(
    installedFiles,
    packedFiles,
    "installed package differs from the packed file set",
  );
  assertNonEmptyFile(path.join(installedRoot, "dist", "ui", "index.html"));
  assert.match(
    fs.readFileSync(path.join(installedRoot, "THIRD_PARTY_NOTICES.md"), "utf8"),
    /Vue\.js[\s\S]*Remix Icon/,
  );

  const previousHome = process.env.SASH_HOME;
  process.env.SASH_HOME = homeDir;
  try {
    const installedWebui = await import(
      `${pathToFileURL(path.join(installedRoot, "dist", "webui.js")).href}?smoke=${Date.now()}`
    );
    assert.equal(
      path.resolve(installedWebui.resolveUiDir()),
      path.resolve(installedRoot, "dist", "ui"),
    );
  } finally {
    if (previousHome === undefined) delete process.env.SASH_HOME;
    else process.env.SASH_HOME = previousHome;
  }

  const cliEnv = { SASH_HOME: homeDir };
  const version = runNpm(
    ["exec", "--offline", "--yes=false", "--prefix", installDir, "--", "sash", "--version"],
    { env: cliEnv },
  ).trim();
  assert.equal(version, packageJson.version);
  const help = runNpm(
    ["exec", "--offline", "--yes=false", "--prefix", installDir, "--", "sash", "--help"],
    { env: cliEnv },
  );
  assert.match(help, /Usage:\s+sash/);
  assert.match(help, /show runtime state/);

  console.log(
    `[package-smoke] packed, installed and verified ${packageJson.name}@${packageJson.version} (${packed.files.length} files)`,
  );
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
