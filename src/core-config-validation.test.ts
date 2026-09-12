import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { isGeodataDownloadFailure, validateCoreConfig } from "./core-config-validation.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { deferred } from "./testing/state.js";

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
    await validateCoreConfig(layout.coreExe, "rules:\n  - MATCH,DIRECT\n", layout, {
      runner: (executable, args) => {
        assert.equal(executable, layout.coreExe);
        assert.deepEqual(args.slice(0, 4), ["-t", "-d", layout.root, "-f"]);
        candidate = args[4] ?? "";
        assert.equal(fs.readFileSync(candidate, "utf8"), "rules:\n  - MATCH,DIRECT\n");
      },
    });

    assert.ok(candidate);
    assert.equal(fs.existsSync(candidate), false);
  });

  it("can validate the candidate with an explicit staged executable", async () => {
    const staged = path.join(layout.binDir, "staged-core");
    fs.writeFileSync(staged, "staged");
    let candidate = "";

    await validateCoreConfig(staged, "rules:\n  - MATCH,DIRECT\n", layout, {
      runner: (executable, args) => {
        assert.equal(executable, staged);
        candidate = args[4] ?? "";
        assert.equal(fs.readFileSync(candidate, "utf8"), "rules:\n  - MATCH,DIRECT\n");
      },
    });

    assert.ok(candidate);
    assert.equal(fs.existsSync(candidate), false);
  });

  it("surfaces validation errors without leaving the candidate behind", async () => {
    let candidate = "";
    await assert.rejects(
      () =>
        validateCoreConfig(layout.coreExe, "rules: invalid\n", layout, {
          runner: (_executable, args) => {
            candidate = args[4] ?? "";
            throw Object.assign(new Error("command failed"), {
              stderr: Buffer.from("invalid rule target"),
            });
          },
        }),
      /Core rejected generated configuration: invalid rule target/,
    );
    assert.ok(candidate);
    assert.equal(fs.existsSync(candidate), false);
  });

  it("fails closed when the installed Core is missing", async () => {
    fs.rmSync(layout.coreExe);
    await assert.rejects(
      () => validateCoreConfig(layout.coreExe, "rules: []\n", layout),
      /Core executable is missing/,
    );
  });

  describe("isGeodataDownloadFailure", () => {
    it("recognizes a fast failure that names the geodata download", () => {
      const error = Object.assign(new Error("command failed"), {
        stderr: Buffer.from(
          'can\'t download MMDB: Get "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/country.mmdb": dial tcp 140.82.112.3:443: connectex: A connection attempt failed',
        ),
      });
      assert.equal(isGeodataDownloadFailure(error), true);
    });

    it("recognizes a killed validation that only started a geodata download", () => {
      assert.equal(
        isGeodataDownloadFailure({
          killed: true,
          stdout: `time="2026-01-01T00:00:00Z" level=info msg="Can't find MMDB, start download"`,
        }),
        true,
      );
    });

    it("recognizes a corrupt database the Core refused to parse", () => {
      const error = Object.assign(new Error("command failed"), {
        stderr: Buffer.from("can't load GeoSite.dat: unexpected EOF"),
      });
      assert.equal(isGeodataDownloadFailure(error), true);
    });

    it("does not treat an ordinary configuration error as a geodata failure", () => {
      const error = Object.assign(new Error("command failed"), {
        stderr: Buffer.from("rules[0] error: rule is invalid"),
      });
      assert.equal(isGeodataDownloadFailure(error), false);
    });

    it("does not treat a killed validation with no geodata line as a geodata failure", () => {
      assert.equal(
        isGeodataDownloadFailure({
          killed: true,
          stderr: Buffer.from("initial configuration directory error: open config.yaml"),
        }),
        false,
      );
    });
  });

  it("removes a geodata partial left by a failed download but keeps untouched files", async () => {
    fs.writeFileSync(path.join(layout.root, "geoip.dat"), "valid-bytes");
    await assert.rejects(
      () =>
        validateCoreConfig(layout.coreExe, "rules: []\n", layout, {
          runner: () => {
            // The Core leaves a half-written database behind when killed mid-download.
            fs.writeFileSync(path.join(layout.root, "geosite.dat"), "partial");
            throw Object.assign(new Error("command failed"), {
              stderr: Buffer.from(
                'can\'t download GeoSite: Get "https://github.com/meta-rules-dat/geosite.dat": connection failed',
              ),
            });
          },
        }),
      /Core could not download its geodata databases/,
    );
    assert.equal(fs.existsSync(path.join(layout.root, "geosite.dat")), false);
    assert.equal(fs.readFileSync(path.join(layout.root, "geoip.dat"), "utf8"), "valid-bytes");
  });

  it("removes a corrupt database the Core names in its error", async () => {
    fs.writeFileSync(path.join(layout.root, "geosite.dat"), "truncated");
    await assert.rejects(
      () =>
        validateCoreConfig(layout.coreExe, "rules: []\n", layout, {
          runner: () => {
            throw Object.assign(new Error("command failed"), {
              stderr: Buffer.from("can't load GeoSite.dat: unexpected EOF"),
            });
          },
        }),
      /Core could not download its geodata databases/,
    );
    assert.equal(fs.existsSync(path.join(layout.root, "geosite.dat")), false);
  });

  it("keeps untouched databases a download failure merely names in its URL", async () => {
    fs.writeFileSync(path.join(layout.root, "country.mmdb"), "valid-mmdb");
    await assert.rejects(
      () =>
        validateCoreConfig(layout.coreExe, "rules: []\n", layout, {
          runner: () => {
            throw Object.assign(new Error("command failed"), {
              stderr: Buffer.from(
                'can\'t download MMDB: Get "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/country.mmdb": dial tcp: connection failed',
              ),
            });
          },
        }),
      /Core could not download its geodata databases/,
    );
    assert.equal(fs.readFileSync(path.join(layout.root, "country.mmdb"), "utf8"), "valid-mmdb");
  });

  it("cancels validation and removes its private candidate", async () => {
    const entered = deferred();
    const controller = new AbortController();
    const reason = new Error("stop requested");
    let candidate = "";
    const validating = validateCoreConfig(layout.coreExe, "rules: []\n", layout, {
      signal: controller.signal,
      runner: async (_executable, args, signal) => {
        candidate = args[4] ?? "";
        entered.resolve();
        await new Promise<void>((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      },
    });
    await entered.promise;
    controller.abort(reason);
    await assert.rejects(validating, (error) => error === reason);
    assert.equal(fs.existsSync(candidate), false);
  });
});
