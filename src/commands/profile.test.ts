import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { sashLayout } from "../paths.js";
import { testProfile, testSettings } from "../testing/state.js";
import { CliProfiles, resolveProfileReference } from "./profile.js";

it("resolves exact profile IDs and unique names, and refuses ambiguous or missing selections", () => {
  const index = {
    activeId: "2",
    profiles: [
      { ...testProfile("1"), name: "shared" },
      { ...testProfile("2"), name: "shared" },
      { ...testProfile("3"), name: "1" },
    ],
  };
  assert.equal(resolveProfileReference(index, "1").id, "1");
  assert.equal(resolveProfileReference(index).id, "2");
  assert.throws(() => resolveProfileReference(index, "shared"), /ambiguous/);
  assert.throws(() => resolveProfileReference(index, "missing"), /not found/);
  assert.throws(
    () => resolveProfileReference({ ...index, activeId: null }),
    /No profile is selected/,
  );
});

it("reads an empty stopped profile library without initializing data", async () => {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "sash-profile-"));
  const layout = sashLayout(path.join(root, "unused"));
  try {
    assert.deepEqual(await new CliProfiles({ layout, settings: testSettings() }).list(), {
      activeId: null,
      profiles: [],
    });
    assert.equal(fs.existsSync(layout.root), false);
  } finally {
    assert.equal(path.dirname(fs.realpathSync(root)), parent);
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
