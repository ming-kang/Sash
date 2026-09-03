import fs from "node:fs";
import { atomicWriteFileSync, durableRemoveFileSync } from "./fs-atomic.js";
import { hasExactOwnKeys, isCanonicalIsoTimestamp, isPlainObject } from "./json-shape.js";
import type { GeneratedConfig } from "./mihomo-config.js";
import type { SashLayout } from "./paths.js";
import { type ProfilesIndex, profileFilePath, serializeProfiles } from "./profiles.js";
import type { SashSettings } from "./settings.js";

const MAX_JOURNAL_BYTES = 36 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 24 * 1024 * 1024;

interface FileSnapshot {
  path: string;
  data: Buffer | null;
}

interface JournalSnapshot {
  data: string | null;
}

type ManagedStateTransactionPhase = "publishing" | "retained" | "committed";
export type ManagedStateTransactionCoordination = "core-update";

interface ManagedStateTransactionJournalBase {
  phase: ManagedStateTransactionPhase;
  createdAt: string;
  index?: JournalSnapshot;
  profile?: { id: string; data: string | null };
  config?: JournalSnapshot;
  settings?: JournalSnapshot;
}

interface ManagedStateTransactionJournalV2 extends ManagedStateTransactionJournalBase {
  version: 2;
  phase: "publishing" | "committed";
}

interface ManagedStateTransactionJournalV3 extends ManagedStateTransactionJournalBase {
  version: 3;
  coordination: ManagedStateTransactionCoordination;
}

type ManagedStateTransactionJournal =
  | ManagedStateTransactionJournalV2
  | ManagedStateTransactionJournalV3;

/** Injectable only to make managed-state persistence failures testable. */
export interface ManagedStateFileOperations {
  write(path: string, data: string | Buffer): void;
  remove(path: string): void;
}

export const defaultManagedStateFileOperations: ManagedStateFileOperations = {
  write: atomicWriteFileSync,
  remove: durableRemoveFileSync,
};

export interface ManagedStateTransaction {
  index?: ProfilesIndex;
  profile?: { id: string; yamlText: string | null };
  config?: GeneratedConfig;
  /** Already canonical settings; written as part of the durable publication. */
  settings?: SashSettings;
  reloadRuntime?: boolean;
  /** Runtime transition performed after files publish but before commit marker. */
  applyRuntime?: () => Promise<void>;
}

export interface ManagedStateTransactionStatus {
  phase: ManagedStateTransactionPhase;
  createdAt: string;
  coordination?: ManagedStateTransactionCoordination;
}

function decodeSnapshot(value: unknown, role: string): Buffer | null {
  if (!isPlainObject(value) || !hasExactOwnKeys(value, ["data"])) {
    throw new Error(`Managed-state transaction journal has invalid ${role} snapshot`);
  }
  if (value.data === null) return null;
  if (typeof value.data !== "string") {
    throw new Error(`Managed-state transaction journal has invalid ${role} snapshot data`);
  }
  const decoded = Buffer.from(value.data, "base64");
  if (decoded.toString("base64") !== value.data) {
    throw new Error(`Managed-state transaction journal has non-canonical ${role} snapshot data`);
  }
  return decoded;
}

interface ParsedJournal extends ManagedStateTransactionStatus {
  snapshots: FileSnapshot[];
}

function parseJournal(raw: unknown): ParsedJournal {
  if (!isPlainObject(raw)) {
    throw new Error("Managed-state transaction journal has an invalid root shape");
  }
  const legacy = raw.version === 1;
  const coordinated = raw.version === 3;
  const allowed = legacy
    ? ["version", "createdAt", "index", "profile", "config"]
    : [
        "version",
        "phase",
        "createdAt",
        "index",
        "profile",
        "config",
        "settings",
        ...(coordinated ? ["coordination"] : []),
      ];
  const required = legacy
    ? ["version", "createdAt", "index"]
    : ["version", "phase", "createdAt", ...(coordinated ? ["coordination"] : [])];
  if (
    Object.keys(raw).some((key) => !allowed.includes(key)) ||
    !required.every((key) => key in raw)
  ) {
    throw new Error("Managed-state transaction journal has an invalid root shape");
  }
  if (raw.version !== 1 && raw.version !== 2 && raw.version !== 3) {
    throw new Error("Managed-state transaction journal has an unsupported version");
  }
  let phase: ParsedJournal["phase"];
  if (raw.version === 1) {
    phase = "publishing";
  } else if (
    raw.phase === "publishing" ||
    raw.phase === "committed" ||
    (raw.version === 3 && raw.phase === "retained")
  ) {
    phase = raw.phase;
  } else {
    throw new Error("Managed-state transaction journal has an invalid phase");
  }
  if (!isCanonicalIsoTimestamp(raw.createdAt)) {
    throw new Error("Managed-state transaction journal has an invalid timestamp");
  }
  const coordination =
    raw.version === 3 && raw.coordination === "core-update" ? raw.coordination : undefined;
  if (raw.version === 3 && !coordination) {
    throw new Error("Managed-state transaction journal has invalid coordination");
  }

  const index = raw.index === undefined ? undefined : decodeSnapshot(raw.index, "index");
  let profile: { id: string; data: Buffer | null } | undefined;
  if (raw.profile !== undefined) {
    if (!isPlainObject(raw.profile) || !hasExactOwnKeys(raw.profile, ["id", "data"])) {
      throw new Error("Managed-state transaction journal has an invalid profile snapshot");
    }
    if (typeof raw.profile.id !== "string" || !/^[0-9]+$/.test(raw.profile.id)) {
      throw new Error("Managed-state transaction journal has an invalid profile id");
    }
    profile = { id: raw.profile.id, data: decodeSnapshot({ data: raw.profile.data }, "profile") };
  }
  const config = raw.config === undefined ? undefined : decodeSnapshot(raw.config, "config");
  const settings =
    raw.settings === undefined ? undefined : decodeSnapshot(raw.settings, "settings");
  const decodedSize =
    (index?.length ?? 0) +
    (profile?.data?.length ?? 0) +
    (config?.length ?? 0) +
    (settings?.length ?? 0);
  if (decodedSize > MAX_SNAPSHOT_BYTES) {
    throw new Error("Managed-state transaction journal snapshots exceed the size limit");
  }

  return {
    phase,
    createdAt: raw.createdAt,
    ...(coordination ? { coordination } : {}),
    snapshots: [
      ...(profile ? [{ path: profile.id, data: profile.data }] : []),
      ...(index !== undefined ? [{ path: "index", data: index }] : []),
      ...(config !== undefined ? [{ path: "config", data: config }] : []),
      ...(settings !== undefined ? [{ path: "settings", data: settings }] : []),
    ],
  };
}

function readJournal(layout: SashLayout): ParsedJournal | undefined {
  let text: string;
  try {
    const stat = fs.lstatSync(layout.managedStateTransactionFile);
    if (!stat.isFile() || stat.size > MAX_JOURNAL_BYTES) {
      throw new Error("Managed-state transaction journal is not a bounded regular file");
    }
    text = fs.readFileSync(layout.managedStateTransactionFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`Managed-state transaction journal is invalid JSON: ${(err as Error).message}`);
  }
  return parseJournal(raw);
}

export function readManagedStateTransactionStatus(
  layout: SashLayout,
): ManagedStateTransactionStatus | undefined {
  const stored = readJournal(layout);
  if (!stored) return undefined;
  return {
    phase: stored.phase,
    createdAt: stored.createdAt,
    ...(stored.coordination ? { coordination: stored.coordination } : {}),
  };
}

function snapshot(paths: string[]): FileSnapshot[] {
  return [...new Set(paths)].map((file) => {
    try {
      return { path: file, data: fs.readFileSync(file) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { path: file, data: null };
      throw err;
    }
  });
}

function journalFromSnapshots(
  snapshots: FileSnapshot[],
  layout: SashLayout,
  profileId: string | undefined,
  coordination?: ManagedStateTransactionCoordination,
): ManagedStateTransactionJournal {
  const indexEntry = snapshots.find((entry) => entry.path === layout.profilesIndexFile);
  const profileEntry = profileId
    ? snapshots.find((entry) => entry.path === profileFilePath(layout, profileId))
    : undefined;
  const configEntry = snapshots.find((entry) => entry.path === layout.configFile);
  const settingsEntry = snapshots.find((entry) => entry.path === layout.settingsFile);
  const size =
    (indexEntry?.data?.length ?? 0) +
    (profileEntry?.data?.length ?? 0) +
    (configEntry?.data?.length ?? 0) +
    (settingsEntry?.data?.length ?? 0);
  if (size > MAX_SNAPSHOT_BYTES) {
    throw new Error("Managed-state transaction snapshots exceed the journal size limit");
  }
  const entries = {
    createdAt: new Date().toISOString(),
    ...(indexEntry ? { index: { data: indexEntry.data?.toString("base64") ?? null } } : {}),
    ...(profileEntry && profileId
      ? {
          profile: {
            id: profileId,
            data: profileEntry.data?.toString("base64") ?? null,
          },
        }
      : {}),
    ...(configEntry ? { config: { data: configEntry.data?.toString("base64") ?? null } } : {}),
    ...(settingsEntry
      ? { settings: { data: settingsEntry.data?.toString("base64") ?? null } }
      : {}),
  };
  return coordination
    ? { version: 3, phase: "publishing", coordination, ...entries }
    : { version: 2, phase: "publishing", ...entries };
}

function restore(snapshots: FileSnapshot[], files: ManagedStateFileOperations): string[] {
  const errors: string[] = [];
  for (const entry of snapshots) {
    try {
      if (entry.data === null) files.remove(entry.path);
      else files.write(entry.path, entry.data);
    } catch (err) {
      errors.push(`${entry.path}: ${(err as Error).message}`);
    }
  }
  return errors;
}

function resolvedSnapshots(stored: ParsedJournal, layout: SashLayout): FileSnapshot[] {
  return stored.snapshots.map((entry) => ({
    path:
      entry.path === "index"
        ? layout.profilesIndexFile
        : entry.path === "config"
          ? layout.configFile
          : entry.path === "settings"
            ? layout.settingsFile
            : profileFilePath(layout, entry.path),
    data: entry.data,
  }));
}

function transactionSnapshots(
  layout: SashLayout,
  transaction: ManagedStateTransaction,
): { profilePath?: string; snapshots: FileSnapshot[] } {
  const profilePath = transaction.profile
    ? profileFilePath(layout, transaction.profile.id)
    : undefined;
  return {
    ...(profilePath ? { profilePath } : {}),
    snapshots: snapshot([
      ...(profilePath ? [profilePath] : []),
      ...(transaction.index ? [layout.profilesIndexFile] : []),
      ...(transaction.config ? [layout.configFile] : []),
      ...(transaction.settings ? [layout.settingsFile] : []),
    ]),
  };
}

function publishFiles(
  layout: SashLayout,
  transaction: ManagedStateTransaction,
  profilePath: string | undefined,
  files: ManagedStateFileOperations,
): void {
  if (profilePath && transaction.profile) {
    if (transaction.profile.yamlText === null) files.remove(profilePath);
    else files.write(profilePath, transaction.profile.yamlText);
  }
  if (transaction.index) {
    files.write(layout.profilesIndexFile, serializeProfiles(transaction.index));
  }
  if (transaction.config) files.write(layout.configFile, transaction.config.yaml);
  if (transaction.settings) {
    files.write(layout.settingsFile, `${JSON.stringify(transaction.settings, null, 2)}\n`);
  }
}

function writeJournal(layout: SashLayout, journal: ManagedStateTransactionJournal): void {
  atomicWriteFileSync(layout.managedStateTransactionFile, `${JSON.stringify(journal)}\n`);
}

function restoreAndClear(
  stored: ParsedJournal,
  layout: SashLayout,
  files: ManagedStateFileOperations,
  errorPrefix: string,
): void {
  const errors = restore(resolvedSnapshots(stored, layout), files);
  if (errors.length === 0) {
    try {
      durableRemoveFileSync(layout.managedStateTransactionFile);
    } catch (err) {
      errors.push(`journal: ${(err as Error).message}`);
    }
  }
  if (errors.length) throw new Error(`${errorPrefix}: ${errors.join("; ")}`);
}

/** Restore an interrupted ordinary publication. Call only while owning mutation.lock. */
export function recoverManagedStateTransaction(
  layout: SashLayout,
  files: ManagedStateFileOperations = defaultManagedStateFileOperations,
): void {
  const stored = readJournal(layout);
  if (!stored) return;
  if (stored.phase === "committed") {
    durableRemoveFileSync(layout.managedStateTransactionFile);
    return;
  }
  if (stored.phase === "retained") {
    throw new Error(
      "A retained managed-state transaction requires coordinated Core update recovery",
    );
  }
  restoreAndClear(stored, layout, files, "Managed-state transaction recovery failed");
}

/**
 * Publish a Core-update config/profile candidate while retaining its exact
 * rollback snapshots. The caller must later commit or roll it back while still
 * owning mutation.lock. Runtime transitions are intentionally forbidden here.
 */
export async function retainManagedStateTransaction(
  layout: SashLayout,
  transaction: ManagedStateTransaction,
  files: ManagedStateFileOperations = defaultManagedStateFileOperations,
): Promise<void> {
  if (transaction.applyRuntime || transaction.reloadRuntime === true || transaction.settings) {
    throw new Error(
      "Retained Core update publications cannot transition runtime or publish settings",
    );
  }
  recoverManagedStateTransaction(layout, files);
  const { profilePath, snapshots } = transactionSnapshots(layout, transaction);
  const journal = journalFromSnapshots(snapshots, layout, transaction.profile?.id, "core-update");
  if (journal.version !== 3) {
    throw new Error("Failed to create a coordinated managed-state transaction");
  }
  writeJournal(layout, journal);

  try {
    publishFiles(layout, transaction, profilePath, files);
    writeJournal(layout, { ...journal, phase: "retained" });
  } catch (err) {
    const rollbackErrors = restore(snapshots, files);
    if (rollbackErrors.length === 0) {
      try {
        durableRemoveFileSync(layout.managedStateTransactionFile);
      } catch (clearErr) {
        rollbackErrors.push(`journal: ${(clearErr as Error).message}`);
      }
    }
    const suffix = rollbackErrors.length
      ? `; managed-state transaction rollback failed: ${rollbackErrors.join("; ")}`
      : "";
    throw new Error(`${(err as Error).message}${suffix}`);
  }
}

/** Roll back a retained Core-update publication and clear its journal on success. */
export function rollbackRetainedManagedStateTransaction(
  layout: SashLayout,
  files: ManagedStateFileOperations = defaultManagedStateFileOperations,
): boolean {
  const stored = readJournal(layout);
  if (!stored) return false;
  if (stored.coordination !== "core-update" || stored.phase === "committed") {
    throw new Error("Managed-state transaction is not a retained Core update publication");
  }
  restoreAndClear(stored, layout, files, "Retained managed-state transaction rollback failed");
  return true;
}

/** Persist the decision to keep a retained publication before Core cleanup. */
export function markRetainedManagedStateTransactionCommitted(layout: SashLayout): boolean {
  const stored = readJournal(layout);
  if (!stored) return false;
  if (stored.coordination !== "core-update" || stored.phase !== "retained") {
    throw new Error("Managed-state transaction is not ready for coordinated commit");
  }
  const raw = JSON.parse(fs.readFileSync(layout.managedStateTransactionFile, "utf8")) as
    | ManagedStateTransactionJournalV3
    | undefined;
  if (raw?.version !== 3 || raw.coordination !== "core-update") {
    throw new Error("Managed-state transaction changed during coordinated commit");
  }
  writeJournal(layout, { ...raw, phase: "committed" });
  return true;
}

/** Clear only a durably committed coordinated publication. */
export function clearCommittedManagedStateTransaction(layout: SashLayout): boolean {
  const stored = readJournal(layout);
  if (!stored) return false;
  if (stored.coordination !== "core-update" || stored.phase !== "committed") {
    throw new Error("Managed-state transaction is not committed coordinated state");
  }
  durableRemoveFileSync(layout.managedStateTransactionFile);
  return true;
}

/**
 * Publish the fixed settings/index/profile/config roles as one recoverable
 * unit. No caller-supplied paths are accepted; the only external side effect
 * is an optional runtime transition after every file has been published.
 */
export async function commitManagedStateTransaction(
  layout: SashLayout,
  transaction: ManagedStateTransaction,
  reloadConfig: ((configPath: string) => Promise<void>) | undefined,
  files: ManagedStateFileOperations = defaultManagedStateFileOperations,
): Promise<void> {
  recoverManagedStateTransaction(layout, files);
  const { profilePath, snapshots } = transactionSnapshots(layout, transaction);
  const journal = journalFromSnapshots(snapshots, layout, transaction.profile?.id);
  writeJournal(layout, journal);
  let reloadAttempted = false;

  try {
    publishFiles(layout, transaction, profilePath, files);
    if (transaction.config && transaction.reloadRuntime !== false && reloadConfig) {
      reloadAttempted = true;
      await reloadConfig(layout.configFile);
    }
    await transaction.applyRuntime?.();
    writeJournal(layout, { ...journal, phase: "committed" });
    durableRemoveFileSync(layout.managedStateTransactionFile);
  } catch (err) {
    const rollbackErrors = restore(snapshots, files);
    if (reloadAttempted && transaction.config && reloadConfig) {
      const oldConfig = snapshots.find((entry) => entry.path === layout.configFile);
      if (oldConfig?.data !== null) {
        try {
          await reloadConfig(layout.configFile);
        } catch (reloadErr) {
          rollbackErrors.push(`config rollback reload failed: ${(reloadErr as Error).message}`);
        }
      }
    }
    if (rollbackErrors.length === 0) {
      try {
        durableRemoveFileSync(layout.managedStateTransactionFile);
      } catch (clearErr) {
        rollbackErrors.push(`journal: ${(clearErr as Error).message}`);
      }
    }
    const suffix = rollbackErrors.length
      ? `; managed-state transaction rollback failed: ${rollbackErrors.join("; ")}`
      : "";
    throw new Error(`${(err as Error).message}${suffix}`);
  }
}
