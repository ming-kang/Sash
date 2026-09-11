import fs from "node:fs";
import { errorMessage } from "./error-utils.js";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { isPlainObject } from "./json-shape.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { type ProfilesIndex, parseProfilesIndex } from "./profile-model.js";
import {
  DEFAULT_SETTINGS,
  initialSettings,
  type SashSettings,
  validateSettingsCandidate,
} from "./settings.js";

export const MAX_STATE_BYTES = 2 * 1024 * 1024;

export interface SashState {
  schemaVersion: 2;
  revision: number;
  settings: SashSettings;
  profiles: ProfilesIndex;
}

export class StateConflictError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "StateConflictError";
  }
}

function freezeSnapshot<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeSnapshot(child);
  }
  return value;
}

function readStateText(layout: SashLayout): string | undefined {
  try {
    const bytes = fs.readFileSync(layout.settingsFile);
    if (bytes.length > MAX_STATE_BYTES) throw new Error("Sash state is too large");
    return bytes.toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read Sash state at ${layout.settingsFile}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

export function parseState(value: unknown): SashState {
  if (!isPlainObject(value) || value.schemaVersion !== 2) {
    throw new Error("Invalid Sash state: schemaVersion must be 2");
  }
  if (
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  ) {
    throw new Error("Sash state has an invalid revision");
  }
  return {
    schemaVersion: 2,
    revision: value.revision,
    settings: validateSettingsCandidate(value.settings),
    profiles: parseProfilesIndex(value.profiles),
  };
}

function parseStateText(text: string, layout: SashLayout): SashState {
  try {
    return parseState(JSON.parse(text) as unknown);
  } catch (error) {
    throw new Error(`Cannot read Sash state at ${layout.settingsFile}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

/** Read-only: CLI discovery must never initialize or migrate state. */
export function readState(layout: SashLayout = sashLayout()): SashState | undefined {
  const text = readStateText(layout);
  return text === undefined ? undefined : parseStateText(text, layout);
}

export function loadSettings(layout: SashLayout = sashLayout()): SashSettings {
  return readState(layout)?.settings ?? { ...DEFAULT_SETTINGS };
}

/** One canonical publication point, used only by the daemon owning the instance lease. */
export class SashStateStore {
  private state: SashState;

  constructor(
    readonly layout: SashLayout,
    settings?: SashSettings,
  ) {
    const stored = readState(layout);
    this.state = freezeSnapshot(
      stored ?? {
        schemaVersion: 2,
        revision: 0,
        settings: validateSettingsCandidate(settings ?? initialSettings()),
        profiles: { activeId: null, profiles: [] },
      },
    );
    if (stored === undefined) {
      const text = `${JSON.stringify(this.state, null, 2)}\n`;
      atomicWriteFileSync(layout.settingsFile, text);
      this.publishBackup(text);
    }
  }

  /** Recovery copy of the last known-good manifest; never blocks the primary write. */
  private publishBackup(text: string): void {
    try {
      atomicWriteFileSync(this.layout.settingsBackupFile, text);
    } catch {
      /* The committed manifest is durable; a failed backup must not reject it. */
    }
  }

  /** Deeply frozen; reference identity changes only after a successful commit. */
  snapshot(): SashState {
    return this.state;
  }

  assertCurrent(revision: number): void {
    if (revision !== this.state.revision) {
      throw new StateConflictError(
        "Sash state changed; refresh before retrying. Edit files only while Sash is stopped.",
      );
    }
  }

  commit(candidate: SashState): SashState {
    this.assertCurrent(candidate.revision);
    const next = freezeSnapshot(
      structuredClone({ ...candidate, revision: candidate.revision + 1 }),
    );
    const text = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new Error("Sash state is too large");
    atomicWriteFileSync(this.layout.settingsFile, text);
    this.state = next;
    this.publishBackup(text);
    return next;
  }
}
