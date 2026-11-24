import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { helperAssets, helperFilenames, helperTargets } from "../scripts/helper-artifacts.mjs";

test("release helpers use distinct names for the six supported targets", () => {
  assert.deepEqual(helperFilenames, [
    "sash-helper-darwin-x64",
    "sash-helper-darwin-arm64",
    "sash-helper-linux-x64",
    "sash-helper-linux-arm64",
    "sash-helper-win32-x64.exe",
    "sash-helper-win32-arm64.exe",
  ]);
  assert.equal(helperTargets().length, 6);
});

test("a release requires and hashes a binary for every target", async (t) => {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "sash-helper-artifacts-"),
  );
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "dist"));
  await assert.rejects(helperAssets(root), /sash-helper-darwin-x64/);
  const binary = Buffer.from([0, 255, 10, 128]);
  for (const name of helperFilenames) await fs.writeFile(path.join(root, "dist", name), binary);
  const assets = await helperAssets(root);
  assert.deepEqual(
    assets.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
    helperFilenames.map((name) => ({
      name,
      size: binary.length,
      sha256: createHash("sha256").update(binary).digest("hex"),
    })),
  );
});
