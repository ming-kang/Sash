import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import zlib from "node:zlib";
import AdmZip from "adm-zip";
import {
  assertCoreInstallationConsistent,
  coreInstalled,
  currentCoreVersion,
  extractCoreArchive,
  goOsArch,
  mihomoAssetCandidates,
  readInstallRecord,
  validateCoreReleaseTag,
  verifyCoreExecutable,
  writeInstallRecord,
} from "./core.js";
import { type ReleaseAsset, selectReleaseAsset } from "./github.js";
import { type SashLayout, sashLayout } from "./paths.js";

describe("core", () => {
  let tmpDir: string;
  let layout: SashLayout;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-core-test-"));
    layout = sashLayout(tmpDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  describe("goOsArch", () => {
    it("maps supported win32/x64 to windows/amd64", () => {
      assert.deepEqual(goOsArch("win32", "x64"), { os: "windows", arch: "amd64" });
    });

    it("maps supported darwin/arm64 to darwin/arm64", () => {
      assert.deepEqual(goOsArch("darwin", "arm64"), { os: "darwin", arch: "arm64" });
    });

    it("maps supported linux/x64 to linux/amd64 and linux/arm64 to linux/arm64", () => {
      assert.deepEqual(goOsArch("linux", "x64"), { os: "linux", arch: "amd64" });
      assert.deepEqual(goOsArch("linux", "arm64"), { os: "linux", arch: "arm64" });
    });

    it("throws an error for unsupported platforms or architectures", () => {
      assert.throws(
        () => goOsArch("linux", "arm" as unknown as NodeJS.Architecture),
        /Unsupported platform: linux\/arm/,
      );
      assert.throws(
        () => goOsArch("freebsd" as unknown as NodeJS.Platform, "x64"),
        /Unsupported platform: freebsd\/x64/,
      );
      assert.throws(
        () => goOsArch("win32", "ia32" as unknown as NodeJS.Architecture),
        /Unsupported platform: win32\/ia32/,
      );
    });
  });

  describe("mihomoAssetCandidates", () => {
    it("returns windows candidates ending in .zip with compatible builds first for win32 x64", () => {
      const candidates = mihomoAssetCandidates("v1.19.30", "win32", "x64");
      assert.deepEqual(candidates, [
        "mihomo-windows-amd64-compatible-v1.19.30.zip",
        "mihomo-windows-amd64-v1-v1.19.30.zip",
        "mihomo-windows-amd64-v1.19.30.zip",
      ]);
      for (const c of candidates) {
        assert.ok(c.endsWith(".zip"));
      }
    });

    it("returns linux arm64 candidate ending in .gz", () => {
      const candidates = mihomoAssetCandidates("v1.19.30", "linux", "arm64");
      assert.deepEqual(candidates, ["mihomo-linux-arm64-v1.19.30.gz"]);
    });

    it("returns darwin amd64 candidates with all variants ending in .gz", () => {
      const candidates = mihomoAssetCandidates("v1.19.30", "darwin", "x64");
      assert.deepEqual(candidates, [
        "mihomo-darwin-amd64-compatible-v1.19.30.gz",
        "mihomo-darwin-amd64-v1-v1.19.30.gz",
        "mihomo-darwin-amd64-v1.19.30.gz",
      ]);
      for (const c of candidates) {
        assert.ok(c.endsWith(".gz"));
      }
    });

    it("actually selects the compatible asset when all amd64 variants exist", () => {
      const candidates = mihomoAssetCandidates("v1.19.30", "linux", "x64");
      const asset = (name: string): ReleaseAsset => ({
        name,
        browser_download_url: `https://example.test/${name}`,
        size: 1,
        digest: `sha256:${"a".repeat(64)}`,
      });
      const assets = [
        asset("mihomo-linux-amd64-v1.19.30.gz"),
        asset("mihomo-linux-amd64-v1-v1.19.30.gz"),
        asset("mihomo-linux-amd64-compatible-v1.19.30.gz"),
      ];

      assert.equal(
        selectReleaseAsset(assets, candidates)?.name,
        "mihomo-linux-amd64-compatible-v1.19.30.gz",
      );
    });
  });

  describe("extractCoreArchive", () => {
    it("extracts executable from a .zip archive to destination path", async () => {
      const fakeExeData = Buffer.from("fake-windows-binary-content-12345");
      const zip = new AdmZip();
      zip.addFile("mihomo.exe", fakeExeData);
      const zipPath = path.join(tmpDir, "archive.zip");
      zip.writeZip(zipPath);

      const destExe = path.join(tmpDir, "bin", "mihomo.exe");
      fs.mkdirSync(path.dirname(destExe), { recursive: true });

      await extractCoreArchive(zipPath, "mihomo-windows-amd64-v1.19.30.zip", destExe);

      assert.equal(fs.existsSync(destExe), true);
      assert.deepEqual(fs.readFileSync(destExe), fakeExeData);
    });

    it("prefers the mihomo*.exe entry when a .zip contains multiple executables", async () => {
      const zip = new AdmZip();
      zip.addFile("helper.exe", Buffer.from("helper-tool"));
      zip.addFile("mihomo-windows-amd64.exe", Buffer.from("real-core-binary"));
      const zipPath = path.join(tmpDir, "multi.zip");
      zip.writeZip(zipPath);

      const destExe = path.join(tmpDir, "bin", "mihomo.exe");
      fs.mkdirSync(path.dirname(destExe), { recursive: true });

      await extractCoreArchive(zipPath, "mihomo-windows-amd64-v1.19.30.zip", destExe);
      assert.deepEqual(fs.readFileSync(destExe), Buffer.from("real-core-binary"));
    });

    it("extracts binary from a .gz archive to destination path", async () => {
      const fakeBinaryData = Buffer.from("fake-linux-binary-content-67890");
      const gzData = zlib.gzipSync(fakeBinaryData);
      const gzPath = path.join(tmpDir, "archive.gz");
      fs.writeFileSync(gzPath, gzData);

      const destExe = path.join(tmpDir, "bin", "mihomo");
      fs.mkdirSync(path.dirname(destExe), { recursive: true });

      await extractCoreArchive(gzPath, "mihomo-linux-amd64-v1.19.30.gz", destExe);

      assert.equal(fs.existsSync(destExe), true);
      assert.deepEqual(fs.readFileSync(destExe), fakeBinaryData);
    });

    it("rejects a helper-only .zip instead of installing an arbitrary executable", async () => {
      const zip = new AdmZip();
      zip.addFile("tools/helper.exe", Buffer.from("helper-tool"));
      const zipPath = path.join(tmpDir, "helper-only.zip");
      zip.writeZip(zipPath);

      const destExe = path.join(tmpDir, "bin", "mihomo.exe");
      fs.mkdirSync(path.dirname(destExe), { recursive: true });

      await assert.rejects(
        () => extractCoreArchive(zipPath, "helper-only.zip", destExe),
        /No mihomo\*\.exe found inside helper-only\.zip/,
      );
      assert.equal(fs.existsSync(destExe), false);
    });

    it("throws an error when a .zip archive does not contain an .exe file", async () => {
      const zip = new AdmZip();
      zip.addFile("README.txt", Buffer.from("no executable here"));
      const zipPath = path.join(tmpDir, "no-exe.zip");
      zip.writeZip(zipPath);

      const destExe = path.join(tmpDir, "bin", "mihomo.exe");
      fs.mkdirSync(path.dirname(destExe), { recursive: true });

      await assert.rejects(
        () => extractCoreArchive(zipPath, "no-exe.zip", destExe),
        /No mihomo\*\.exe found inside no-exe\.zip/,
      );
      assert.equal(fs.existsSync(destExe), false);
      assert.equal(fs.existsSync(`${destExe}.extracted`), false);
    });

    it("throws an error for unsupported archive extensions", async () => {
      const tarPath = path.join(tmpDir, "archive.tar");
      fs.writeFileSync(tarPath, "dummy");
      const destExe = path.join(tmpDir, "bin", "mihomo");

      await assert.rejects(
        () => extractCoreArchive(tarPath, "archive.tar", destExe),
        /Unsupported archive type: archive\.tar/,
      );
    });

    it("rejects traversal paths before extracting any executable", async () => {
      const zip = new AdmZip();
      zip.addFile("safe/mihomo.exe", Buffer.from("core"));
      const bytes = zip.toBuffer();
      const name = Buffer.from("safe/mihomo.exe");
      // Patch both ZIP directory entries without a library sanitizing the malicious path.
      for (let at = bytes.indexOf(name); at >= 0; at = bytes.indexOf(name, at + name.length)) {
        Buffer.from(".././mihomo.exe").copy(bytes, at);
      }
      const archive = path.join(tmpDir, "traversal.zip");
      const target = path.join(tmpDir, "core.exe");
      fs.writeFileSync(archive, bytes);
      await assert.rejects(extractCoreArchive(archive, "core.zip", target), /unsafe path/);
      assert.equal(fs.existsSync(target), false);
      assert.equal(fs.existsSync(`${target}.extracted`), false);
    });

    it("rejects oversized ZIP output before allocating the declared contents", async () => {
      const zip = new AdmZip();
      zip.addFile("mihomo.exe", Buffer.from("core"));
      const bytes = zip.toBuffer();
      const directory = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      assert.ok(directory >= 0);
      bytes.writeUInt32LE(513 * 1024 * 1024, directory + 24);
      const archive = path.join(tmpDir, "oversized.zip");
      const target = path.join(tmpDir, "core.exe");
      fs.writeFileSync(archive, bytes);
      await assert.rejects(extractCoreArchive(archive, "core.zip", target), /512MB safety limit/);
      assert.equal(fs.existsSync(target), false);
    });
  });

  describe("release tag validation", () => {
    it("accepts release tokens and rejects path/control characters", () => {
      assert.equal(validateCoreReleaseTag("v1.19.30"), "v1.19.30");
      assert.equal(validateCoreReleaseTag("Prerelease-Alpha"), "Prerelease-Alpha");
      assert.throws(() => validateCoreReleaseTag("../../escape"), /Invalid Core release tag/);
      assert.throws(() => validateCoreReleaseTag("tag/asset"), /Invalid Core release tag/);
      assert.throws(() => validateCoreReleaseTag("bad\ntag"), /Invalid Core release tag/);
    });
  });

  describe("staged binary validation", () => {
    it("accepts an executable that exits successfully for -v", () => {
      assert.doesNotThrow(() => verifyCoreExecutable(process.execPath));
    });

    it("rejects a non-executable or invalid binary", () => {
      const invalid = path.join(tmpDir, "invalid-core.exe");
      fs.writeFileSync(invalid, "not an executable");
      assert.throws(() => verifyCoreExecutable(invalid, 1000), /failed validation/);
    });

    it("rejects a binary whose version output does not match the requested release", () => {
      assert.throws(
        () => verifyCoreExecutable(process.execPath, 5000, "v0.0.0-impossible"),
        /does not contain expected release/,
      );
      assert.throws(
        () => verifyCoreExecutable(process.execPath, 5000, process.version.split(".")[0]),
        /does not contain expected release/,
      );
    });
  });

  describe("install records & coreInstalled", () => {
    it("rejects malformed or unknown install metadata", () => {
      fs.mkdirSync(layout.stateDir, { recursive: true });
      fs.writeFileSync(layout.installFile, JSON.stringify({ coreVersion: null }));
      assert.equal(readInstallRecord(layout), undefined);
      fs.writeFileSync(
        layout.installFile,
        JSON.stringify({
          coreVersion: "v1.19.30",
          installedAt: "2025-01-01T00:00:00.000Z",
          unexpected: true,
        }),
      );
      assert.equal(readInstallRecord(layout), undefined);
    });

    it("writes and reads install record", () => {
      assert.equal(readInstallRecord(layout), undefined);
      assert.equal(currentCoreVersion(layout), "");
      assert.equal(coreInstalled(layout), false);

      const record = { coreVersion: "v1.19.30", installedAt: "2025-01-01T00:00:00.000Z" };
      writeInstallRecord(record, layout);

      assert.deepEqual(readInstallRecord(layout), record);
      assert.equal(currentCoreVersion(layout), "v1.19.30");

      fs.mkdirSync(path.dirname(layout.coreExe), { recursive: true });
      fs.writeFileSync(layout.coreExe, "binary");
      assert.equal(coreInstalled(layout), true);
    });

    it("does not count a binary without valid install metadata as installed", () => {
      fs.mkdirSync(layout.binDir, { recursive: true });
      fs.writeFileSync(layout.coreExe, "ambiguous-binary");

      assert.equal(coreInstalled(layout), false);
      assert.throws(() => assertCoreInstallationConsistent(layout), /clean data directory/);

      fs.mkdirSync(layout.stateDir, { recursive: true });
      fs.writeFileSync(layout.installFile, "{ malformed");
      assert.throws(
        () => assertCoreInstallationConsistent(layout),
        /without valid install metadata.*clean data directory/,
      );
    });

    it("fails closed when valid metadata exists without the binary", () => {
      writeInstallRecord(
        { coreVersion: "v1.19.30", installedAt: "2025-01-01T00:00:00.000Z" },
        layout,
      );
      assert.equal(coreInstalled(layout), false);
      assert.throws(
        () => assertCoreInstallationConsistent(layout),
        /executable is missing.*clean data directory/,
      );
    });
  });
});
