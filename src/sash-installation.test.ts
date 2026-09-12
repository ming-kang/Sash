import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import {
  assertAbsolutePath,
  inspectInstallation,
  npmPackageRoot,
  npmPrefixForPackage,
} from "./sash-installation.js";

it("recognizes a direct npm prefix and refuses local and mismatched layouts", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-installation-test-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const prefix = path.join(root, "npm prefix 空间");
  const packageRoot = npmPackageRoot(prefix, "win32");
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "dist", "cli.js"), "// installed CLI");
  const options = { packageRoot, nodePath: process.execPath, platform: "win32" as const };
  const result = inspectInstallation(options);
  assert.equal(result.kind, "npm-global");
  if (result.kind === "npm-global") {
    assert.equal(result.prefix, fs.realpathSync.native(prefix));
    assert.equal(result.packageRoot, fs.realpathSync.native(packageRoot));
    assert.equal(result.nodePath, fs.realpathSync.native(process.execPath));
  }
  // Detection is read-only: it never creates upgrade or installation state.
  assert.equal(fs.readdirSync(prefix).sort().join(","), "node_modules");
  assert.equal(fs.existsSync(path.join(prefix, ".sash-upgrade")), false);

  // A package outside the @astralyn/sash npm layout is a checkout or another package.
  const checkout = inspectInstallation({ ...options, packageRoot: path.join(root, "sash") });
  assert.equal(checkout.kind, "source");
  if (checkout.kind === "source") assert.match(checkout.reason, /local installation/);

  // The npm layout for one platform never matches another platform's derived prefix.
  const mismatched = inspectInstallation({ ...options, platform: "linux" });
  assert.equal(mismatched.kind, "source");
  if (mismatched.kind === "source")
    assert.match(mismatched.reason, /outside an npm global installation/);
});

it("derives platform-specific npm layouts and rejects incomplete or non-absolute paths", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-installation-layout-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const prefix = path.join(root, "prefix");
  assert.equal(
    npmPackageRoot(prefix, "linux"),
    path.join(prefix, "lib", "node_modules", "@astralyn", "sash"),
  );
  assert.equal(
    npmPackageRoot(prefix, "win32"),
    path.join(prefix, "node_modules", "@astralyn", "sash"),
  );
  for (const platform of ["linux", "win32"] as const) {
    assert.equal(npmPrefixForPackage(npmPackageRoot(prefix, platform), platform), prefix);
  }
  assert.equal(npmPrefixForPackage(path.join(prefix, "elsewhere", "sash"), "linux"), undefined);

  // A matching layout without the CLI entry cannot be verified.
  const packageRoot = npmPackageRoot(prefix, process.platform);
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  assert.equal(inspectInstallation({ packageRoot }).kind, "unknown");

  assert.throws(() => assertAbsolutePath("relative/path"), /must be absolute/);
  assert.equal(inspectInstallation({ packageRoot: "relative/path" }).kind, "unknown");
  assert.equal(
    inspectInstallation({ packageRoot: os.tmpdir(), nodePath: "relative-node" }).kind,
    "unknown",
  );
});
