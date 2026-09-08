// Post-publish runtime verification: installs the published package from the
// npm registry into an isolated global prefix, installs the pinned official
// Core (SHA-256 verified, TUN and system proxy disabled), then runs a real
// start/status/stop cycle on non-default loopback ports.
//
// Usage: node scripts/registry-runtime-smoke.mjs <x.y.z>
//
// Requires the GitHub CLI (`gh`). Locally it uses stored gh credentials; in
// CI provide GH_TOKEN. Only gh sees that token: the installed package and npm
// run with a scrubbed environment.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const CORE_VERSION = "v1.19.30"; // currently tested Core contract (see README)

const version = process.argv[2];
assert.match(
  version ?? "",
  /^\d+\.\d+\.\d+$/,
  "usage: node scripts/registry-runtime-smoke.mjs <x.y.z>",
);

// Mirrors buildSanitizedEnv in src/process.ts; inlined so the script runs
// without a local build.
function sanitizedEnv() {
  const env = { ...process.env };
  const strippedKeys = new Set([
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
    const isNpmAuthConfig =
      lower.startsWith("npm_config_") &&
      (lower.includes("authtoken") ||
        lower.includes("auth_token") ||
        lower.endsWith("_auth") ||
        lower.includes("password") ||
        lower.includes("username") ||
        lower === "npm_config_userconfig" ||
        lower === "npm_config_globalconfig");
    if (strippedKeys.has(key.toUpperCase()) || isNpmAuthConfig) {
      delete env[key];
    }
  }
  return env;
}

const isolation = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sash-registry-runtime-")));
const prefix = path.join(isolation, "prefix");
const data = path.join(isolation, "data");
const env = {
  ...sanitizedEnv(),
  SASH_HOME: data,
  LOCALAPPDATA: path.join(isolation, "local"),
  SASH_DEVELOPMENT: "0",
};
const npmCli =
  process.env.npm_execpath ??
  path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
assert.ok(fs.existsSync(npmCli), `npm CLI not found at ${npmCli}`);
const execute = promisify(execFile);
const run = async (args, timeout = 60_000) =>
  (
    await execute(process.execPath, args, {
      cwd: isolation,
      env,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      timeout,
    })
  ).stdout;
// gh keeps the ambient environment so GH_TOKEN (CI) or stored credentials
// (local) authenticate public release metadata reads.
const gh = async (args) =>
  (
    await execute("gh", args, {
      cwd: isolation,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      timeout: 120_000,
    })
  ).stdout;
let stop;
let confirmStopped;
let completed = false;
try {
  console.log(`Installing @astralyn/sash@${version} into an isolated global prefix`);
  await run(
    [
      npmCli,
      "install",
      "--global",
      "--prefix",
      prefix,
      "--cache",
      path.join(isolation, "cache"),
      "--registry=https://registry.npmjs.org",
      "--no-audit",
      "--no-fund",
      `@astralyn/sash@${version}`,
    ],
    180_000,
  );
  const installed = path.join(
    prefix,
    ...(process.platform === "win32" ? [] : ["lib"]),
    "node_modules",
    "@astralyn",
    "sash",
  );
  const importInstalled = (file) => import(pathToFileURL(path.join(installed, "dist", file)).href);
  const { sashLayout } = await importInstalled("paths.js");
  const { SashStateStore, readState } = await importInstalled("app-state.js");
  const { initialSettings } = await importInstalled("settings.js");
  const { evaluateDaemon } = await importInstalled("daemon-lifecycle.js");
  const { renderActiveConfig } = await importInstalled("profiles.js");
  const { mihomoAssetCandidates, extractCoreArchive, verifyCoreExecutable, writeInstallRecord } =
    await importInstalled("core.js");
  const { sha256File } = await importInstalled("github.js");
  const YAML = createRequire(path.join(installed, "package.json"))("yaml");
  const layout = sashLayout(data);
  const sockets = await Promise.all(
    [0, 1, 2].map(async () => {
      const server = net.createServer();
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return server;
    }),
  );
  const ports = sockets.map((server) => server.address().port);
  assert.equal(new Set(ports).size, 3);
  assert.ok(ports.every((port) => ![7890, 9090, 19090].includes(port)));
  await Promise.all(sockets.map((server) => new Promise((resolve) => server.close(resolve))));
  const settings = {
    ...initialSettings(),
    mixedPort: ports[0],
    controller: `127.0.0.1:${ports[1]}`,
    daemonPort: ports[2],
    allowLan: false,
    systemProxy: false,
  };
  new SashStateStore(layout, settings);
  const cli = (args, timeout) => run([path.join(installed, "dist", "cli.js"), ...args], timeout);
  assert.equal((await cli(["--version"])).trim(), version);
  assert.match(await cli(["--help"]), /Usage:\s+sash/);
  stop = () => cli(["stop"], 60_000);
  confirmStopped = async () =>
    assert.equal((await evaluateDaemon(layout, settings)).kind, "stopped");
  console.log(
    `Preparing the official Core ${CORE_VERSION} via gh; verifying its SHA-256 and version`,
  );
  const release = JSON.parse(
    await gh([
      "api",
      "--hostname",
      "github.com",
      `repos/MetaCubeX/mihomo/releases/tags/${CORE_VERSION}`,
    ]),
  );
  const asset = mihomoAssetCandidates(CORE_VERSION)
    .map((name) => release.assets.find((candidate) => candidate.name === name))
    .find(Boolean);
  assert.ok(asset && /^sha256:[a-f0-9]{64}$/.test(asset.digest) && asset.size <= 128 * 1024 * 1024);
  const download = path.join(isolation, "download");
  fs.mkdirSync(download);
  await gh([
    "release",
    "download",
    CORE_VERSION,
    "--repo",
    "https://github.com/MetaCubeX/mihomo",
    "--pattern",
    asset.name,
    "--dir",
    download,
  ]);
  const archive = path.join(download, asset.name);
  assert.equal(await sha256File(archive), asset.digest.slice(7));
  fs.mkdirSync(layout.binDir, { recursive: true });
  await extractCoreArchive(archive, asset.name, layout.coreExe);
  verifyCoreExecutable(layout.coreExe, 5000, CORE_VERSION);
  writeInstallRecord({ coreVersion: CORE_VERSION, installedAt: new Date().toISOString() }, layout);
  const preview = YAML.parse(renderActiveConfig(readState(layout), layout).yaml);
  assert.equal(preview.tun.enable, false);
  await cli(["web", "--no-open"]);
  const installedStatus = JSON.parse(await cli(["status", "--json"]));
  assert.equal(installedStatus.core.running, false);
  assert.equal(installedStatus.core.installedVersion, CORE_VERSION);
  assert.equal(fs.existsSync(`${layout.coreExe}.bak`), false);
  assert.equal(fs.existsSync(layout.coreUpdateTransactionFile), false);
  console.log("Starting the isolated Core and checking its actual controller health");
  await cli(["start"], 60_000);
  const generated = YAML.parse(fs.readFileSync(layout.configFile, "utf8"));
  assert.equal(generated.tun.enable, false);
  assert.equal(generated["mixed-port"], ports[0]);
  const running = JSON.parse(await cli(["status", "--json"]));
  assert.equal(running.core.running, true);
  assert.equal(running.core.healthy, true);
  assert.equal(running.systemProxy.desired, false);
  assert.equal(running.systemProxy.daemonApplied, false);
  assert.equal(running.endpoints.mixedProxy, `127.0.0.1:${ports[0]}`);
  await stop();
  await confirmStopped();
  completed = true;
  console.log(
    `PASS: registry ${version}, isolated global installation, real Core ${CORE_VERSION} install/start/status/stop, verified cleanup`,
  );
} finally {
  if (stop && !completed) await stop();
  if (confirmStopped) await confirmStopped();
  assert.equal(
    path.dirname(fs.realpathSync(isolation)).toLowerCase(),
    fs.realpathSync(os.tmpdir()).toLowerCase(),
  );
  assert.ok(path.basename(isolation).startsWith("sash-registry-runtime-"));
  fs.rmSync(isolation, { recursive: true, force: true });
}
