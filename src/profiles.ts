import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { atomicWriteFileSync } from "./fs-atomic.js";
import {
  isValidMihomoConfig,
  type SubscriptionFetch,
  type SubscriptionUserinfo,
} from "./mihomo-config.js";
import { type SashLayout, sashLayout } from "./paths.js";

/**
 * Subscription profiles. A downloaded subscription becomes an ordinary local
 * file under <root>/profiles/ (one <id>.yaml per profile) with metadata in
 * <root>/profiles/index.json; sashd refreshes remote profiles on their
 * configured interval or on manual request. The layout mirrors the classic
 * Clash for Windows data/profiles convention.
 *
 * All mutators are synchronous between the index read and write, so the
 * single-process daemon cannot interleave them mid-mutation; network fetches
 * always happen before a mutator is called.
 */

export interface ProfileMeta {
  /** File stem: ms epoch at creation, e.g. "1780811098558" → <id>.yaml. */
  id: string;
  name: string;
  /** Remote subscription URL; "" for imported/local files. */
  url: string;
  /** Auto-update interval in hours; 0 disables scheduled updates. */
  intervalHours: number;
  createdAt: string;
  /** Last successful content write; epoch 0 means "never downloaded". */
  updatedAt: string;
  subInfo?: SubscriptionUserinfo;
  homePage?: string;
  /** Last (auto-)update error; cleared on the next success. */
  lastError?: string;
}

export interface ProfilesIndex {
  activeId: string | null;
  profiles: ProfileMeta[];
}

export const DEFAULT_PROFILE_INTERVAL_HOURS = 24;

/** updatedAt sentinel for profiles whose content has never been downloaded. */
export const NEVER_UPDATED = new Date(0).toISOString();

export function profileFilePath(layout: SashLayout, id: string): string {
  if (!/^[0-9]+$/.test(id)) throw new Error(`invalid profile id: ${id}`);
  return path.join(layout.profilesDir, `${id}.yaml`);
}

function isSubscriptionUserinfo(value: unknown): value is SubscriptionUserinfo {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const info = value as Partial<SubscriptionUserinfo>;
  return (
    Number.isFinite(info.upload) &&
    Number.isFinite(info.download) &&
    Number.isFinite(info.total) &&
    (info.expire === undefined || Number.isFinite(info.expire))
  );
}

function isProfileMeta(value: unknown): value is ProfileMeta {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const p = value as Partial<ProfileMeta>;
  return (
    typeof p.id === "string" &&
    /^[0-9]+$/.test(p.id) &&
    typeof p.name === "string" &&
    typeof p.url === "string" &&
    typeof p.intervalHours === "number" &&
    Number.isFinite(p.intervalHours) &&
    p.intervalHours >= 0 &&
    typeof p.createdAt === "string" &&
    Number.isFinite(new Date(p.createdAt).getTime()) &&
    typeof p.updatedAt === "string" &&
    Number.isFinite(new Date(p.updatedAt).getTime()) &&
    (p.subInfo === undefined || isSubscriptionUserinfo(p.subInfo)) &&
    (p.homePage === undefined || typeof p.homePage === "string") &&
    (p.lastError === undefined || typeof p.lastError === "string")
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function loadProfiles(layout: SashLayout = sashLayout()): ProfilesIndex {
  let text: string;
  try {
    text = fs.readFileSync(layout.profilesIndexFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { activeId: null, profiles: [] };
    }
    throw err;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(
      `Profiles index is invalid JSON: ${layout.profilesIndexFile}: ${(err as Error).message}`,
    );
  }
  if (!isPlainObject(raw)) {
    throw new Error(`Profiles index root must be a plain object: ${layout.profilesIndexFile}`);
  }
  if (Object.keys(raw).some((key) => key !== "activeId" && key !== "profiles")) {
    throw new Error(`Profiles index has unexpected root fields: ${layout.profilesIndexFile}`);
  }
  if (!Array.isArray(raw.profiles) || !raw.profiles.every(isProfileMeta)) {
    throw new Error(`Profiles index has invalid profile metadata: ${layout.profilesIndexFile}`);
  }
  if (raw.activeId !== null && raw.activeId !== undefined && typeof raw.activeId !== "string") {
    throw new Error(`Profiles index has an invalid activeId: ${layout.profilesIndexFile}`);
  }
  const profiles = raw.profiles;
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
    throw new Error(`Profiles index has duplicate profile ids: ${layout.profilesIndexFile}`);
  }
  const activeId =
    typeof raw.activeId === "string" && profiles.some((p) => p.id === raw.activeId)
      ? raw.activeId
      : null;
  return { activeId, profiles };
}

export function serializeProfiles(index: ProfilesIndex): string {
  const activeId = index.profiles.some((p) => p.id === index.activeId) ? index.activeId : null;
  return `${JSON.stringify({ ...index, activeId }, null, 2)}\n`;
}

export function saveProfiles(index: ProfilesIndex, layout: SashLayout = sashLayout()): void {
  atomicWriteFileSync(layout.profilesIndexFile, serializeProfiles(index));
}

export function getActiveProfile(index: ProfilesIndex): ProfileMeta | null {
  return index.profiles.find((p) => p.id === index.activeId) ?? null;
}

export function findProfileByUrl(index: ProfilesIndex, url: string): ProfileMeta | null {
  return index.profiles.find((p) => p.url !== "" && p.url === url) ?? null;
}

/** Read and validate a profile's stored document; undefined only when the file is absent. */
export function readProfileDoc(
  layout: SashLayout,
  id: string,
): Record<string, unknown> | undefined {
  const file = profileFilePath(layout, id);
  if (!fs.existsSync(file)) return undefined;
  let doc: unknown;
  try {
    doc = YAML.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Profile ${id} contains invalid YAML: ${(err as Error).message}`);
  }
  if (!isValidMihomoConfig(doc)) {
    throw new Error(`Profile ${id} is not a valid core configuration`);
  }
  return doc;
}

export interface AddProfileInit {
  name: string;
  url: string;
  /** Raw YAML content; omit for meta-only entries filled by a later update. */
  yamlText?: string;
  intervalHours?: number;
  subInfo?: SubscriptionUserinfo;
  homePage?: string;
}

/** Append a new inactive profile; activation policy belongs to the application service. */
export function addProfile(
  init: AddProfileInit,
  layout: SashLayout = sashLayout(),
): { index: ProfilesIndex; profile: ProfileMeta } {
  const index = loadProfiles(layout);
  let id = String(Date.now());
  while (index.profiles.some((p) => p.id === id)) {
    id = String(Number(id) + 1);
  }
  const now = new Date().toISOString();
  const profile: ProfileMeta = {
    id,
    name: init.name.trim() || "profile",
    url: init.url,
    intervalHours: init.intervalHours ?? DEFAULT_PROFILE_INTERVAL_HOURS,
    createdAt: now,
    updatedAt: init.yamlText !== undefined ? now : NEVER_UPDATED,
    ...(init.subInfo ? { subInfo: init.subInfo } : {}),
    ...(init.homePage ? { homePage: init.homePage } : {}),
  };
  if (init.yamlText !== undefined) {
    atomicWriteFileSync(profileFilePath(layout, id), init.yamlText);
  }
  index.profiles.push(profile);
  saveProfiles(index, layout);
  return { index, profile };
}

export interface UpdateProfilePatch {
  yamlText?: string;
  name?: string;
  intervalHours?: number;
  subInfo?: SubscriptionUserinfo;
  homePage?: string;
  /** Set to clear (undefined) or record an update error. */
  lastError?: string;
}

export function updateProfile(
  id: string,
  patch: UpdateProfilePatch,
  layout: SashLayout = sashLayout(),
): ProfilesIndex {
  const index = loadProfiles(layout);
  const profile = index.profiles.find((p) => p.id === id);
  if (!profile) throw new Error(`profile not found: ${id}`);
  if (patch.yamlText !== undefined) {
    atomicWriteFileSync(profileFilePath(layout, id), patch.yamlText);
    profile.updatedAt = new Date().toISOString();
    delete profile.lastError;
  }
  if (patch.name?.trim()) profile.name = patch.name.trim();
  if (patch.intervalHours !== undefined && Number.isFinite(patch.intervalHours)) {
    profile.intervalHours = Math.max(0, Math.floor(patch.intervalHours));
  }
  if (patch.subInfo !== undefined) profile.subInfo = patch.subInfo;
  if (patch.homePage !== undefined) profile.homePage = patch.homePage;
  if (patch.lastError !== undefined) profile.lastError = patch.lastError;
  saveProfiles(index, layout);
  return index;
}

/** Record a failed (auto-)update without touching stored content. */
export function recordProfileError(
  id: string,
  message: string,
  layout: SashLayout = sashLayout(),
): void {
  const index = loadProfiles(layout);
  const profile = index.profiles.find((p) => p.id === id);
  if (!profile) return;
  profile.lastError = message.slice(0, 300);
  saveProfiles(index, layout);
}

/** Delete a profile and its file. Returns whether it was the active one. */
export function removeProfile(
  id: string,
  layout: SashLayout = sashLayout(),
): { index: ProfilesIndex; wasActive: boolean } {
  const index = loadProfiles(layout);
  const pos = index.profiles.findIndex((p) => p.id === id);
  if (pos < 0) throw new Error(`profile not found: ${id}`);
  index.profiles.splice(pos, 1);
  const wasActive = index.activeId === id;
  if (wasActive) index.activeId = null;
  fs.rmSync(profileFilePath(layout, id), { force: true });
  saveProfiles(index, layout);
  return { index, wasActive };
}

/** Select (or with null, deselect) the profile feeding config.yaml. */
export function setActiveProfile(
  id: string | null,
  layout: SashLayout = sashLayout(),
): ProfilesIndex {
  const index = loadProfiles(layout);
  if (id !== null && !index.profiles.some((p) => p.id === id)) {
    throw new Error(`profile not found: ${id}`);
  }
  index.activeId = id;
  saveProfiles(index, layout);
  return index;
}

/** Persist freshly fetched subscription content onto an existing profile. */
export function applySubscriptionFetch(
  id: string,
  fetched: SubscriptionFetch,
  layout: SashLayout = sashLayout(),
): ProfilesIndex {
  return updateProfile(
    id,
    {
      yamlText: fetched.yamlText,
      ...(fetched.subInfo ? { subInfo: fetched.subInfo } : {}),
      ...(fetched.homePage ? { homePage: fetched.homePage } : {}),
      ...(fetched.intervalHours ? { intervalHours: fetched.intervalHours } : {}),
    },
    layout,
  );
}

/** Host-derived display name fallback for subscriptions without a filename. */
export function profileNameFromUrl(url: string): string {
  try {
    return new URL(url).hostname || "profile";
  } catch {
    return "profile";
  }
}

/**
 * Whether a remote profile should be refreshed now: its file is missing
 * (e.g. freshly migrated) or its update interval has elapsed.
 */
export function profileDueForUpdate(
  profile: ProfileMeta,
  fileExists: boolean,
  nowMs: number = Date.now(),
): boolean {
  if (!profile.url || profile.intervalHours <= 0) return false;
  if (!fileExists) return true;
  const updatedMs = new Date(profile.updatedAt).getTime();
  if (!Number.isFinite(updatedMs)) return true;
  return nowMs - updatedMs >= profile.intervalHours * 3_600_000;
}

/**
 * One-time migration: a legacy single subscription (settings.subscriptionUrl)
 * becomes a meta-only, active profile. Its content is fetched lazily — the
 * file-missing rule in profileDueForUpdate makes it due immediately.
 */
export function migrateLegacySubscription(
  url: string,
  layout: SashLayout = sashLayout(),
): { index: ProfilesIndex; created: boolean } {
  const index = loadProfiles(layout);
  if (!url || findProfileByUrl(index, url)) return { index, created: false };
  const now = new Date().toISOString();
  const profile: ProfileMeta = {
    id: String(Date.now()),
    name: profileNameFromUrl(url),
    url,
    intervalHours: DEFAULT_PROFILE_INTERVAL_HOURS,
    createdAt: now,
    updatedAt: NEVER_UPDATED,
  };
  index.profiles.push(profile);
  if (index.activeId === null) index.activeId = profile.id;
  saveProfiles(index, layout);
  return { index, created: true };
}
