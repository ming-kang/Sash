import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { HELPER_ARCHITECTURES, helperAssetFileName } from "../../scripts/helper-data.mjs";
import { type HelperDigestAsset, parseHelperDigests, readHelperDigests } from "./helper-digests.js";

const validAsset = {
  name: "sash-tun-helper-win32-x64.exe",
  size: 1024,
  sha256: "a".repeat(64),
};

describe("parseHelperDigests", () => {
  it("parses the assets a release package carries", () => {
    assert.deepEqual(parseHelperDigests({ version: "0.7.1", assets: [validAsset] }), [validAsset]);
  });

  it("drops malformed assets and rejects a file with nothing usable", () => {
    const other = { ...validAsset, name: "sash-tun-helper-win32-arm64.exe" };
    assert.deepEqual(parseHelperDigests({ assets: [{ ...validAsset, sha256: "bad" }, other] }), [
      other,
    ]);
    assert.equal(parseHelperDigests({ assets: [{ ...validAsset, size: 0 }] }), undefined);
    assert.equal(parseHelperDigests({ assets: "nope" }), undefined);
    assert.equal(parseHelperDigests("nope"), undefined);
    assert.equal(parseHelperDigests({ assets: [] }), undefined);
  });

  it("rejects asset names outside the helper naming scheme", () => {
    for (const name of ["mihomo.exe", "../x", "sash-tun-helper-win32-x64.exe/evil"]) {
      assert.equal(parseHelperDigests({ assets: [{ ...validAsset, name }] }), undefined);
    }
  });
});

describe("readHelperDigests", () => {
  it("reads leniently: missing or malformed files mean no fallback", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-helper-digests-"));
    try {
      assert.equal(readHelperDigests(path.join(dir, "missing.json")), undefined);
      const malformed = path.join(dir, "malformed.json");
      fs.writeFileSync(malformed, "not json");
      assert.equal(readHelperDigests(malformed), undefined);
      const valid = path.join(dir, "valid.json");
      fs.writeFileSync(valid, JSON.stringify({ version: "0.7.1", assets: [validAsset] }));
      assert.deepEqual(readHelperDigests(valid), [validAsset]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("build-helper-digests.mjs contract", () => {
  it("writes a file the runtime parser accepts for every shipped architecture", () => {
    const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-helper-digests-build-"));
    try {
      const exes = new Map<string, Buffer>();
      for (const arch of Object.keys(HELPER_ARCHITECTURES)) {
        const bytes = Buffer.from(`fake ${arch} helper ${process.pid}`);
        exes.set(arch, bytes);
        fs.writeFileSync(path.join(dir, helperAssetFileName(arch)), bytes);
      }
      const outFile = path.join(dir, "out", "tun-helper-digests.json");
      const result = spawnSync(
        process.execPath,
        [path.join(root, "scripts", "build-helper-digests.mjs"), dir, outFile],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);

      const parsed = parseHelperDigests(JSON.parse(fs.readFileSync(outFile, "utf8")));
      assert.ok(parsed);
      assert.deepEqual(
        parsed.map((asset) => asset.name).sort(),
        Object.keys(HELPER_ARCHITECTURES)
          .map((arch) => helperAssetFileName(arch))
          .sort(),
      );
      for (const [arch, bytes] of exes) {
        const asset: HelperDigestAsset | undefined = parsed.find(
          (entry) => entry.name === helperAssetFileName(arch),
        );
        assert.ok(asset);
        assert.equal(asset.size, bytes.length);
        assert.equal(asset.sha256, createHash("sha256").update(bytes).digest("hex"));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when the artifact is missing an architecture", () => {
    const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-helper-digests-missing-"));
    try {
      fs.writeFileSync(path.join(dir, helperAssetFileName("x64")), "x64 only");
      const result = spawnSync(
        process.execPath,
        [path.join(root, "scripts", "build-helper-digests.mjs"), dir, path.join(dir, "out.json")],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /the helper artifact is missing sash-tun-helper-win32-/);
      assert.equal(fs.existsSync(path.join(dir, "out.json")), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
