import fs from "node:fs";
import { errnoCode, errorMessage } from "../error-utils.js";
import { atomicWriteFileSync } from "../fs-atomic.js";
import { hasExactOwnKeys, isCanonicalIsoTimestamp, isPlainObject } from "../json-shape.js";
import { sashLayout } from "../paths.js";
import { withStateLock } from "../state-lock.js";
import { createSystemProxyBackend } from "./index.js";
import { parseSystemProxySnapshot, snapshotsCompatible, snapshotsEquivalent } from "./snapshot.js";
import type {
  EnableOptions,
  SystemProxyBackend,
  SystemProxySnapshot,
  SystemProxySnapshotCodec,
  SystemProxyState,
} from "./types.js";
import { asWindowsSnapshot, createWindowsTarget, windowsState } from "./windows.js";

export interface SystemProxyInspection {
  applied: boolean;
  state: SystemProxyState;
  appliedKnown: boolean;
  stateKnown: boolean;
  queryError?: string;
}

export interface SystemProxyController {
  apply(opts: EnableOptions): Promise<void>;
  release(): Promise<void>;
  inspect(fresh?: boolean): Promise<SystemProxyInspection>;
}

export interface SystemProxyJournalLayout {
  systemProxyStateFile: string;
  systemProxyLockFile: string;
}

export interface SystemProxyManagerOptions {
  layout?: SystemProxyJournalLayout;
  backend?: SystemProxyBackend;
}

export interface SystemProxyJournal {
  schemaVersion: 2;
  phase: "prepared" | "applied" | "restoring";
  ownerPid: number;
  createdAt: string;
  original: SystemProxySnapshot;
  target: SystemProxySnapshot;
}

const MAX_JOURNAL_BYTES = 256 * 1024;

const SYSTEM_PROXY_INSPECTION_TTL_MS = 30_000;

function journalError(message: string): Error {
  return new Error(`Invalid system proxy journal: ${message}`);
}

function hasExactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) throw journalError("root must be a plain object");
  if (!hasExactOwnKeys(value, keys)) throw journalError("root has unexpected fields");
  return value;
}

function parseCreatedAt(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw journalError("createdAt must be a non-empty ISO timestamp");
  }
  if (!isCanonicalIsoTimestamp(value)) {
    throw journalError("createdAt must be a canonical ISO timestamp");
  }
  return value;
}

function parseSystemProxyJournal(
  value: unknown,
  parseSnapshot: SystemProxySnapshotCodec["parse"],
): SystemProxyJournal {
  const record = hasExactKeys(value, [
    "schemaVersion",
    "phase",
    "ownerPid",
    "createdAt",
    "original",
    "target",
  ]);
  if (record.schemaVersion !== 2) {
    throw journalError("schemaVersion must be 2");
  }
  if (record.phase !== "prepared" && record.phase !== "applied" && record.phase !== "restoring") {
    throw journalError("phase must be prepared, applied, or restoring");
  }
  if (
    typeof record.ownerPid !== "number" ||
    !Number.isSafeInteger(record.ownerPid) ||
    record.ownerPid <= 0
  ) {
    throw journalError("ownerPid must be a positive integer");
  }

  let original: SystemProxySnapshot;
  let target: SystemProxySnapshot;
  try {
    original = parseSnapshot(record.original);
    target = parseSnapshot(record.target);
    if (original.platform !== target.platform) throw new Error("Snapshot platforms do not match");
  } catch (err) {
    throw journalError(errorMessage(err));
  }

  return {
    schemaVersion: 2,
    phase: record.phase,
    ownerPid: record.ownerPid,
    createdAt: parseCreatedAt(record.createdAt),
    original,
    target,
  };
}

function combinedError(primary: unknown, recovery: unknown): Error {
  return new Error(
    `${errorMessage(primary)}; conditional restoration failed: ${errorMessage(recovery)}`,
  );
}

export class SystemProxyManager implements SystemProxyController {
  private readonly layout: SystemProxyJournalLayout;
  private readonly backend: SystemProxyBackend;
  private readonly snapshot: SystemProxySnapshotCodec;
  private readonly operationLockFile: string;
  private operationQueue: Promise<void> = Promise.resolve();
  private inspectionCache: { expiresAt: number; inspection: SystemProxyInspection } | undefined;

  constructor(options: SystemProxyManagerOptions = {}) {
    this.layout = options.layout ?? sashLayout();
    this.backend = options.backend ?? createSystemProxyBackend();
    this.snapshot = this.backend.snapshot ?? {
      parse: parseSystemProxySnapshot,
      equivalent: snapshotsEquivalent,
      compatible: snapshotsCompatible,
      target: createWindowsTarget,
      state: (snapshot) => windowsState(asWindowsSnapshot(snapshot)),
    };
    if (!this.layout.systemProxyStateFile) {
      throw new Error("System proxy journal requires a systemProxyStateFile path");
    }
    this.operationLockFile = this.layout.systemProxyLockFile;
  }

  apply(opts: EnableOptions): Promise<void> {
    return this.enqueue(() =>
      withStateLock(
        this.operationLockFile,
        { purpose: "apply system proxy", timeoutMs: 30_000 },
        () => {
          this.inspectionCache = undefined;
          return this.applyUnlocked(opts);
        },
      ),
    );
  }

  release(): Promise<void> {
    return this.enqueue(() =>
      withStateLock(
        this.operationLockFile,
        { purpose: "restore system proxy", timeoutMs: 30_000 },
        () => {
          this.inspectionCache = undefined;
          return this.recoverUnlocked();
        },
      ),
    );
  }

  inspect(fresh = false): Promise<SystemProxyInspection> {
    return this.enqueue(async () => {
      if (!fresh && this.inspectionCache && this.inspectionCache.expiresAt > Date.now()) {
        return this.inspectionCache.inspection;
      }
      const inspection = await withStateLock(
        this.operationLockFile,
        { purpose: "inspect system proxy", timeoutMs: 30_000 },
        () => this.inspectUnlocked(),
      );
      this.inspectionCache = {
        expiresAt: Date.now() + SYSTEM_PROXY_INSPECTION_TTL_MS,
        inspection,
      };
      return inspection;
    });
  }

  private async inspectUnlocked(): Promise<SystemProxyInspection> {
    if (this.backend.supported === false) {
      return {
        applied: false,
        appliedKnown: true,
        stateKnown: true,
        state: {
          supported: false,
          enabled: false,
          details: "System proxy integration is not available on this platform",
        },
      };
    }

    const messages: string[] = [];
    const add = (error: unknown): void => {
      const message = errorMessage(error) || "unknown error";
      if (!messages.includes(message)) messages.push(message);
    };
    let journal: SystemProxyJournal | undefined;
    try {
      journal = this.readJournal();
    } catch (error) {
      add(error);
    }

    let current: SystemProxySnapshot;
    let state: SystemProxyState;
    try {
      current = await this.backend.capture();
      state = this.snapshot.state(current);
    } catch (error) {
      add(error);
      const queryError = messages.join("; ");
      return {
        applied: false,
        state: {
          supported: this.backend.supported,
          enabled: false,
          details: queryError,
        },
        appliedKnown: false,
        stateKnown: false,
        queryError,
      };
    }

    if (messages.length > 0) {
      state.details = [state.details, ...messages].filter(Boolean).join("; ");
      return {
        applied: false,
        state,
        appliedKnown: false,
        stateKnown: true,
        queryError: messages.join("; "),
      };
    }
    return {
      applied: journal?.phase === "applied" && this.snapshot.equivalent(current, journal.target),
      state,
      appliedKnown: true,
      stateKnown: true,
    };
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private readJournal(): SystemProxyJournal | undefined {
    const file = this.layout.systemProxyStateFile;
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(file);
    } catch (err) {
      if (errnoCode(err) === "ENOENT") return undefined;
      throw new Error(`Could not inspect system proxy journal ${file}: ${errorMessage(err)}`);
    }
    if (!stats.isFile()) {
      throw new Error(`System proxy journal is not a regular file: ${file}`);
    }
    if (stats.size > MAX_JOURNAL_BYTES) {
      throw new Error(`System proxy journal is too large: ${file}`);
    }

    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      if (errnoCode(err) === "ENOENT") return undefined;
      throw new Error(`Could not read system proxy journal ${file}: ${errorMessage(err)}`);
    }
    let document: unknown;
    try {
      document = JSON.parse(text) as unknown;
    } catch (err) {
      throw new Error(`System proxy journal is invalid: ${file}: ${errorMessage(err)}`);
    }
    try {
      return parseSystemProxyJournal(document, (value) => this.snapshot.parse(value));
    } catch (err) {
      throw new Error(`System proxy journal is invalid: ${file}: ${errorMessage(err)}`);
    }
  }

  private writeJournal(journal: SystemProxyJournal): void {
    const text = `${JSON.stringify(journal, null, 2)}\n`;
    if (Buffer.byteLength(text) > MAX_JOURNAL_BYTES) {
      throw new Error(
        `System proxy journal exceeds its size limit: ${this.layout.systemProxyStateFile}`,
      );
    }
    atomicWriteFileSync(this.layout.systemProxyStateFile, text, 0o600);
  }

  private clearJournal(): void {
    try {
      fs.unlinkSync(this.layout.systemProxyStateFile);
    } catch (err) {
      if (errnoCode(err) !== "ENOENT") {
        throw new Error(`Could not remove system proxy journal: ${errorMessage(err)}`);
      }
    }
  }

  private async applyUnlocked(opts: EnableOptions): Promise<void> {
    const previous = this.readJournal();
    if (previous) {
      const desiredTarget = this.snapshot.target(opts, previous.original);
      const current = await this.backend.capture();
      if (
        previous.phase === "applied" &&
        this.snapshot.equivalent(previous.target, desiredTarget) &&
        this.snapshot.equivalent(current, previous.target)
      ) {
        return;
      }
      await this.restoreJournal(previous);
    }

    const original = await this.backend.capture();
    const target = this.snapshot.target(opts, original);

    const prepared: SystemProxyJournal = {
      schemaVersion: 2,
      phase: "prepared",
      ownerPid: process.pid,
      createdAt: new Date().toISOString(),
      original,
      target,
    };
    this.writeJournal(prepared);

    const beforeApply = await this.backend.capture();
    if (!this.snapshot.equivalent(beforeApply, original)) {
      this.clearJournal();
      throw new Error(
        "System proxy settings changed while Sash was preparing ownership; refusing to overwrite them",
      );
    }

    let activeJournal = prepared;
    try {
      await this.backend.apply(target);
      const current = await this.backend.capture();
      if (!this.snapshot.equivalent(current, target)) {
        throw new Error("System proxy target verification failed after apply");
      }
      // The target persists as the semantic value Sash constructed, never
      // the readback: `current` only verifies the write produced the
      // intended state (a foreign change caught mid-apply fails above).
      const applied: SystemProxyJournal = { ...prepared, phase: "applied" };
      this.writeJournal(applied);
      activeJournal = applied;
    } catch (err) {
      try {
        await this.restoreJournal(activeJournal);
      } catch (restoreErr) {
        throw combinedError(err, restoreErr);
      }
      throw err;
    }
  }

  private async recoverUnlocked(): Promise<void> {
    const journal = this.readJournal();
    if (!journal) return;
    await this.restoreJournal(journal);
  }

  private async restoreJournal(journal: SystemProxyJournal): Promise<void> {
    if (this.backend.restore) {
      // Journal-scoped restore: the backend decides per recorded service
      // (offline included) whether writing is safe. Services left untouched
      // keep their journal entry as evidence and are reported.
      const result = await this.backend.restore(journal.original, journal.target);
      if (result.skipped.length === 0) {
        this.clearJournal();
        return;
      }
      const detail = result.skipped
        .map(
          (skip) =>
            `${skip.service}${skip.service !== skip.key ? ` (${skip.key})` : ""}: ${
              skip.reason === "modified" ? "modified outside Sash" : "service removed"
            }`,
        )
        .join("; ");
      throw new Error(`System proxy restore left services untouched: ${detail}`);
    }
    const current = await this.backend.capture();
    if (this.snapshot.equivalent(current, journal.original)) {
      this.clearJournal();
      return;
    }

    const canRestore =
      this.snapshot.equivalent(current, journal.target) ||
      ((journal.phase === "prepared" || journal.phase === "restoring") &&
        this.snapshot.compatible(current, journal.original, journal.target));
    if (!canRestore) {
      throw new Error(
        "System proxy journal refuses to restore because current settings were modified outside Sash",
      );
    }

    const restoring: SystemProxyJournal =
      journal.phase === "restoring" ? journal : { ...journal, phase: "restoring" };
    if (restoring !== journal) this.writeJournal(restoring);

    let applyResult: { readonly ok: true } | { readonly ok: false; readonly error: unknown } = {
      ok: true,
    };
    try {
      await this.backend.apply(restoring.original);
    } catch (error) {
      applyResult = { ok: false, error };
    }

    let restored: SystemProxySnapshot;
    try {
      restored = await this.backend.capture();
    } catch (err) {
      const verificationError = new Error(
        `Could not verify system proxy restoration: ${errorMessage(err)}`,
      );
      throw applyResult.ok
        ? verificationError
        : combinedError(applyResult.error, verificationError);
    }
    if (!this.snapshot.equivalent(restored, restoring.original)) {
      const verificationError = new Error("System proxy restoration verification failed");
      throw applyResult.ok
        ? verificationError
        : combinedError(applyResult.error, verificationError);
    }

    this.clearJournal();
  }
}
