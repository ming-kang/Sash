import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { AutostartService } from "../autostart.js";
import { testAutostartContext } from "../testing/autostart-context.js";
import { upgradeFixture, writeFixturePackage } from "../testing/upgrade-fixture.js";
import { writeUpgradeAuthorization } from "../upgrade-access.js";
import { upgradeTransactionPaths } from "../upgrade-paths.js";
import { runAutostartUpgrade } from "./autostart-upgrade.js";

it("preserves login startup for a stopped installation without creating application state", {
  skip: process.platform !== "win32",
}, async (t) => {
  const f = upgradeFixture();
  let command: string | null = null;
  const { root, options, ctx } = testAutostartContext(t, "win32", async (_command, _args, env) => {
    if (env.SASH_AUTOSTART_MODE) {
      command = env.SASH_AUTOSTART_MODE === "on" ? (env.SASH_AUTOSTART_COMMAND ?? "") : null;
      return { code: 0, stdout: "", stderr: "" };
    }
    return {
      code: 0,
      stdout: JSON.stringify({
        run: command === null ? null : Buffer.from(command).toString("base64"),
        approval: null,
      }),
      stderr: "",
    };
  });
  const oldNode = path.join(root, "previous-node.exe");
  fs.writeFileSync(oldNode, "Node executable fixture");
  const original = new AutostartService({
    ...options,
    packageRoot: f.installation.packageRoot,
    nodePath: oldNode,
  });
  const replacement = new AutostartService({ ...options, packageRoot: f.installation.packageRoot });
  const access = {
    transactionId: f.journal.transactionId,
    installationId: f.installation.id,
    grant: crypto.randomBytes(32).toString("hex"),
  };
  writeUpgradeAuthorization({
    ...access,
    protocol: 1,
    sourceVersion: "1.0.0",
    targetVersion: "2.0.0",
    instances: [],
  });
  const staged = writeFixturePackage(
    upgradeTransactionPaths(f.prefix, access.transactionId).stage,
    "2.0.0",
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(staged, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  fs.writeFileSync(
    path.join(staged, "package.json"),
    JSON.stringify({ ...manifest, engines: { node: ">=24.1.0" } }),
  );
  const actor = {
    platform: options.platform,
    env: options.env,
    runCommand: options.runCommand,
    nodeVersion: async () => "v24.0.0",
  };
  try {
    await original.set(true);
    const before = fs.readFileSync(path.join(ctx.controlDir, "start.vbs"));
    assert.equal(fs.existsSync(ctx.dataDir), false);
    await runAutostartUpgrade("capture", access, f.installation.packageRoot, actor);
    await runAutostartUpgrade("apply", access, f.installation.packageRoot, actor);
    assert.equal((await replacement.inspect()).state, "on");
    assert.equal(fs.existsSync(ctx.dataDir), false);
    await runAutostartUpgrade("rollback", access, f.installation.packageRoot, actor);
    assert.equal((await original.inspect()).state, "on");
    assert.deepEqual(fs.readFileSync(path.join(ctx.controlDir, "start.vbs")), before);
    await runAutostartUpgrade("cleanup", access, f.installation.packageRoot, actor);
    assert.equal(fs.existsSync(ctx.dataDir), false);
  } finally {
    f.cleanup();
  }
});
