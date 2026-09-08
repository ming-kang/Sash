import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import {
  inspectInstallation,
  installationId,
  npmPackageRoot,
  npmShimPaths,
} from "./installation.js";

it("recognizes a direct npm prefix and refuses local, linked and redirected command layouts", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-installation-test-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const prefix = path.join(root, "npm prefix 空间");
  const packageRoot = npmPackageRoot(prefix, "win32");
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "dist", "cli.js"), "// installed CLI");
  fs.writeFileSync(
    path.join(prefix, "sash.cmd"),
    '@"%dp0%\\node_modules\\@astralyn\\sash\\dist\\cli.js"',
  );
  const options = { packageRoot, nodePath: process.execPath, platform: "win32" as const };
  const result = inspectInstallation(options);
  assert.equal(result.kind, "npm-global");
  if (result.kind === "npm-global") {
    assert.equal(result.prefix, fs.realpathSync.native(prefix));
    assert.equal(result.id, installationId(packageRoot));
  }
  assert.equal(fs.existsSync(path.join(prefix, ".sash-upgrade")), false);
  fs.writeFileSync(path.join(prefix, "package.json"), "{}");
  assert.equal(inspectInstallation(options).kind, "source");
  fs.unlinkSync(path.join(prefix, "package.json"));
  fs.writeFileSync(path.join(prefix, "sash.cmd"), "@node other.js");
  assert.equal(inspectInstallation(options).kind, "unknown");
  assert.equal(inspectInstallation({ ...options, nodePath: "relative-node" }).kind, "unknown");
  const linked = npmPackageRoot(path.join(root, "linked"), "win32");
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  fs.symlinkSync(packageRoot, linked, process.platform === "win32" ? "junction" : "dir");
  assert.equal(inspectInstallation({ ...options, packageRoot: linked }).kind, "linked");
});

it("identifies package-manager stores and keeps npm layout derivation platform-specific", () => {
  for (const [marker, kind] of [
    ["_npx", "npx"],
    [".pnpm", "pnpm"],
    [".yarn", "yarn"],
    [".bun", "bun"],
  ] as const) {
    assert.equal(
      inspectInstallation({
        packageRoot: path.join(os.tmpdir(), marker, "node_modules", "@astralyn", "sash"),
      }).kind,
      kind,
    );
  }
  const prefix = path.join(os.tmpdir(), "isolated-prefix");
  assert.equal(
    npmPackageRoot(prefix, "linux"),
    path.join(prefix, "lib", "node_modules", "@astralyn", "sash"),
  );
  assert.deepEqual(npmShimPaths(prefix, "linux"), [path.join(prefix, "bin", "sash")]);
  assert.deepEqual(
    npmShimPaths(prefix, "win32").map((file) => path.basename(file)),
    ["sash", "sash.cmd", "sash.ps1"],
  );
});
