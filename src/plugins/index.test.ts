import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import { defaultTunSettings } from "../tun-settings.js";
import { type PluginGenerateContext, PluginRegistry } from "./index.js";

const roots: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-plugins-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writePlugin(dir: string, name: string, code: string): void {
  fs.writeFileSync(path.join(dir, name), code);
}

const context: PluginGenerateContext = {
  settings: {
    mixedPort: 7890,
    controller: "127.0.0.1:9090",
    allowLan: false,
    daemonPort: 19090,
    systemProxy: false,
    tun: defaultTunSettings(),
  },
  profile: null,
  source: "default",
};

describe("PluginRegistry", () => {
  it("returns the document unchanged when the plugin directory is missing", async () => {
    const registry = new PluginRegistry(path.join(tempDir(), "absent"));
    const doc = { mode: "rule" };
    assert.equal(await registry.applyGenerated(doc, context), doc);
    assert.deepEqual(registry.list(), []);
  });

  it("returns the input document untouched when no plugin exports onGenerate", async () => {
    const dir = tempDir();
    writePlugin(dir, "passive.js", `module.exports = { name: "passive" };`);
    const registry = new PluginRegistry(dir);
    const doc = { untouched: true };
    assert.equal(await registry.applyGenerated(doc, context), doc);
    assert.equal(await registry.hasGenerateHooks(), false);
  });

  it("applies onGenerate hooks in sorted file order and threads context", async () => {
    const dir = tempDir();
    writePlugin(
      dir,
      "b-second.js",
      `module.exports = {
        name: "second",
        onGenerate(config, ctx) {
          assert_ctx(ctx);
          config.order = (config.order ?? "") + "2";
        },
      };
      function assert_ctx(ctx) {
        if (ctx.profile !== null) throw new Error("context mismatch");
        if (ctx.source !== "default") throw new Error("source mismatch");
      }`,
    );
    writePlugin(
      dir,
      "a-first.js",
      `module.exports = {
        name: "first",
        onGenerate(config) {
          config.order = (config.order ?? "") + "1";
          return config;
        },
      };`,
    );
    const registry = new PluginRegistry(dir);
    assert.equal(await registry.hasGenerateHooks(), true);
    const result = await registry.applyGenerated({}, context);
    assert.equal(result.order, "12");
    assert.deepEqual(
      registry.list().map((info) => info.name),
      ["first", "second"],
    );
  });

  it("keeps mutated documents when the hook returns nothing", async () => {
    const dir = tempDir();
    writePlugin(
      dir,
      "mutator.js",
      `module.exports = {
      onGenerate(config) { config["log-level"] = "debug"; },
    };`,
    );
    const result = await new PluginRegistry(dir).applyGenerated({}, context);
    assert.equal(result["log-level"], "debug");
  });

  it("skips failing plugins and still applies later ones", async () => {
    const dir = tempDir();
    writePlugin(
      dir,
      "a-bad.js",
      `module.exports = {
      onGenerate() { throw new Error("boom"); },
    };`,
    );
    writePlugin(
      dir,
      "b-corrupt.js",
      `module.exports = {
      onGenerate(config) { config.corrupt = "not a plain object"; return 42; },
    };`,
    );
    writePlugin(
      dir,
      "c-good.js",
      `module.exports = {
      onGenerate(config) { config.good = true; return config; },
    };`,
    );
    const result = await new PluginRegistry(dir).applyGenerated({ keep: 1 }, context);
    assert.deepEqual(result, { keep: 1, corrupt: "not a plain object", good: true });
  });

  it("times out hooks that never settle", async () => {
    const dir = tempDir();
    writePlugin(
      dir,
      "slow.js",
      `module.exports = {
      name: "slow",
      onGenerate() { return new Promise(() => {}); },
    };`,
    );
    const registry = new PluginRegistry(dir, 25);
    const result = await registry.applyGenerated({ ok: true }, context);
    assert.deepEqual(result, { ok: true });
    assert.ok(registry.list().some((info) => info.name === "slow"));
  });

  it("records load errors for invalid plugins and continues", async () => {
    const dir = tempDir();
    writePlugin(dir, "syntax.js", "module.exports = {");
    writePlugin(dir, "nonobject.js", "module.exports = 42;");
    writePlugin(dir, "nonfn.js", `module.exports = { onGenerate: "x" };`);
    writePlugin(
      dir,
      "good.js",
      `module.exports = {
      name: "good",
      onGenerate(config) { config.ok = 1; },
    };`,
    );
    const registry = new PluginRegistry(dir);
    const result = await registry.applyGenerated({}, context);
    assert.equal(result.ok, 1);
    const infos = registry.list();
    assert.equal(infos.filter((info) => info.error).length, 3);
    assert.equal(infos.find((info) => info.name === "good")?.error, undefined);
  });

  it("freezes the shared context so one plugin cannot poison the next", async () => {
    const dir = tempDir();
    writePlugin(
      dir,
      "a-evil.js",
      `module.exports = {
      onGenerate(config, ctx) {
        try { ctx.source = "hacked"; } catch (e) {}
        try { ctx.settings = {}; } catch (e) {}
        try { ctx.profile = { id: "x" }; } catch (e) {}
      },
    };`,
    );
    writePlugin(
      dir,
      "b-check.js",
      `module.exports = {
      onGenerate(config, ctx) {
        config.sourceOk = ctx.source === "default";
        config.settingsOk = ctx.settings && ctx.settings.mixedPort === 7890;
        config.profileOk = ctx.profile === null;
      },
    };`,
    );
    const result = await new PluginRegistry(dir).applyGenerated({}, context);
    assert.equal(result.sourceOk, true);
    assert.equal(result.settingsOk, true);
    assert.equal(result.profileOk, true);
  });

  it("denies host globals inside the sandbox", async () => {
    const dir = tempDir();
    writePlugin(
      dir,
      "probe.js",
      `module.exports = {
      name: "probe",
      onGenerate(config) {
        config.globals = {
          process: typeof process,
          require: typeof require,
          fetch: typeof fetch,
        };
      },
    };`,
    );
    const result = await new PluginRegistry(dir).applyGenerated({}, context);
    // `result.globals` was built inside the vm realm: spread it into a host
    // object so strict deep equality ignores the foreign prototype.
    assert.deepEqual(
      { ...(result.globals as Record<string, unknown>) },
      {
        process: "undefined",
        require: "undefined",
        fetch: "undefined",
      },
    );
  });
});
