import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ACK, guard, sanitizedEnvironment } from "./service-vm-smoke.mjs";

const allowed = {
  GITHUB_ACTIONS: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
  SASH_VM_ACK: ACK,
  RUNNER_TEMP: "C:\\runner\\temp",
};

test("pure guard accepts only explicit hosted Windows acknowledgement", () => {
  assert.equal(guard([], allowed, "win32"), "");
  assert.equal(guard([], { ...allowed, SASH_VM_CORE_VERSION: "v1.19.30" }, "win32"), "v1.19.30");
  for (const platform of ["linux", "darwin"]) assert.throws(() => guard([], allowed, platform));
  for (const patch of [
    { GITHUB_ACTIONS: "false" },
    { GITHUB_ACTIONS: "TRUE" },
    { RUNNER_ENVIRONMENT: "self-hosted" },
    { RUNNER_ENVIRONMENT: "" },
    { SASH_VM_ACK: "yes" },
    { SASH_VM_ACK: "" },
    { RUNNER_TEMP: "relative" },
    { RUNNER_TEMP: "" },
    { SASH_HOME: "C:\\existing" },
  ]) {
    assert.throws(() => guard([], { ...allowed, ...patch }, "win32"));
  }
});

test("argument and version parse errors fail before effects", () => {
  for (const args of [["--help"], ["--force"], ["--core-version", "v1.2.3"], ["--"], ["install"]])
    assert.throws(() => guard(args, allowed, "win32"));
  for (const version of [
    "latest",
    "1.2.3",
    "v01.2.3",
    "v1.2.3-beta",
    "v1.2.3\n",
    "v1.2.3;whoami",
    "../tag",
    "https://example.org",
  ])
    assert.throws(() => guard([], { ...allowed, SASH_VM_CORE_VERSION: version }, "win32"));
});

test("child environment uses an allowlist, excluding credentials and injection", () => {
  const env = sanitizedEnvironment({
    ...allowed,
    PATH: "safe",
    NODE_OPTIONS: "--require evil",
    GITHUB_TOKEN: "secret",
    ACTIONS_RUNTIME_TOKEN: "secret",
    NPM_TOKEN: "secret",
    npm_config_userconfig: "secret",
    HTTPS_PROXY: "secret",
    SASH_HOME: "old",
  });
  assert.equal(env.PATH, "safe");
  for (const name of [
    "NODE_OPTIONS",
    "GITHUB_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
    "NPM_TOKEN",
    "npm_config_userconfig",
    "HTTPS_PROXY",
    "SASH_HOME",
  ])
    assert.equal(env[name], undefined);
});

test("real entry point safely refuses local/self-hosted before root allocation or helper access", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "sash-vm-guard-"));
  try {
    for (const patch of [
      { GITHUB_ACTIONS: "false", RUNNER_ENVIRONMENT: "github-hosted", SASH_VM_ACK: ACK },
      { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted", SASH_VM_ACK: ACK },
      { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", SASH_VM_ACK: "" },
    ]) {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("service-vm-smoke.mjs", import.meta.url))],
        {
          encoding: "utf8",
          timeout: 10000,
          env: { ...process.env, ...patch, RUNNER_TEMP: temp, SASH_HOME: "" },
        },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /VM acceptance failed/);
      assert.equal(result.stdout, "");
      assert.deepEqual(readdirSync(temp), []);
    }
    assert(existsSync(temp));
  } finally {
    rmSync(temp, { recursive: true });
  }
});
