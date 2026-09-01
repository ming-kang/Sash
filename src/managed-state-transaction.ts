import fs from "node:fs";
import { atomicWriteFileSync, durableRemoveFileSync } from "./fs-atomic.js";
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

interface ManagedStateTransactionJournal {
  version: 2;
  phase: "publishing" | "committed";
  createdAt: string;
  index?: JournalSnapshot;
  profile?: { id: string; data: string | null };
  config?: JournalSnapshot;
  settings?: JournalSnapshot;
}

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function decodeSnapshot(value: unknown, role: string): Buffer | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ["data"])) {
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

interface ParsedJournal {
  phase: "publishing" | "committed";
  snapshots: FileSnapshot[];
}

function parseJournal(raw: unknown): ParsedJournal {
  if (!isPlainObject(raw)) {
    throw new Error("Managed-state transaction journal has an invalid root shape");
  }
  const legacy = raw.version === 1;
  const allowed = legacy
    ? ["version", "createdAt", "index", "profile", "config"]
    : ["version", "phase", "createdAt", "index", "profile", "config", "settings"];
  const required = legacy ? ["version", "createdAt", "index"] : ["version", "phase", "createdAt"];
  if (
    Object.keys(raw).some((key) => !allowed.includes(key)) ||
    !required.every((key) => key in raw)
  ) {
    throw new Error("Managed-state transaction journal has an invalid root shape");
  }
  if (raw.version !== 1 && raw.version !== 2) {
    throw new Error("Managed-state transaction journal has an unsupported version");
  }
  let phase: ParsedJournal["phase"];
  if (raw.version === 1) {
    phase = "publishing";
  } else if (raw.phase === "publishing" || raw.phase === "committed") {
    phase = raw.phase;
  } else {
    throw new Error("Managed-state transaction journal has an invalid phase");
  }
  if (
    typeof raw.createdAt !== "string" ||
    !Number.isFinite(new Date(raw.createdAt).getTime()) ||
    new Date(raw.createdAt).toISOString() !== raw.createdAt
  ) {
    throw new Error("Managed-state transaction journal has an invalid timestamp");
  }

  const index = raw.index === undefined ? undefined : decodeSnapshot(raw.index, "index");
  let profile: { id: string; data: Buffer | null } | undefined;
  if (raw.profile !== undefined) {
    if (!isPlainObject(raw.profile) || !hasExactKeys(raw.profile, ["id", "data"])) {
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
    throw new Error("Profile transaction snapshots exceed the journal size limit");
  }
  return {
    version: 2,
    phase: "publishing",
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

/** Restore an interrupted managed-state publication. Call only while owning mutation.lock. */
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
  const snapshots = stored.snapshots.map((entry) => ({
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
  const errors = restore(snapshots, files);
  if (errors.length === 0) {
    try {
      durableRemoveFileSync(layout.managedStateTransactionFile);
    } catch (err) {
      errors.push(`journal: ${(err as Error).message}`);
    }
  }
  if (errors.length)
    throw new Error(`Managed-state transaction recovery failed: ${errors.join("; ")}`);
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
  const profilePath = transaction.profile
    ? profileFilePath(layout, transaction.profile.id)
    : undefined;
  const snapshots = snapshot([
    ...(profilePath ? [profilePath] : []),
    ...(transaction.index ? [layout.profilesIndexFile] : []),
    ...(transaction.config ? [layout.configFile] : []),
    ...(transaction.settings ? [layout.settingsFile] : []),
  ]);
  const journal = journalFromSnapshots(snapshots, layout, transaction.profile?.id);
  atomicWriteFileSync(layout.managedStateTransactionFile, `${JSON.stringify(journal)}\n`);
  let reloadAttempted = false;

  try {
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
    if (transaction.config && transaction.reloadRuntime !== false && reloadConfig) {
      reloadAttempted = true;
      await reloadConfig(layout.configFile);
    }
    await transaction.applyRuntime?.();
    atomicWriteFileSync(
      layout.managedStateTransactionFile,
      `${JSON.stringify({ ...journal, phase: "committed" })}\n`,
    );
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
