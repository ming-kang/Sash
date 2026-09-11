import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import {
  exactSashVersion,
  parseSashPackageInfo,
  readSashPackageInfo,
  supportsNode,
} from "./package-info.js";

const manifest = {
  name: "@astralyn/sash",
  version: "1.2.3",
  bin: { sash: "dist/cli.js" },
  engines: { node: ">=24.5.0 <25 || >=26" },
};

it("accepts exact versions and rejects npm paths, ranges and noncanonical versions", () => {
  for (const value of ["1.2.3", "1.2.3-rc.2", "1.2.3+build.4"])
    assert.equal(exactSashVersion(value), value);
  for (const value of [
    "latest",
    "^1.2.3",
    "v1.2.3",
    "1.2.3-01",
    "1.02.3",
    "file:../other",
    "https://example.test/other.tgz",
    "1.2.3;echo x",
    "1".repeat(257),
    123,
  ])
    assert.throws(() => exactSashVersion(value));
});

it("verifies package identity and the full Node engine range", () => {
  const info = parseSashPackageInfo(manifest);
  assert.equal(supportsNode(info, "v24.6.0"), true);
  assert.equal(supportsNode(info, "v24.4.0"), false);
  assert.equal(supportsNode(info, "v25.0.0"), false);
  assert.equal(supportsNode(info, "v26.0.0"), true);
  for (const patch of [{ name: "other" }, { engines: {} }, { engines: { node: "not a range" } }])
    assert.throws(() => parseSashPackageInfo({ ...manifest, ...patch }));
});

it("bounds package metadata reads and does not initialize application state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-package-info-test-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, "package.json");
  fs.writeFileSync(file, JSON.stringify(manifest));
  assert.equal(readSashPackageInfo(root).version, "1.2.3");
  assert.deepEqual(fs.readdirSync(root), ["package.json"]);
  fs.writeFileSync(file, "x".repeat(64 * 1024 + 1));
  assert.throws(() => readSashPackageInfo(root), /manifest/);
});
