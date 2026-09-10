import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { installationIssue } from "../autostart.js";
import { testAutostartContext } from "../testing/autostart-context.js";
import { autostartContext } from "./context.js";

describe("stable autostart installation", () => {
  it("accepts a direct Windows global package but rejects local and incomplete layouts", (t) => {
    const { root, options } = testAutostartContext(t, "win32");
    const prefix = path.join(root, "npm prefix");
    const packageRoot = path.join(prefix, "node_modules", "@astralyn", "sash");
    fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "dist", "cli.js"), "// cli");
    fs.writeFileSync(path.join(packageRoot, "dist", "autostart-entry.js"), "// login");
    const ctx = autostartContext({ ...options, packageRoot });
    assert.equal(installationIssue(ctx), null);

    // A checkout or any other package shape cannot register a stable login entry.
    assert.match(
      installationIssue(
        autostartContext({ ...options, packageRoot: path.join(root, "package") }),
      ) ?? "",
      /direct global/,
    );
    // The npm layout is recognized for the requested platform only.
    assert.match(
      installationIssue(autostartContext({ ...options, packageRoot, platform: "linux" })) ?? "",
      /direct global/,
    );
    // The referenced entry file must exist.
    fs.unlinkSync(ctx.entryPath);
    assert.match(installationIssue(ctx) ?? "", /direct global/);
  });

  it("rejects relative paths and control characters", (t) => {
    const { ctx } = testAutostartContext(t, "win32");
    assert.ok(installationIssue({ ...ctx, nodePath: "relative-node" }));
    assert.ok(installationIssue({ ...ctx, dataDir: `${ctx.dataDir}\nmalformed` }));
  });
});
