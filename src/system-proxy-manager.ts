import fs from "node:fs";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { sashLayout } from "./paths.js";
import { withStateLock } from "./state-lock.js";
import {
  createSystemProxyBackend,
  type EnableOptions,
  isSystemProxySupported,
  parseSystemProxySnapshot,
  type SystemProxyBackend,
  type SystemProxySnapshot,
  type SystemProxyState,
} from "./sysproxy.js";

export interface SystemProxyInspection {
  applied: boolean;
  state: SystemProxyState;
}

export interface SystemProxyController {
  apply(opts: EnableOptions): Promise<void>;
  release(): Promise<void>;
  recover(): Promise<void>;
  inspect(fresh?: boolean): SystemProxyInspection;
  isApplied(): boolean;
  getState(): SystemProxyState;
}

export interface SystemProxyJournalLayout {
  systemProxyStateFile: string;
}

export interface SystemProxyManagerOptions {
  layout?: SystemProxyJournalLayout;
  backend?: SystemProxyBackend;
}

export interface SystemProxyJournal {
  schemaVersion: 1;
  phase: "prepared" | "applied";
  ownerPid: number;
  createdAt: string;
  original: SystemProxySnapshot;
  target: SystemProxySnapshot;
}

const MAX_JOURNAL_BYTES = 256 * 1024;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

function journalError(message: string): Error {
  return new Error(`Invalid system proxy journal: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) throw journalError("root must be a plain object");
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
    throw journalError("root has unexpected fields");
  }
  return value;
}

function sameDarwinServiceCollection(a: SystemProxySnapshot, b: SystemProxySnapshot): boolean {
  if (a.platform !== "darwin" || b.platform !== "darwin") return false;
  if (a.services.length !== b.services.length) return false;
  return a.services.every((service, index) => service.service === b.services[index]?.service);
}

function journalSnapshotsHaveSameStructure(
  original: SystemProxySnapshot,
  target: SystemProxySnapshot,
): boolean {
  if (original.platform !== target.platform) return false;
  if (original.platform === "darwin" && target.platform === "darwin") {
    return sameDarwinServiceCollection(original, target);
  }
  return true;
}

function parseCreatedAt(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw journalError("createdAt must be a non-empty ISO timestamp");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw journalError("createdAt must be a canonical ISO timestamp");
  }
  return value;
}

/** Strictly parse an on-disk ownership journal before any OS operation. */
export function parseSystemProxyJournal(value: unknown): SystemProxyJournal {
  const record = hasExactKeys(value, [
    "schemaVersion",
    "phase",
    "ownerPid",
    "createdAt",
    "original",
    "target",
  ]);
  if (record.schemaVersion !== 1) {
    throw journalError("schemaVersion must be 1");
  }
  if (record.phase !== "prepared" && record.phase !== "applied") {
    throw journalError("phase must be prepared or applied");
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
    original = parseSystemProxySnapshot(record.original);
    target = parseSystemProxySnapshot(record.target);
  } catch (err) {
    throw journalError(errorMessage(err));
  }
  if (!journalSnapshotsHaveSameStructure(original, target)) {
    throw journalError("original and target have different platform structures");
  }

  return {
    schemaVersion: 1,
    phase: record.phase,
    ownerPid: record.ownerPid,
    createdAt: parseCreatedAt(record.createdAt),
    original,
    target,
  };
}

function sameJournal(a: SystemProxyJournal, b: SystemProxyJournal): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The phase may change from prepared to applied without changing ownership. */
function sameJournalOwnership(a: SystemProxyJournal, b: SystemProxyJournal): boolean {
  return (
    a.schemaVersion === b.schemaVersion &&
    a.ownerPid === b.ownerPid &&
    a.createdAt === b.createdAt &&
    JSON.stringify(a.original) === JSON.stringify(b.original) &&
    JSON.stringify(a.target) === JSON.stringify(b.target)
  );
}

function combinedError(primary: unknown, recovery: unknown): Error {
  return new Error(
    `${errorMessage(primary)}; conditional restoration failed: ${errorMessage(recovery)}`,
  );
}

function isJournalLayout(
  value: SystemProxyManagerOptions | SystemProxyJournalLayout,
): value is SystemProxyJournalLayout {
  return "systemProxyStateFile" in value && typeof value.systemProxyStateFile === "string";
}

/**
 * Snapshot/journal based controller. Mutating operations are serialized within
 * this process; every persisted snapshot is parsed again before it is applied.
 */
export class SystemProxyManager implements SystemProxyController {
  private readonly layout: SystemProxyJournalLayout;
  private readonly backend: SystemProxyBackend;
  private readonly operationLockFile: string;
  private operationQueue: Promise<void> = Promise.resolve();
  private inspectionCache: { expiresAt: number; inspection: SystemProxyInspection } | undefined;

  constructor(options?: SystemProxyManagerOptions);
  constructor(layout?: SystemProxyJournalLayout, backend?: SystemProxyBackend);
  constructor(
    optionsOrLayout: SystemProxyManagerOptions | SystemProxyJournalLayout = {},
    backend?: SystemProxyBackend,
  ) {
    if (isJournalLayout(optionsOrLayout)) {
      this.layout = optionsOrLayout;
      this.backend = backend ?? createSystemProxyBackend();
    } else {
      this.layout = optionsOrLayout.layout ?? sashLayout();
      this.backend = optionsOrLayout.backend ?? backend ?? createSystemProxyBackend();
    }
    if (!this.layout.systemProxyStateFile) {
      throw new Error("System proxy journal requires a systemProxyStateFile path");
    }
    this.operationLockFile = `${this.layout.systemProxyStateFile}.lock`;
  }

  apply(opts: EnableOptions): Promise<void> {
    return this.enqueue(() =>
      withStateLock(
        this.operationLockFile,
        { purpose: "apply system proxy", timeoutMs: 30_000 },
        async () => {
          this.inspectionCache = undefined;
          try {
            await this.applyUnlocked(opts);
          } finally {
            this.inspectionCache = undefined;
          }
        },
      ),
    );
  }

  release(): Promise<void> {
    return this.enqueue(() =>
      withStateLock(
        this.operationLockFile,
        { purpose: "restore system proxy", timeoutMs: 30_000 },
        async () => {
          this.inspectionCache = undefined;
          try {
            await this.recoverUnlocked();
          } finally {
            this.inspectionCache = undefined;
          }
        },
      ),
    );
  }

  recover(): Promise<void> {
    return this.release();
  }

  inspect(fresh = false): SystemProxyInspection {
    if (!fresh && this.inspectionCache && this.inspectionCache.expiresAt > Date.now()) {
      return this.inspectionCache.inspection;
    }

    let journal: SystemProxyJournal | undefined;
    let journalFailure: unknown;
    try {
      journal = this.readJournal();
    } catch (err) {
      // A corrupt journal remains on disk, but it must not hide the observable
      // OS proxy state from status callers.
      journalFailure = err;
    }

    try {
      const current = this.captureCurrent();
      const state = this.backend.state(current);
      if (journalFailure) {
        state.details = [state.details, errorMessage(journalFailure)].filter(Boolean).join("; ");
      }
      const inspection = {
        applied:
          !journalFailure &&
          journal?.phase === "applied" &&
          this.backend.equivalent(current, journal.target),
        state,
      };
      this.inspectionCache = { expiresAt: Date.now() + 3000, inspection };
      return inspection;
    } catch (err) {
      const inspection = {
        applied: false,
        state: {
          supported: this.backend.supported ?? isSystemProxySupported(),
          enabled: false,
          details: [journalFailure, err].filter(Boolean).map(errorMessage).join("; "),
        },
      };
      this.inspectionCache = { expiresAt: Date.now() + 3000, inspection };
      return inspection;
    }
  }

  isApplied(): boolean {
    return this.inspect().applied;
  }

  getState(): SystemProxyState {
    return this.inspect().state;
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

    let document: unknown;
    try {
      document = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    } catch (err) {
      throw new Error(`System proxy journal is invalid: ${file}: ${errorMessage(err)}`);
    }
    try {
      return parseSystemProxyJournal(document);
    } catch (err) {
      throw new Error(`System proxy journal is invalid: ${file}: ${errorMessage(err)}`);
    }
  }

  private writeNewJournal(journal: SystemProxyJournal): void {
    const existing = this.readJournal();
    if (existing) {
      throw new Error(`System proxy journal already exists: ${this.layout.systemProxyStateFile}`);
    }
    const canonical = parseSystemProxyJournal(journal);
    atomicWriteFileSync(
      this.layout.systemProxyStateFile,
      `${JSON.stringify(canonical, null, 2)}\n`,
      0o600,
    );
  }

  private replaceJournal(expected: SystemProxyJournal, next: SystemProxyJournal): void {
    const existing = this.readJournal();
    if (!existing || !sameJournal(existing, expected)) {
      throw new Error(
        `System proxy journal changed while applying: ${this.layout.systemProxyStateFile}`,
      );
    }
    const canonical = parseSystemProxyJournal(next);
    atomicWriteFileSync(
      this.layout.systemProxyStateFile,
      `${JSON.stringify(canonical, null, 2)}\n`,
      0o600,
    );
  }

  private clearJournal(expected: SystemProxyJournal): void {
    const existing = this.readJournal();
    if (!existing) return;
    if (!sameJournalOwnership(existing, expected)) {
      throw new Error(
        `System proxy journal changed while restoring: ${this.layout.systemProxyStateFile}`,
      );
    }
    try {
      fs.unlinkSync(this.layout.systemProxyStateFile);
    } catch (err) {
      if (errnoCode(err) !== "ENOENT") {
        throw new Error(`Could not remove system proxy journal: ${errorMessage(err)}`);
      }
    }
  }

  private captureCurrent(): SystemProxySnapshot {
    return parseSystemProxySnapshot(this.backend.capture());
  }

  private async applyUnlocked(opts: EnableOptions): Promise<void> {
    const previous = this.readJournal();
    if (previous) {
      const desiredTarget = parseSystemProxySnapshot(
        this.backend.createTarget(previous.original, opts),
      );
      const current = this.captureCurrent();
      if (
        previous.phase === "applied" &&
        this.backend.equivalent(previous.target, desiredTarget) &&
        this.backend.equivalent(current, previous.target)
      ) {
        return;
      }
      this.restoreJournal(previous);
    }

    const original = this.captureCurrent();
    const target = parseSystemProxySnapshot(this.backend.createTarget(original, opts));
    if (!journalSnapshotsHaveSameStructure(original, target)) {
      throw new Error("System proxy backend produced a target with a different platform structure");
    }
    const prepared: SystemProxyJournal = {
      schemaVersion: 1,
      phase: "prepared",
      ownerPid: process.pid,
      createdAt: new Date().toISOString(),
      original,
      target,
    };
    this.writeNewJournal(prepared);

    const beforeApply = this.captureCurrent();
    if (!this.backend.equivalent(beforeApply, original)) {
      this.clearJournal(prepared);
      throw new Error(
        "System proxy settings changed while Sash was preparing ownership; refusing to overwrite them",
      );
    }

    let activeJournal = prepared;
    try {
      this.backend.apply(target);
      const current = this.captureCurrent();
      if (!this.backend.equivalent(current, target)) {
        throw new Error("System proxy target verification failed after apply");
      }
      const applied: SystemProxyJournal = { ...prepared, phase: "applied" };
      this.replaceJournal(prepared, applied);
      activeJournal = applied;
    } catch (err) {
      try {
        this.restoreJournal(activeJournal);
      } catch (restoreErr) {
        throw combinedError(err, restoreErr);
      }
      throw err;
    }
  }

  private async recoverUnlocked(): Promise<void> {
    const journal = this.readJournal();
    if (!journal) return;
    this.restoreJournal(journal);
  }

  /**
   * Restore only when current managed values still belong to this journal.
   * A third value, or a changed macOS service collection, is never overwritten.
   */
  private restoreJournal(journal: SystemProxyJournal): void {
    const current = this.captureCurrent();
    if (this.backend.equivalent(current, journal.original)) {
      this.clearJournal(journal);
      return;
    }

    const canRestore =
      this.backend.equivalent(current, journal.target) ||
      (journal.phase === "prepared" &&
        this.backend.compatible(current, journal.original, journal.target));
    if (!canRestore) {
      throw new Error(
        "System proxy journal refuses to restore because current settings were modified outside Sash",
      );
    }

    let applyError: unknown;
    try {
      this.backend.apply(journal.original);
    } catch (err) {
      applyError = err;
    }

    let restored: SystemProxySnapshot;
    try {
      restored = this.captureCurrent();
    } catch (err) {
      const verificationError = new Error(
        `Could not verify system proxy restoration: ${errorMessage(err)}`,
      );
      throw applyError ? combinedError(applyError, verificationError) : verificationError;
    }
    if (!this.backend.equivalent(restored, journal.original)) {
      const verificationError = new Error("System proxy restoration verification failed");
      throw applyError ? combinedError(applyError, verificationError) : verificationError;
    }

    this.clearJournal(journal);
  }
}
