import fs from "node:fs";
import { errnoCode, errorMessage } from "./error-utils.js";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { hasExactOwnKeys, isCanonicalIsoTimestamp, isPlainObject } from "./json-shape.js";
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
  /** False when journal corruption prevents proving Sash ownership. */
  appliedKnown: boolean;
  /** False when the backend could not observe the OS proxy state. */
  stateKnown: boolean;
  queryError?: string;
}

export interface SystemProxyController {
  apply(opts: EnableOptions): Promise<void>;
  release(): Promise<void>;
  inspect(fresh?: boolean): Promise<SystemProxyInspection>;
  isApplied(): Promise<boolean>;
  getState(): Promise<SystemProxyState>;
}

export interface SystemProxyJournalLayout {
  systemProxyStateFile: string;
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

function journalError(message: string): Error {
  return new Error(`Invalid system proxy journal: ${message}`);
}

function hasExactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) throw journalError("root must be a plain object");
  if (!hasExactOwnKeys(value, keys)) throw journalError("root has unexpected fields");
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
  if (!isCanonicalIsoTimestamp(value)) {
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
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2) {
    throw journalError("schemaVersion must be 1 or 2");
  }
  if (
    record.phase !== "prepared" &&
    record.phase !== "applied" &&
    !(record.schemaVersion === 2 && record.phase === "restoring")
  ) {
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
    original = parseSystemProxySnapshot(record.original);
    target = parseSystemProxySnapshot(record.target);
  } catch (err) {
    throw journalError(errorMessage(err));
  }
  if (!journalSnapshotsHaveSameStructure(original, target)) {
    throw journalError("original and target have different platform structures");
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

function sameJournal(a: SystemProxyJournal, b: SystemProxyJournal): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Transaction phase may change without changing the captured ownership boundary. */
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

type JournalObservation =
  | { readonly kind: "read"; readonly journal: SystemProxyJournal | undefined }
  | { readonly kind: "error"; readonly error: unknown };

interface InspectionAttempt {
  readonly inspection: SystemProxyInspection;
  readonly journalStable: boolean;
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
  private inspectionGeneration = 0;
  private inspectionCache:
    | { generation: number; expiresAt: number; inspection: SystemProxyInspection }
    | undefined;
  private inspectionInFlight:
    | { generation: number; promise: Promise<SystemProxyInspection> }
    | undefined;

  constructor(options: SystemProxyManagerOptions = {}, ...unexpected: never[]) {
    if (
      typeof options !== "object" ||
      options === null ||
      Array.isArray(options) ||
      unexpected.length > 0 ||
      "systemProxyStateFile" in options
    ) {
      throw new Error(
        "SystemProxyManager requires an options object with layout and backend fields",
      );
    }
    this.layout = options.layout ?? sashLayout();
    this.backend = options.backend ?? createSystemProxyBackend();
    if (!this.layout.systemProxyStateFile) {
      throw new Error("System proxy journal requires a systemProxyStateFile path");
    }
    this.operationLockFile = `${this.layout.systemProxyStateFile}.lock`;
  }

  apply(opts: EnableOptions): Promise<void> {
    this.invalidateInspection();
    return this.enqueue(async () => {
      try {
        await withStateLock(
          this.operationLockFile,
          { purpose: "apply system proxy", timeoutMs: 30_000 },
          () => this.applyUnlocked(opts),
        );
      } finally {
        this.invalidateInspection();
      }
    });
  }

  release(): Promise<void> {
    this.invalidateInspection();
    return this.enqueue(async () => {
      try {
        await withStateLock(
          this.operationLockFile,
          { purpose: "restore system proxy", timeoutMs: 30_000 },
          () => this.recoverUnlocked(),
        );
      } finally {
        this.invalidateInspection();
      }
    });
  }

  inspect(fresh = false): Promise<SystemProxyInspection> {
    const generation = this.inspectionGeneration;
    if (
      !fresh &&
      this.inspectionCache?.generation === generation &&
      this.inspectionCache.expiresAt > Date.now()
    ) {
      return Promise.resolve(this.inspectionCache.inspection);
    }
    if (this.inspectionInFlight?.generation === generation) {
      return this.inspectionInFlight.promise;
    }

    const promise = this.enqueue(async () => {
      const result = await this.inspectUncached();
      if (result.journalStable && this.inspectionGeneration === generation) {
        this.inspectionCache = {
          generation,
          expiresAt: Date.now() + 3000,
          inspection: result.inspection,
        };
      }
      return result.inspection;
    });
    this.inspectionInFlight = { generation, promise };
    const clearInFlight = (): void => {
      if (
        this.inspectionInFlight?.generation === generation &&
        this.inspectionInFlight.promise === promise
      ) {
        this.inspectionInFlight = undefined;
      }
    };
    void promise.then(clearInFlight, clearInFlight);
    return promise;
  }

  async isApplied(): Promise<boolean> {
    return (await this.inspect()).applied;
  }

  async getState(): Promise<SystemProxyState> {
    return (await this.inspect()).state;
  }

  private invalidateInspection(): void {
    this.inspectionGeneration += 1;
    this.inspectionCache = undefined;
  }

  private observeJournal(): JournalObservation {
    try {
      return { kind: "read", journal: this.readJournal() };
    } catch (error) {
      return { kind: "error", error };
    }
  }

  private sameJournalObservation(left: JournalObservation, right: JournalObservation): boolean {
    if (left.kind === "error" || right.kind === "error") {
      return (
        left.kind === "error" &&
        right.kind === "error" &&
        errorMessage(left.error) === errorMessage(right.error)
      );
    }
    if (!left.journal || !right.journal) return left.journal === right.journal;
    return sameJournal(left.journal, right.journal);
  }

  private inspectionMessages(
    before: JournalObservation,
    after: JournalObservation,
    captureError?: { readonly caught: true; readonly error: unknown },
  ): string[] {
    const messages: string[] = [];
    const add = (error: unknown): void => {
      const message = errorMessage(error) || "unknown error";
      if (!messages.includes(message)) messages.push(message);
    };
    if (before.kind === "error") add(before.error);
    if (after.kind === "error") add(after.error);
    if (!this.sameJournalObservation(before, after)) {
      add(new Error("System proxy journal changed during inspection"));
    }
    if (captureError) add(captureError.error);
    return messages;
  }

  private async inspectAttempt(): Promise<InspectionAttempt> {
    const before = this.observeJournal();
    let current: SystemProxySnapshot;
    let state: SystemProxyState;
    try {
      current = await this.captureCurrent();
      state = this.backend.state(current);
    } catch (error) {
      const after = this.observeJournal();
      const messages = this.inspectionMessages(before, after, { caught: true, error });
      const queryError = messages.join("; ");
      return {
        journalStable: this.sameJournalObservation(before, after),
        inspection: {
          applied: false,
          state: {
            supported: this.backend.supported ?? isSystemProxySupported(),
            enabled: false,
            details: queryError,
          },
          appliedKnown: false,
          stateKnown: false,
          queryError,
        },
      };
    }

    const after = this.observeJournal();
    const journalStable = this.sameJournalObservation(before, after);
    const messages = this.inspectionMessages(before, after);
    if (messages.length > 0) {
      state.details = [state.details, ...messages].filter(Boolean).join("; ");
    }
    const journal =
      journalStable && before.kind === "read" && after.kind === "read" ? after.journal : undefined;
    const appliedKnown = journalStable && messages.length === 0;
    const queryError = messages.join("; ");
    return {
      journalStable,
      inspection: {
        applied:
          appliedKnown &&
          journal?.phase === "applied" &&
          this.backend.equivalent(current, journal.target),
        state,
        appliedKnown,
        stateKnown: true,
        ...(queryError ? { queryError } : {}),
      },
    };
  }

  private async inspectUncached(): Promise<InspectionAttempt> {
    const first = await this.inspectAttempt();
    return first.journalStable ? first : this.inspectAttempt();
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
    this.writeJournal(canonical);
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

  private replaceJournal(expected: SystemProxyJournal, next: SystemProxyJournal): void {
    const existing = this.readJournal();
    if (!existing || !sameJournal(existing, expected)) {
      throw new Error(
        `System proxy journal changed while applying: ${this.layout.systemProxyStateFile}`,
      );
    }
    const canonical = parseSystemProxyJournal(next);
    this.writeJournal(canonical);
  }

  private clearJournal(expected: SystemProxyJournal): void {
    const existing = this.readJournal();
    if (!existing || !sameJournalOwnership(existing, expected)) {
      throw new Error(
        `System proxy journal changed while restoring: ${this.layout.systemProxyStateFile}`,
      );
    }
    try {
      fs.unlinkSync(this.layout.systemProxyStateFile);
    } catch (err) {
      if (errnoCode(err) === "ENOENT") {
        throw new Error(
          `System proxy journal changed while restoring: ${this.layout.systemProxyStateFile}`,
        );
      }
      throw new Error(`Could not remove system proxy journal: ${errorMessage(err)}`);
    }
  }

  private async captureCurrent(): Promise<SystemProxySnapshot> {
    return parseSystemProxySnapshot(await this.backend.capture());
  }

  private async applyUnlocked(opts: EnableOptions): Promise<void> {
    const previous = this.readJournal();
    if (previous) {
      const desiredTarget = parseSystemProxySnapshot(
        this.backend.createTarget(previous.original, opts),
      );
      const current = await this.captureCurrent();
      if (
        previous.phase === "applied" &&
        this.backend.equivalent(previous.target, desiredTarget) &&
        this.backend.equivalent(current, previous.target)
      ) {
        return;
      }
      await this.restoreJournal(previous);
    }

    const original = await this.captureCurrent();
    const target = parseSystemProxySnapshot(this.backend.createTarget(original, opts));
    if (!journalSnapshotsHaveSameStructure(original, target)) {
      throw new Error("System proxy backend produced a target with a different platform structure");
    }
    const prepared: SystemProxyJournal = {
      schemaVersion: 2,
      phase: "prepared",
      ownerPid: process.pid,
      createdAt: new Date().toISOString(),
      original,
      target,
    };
    this.writeNewJournal(prepared);

    const beforeApply = await this.captureCurrent();
    if (!this.backend.equivalent(beforeApply, original)) {
      this.clearJournal(prepared);
      throw new Error(
        "System proxy settings changed while Sash was preparing ownership; refusing to overwrite them",
      );
    }

    let activeJournal = prepared;
    try {
      await this.backend.apply(target);
      const current = await this.captureCurrent();
      if (!this.backend.equivalent(current, target)) {
        throw new Error("System proxy target verification failed after apply");
      }
      const applied: SystemProxyJournal = { ...prepared, phase: "applied" };
      this.replaceJournal(prepared, applied);
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

  /**
   * Restore only when current managed values still belong to this journal.
   * A third value, or a changed macOS service collection, is never overwritten.
   */
  private async restoreJournal(journal: SystemProxyJournal): Promise<void> {
    const current = await this.captureCurrent();
    if (this.backend.equivalent(current, journal.original)) {
      this.clearJournal(journal);
      return;
    }

    const canRestore =
      this.backend.equivalent(current, journal.target) ||
      ((journal.phase === "prepared" || journal.phase === "restoring") &&
        this.backend.compatible(current, journal.original, journal.target));
    if (!canRestore) {
      throw new Error(
        "System proxy journal refuses to restore because current settings were modified outside Sash",
      );
    }

    const restoring: SystemProxyJournal =
      journal.phase === "restoring" ? journal : { ...journal, phase: "restoring" };
    if (restoring !== journal) this.replaceJournal(journal, restoring);

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
      restored = await this.captureCurrent();
    } catch (err) {
      const verificationError = new Error(
        `Could not verify system proxy restoration: ${errorMessage(err)}`,
      );
      throw applyResult.ok
        ? verificationError
        : combinedError(applyResult.error, verificationError);
    }
    if (!this.backend.equivalent(restored, restoring.original)) {
      const verificationError = new Error("System proxy restoration verification failed");
      throw applyResult.ok
        ? verificationError
        : combinedError(applyResult.error, verificationError);
    }

    this.clearJournal(restoring);
  }
}
