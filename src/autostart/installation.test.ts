import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { autostartContext } from "./context.js";
import { installationIssue } from "./installation.js";
import { testAutostartContext } from "./test-context.test.js";

describe("stable autostart installation", () => {
  it("accepts a direct Windows global package but rejects local, linked and npx layouts", (t) => {
    const { root, options } = testAutostartContext(t, "win32");
    const prefix = path.join(root, "npm prefix");
    const packageRoot = path.join(prefix, "node_modules", "@astralyn", "sash");
    fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "dist", "cli.js"), "// cli");
    fs.writeFileSync(path.join(packageRoot, "dist", "autostart-entry.js"), "// login");
    fs.writeFileSync(
      path.join(prefix, "sash.cmd"),
      '@"%dp0%\\node_modules\\@astralyn\\sash\\dist\\cli.js"',
    );
    const ctx = autostartContext({ ...options, packageRoot });
    assert.equal(installationIssue(ctx), null);
    fs.writeFileSync(path.join(prefix, "package.json"), "{}");
    assert.match(installationIssue(ctx) ?? "", /direct global/);
    fs.unlinkSync(path.join(prefix, "package.json"));
    fs.writeFileSync(path.join(prefix, "sash.cmd"), "@call another-program");
    assert.match(installationIssue(ctx) ?? "", /direct global/);
    assert.match(installationIssue(autostartContext(options)) ?? "", /direct global/);
    assert.match(
      installationIssue(
        autostartContext({
          ...options,
          packageRoot: path.join(root, "_npx", "node_modules", "@astralyn", "sash"),
        }),
      ) ?? "",
      /direct global/,
    );
    const alias = path.join(root, "linked-package");
    fs.symlinkSync(packageRoot, alias, process.platform === "win32" ? "junction" : "dir");
    assert.match(installationIssue({ ...ctx, packageRoot: alias }) ?? "", /direct global/);
  });

  it("requires a built entry and rejects control characters", (t) => {
    const { ctx } = testAutostartContext(t, "win32");
    assert.ok(installationIssue({ ...ctx, nodePath: "relative-node" }));
    assert.ok(installationIssue({ ...ctx, dataDir: `${ctx.dataDir}\nmalformed` }));
  });

  it("accepts a POSIX global package whose bin link resolves to its CLI", {
    skip: process.platform === "win32",
  }, (t) => {
    const { root, options } = testAutostartContext(t, "linux");
    const prefix = path.join(root, "prefix");
    const packageRoot = path.join(prefix, "lib", "node_modules", "@astralyn", "sash");
    fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    const cli = path.join(packageRoot, "dist", "cli.js");
    fs.writeFileSync(cli, "// cli");
    fs.writeFileSync(path.join(packageRoot, "dist", "autostart-entry.js"), "// login");
    fs.symlinkSync(cli, path.join(prefix, "bin", "sash"));
    assert.equal(installationIssue(autostartContext({ ...options, packageRoot })), null);
    fs.unlinkSync(path.join(packageRoot, "dist", "autostart-entry.js"));
    assert.ok(installationIssue(autostartContext({ ...options, packageRoot })));
  });
});
