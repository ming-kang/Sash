import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { coreCandidates, GEODATA_FILES } from "../scripts/bootstrap-manifest-data.mjs";
import { mihomoAssetCandidates } from "./core.js";
import { GEODATA_FILE_NAMES } from "./core-config-validation.js";

describe("bootstrap manifest data", () => {
  it("pins exactly the geodata files the Core may fetch", () => {
    assert.deepEqual([...GEODATA_FILES].sort(), [...GEODATA_FILE_NAMES].sort());
  });

  it("pins every Core asset name the installer can request", () => {
    const pinned = new Set(coreCandidates("v9.9.9"));
    const platforms: NodeJS.Platform[] = ["win32", "linux", "darwin"];
    const arches: NodeJS.Architecture[] = ["x64", "arm64"];
    for (const platform of platforms)
      for (const arch of arches)
        for (const name of mihomoAssetCandidates("v9.9.9", platform, arch))
          assert.ok(pinned.has(name), `bootstrap manifest data lost ${name}`);
  });
});
