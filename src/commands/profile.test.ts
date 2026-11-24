import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "vitest";
import { errorPresentation } from "../error-utils.js";
import { sashLayout } from "../paths.js";
import { testProfile, testSettings } from "../testing/state.js";
import { CliProfiles, resolveProfileReference } from "./profile.js";

function thrown(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  throw new Error("expected the action to throw");
}

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
  const ambiguous = thrown(() => resolveProfileReference(index, "shared"));
  assert.match(ambiguous.message, /ambiguous/);
  assert.deepEqual(errorPresentation(ambiguous), {
    message: 'More than one profile is named "shared".',
    advice: "Use an ID from sash profile list.",
  });
  const missing = thrown(() => resolveProfileReference(index, "missing"));
  assert.equal(missing.message, 'Profile "missing" was not found — run sash profile list');
  assert.deepEqual(errorPresentation(missing), {
    message: 'Profile "missing" was not found.',
    advice: "Run sash profile list to see saved profiles.",
  });
  const unselected = thrown(() => resolveProfileReference({ ...index, activeId: null }));
  assert.match(unselected.message, /No profile is selected/);
  assert.deepEqual(errorPresentation(unselected), {
    message: "No profile is selected.",
    advice: "Specify a profile or use --all.",
  });
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
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
