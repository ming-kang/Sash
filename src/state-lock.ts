import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { errnoCode, errorMessage } from "./error-utils.js";
import { isProcessAlive } from "./process.js";

/** On-disk ownership record for a state-file lock. */
export interface StateLockRecord {
  pid: number;
  token: string;
  purpose: string;
}

export interface StateLockOptions {
  /** A short description included in diagnostics and the on-disk record. */
  purpose: string;
  /** Maximum time to wait for a live owner. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Delay between acquisition attempts. Defaults to 50 milliseconds. */
  pollMs?: number;
}

export interface StateLockLease {
  readonly file: string;
  readonly record: Readonly<StateLockRecord>;
  /** Release this lease only when the lock still contains this lease's token. */
  release(): void;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 50;
/** A record that cannot be parsed within this window is abandoned, not being written. */
const WRITE_GRACE_MS = 250;

function ownerText(record?: StateLockRecord): string {
  return `owner PID ${record?.pid ?? "unknown"}, purpose ${JSON.stringify(record?.purpose ?? "unknown")}`;
}

function lockError(file: string, message: string, record?: StateLockRecord): Error {
  return new Error(`State lock ${message}: ${file} (${ownerText(record)})`);
}

/** Lenient by design: the lock file is a diagnostic record, not a validated schema. */
function readLockRecord(file: string): StateLockRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.pid !== "number" ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.token !== "string" ||
    !value.token
  )
    return undefined;
  return {
    pid: value.pid,
    token: value.token,
    purpose: typeof value.purpose === "string" ? value.purpose : "unknown",
  };
}

/** Read the current owner without modifying the lock file. Missing or unreadable files are absent. */
export function readStateLockRecord(file: string): StateLockRecord | undefined {
  return readLockRecord(file);
}

function writeLockRecord(file: string, record: StateLockRecord): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if (errnoCode(error) === "EEXIST") return false;
    throw lockError(file, `could not be created (${errorMessage(error)})`);
  }
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function releaseLock(file: string, record: { token: string }): void {
  const current = readLockRecord(file);
  if (!current || current.token !== record.token) return;
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT")
      throw lockError(file, `could not be released (${errorMessage(error)})`, current);
  }
}

function createLease(file: string, record: StateLockRecord): StateLockLease {
  return { file, record, release: () => releaseLock(file, record) };
}

/**
 * Remove a lock whose owner is no longer running, or whose record has stayed
 * unreadable past the write grace. The rename makes the removal exclusive:
 * another contender either moves the same file first or sees ENOENT. Returns
 * whether the canonical path was freed.
 */
function reclaimLock(file: string): boolean {
  const current = readLockRecord(file);
  if (current) {
    if (isProcessAlive(current.pid)) return false;
  } else {
    let ageMs: number;
    try {
      ageMs = Date.now() - fs.statSync(file).mtimeMs;
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return true;
      throw lockError(file, `could not be inspected (${errorMessage(error)})`);
    }
    if (ageMs < WRITE_GRACE_MS) return false;
  }
  const stale = `${file}.stale.${process.pid}.${crypto.randomBytes(8).toString("hex")}`;
  try {
    fs.renameSync(file, stale);
  } catch (error) {
    return errnoCode(error) === "ENOENT";
  }
  try {
    fs.unlinkSync(stale);
  } catch {
    // The canonical path is already free; a leftover stale file is diagnostic only.
  }
  return true;
}

/** Acquire a state-file lock without blocking the Node.js event loop. */
export async function acquireStateLock(
  file: string,
  options: StateLockOptions,
): Promise<StateLockLease> {
  const purpose = options.purpose?.trim();
  if (!purpose) throw lockError(file, "requires a non-empty purpose");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (error) {
    throw lockError(file, `parent directory could not be created (${errorMessage(error)})`);
  }
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const record: StateLockRecord = {
        pid: process.pid,
        token: crypto.randomBytes(24).toString("hex"),
        purpose,
      };
      if (writeLockRecord(file, record)) return createLease(file, record);
      if (!reclaimLock(file)) break;
    }
    const owner = readLockRecord(file);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw lockError(file, "is busy", owner);
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
  }
}

/** Acquire a lock, run an action, and release the lock even when the action fails. */
export async function withStateLock<T>(
  file: string,
  options: StateLockOptions,
  action: (lease: StateLockLease) => T | Promise<T>,
): Promise<T> {
  const lease = await acquireStateLock(file, options);
  try {
    return await action(lease);
  } finally {
    lease.release();
  }
}

/** Serializes in-process mutations under the same cross-process lock file. */
export class StateMutationQueue {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly timeoutMs = 30_000,
  ) {}

  run<T>(purpose: string, action: () => T | Promise<T>): Promise<T> {
    const operation = () =>
      withStateLock(this.file, { purpose, timeoutMs: this.timeoutMs }, () => action());
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
