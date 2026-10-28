import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { errnoCode, errorMessage } from "./error-utils.js";
import { atomicWriteFile } from "./fs-atomic.js";
import { isProcessAlive } from "./process.js";

export interface StateLockRecord {
  pid: number;
  token: string;
  purpose: string;
}

export interface StateLockOptions {
  purpose: string;
  timeoutMs?: number;
  pollMs?: number;
}

export interface StateLockLease {
  readonly file: string;
  readonly record: Readonly<StateLockRecord>;
  release(): void;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 50;
const WRITE_GRACE_MS = 250;

function ownerText(record?: StateLockRecord): string {
  return `owner PID ${record?.pid ?? "unknown"}, purpose ${JSON.stringify(record?.purpose ?? "unknown")}`;
}

function lockError(file: string, message: string, record?: StateLockRecord): Error {
  return new Error(`State lock ${message}: ${file} (${ownerText(record)})`);
}

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

export function readStateLockRecord(file: string): StateLockRecord | undefined {
  return readLockRecord(file);
}

interface Contender {
  name: string;
  ticket: bigint | null;
}

function contenders(directory: string): Contender[] {
  const result: Contender[] = [];
  for (const name of fs.readdirSync(directory)) {
    const match = /^([1-9]\d*)\.[a-f0-9]{48}$/.exec(name);
    if (!match) continue;
    const candidate = path.join(directory, name);
    if (!isProcessAlive(Number(match[1]))) {
      try {
        fs.unlinkSync(candidate);
      } catch {}
      continue;
    }
    try {
      const value = fs.readFileSync(candidate, "utf8").trim();
      result.push({ name, ticket: /^[1-9]\d{0,30}$/.test(value) ? BigInt(value) : null });
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") result.push({ name, ticket: null });
    }
  }
  return result;
}

export async function acquireStateLock(
  file: string,
  options: StateLockOptions,
): Promise<StateLockLease> {
  const purpose = options.purpose?.trim();
  if (!purpose) throw lockError(file, "requires a non-empty purpose");
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const directory = `${file}.contenders`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const record = { pid: process.pid, token: crypto.randomBytes(24).toString("hex"), purpose };
  const name = `${record.pid}.${record.token}`;
  const candidate = path.join(directory, name);
  // Lamport's bakery protocol: publish "choosing" before reading other tickets,
  // then publish a ticket before checking priority. A later arrival sees ours.
  fs.writeFileSync(candidate, "", { flag: "wx", mode: 0o600 });
  try {
    const ticket =
      contenders(directory).reduce(
        (max, entry) => (entry.ticket !== null && entry.ticket > max ? entry.ticket : max),
        0n,
      ) + 1n;
    await atomicWriteFile(candidate, String(ticket));
    for (;;) {
      const ahead = contenders(directory).some(
        (entry) =>
          entry.name !== name &&
          (entry.ticket === null ||
            entry.ticket < ticket ||
            (entry.ticket === ticket && entry.name < name)),
      );
      const owner = readLockRecord(file);
      let legacyBusy = Boolean(owner && isProcessAlive(owner.pid));
      if (!owner) {
        try {
          legacyBusy = Date.now() - fs.statSync(file).mtimeMs < WRITE_GRACE_MS;
        } catch (error) {
          if (errnoCode(error) !== "ENOENT") throw error;
        }
      }
      if (!ahead && !legacyBusy) {
        await atomicWriteFile(file, `${JSON.stringify(record)}\n`);
        let released = false;
        return {
          file,
          record,
          release: () => {
            if (released) return;
            // Keep our ticket until the diagnostic record has been cleared, so
            // no successor can publish between the ownership check and unlink.
            if (readLockRecord(file)?.token === record.token) fs.unlinkSync(file);
            fs.rmSync(candidate, { force: true });
            released = true;
          },
        };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw lockError(file, "is busy", owner);
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
    }
  } catch (error) {
    try {
      fs.unlinkSync(candidate);
    } catch {}
    throw new Error(errorMessage(error), { cause: error });
  }
}

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
