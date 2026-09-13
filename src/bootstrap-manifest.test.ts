import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseBootstrapManifest, readBootstrapManifest } from "./bootstrap-manifest.js";

const VALID = {
  core: {
    tag: "v1.19.30",
    assets: [
      { name: "mihomo-windows-amd64-v3-v1.19.30.zip", size: 1024, sha256: "1".repeat(64) },
      { name: "mihomo-linux-arm64-v1.19.30.gz", size: 2048, sha256: "2".repeat(64) },
    ],
  },
  geodata: {
    tag: "latest",
    assets: [{ name: "geoip.dat", size: 4096, sha256: "3".repeat(64) }],
  },
};

describe("parseBootstrapManifest", () => {
  it("accepts a well-formed manifest", () => {
    assert.deepEqual(parseBootstrapManifest(VALID), VALID);
  });

  it("rejects non-objects and incomplete sections", () => {
    assert.equal(parseBootstrapManifest(null), undefined);
    assert.equal(parseBootstrapManifest([]), undefined);
    assert.equal(parseBootstrapManifest({}), undefined);
    assert.equal(parseBootstrapManifest({ core: VALID.core }), undefined);
    assert.equal(
      parseBootstrapManifest({ core: VALID.core, geodata: { tag: "latest" } }),
      undefined,
    );
  });

  it("rejects unsafe tags", () => {
    const bad = structuredClone(VALID);
    bad.core.tag = "../../escape";
    assert.equal(parseBootstrapManifest(bad), undefined);
  });

  it("drops invalid assets and rejects a section left empty", () => {
    const mixed = structuredClone(VALID);
    mixed.core.assets.push(
      { name: "../escape", size: 1, sha256: "4".repeat(64) },
      { name: "ok.zip", size: -1, sha256: "5".repeat(64) },
      { name: "ok.zip", size: 1, sha256: "not-hex" },
    );
    const parsed = parseBootstrapManifest(mixed);
    assert.deepEqual(parsed, VALID);

    const emptied = structuredClone(VALID);
    emptied.geodata.assets = [{ name: "x", size: 1, sha256: "nope" }];
    assert.equal(parseBootstrapManifest(emptied), undefined);
  });
});

describe("readBootstrapManifest", () => {
  it("reads a manifest file and treats anything unreadable as absent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-manifest-test-"));
    try {
      const file = path.join(dir, "bootstrap-manifest.json");
      assert.equal(readBootstrapManifest(path.join(dir, "missing.json")), undefined);
      fs.writeFileSync(file, "not json");
      assert.equal(readBootstrapManifest(file), undefined);
      fs.writeFileSync(file, JSON.stringify(VALID));
      assert.deepEqual(readBootstrapManifest(file), VALID);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
