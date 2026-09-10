import crypto from "node:crypto";
import { readBoundedJsonFile } from "./bounded-file.js";
import { errnoCode } from "./error-utils.js";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { hasExactOwnKeys, isPlainObject, isSha256 } from "./json-shape.js";

export interface SignedFileOptions {
  /** MAC input prefix that binds one file role; empty when the owning module already scopes it. */
  domain: string;
  maxBytes: number;
  /** Human-readable subject used in validation errors. */
  subject: string;
  mode?: number;
}

function mac(key: string, domain: string, payload: unknown): Buffer {
  return crypto
    .createHmac("sha256", key)
    .update(`${domain}${JSON.stringify(payload)}`)
    .digest();
}

/** Atomically write one `{payload, mac}` envelope over the exact serialized payload. */
export function writeSignedFile(
  file: string,
  key: string,
  payload: unknown,
  options: SignedFileOptions,
): void {
  const text = `${JSON.stringify({ payload, mac: mac(key, options.domain, payload).toString("hex") })}\n`;
  if (Buffer.byteLength(text) > options.maxBytes)
    throw new Error(`${options.subject} exceeds its size limit`);
  atomicWriteFileSync(file, text, options.mode);
}

/** Read and authenticate an envelope. A missing file is `undefined`; invalid files are preserved. */
export function readSignedFile(
  file: string,
  key: string,
  options: SignedFileOptions,
): unknown | undefined {
  let value: unknown;
  try {
    value = readBoundedJsonFile(file, options.maxBytes);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (!isPlainObject(value) || !hasExactOwnKeys(value, ["payload", "mac"]) || !isSha256(value.mac))
    throw new Error(`Invalid signed ${options.subject}`);
  const expected = mac(key, options.domain, value.payload);
  if (!crypto.timingSafeEqual(expected, Buffer.from(value.mac, "hex")))
    throw new Error(`${options.subject} authentication failed; files preserved`);
  return value.payload;
}
