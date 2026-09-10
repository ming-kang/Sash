import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { readSashPackageInfo } from "./package-info.js";
import { upgradeFixture } from "./testing/upgrade-fixture.js";
import { runUpgradeCommand } from "./upgrade-command.js";
import { verifyStagedShims } from "./upgrade-launcher.js";
import { parseSashNpmTarget, resolveNpmCli, stageSashPackage } from "./upgrade-npm.js";
import { upgradeTransactionPaths } from "./upgrade-paths.js";

describe("npm self-upgrade preparation", () => {
  it("accepts exact package metadata and leaves artifact integrity to npm", () => {
    const value = {
      name: "@astralyn/sash",
      version: "2.0.0",
      engines: { node: ">=24" },
      bin: { sash: "dist/cli.js" },
      sashUpgradeProtocol: 1,
    };
    assert.equal(parseSashNpmTarget(value).version, "2.0.0");
    assert.throws(() => parseSashNpmTarget({ ...value, version: "latest" }));
    assert.throws(() => parseSashNpmTarget({ ...value, name: "another-package" }));
  });

  it("uses one npm installation to prepare the exact version, dependencies and native shims", {
    timeout: 45_000,
  }, async () => {
    const f = upgradeFixture();
    const packageDir = path.join(f.root, "artifact-source");
    const cli = path.join(packageDir, "dist", "cli.js");
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(
      cli,
      'import value from "sash-fixture-dependency"; process.stdout.write(value + "\\n");\n',
    );
    const dependency = path.join(packageDir, "node_modules", "sash-fixture-dependency");
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(
      path.join(dependency, "package.json"),
      JSON.stringify({
        name: "sash-fixture-dependency",
        version: "1.0.0",
        type: "module",
        exports: "./index.js",
      }),
    );
    fs.writeFileSync(
      path.join(dependency, "index.js"),
      'export default "complete dependency tree";\n',
    );
    const manifest = {
      name: "@astralyn/sash",
      version: "2.0.0",
      type: "module",
      bin: { sash: "dist/cli.js" },
      engines: { node: ">=24" },
      sashUpgradeProtocol: 1,
      dependencies: { "sash-fixture-dependency": "1.0.0" },
      bundleDependencies: ["sash-fixture-dependency"],
    };
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify(manifest));
    const config = path.join(f.root, "empty-npmrc");
    const globalConfig = path.join(f.root, "global-npmrc");
    fs.writeFileSync(config, "");
    fs.writeFileSync(globalConfig, "");
    try {
      const packed = JSON.parse(
        await runUpgradeCommand(
          process.execPath,
          [
            resolveNpmCli(),
            "pack",
            "--json",
            "--cache",
            path.join(f.root, "pack-cache"),
            "--userconfig",
            config,
            "--globalconfig",
            globalConfig,
          ],
          { cwd: packageDir, purpose: "Pack isolated npm fixture" },
        ),
      ) as Array<{ filename: string }>;
      assert.ok(packed[0]);
      const tarball = path.join(packageDir, packed[0].filename);
      const target = parseSashNpmTarget(manifest);
      let installs = 0;
      const staged = await stageSashPackage({
        prefix: f.prefix,
        transactionId: f.journal.transactionId,
        nodePath: process.execPath,
        target,
        runCommand: async (command, args, options) => {
          installs++;
          assert.equal(args[1], "install");
          assert.equal(args.at(-1), "@astralyn/sash@2.0.0");
          assert.equal(args[args.indexOf("--registry") + 1], "https://registry.npmjs.org");
          return runUpgradeCommand(command, [...args.slice(0, -1), "--offline", tarball], options);
        },
      });
      assert.equal(readSashPackageInfo(staged).version, "2.0.0");
      assert.equal(
        (
          await runUpgradeCommand(process.execPath, [path.join(staged, "dist", "cli.js")], {
            cwd: f.root,
            purpose: "Read the staged dependency",
          })
        ).trim(),
        "complete dependency tree",
      );
      assert.ok(
        verifyStagedShims(upgradeTransactionPaths(f.prefix, f.journal.transactionId).stage, staged)
          .length > 0,
      );
      assert.equal(readSashPackageInfo(f.installation.packageRoot).version, "1.0.0");
      assert.equal(installs, 1);
    } finally {
      f.cleanup();
    }
  });
});
