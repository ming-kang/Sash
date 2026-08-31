import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import zlib from "node:zlib";
import AdmZip from "adm-zip";
import {
  coreInstalled,
  currentCoreVersion,
  extractCoreArchive,
  goOsArch,
  mihomoAssetCandidates,
  readInstallRecord,
  writeInstallRecord,
} from "./core.js";
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
    it("returns windows candidates ending in .zip with default, compatible, and v1 variants for win32 x64", () => {
      const candidates = mihomoAssetCandidates("v1.19.30", "win32", "x64");
      assert.deepEqual(candidates, [
        "mihomo-windows-amd64-v1.19.30.zip",
        "mihomo-windows-amd64-compatible-v1.19.30.zip",
        "mihomo-windows-amd64-v1-v1.19.30.zip",
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
        "mihomo-darwin-amd64-v1.19.30.gz",
        "mihomo-darwin-amd64-compatible-v1.19.30.gz",
        "mihomo-darwin-amd64-v1-v1.19.30.gz",
      ]);
      for (const c of candidates) {
        assert.ok(c.endsWith(".gz"));
      }
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

    it("throws an error when a .zip archive does not contain an .exe file", async () => {
      const zip = new AdmZip();
      zip.addFile("README.txt", Buffer.from("no executable here"));
      const zipPath = path.join(tmpDir, "no-exe.zip");
      zip.writeZip(zipPath);

      const destExe = path.join(tmpDir, "bin", "mihomo.exe");
      fs.mkdirSync(path.dirname(destExe), { recursive: true });

      await assert.rejects(
        () => extractCoreArchive(zipPath, "no-exe.zip", destExe),
        /No \.exe found inside no-exe\.zip/,
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
  });

  describe("install records & coreInstalled", () => {
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
  });
});
