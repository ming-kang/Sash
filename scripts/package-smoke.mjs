import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const temporaryParent = fs.realpathSync(os.tmpdir());
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(temporaryParent, "sash-package-smoke-")));
const npmConfig = path.join(tempRoot, "npmrc");
const npmGlobalConfig = path.join(tempRoot, "global-npmrc");
fs.writeFileSync(npmConfig, "", { mode: 0o600 });
fs.writeFileSync(npmGlobalConfig, "", { mode: 0o600 });

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
  const isolatedArgs = [
    "--userconfig",
    npmConfig,
    "--globalconfig",
    npmGlobalConfig,
    "--cache",
    path.join(tempRoot, "npm-cache"),
    "--registry=https://registry.npmjs.org",
    ...args,
  ];
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && fs.existsSync(npmExecPath)) {
    return run(process.execPath, [npmExecPath, ...isolatedArgs], options);
  }
  const bundledCli = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (fs.existsSync(bundledCli)) {
    return run(process.execPath, [bundledCli, ...isolatedArgs], options);
  }
  return run(process.platform === "win32" ? "npm.cmd" : "npm", isolatedArgs, options);
}

function assertNonEmptyFile(file) {
  const stat = fs.statSync(file);
  assert.equal(stat.isFile(), true, `${file} is not a regular file`);
  assert.ok(stat.size > 0, `${file} is empty`);
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
    "docs/completions/sash.ps1",
    "docs/remix-icon-license.txt",
    "dist/cli.js",
    "dist/daemon-entry.js",
    "dist/autostart-entry.js",
    "dist/webui.js",
    "dist/installation.js",
    "dist/ui/index.html",
    "dist/ui/.vite/manifest.json",
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

const installSpec = process.argv[2];

try {
  const packDir = path.join(tempRoot, "pack");
  const installDir = path.join(tempRoot, "install");
  const homeDir = path.join(tempRoot, "home");
  fs.mkdirSync(packDir, { recursive: true });

  let spec = installSpec;
  let expectedVersion = packageJson.version;
  let packedFiles;
  if (spec) {
    const packOutput = JSON.parse(
      runNpm(["pack", spec, "--dry-run", "--json", "--pack-destination", packDir]),
    );
    assert.equal(packOutput.length, 1, "npm pack produced an unexpected result count");
    expectedVersion = packOutput[0].version ?? expectedVersion;
    packedFiles = packOutput[0].files;
  } else {
    const packOutput = JSON.parse(runNpm(["pack", "--json", "--pack-destination", packDir]));
    assert.equal(packOutput.length, 1, "npm pack produced an unexpected result count");
    const packed = packOutput[0];
    spec = path.join(packDir, packed.filename);
    assertNonEmptyFile(spec);
    packedFiles = packed.files;
  }
  assertPackedFiles(packedFiles);

  runNpm([
    "install",
    "--global",
    "--prefix",
    installDir,
    "--install-strategy=nested",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    spec,
  ]);
  const installedRoot = path.join(
    installDir,
    ...(process.platform === "win32" ? [] : ["lib"]),
    "node_modules",
    "@astralyn",
    "sash",
  );
  assert.equal(fs.statSync(installedRoot).isDirectory(), true);
  assertNonEmptyFile(path.join(installedRoot, "dist", "ui", "index.html"));
  const { inspectInstallation } = await import(
    pathToFileURL(path.join(installedRoot, "dist", "installation.js")).href
  );
  assert.equal(inspectInstallation().kind, "npm-global");
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

  const cliEnv = {
    SASH_HOME: homeDir,
    LOCALAPPDATA: path.join(tempRoot, "local"),
    XDG_STATE_HOME: path.join(tempRoot, "xdg-state"),
  };
  const runCli = (args, extension = ".ps1") =>
    process.platform === "win32"
      ? run(
          "pwsh",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$ErrorActionPreference = 'Stop'; $sashSmokeArgs = @(ConvertFrom-Json -InputObject $env:SASH_PACKAGE_SMOKE_ARGS); & $env:SASH_PACKAGE_SMOKE_SHIM @sashSmokeArgs; exit $LASTEXITCODE",
          ],
          {
            env: {
              ...cliEnv,
              SASH_PACKAGE_SMOKE_SHIM: path.join(installDir, `sash${extension}`),
              SASH_PACKAGE_SMOKE_ARGS: JSON.stringify(args),
            },
          },
        )
      : run(path.join(installDir, "bin", "sash"), args, { env: cliEnv });
  const version = runCli(["--version"]).trim();
  assert.equal(version, expectedVersion);
  if (process.platform === "win32")
    assert.equal(runCli(["--version"], ".cmd").trim(), expectedVersion);
  const help = runCli(["--help"]);
  // Assert the wiring, not the wording: command presence survives copy edits.
  assert.match(help, /Usage:\s+sash/);
  for (const command of ["start", "stop", "restart", "doctor", "status", "profile", "upgrade"]) {
    assert.match(help, new RegExp(`^\\s+${command}\\b`, "m"), `help is missing ${command}`);
  }
  const profiles = JSON.parse(runCli(["profile", "list", "--json"]));
  assert.deepEqual(profiles, { activeId: null, profiles: [] });
  assert.equal(
    fs.existsSync(homeDir),
    false,
    "Read-only commands must not initialize application data",
  );
  // Wiring again, not wording: the subcommand exists and its options are wired.
  const upgradeHelp = runCli(["upgrade", "--help"]);
  assert.match(upgradeHelp, /Usage:\s+sash upgrade/);
  for (const option of ["--check", "--no-restart", "--json"]) {
    assert.ok(upgradeHelp.includes(option), `upgrade help is missing ${option}`);
  }

  console.log(
    `[package-smoke] installed and verified ${installSpec ?? "the freshly packed tarball"} as ${packageJson.name}@${expectedVersion} (${packedFiles.length} files)`,
  );
} finally {
  assert.equal(path.dirname(fs.realpathSync(tempRoot)), temporaryParent);
  await fs.promises.rm(tempRoot, { recursive: true, force: true });
}
