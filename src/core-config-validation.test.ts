import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { validateCoreConfigText } from "./core-config-validation.js";
import { type SashLayout, sashLayout } from "./paths.js";

describe("Core config validation", () => {
  let tmpDir: string;
  let layout: SashLayout;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-config-validation-"));
    layout = sashLayout(tmpDir);
    fs.mkdirSync(path.dirname(layout.coreExe), { recursive: true });
    fs.writeFileSync(layout.coreExe, "fake core");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("tests an isolated candidate with the installed Core and removes it afterward", async () => {
    let candidate = "";
    await validateCoreConfigText("rules:\n  - MATCH,DIRECT\n", layout, (executable, args) => {
      assert.equal(executable, layout.coreExe);
      assert.deepEqual(args.slice(0, 4), ["-t", "-d", layout.root, "-f"]);
      candidate = args[4] ?? "";
      assert.equal(fs.readFileSync(candidate, "utf8"), "rules:\n  - MATCH,DIRECT\n");
    });

    assert.ok(candidate);
    assert.equal(fs.existsSync(candidate), false);
  });

  it("surfaces validation errors without leaving the candidate behind", async () => {
    let candidate = "";
    await assert.rejects(
      () =>
        validateCoreConfigText("rules: invalid\n", layout, (_executable, args) => {
          candidate = args[4] ?? "";
          throw Object.assign(new Error("command failed"), {
            stderr: Buffer.from("invalid rule target"),
          });
        }),
      /Core rejected generated configuration: invalid rule target/,
    );
    assert.ok(candidate);
    assert.equal(fs.existsSync(candidate), false);
  });

  it("fails closed when the installed Core is missing", async () => {
    fs.rmSync(layout.coreExe);
    await assert.rejects(
      () => validateCoreConfigText("rules: []\n", layout),
      /Core executable is missing/,
    );
  });
});
