import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { errnoCode, errorMessage } from "./error-utils.js";
import { atomicWriteFile } from "./fs-atomic.js";
import {
  classifyProcessIdentityAsync,
  classifyProcessNameAsync,
  isProcessAlive,
  type ProcessIdentity,
} from "./process.js";

export interface StateLockRecord {
  pid: number;
  token: string;
  purpose: string;
  exe?: string;
}

export interface StateLockOptions {
  purpose: string;
  timeoutMs?: number;
  pollMs?: number;
  classifyIdentity?: (pid: number, exe: string) => ProcessIdentity | Promise<ProcessIdentity>;
  classifyName?: (pid: number, exe: string) => ProcessIdentity | Promise<ProcessIdentity>;
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
    ...(typeof value.exe === "string" && value.exe ? { exe: value.exe } : {}),
  };
}

export function readStateLockRecord(file: string): StateLockRecord | undefined {
  return readLockRecord(file);
}

interface Contender {
  name: string;
  ticket: bigint | null;
}

type IdentityClassifier = NonNullable<StateLockOptions["classifyIdentity"]>;

type IdentityCache = Map<string, ProcessIdentity>;

async function classifyOnce(
  cache: IdentityCache,
  classify: IdentityClassifier,
  pid: number,
  exe: string,
): Promise<ProcessIdentity> {
  const key = `${pid}${exe}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let identity: ProcessIdentity;
  try {
    identity = await classify(pid, exe);
  } catch {
    identity = "unknown";
  }
  cache.set(key, identity);
  return identity;
}

/** A live pid is a real owner only while its image matches the recorded exe;
 * a pid recycled by an unrelated process means the owner is gone. Records
 * written before `exe` was stored fall back to an image-name check against
 * this process, so a recycled pid still loses to a foreign image. */
async function pidGone(
  cache: IdentityCache,
  classify: IdentityClassifier,
  classifyName: IdentityClassifier,
  pid: number,
  exe?: string,
): Promise<boolean> {
  if (!isProcessAlive(pid)) return true;
  if (exe) return (await classifyOnce(cache, classify, pid, exe)) === "mismatch";
  return (await classifyOnce(cache, classifyName, pid, process.execPath)) === "mismatch";
}

interface ContenderPayload {
  ticket: bigint | null;
  exe?: string;
}

function parseContenderPayload(value: string): ContenderPayload {
  const trimmed = value.trim();
  if (/^[1-9]\d{0,30}$/.test(trimmed)) return { ticket: BigInt(trimmed) };
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const ticket =
      typeof parsed.ticket === "string" && /^[1-9]\d{0,30}$/.test(parsed.ticket)
        ? BigInt(parsed.ticket)
        : null;
    const exe = typeof parsed.exe === "string" && parsed.exe ? parsed.exe : undefined;
    return { ticket, ...(exe ? { exe } : {}) };
  } catch {
    return { ticket: null };
  }
}

async function contenders(
  directory: string,
  cache: IdentityCache,
  classify: IdentityClassifier,
  classifyName: IdentityClassifier,
): Promise<Contender[]> {
  const result: Contender[] = [];
  for (const name of fs.readdirSync(directory)) {
    const match = /^([1-9]\d*)\.[a-f0-9]{48}$/.exec(name);
    if (!match) continue;
    const candidate = path.join(directory, name);
    const pid = Number(match[1]);
    let payload: ContenderPayload | undefined;
    try {
      payload = parseContenderPayload(fs.readFileSync(candidate, "utf8"));
    } catch (error) {
      if (errnoCode(error) === "ENOENT") continue;
    }
    if (await pidGone(cache, classify, classifyName, pid, payload?.exe)) {
      try {
        fs.unlinkSync(candidate);
      } catch {}
      continue;
    }
    result.push({ name, ticket: payload?.ticket ?? null });
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
  const record = {
    pid: process.pid,
    token: crypto.randomBytes(24).toString("hex"),
    purpose,
    exe: process.execPath,
  };
  const classify = options.classifyIdentity ?? classifyProcessIdentityAsync;
  const classifyName = options.classifyName ?? classifyProcessNameAsync;
  const identityCache: IdentityCache = new Map();
  const name = `${record.pid}.${record.token}`;
  const candidate = path.join(directory, name);
  // Lamport's bakery protocol: publish "choosing" before reading other tickets,
  // then publish a ticket before checking priority. A later arrival sees ours.
  fs.writeFileSync(candidate, "", { flag: "wx", mode: 0o600 });
  try {
    const ticket =
      (await contenders(directory, identityCache, classify, classifyName)).reduce(
        (max, entry) => (entry.ticket !== null && entry.ticket > max ? entry.ticket : max),
        0n,
      ) + 1n;
    await atomicWriteFile(candidate, JSON.stringify({ ticket: String(ticket), exe: record.exe }));
    for (;;) {
      const ahead = (await contenders(directory, identityCache, classify, classifyName)).some(
        (entry) =>
          entry.name !== name &&
          (entry.ticket === null ||
            entry.ticket < ticket ||
            (entry.ticket === ticket && entry.name < name)),
      );
      const owner = readLockRecord(file);
      let legacyBusy = Boolean(
        owner && !(await pidGone(identityCache, classify, classifyName, owner.pid, owner.exe)),
      );
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
