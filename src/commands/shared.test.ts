import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { createTestState } from "../test-state.test.js";
import { runtimeContext } from "./shared.js";

it("CLI context reads committed state without initializing missing data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-cli-context-test-"));
  const previous = process.env.SASH_HOME;
  process.env.SASH_HOME = root;
  try {
    const context = runtimeContext();
    assert.equal(context.layout.root, root);
    assert.deepEqual(fs.readdirSync(root), []);
    const state = createTestState(context.layout);
    const bytes = fs.readFileSync(context.layout.settingsFile, "utf8");
    assert.deepEqual(runtimeContext().settings, state.snapshot().settings);
    assert.equal(fs.readFileSync(context.layout.settingsFile, "utf8"), bytes);
  } finally {
    if (previous === undefined) delete process.env.SASH_HOME;
    else process.env.SASH_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
