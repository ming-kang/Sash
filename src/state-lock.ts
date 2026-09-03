import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { errnoCode, errorMessage } from "./error-utils.js";
import { isPlainObject } from "./json-shape.js";
import { isProcessAlive } from "./process.js";

/** On-disk ownership record for a state-file lock. */
export interface StateLockRecord {
  version: 1;
  pid: number;
  token: string;
  purpose: string;
  acquiredAt: string;
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

interface NormalizedStateLockOptions {
  purpose: string;
  timeoutMs: number;
  pollMs: number;
}

interface StateLockOwner {
  pid?: number;
  purpose?: string;
}

type ExistingStateLock =
  | { kind: "missing" }
  | { kind: "valid"; record: StateLockRecord }
  | { kind: "corrupt"; reason: string; owner?: StateLockOwner };

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 50;
const syncWaitCell = new Int32Array(new SharedArrayBuffer(4));

function ownerDescription(owner?: StateLockOwner): string {
  const pid = owner?.pid ?? "unknown";
  const purpose = owner?.purpose === undefined ? "unknown" : JSON.stringify(owner.purpose);
  return `owner PID ${pid}, purpose ${purpose}`;
}

function lockError(file: string, message: string, owner?: StateLockOwner): Error {
  return new Error(`State lock ${message}: ${file} (${ownerDescription(owner)})`);
}

function normalizeOptions(file: string, options: StateLockOptions): NormalizedStateLockOptions {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.purpose !== "string" ||
    !options.purpose.trim()
  ) {
    throw lockError(file, "requires a non-empty purpose");
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw lockError(file, "requires timeoutMs to be a non-negative integer");
  }

  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  if (!Number.isInteger(pollMs) || pollMs <= 0) {
    throw lockError(file, "requires pollMs to be a positive integer");
  }

  return {
    purpose: options.purpose.trim(),
    timeoutMs,
    pollMs,
  };
}

function partialOwner(value: unknown): StateLockOwner | undefined {
  if (!isPlainObject(value)) return undefined;
  const pid =
    typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0
      ? value.pid
      : undefined;
  const purpose = typeof value.purpose === "string" && value.purpose ? value.purpose : undefined;
  return pid === undefined && purpose === undefined ? undefined : { pid, purpose };
}

function parseLockRecord(value: unknown): StateLockRecord | undefined {
  if (!isPlainObject(value)) return undefined;
  if (value.version !== 1) return undefined;
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) {
    return undefined;
  }
  if (typeof value.token !== "string" || !value.token) return undefined;
  if (typeof value.purpose !== "string" || !value.purpose) return undefined;
  if (typeof value.acquiredAt !== "string" || !value.acquiredAt) return undefined;

  return {
    version: 1,
    pid: value.pid,
    token: value.token,
    purpose: value.purpose,
    acquiredAt: value.acquiredAt,
  };
}

function readExistingStateLock(file: string): ExistingStateLock {
  try {
    if (!fs.lstatSync(file).isFile()) {
      return { kind: "corrupt", reason: "lock path is not a regular file" };
    }

    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      if (errnoCode(err) === "ENOENT") return { kind: "missing" };
      return { kind: "corrupt", reason: `lock record is not valid JSON (${errorMessage(err)})` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (err) {
      return { kind: "corrupt", reason: `lock record is not valid JSON (${errorMessage(err)})` };
    }

    const record = parseLockRecord(parsed);
    return record
      ? { kind: "valid", record }
      : {
          kind: "corrupt",
          reason: "lock record has an invalid shape",
          owner: partialOwner(parsed),
        };
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return { kind: "missing" };
    return { kind: "corrupt", reason: `lock record cannot be read (${errorMessage(err)})` };
  }
}

function removeMatchingStateLock(file: string, token: string): void {
  const existing = readExistingStateLock(file);
  if (existing.kind !== "valid" || existing.record.token !== token) return;

  try {
    fs.unlinkSync(file);
  } catch (err) {
    if (errnoCode(err) !== "ENOENT") {
      throw lockError(file, `could not be released (${errorMessage(err)})`, existing.record);
    }
  }
}

function createLease(file: string, record: StateLockRecord): StateLockLease {
  return {
    file,
    record,
    release: () => {
      removeMatchingStateLock(file, record.token);
    },
  };
}

function tryCreateStateLock(
  file: string,
  options: NormalizedStateLockOptions,
): StateLockLease | undefined {
  const record: StateLockRecord = {
    version: 1,
    pid: process.pid,
    token: crypto.randomBytes(24).toString("hex"),
    purpose: options.purpose,
    acquiredAt: new Date().toISOString(),
  };
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${record.token}.tmp`,
  );

  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    // A hard link gives create-if-absent semantics while ensuring contenders
    // can only observe the fully written record, never partial JSON.
    fs.linkSync(temp, file);
    return createLease(file, record);
  } catch (err) {
    if (errnoCode(err) === "EEXIST" && fs.existsSync(file)) return undefined;
    throw lockError(file, `could not create (${errorMessage(err)})`, record);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the primary acquisition error.
      }
    }
    try {
      fs.unlinkSync(temp);
    } catch {
      // The linked canonical record, when present, remains valid.
    }
  }
}

function staleLockFile(file: string): string {
  return path.join(
    path.dirname(file),
    `.${path.basename(file)}.stale.${process.pid}.${crypto.randomBytes(8).toString("hex")}`,
  );
}

function reclaimDeadStateLock(file: string, owner: StateLockRecord): void {
  const current = readExistingStateLock(file);
  if (current.kind === "missing") return;
  if (
    current.kind !== "valid" ||
    current.record.token !== owner.token ||
    current.record.pid !== owner.pid
  ) {
    return;
  }
  if (isProcessAlive(current.record.pid)) return;

  const stale = staleLockFile(file);
  try {
    fs.renameSync(file, stale);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return;
    throw lockError(file, `could not move dead owner aside (${errorMessage(err)})`, owner);
  }

  const moved = readExistingStateLock(stale);
  if (
    moved.kind !== "valid" ||
    moved.record.token !== owner.token ||
    moved.record.pid !== owner.pid
  ) {
    // A replacement must never be stranded under the stale name. Restore it
    // when the canonical path is still free, then fail closed.
    try {
      fs.renameSync(stale, file);
    } catch {
      // Preserve both paths for operator inspection rather than deleting an
      // ownership record that no longer matches the observed dead owner.
    }
    throw lockError(file, "changed while reclaiming a dead owner; refusing to delete it", owner);
  }

  try {
    fs.unlinkSync(stale);
  } catch (err) {
    if (errnoCode(err) !== "ENOENT") {
      throw lockError(file, `could not remove stale record (${errorMessage(err)})`, owner);
    }
  }
}

function inspectExistingLock(file: string): ExistingStateLock {
  const existing = readExistingStateLock(file);
  if (existing.kind !== "valid" || isProcessAlive(existing.record.pid)) return existing;

  reclaimDeadStateLock(file, existing.record);
  return { kind: "missing" };
}

function ensureParentDirectory(file: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (err) {
    throw lockError(file, `could not create parent directory (${errorMessage(err)})`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms: number): void {
  Atomics.wait(syncWaitCell, 0, 0, ms);
}

function busyError(file: string, owner: StateLockRecord): Error {
  return lockError(file, "is busy", owner);
}

/** Read a valid lock owner without reclaiming or modifying the lock file. */
export function readStateLockRecord(file: string): StateLockRecord | undefined {
  const existing = readExistingStateLock(file);
  if (existing.kind === "missing") return undefined;
  if (existing.kind === "corrupt") {
    throw lockError(file, `is corrupt and cannot be trusted (${existing.reason})`, existing.owner);
  }
  return existing.record;
}

type StateLockAcquisitionStep =
  | { kind: "acquired"; lease: StateLockLease }
  | { kind: "retry" }
  | { kind: "wait"; delayMs: number };

function createStateLockAcquisition(
  file: string,
  options: StateLockOptions,
): () => StateLockAcquisitionStep {
  const normalized = normalizeOptions(file, options);
  ensureParentDirectory(file);
  const deadline = Date.now() + normalized.timeoutMs;
  let sawCorruptRecord = false;

  return () => {
    const lease = tryCreateStateLock(file, normalized);
    if (lease) return { kind: "acquired", lease };

    const existing = inspectExistingLock(file);
    if (existing.kind === "missing") {
      sawCorruptRecord = false;
      return { kind: "retry" };
    }

    const remaining = deadline - Date.now();
    if (existing.kind === "corrupt") {
      if (sawCorruptRecord || remaining <= 0) {
        throw lockError(
          file,
          `is corrupt and cannot be reclaimed (${existing.reason})`,
          existing.owner,
        );
      }
      sawCorruptRecord = true;
      return { kind: "wait", delayMs: Math.min(normalized.pollMs, remaining) };
    }

    sawCorruptRecord = false;
    if (remaining <= 0) throw busyError(file, existing.record);
    return { kind: "wait", delayMs: Math.min(normalized.pollMs, remaining) };
  };
}

/** Acquire a state-file lock without blocking the Node.js event loop. */
export async function acquireStateLock(
  file: string,
  options: StateLockOptions,
): Promise<StateLockLease> {
  const next = createStateLockAcquisition(file, options);
  for (;;) {
    const step = next();
    if (step.kind === "acquired") return step.lease;
    if (step.kind === "wait") await sleep(step.delayMs);
  }
}

/** Acquire a state-file lock synchronously for synchronous state operations. */
export function acquireStateLockSync(file: string, options: StateLockOptions): StateLockLease {
  const next = createStateLockAcquisition(file, options);
  for (;;) {
    const step = next();
    if (step.kind === "acquired") return step.lease;
    if (step.kind === "wait") sleepSync(step.delayMs);
  }
}

/** Acquire a lock, run an action, and release the lock even when the action fails. */
export async function withStateLock<T>(
  file: string,
  options: StateLockOptions,
  action: (lease: StateLockLease) => T | Promise<T>,
): Promise<T> {
  const lease = await acquireStateLock(file, options);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await action(lease) };
  } catch (err) {
    outcome = { ok: false, error: err };
  }

  let releaseError: unknown;
  try {
    lease.release();
  } catch (err) {
    releaseError = err;
  }

  if (!outcome.ok) {
    if (releaseError) {
      throw new Error(
        `${errorMessage(outcome.error)}; state lock release failed: ${errorMessage(releaseError)}`,
      );
    }
    throw outcome.error;
  }
  if (releaseError) throw releaseError;
  return outcome.value;
}

/**
 * Serializes in-process mutations and extends that exclusion across Sash
 * processes with the same state lock file.
 */
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
