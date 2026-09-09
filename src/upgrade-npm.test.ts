import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { MockAgent } from "undici";
import { proxyAwareDispatcher } from "./http.js";
import { readSashPackageInfo } from "./package-info.js";
import { runUpgradeCommand } from "./upgrade-command.js";
import { verifyStagedShims } from "./upgrade-launcher.js";
import { parseSashNpmTarget, resolveNpmCli, stageSashPackage } from "./upgrade-npm.js";
import { upgradeTransactionPaths } from "./upgrade-paths.js";
import { upgradeFixture } from "./upgrade-test-fixture.test.js";

describe("npm self-upgrade preparation", () => {
  it("accepts exact official artifacts and rejects foreign origins or weak integrity", () => {
    const value = {
      name: "@astralyn/sash",
      version: "2.0.0",
      engines: { node: ">=24" },
      bin: { sash: "dist/cli.js" },
      sashUpgradeProtocol: 1,
      dist: {
        tarball: "https://registry.npmjs.org/@astralyn/sash/-/sash-2.0.0.tgz",
        integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
      },
    };
    assert.equal(parseSashNpmTarget(value).integrity.digest, "0".repeat(128));
    for (const tarball of [
      "https://registry.npmjs.org.evil.test/@astralyn/sash/-/file.tgz",
      "http://registry.npmjs.org/@astralyn/sash/-/file.tgz",
      "https://user:password@registry.npmjs.org/@astralyn/sash/-/file.tgz",
      "https://registry.npmjs.org/other/-/file.tgz",
    ])
      assert.throws(() => parseSashNpmTarget({ ...value, dist: { ...value.dist, tarball } }));
    assert.throws(() => parseSashNpmTarget({ ...value, version: "latest" }));
    assert.throws(() =>
      parseSashNpmTarget({ ...value, dist: { ...value.dist, integrity: "sha1-deadbeef" } }),
    );
  });

  it("uses npm to prepare a complete dependency tree and portable native shims from a verified tarball", {
    timeout: 45_000,
  }, async (t) => {
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
    const agent = new MockAgent();
    agent.disableNetConnect();
    t.mock.method(proxyAwareDispatcher(), "dispatch", agent.dispatch.bind(agent));
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
      const tarball = fs.readFileSync(path.join(packageDir, packed[0].filename));
      const tarballPath = "/@astralyn/sash/-/sash-2.0.0.tgz";
      agent
        .get("https://registry.npmjs.org")
        .intercept({ path: tarballPath, method: "GET" })
        .reply(200, tarball);
      const target = parseSashNpmTarget({
        ...manifest,
        dist: {
          tarball: `https://registry.npmjs.org${tarballPath}`,
          integrity: `sha512-${crypto.hash("sha512", tarball, "base64")}`,
        },
      });
      const staged = await stageSashPackage({
        prefix: f.prefix,
        transactionId: f.journal.transactionId,
        nodePath: process.execPath,
        target,
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
      agent.assertNoPendingInterceptors();
    } finally {
      await agent.close();
      f.cleanup();
    }
  });
});
