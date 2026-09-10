import assert from "node:assert/strict";
import { it } from "node:test";
import { mihomoAssetCandidates } from "./core.js";
import { amd64LevelFromFlags, amd64LevelFromWindows } from "./cpu-features.js";
import { type ReleaseAsset, selectReleaseAsset } from "./github.js";

const v2 = "sse2 pni ssse3 sse4_1 sse4_2 popcnt cx16 lahf_lm";
const v3 = `${v2} avx avx2 bmi1 bmi2 f16c fma abm movbe xsave`;

it("selects the highest fully supported instruction level, including macOS flag names", () => {
  assert.equal(amd64LevelFromFlags(""), undefined);
  assert.equal(amd64LevelFromFlags("sse2"), 1);
  assert.equal(amd64LevelFromFlags(v2), 2);
  assert.equal(amd64LevelFromFlags(v3), 3);
  for (const missing of ["avx", "avx2", "bmi1", "bmi2", "f16c", "fma", "abm", "movbe", "xsave"])
    assert.equal(
      amd64LevelFromFlags(
        v3
          .split(" ")
          .filter((flag) => flag !== missing)
          .join(" "),
      ),
      2,
    );
  assert.equal(
    amd64LevelFromFlags(
      "SSE2 SSE3 SSSE3 SSE4.1 SSE4.2 POPCNT CX16 LAHF AVX1.0 AVX2 BMI1 BMI2 F16C FMA LZCNT MOVBE XSAVE",
    ),
    3,
  );
});

it("requires Windows OS AVX support in addition to CPU instruction bits", () => {
  const observation = {
    ecx: [0, 9, 12, 13, 19, 20, 22, 23, 26, 27, 28, 29].reduce((bits, bit) => bits | (1 << bit), 0),
    ebx7: (1 << 3) | (1 << 5) | (1 << 8),
    ecxExtended: 1 | (1 << 5),
    avx: true,
    avx2: true,
  };
  assert.equal(amd64LevelFromWindows(observation), 3);
  assert.equal(amd64LevelFromWindows({ ...observation, avx: false }), 2);
  assert.equal(amd64LevelFromWindows({ ...observation, avx2: false }), 2);
  assert.equal(amd64LevelFromWindows({ ...observation, ecxExtended: 1 }), 2);
  assert.equal(amd64LevelFromWindows({ ...observation, ecxExtended: 0 }), 1);
  assert.equal(amd64LevelFromWindows({ ...observation, ecx: "unknown" }), undefined);
});

it("selects available compatible assets without falling forward to unsupported v3", () => {
  const asset = (variant: string): ReleaseAsset => ({
    name: `mihomo-windows-amd64-${variant ? `${variant}-` : ""}v1.19.30.zip`,
    size: 1,
    digest: `sha256:${"a".repeat(64)}`,
    browser_download_url: "https://github.com/asset",
  });
  const assets = [asset(""), asset("v2"), asset("v1"), asset("compatible")];
  assert.equal(
    selectReleaseAsset(assets, mihomoAssetCandidates("v1.19.30", "win32", "x64", 3))?.name,
    assets[0]?.name,
  );
  assert.equal(
    selectReleaseAsset(assets, mihomoAssetCandidates("v1.19.30", "win32", "x64", 2))?.name,
    assets[1]?.name,
  );
  assert.equal(
    selectReleaseAsset(assets, mihomoAssetCandidates("v1.19.30", "win32", "x64", 1))?.name,
    assets[2]?.name,
  );
  assert.equal(
    selectReleaseAsset(assets, mihomoAssetCandidates("v1.19.30", "win32", "x64"))?.name,
    assets[3]?.name,
  );
  assert.equal(
    selectReleaseAsset([asset("")], mihomoAssetCandidates("v1.19.30", "win32", "x64")),
    undefined,
  );
  assert.equal(
    selectReleaseAsset([asset("v1")], mihomoAssetCandidates("v1.19.30", "win32", "x64", 3))?.name,
    asset("v1").name,
  );
});
