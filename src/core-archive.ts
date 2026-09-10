import fs from "node:fs";
import path from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { type Entry, openPromise, type ZipFile } from "yauzl";
import { CORE_BINARY_SIZE_LIMIT } from "./core-binary.js";
import { RELEASE_ASSET_SIZE_LIMIT } from "./github.js";

function extractionLimiter(): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > CORE_BINARY_SIZE_LIMIT) {
        callback(new Error("Extracted binary exceeds 512MB safety limit"));
        return;
      }
      callback(null, chunk);
    },
  });
}

/** Read archive entries only; Sash exclusively creates and owns the output file. */
export async function extractCoreArchive(
  archivePath: string,
  assetName: string,
  destExe: string,
  signal?: AbortSignal,
): Promise<void> {
  const extracted = `${destExe}.extracted`;
  let created = false;
  let zip: ZipFile | undefined;
  let closed: Promise<void> | undefined;
  let input: Readable | undefined;
  const transforms: Transform[] = [];
  try {
    signal?.throwIfAborted();
    if (!assetName.endsWith(".zip") && !assetName.endsWith(".gz"))
      throw new Error(`Unsupported archive type: ${assetName}`);
    const archive = fs.lstatSync(archivePath);
    if (!archive.isFile() || archive.size > RELEASE_ASSET_SIZE_LIMIT)
      throw new Error("Core archive must be a regular file within the download safety limit");
    if (assetName.endsWith(".zip")) {
      zip = await openPromise(archivePath, {
        autoClose: false,
        strictFileNames: true,
        validateEntrySizes: true,
      });
      closed = new Promise<void>((resolve) => zip?.once("close", resolve));
      let executable: Entry | undefined;
      // Scan every name before creating output, including entries after the executable.
      for await (const entry of zip.eachEntry()) {
        signal?.throwIfAborted();
        if (
          entry.fileName.split(/[\\/]/).includes("..") ||
          /^(?:[\\/]|[A-Za-z]:)/.test(entry.fileName) ||
          entry.fileName.includes("\0")
        )
          throw new Error("Core archive contains an unsafe path");
        if (
          !executable &&
          !entry.fileName.endsWith("/") &&
          /^mihomo.*\.exe$/i.test(path.posix.basename(entry.fileName))
        )
          executable = entry;
      }
      if (!executable) throw new Error(`No mihomo*.exe found inside ${assetName}`);
      if (executable.uncompressedSize > CORE_BINARY_SIZE_LIMIT)
        throw new Error("Extracted binary exceeds 512MB safety limit");
      if (executable.isEncrypted()) throw new Error("Encrypted Core archives are not supported");
      if (executable.compressionMethod !== 0 && executable.compressionMethod !== 8)
        throw new Error(`Unsupported ZIP compression method: ${executable.compressionMethod}`);
      input = await zip.openReadStreamPromise(executable);
    } else {
      input = fs.createReadStream(archivePath);
      transforms.push(zlib.createGunzip());
    }
    signal?.throwIfAborted();
    const fd = fs.openSync(extracted, "wx", 0o755);
    created = true;
    let output: fs.WriteStream;
    try {
      output = fs.createWriteStream(extracted, { fd, autoClose: true });
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
    await pipeline([input, ...transforms, extractionLimiter(), output], { signal });
    signal?.throwIfAborted();
    fs.renameSync(extracted, destExe);
  } catch (error) {
    if (created) fs.rmSync(extracted, { force: true });
    throw error;
  } finally {
    input?.destroy();
    if (zip) {
      zip.close();
      await closed;
    }
  }
}
