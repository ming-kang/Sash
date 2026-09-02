import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { atomicWriteFileSync } from "./fs-atomic.js";
import {
  isValidMihomoConfig,
  PROFILE_DOWNLOAD_SIZE_LIMIT,
  type SubscriptionUserinfo,
} from "./mihomo-config.js";
import { type SashLayout, sashLayout } from "./paths.js";

/**
 * Subscription profiles. A downloaded subscription becomes an ordinary local
 * file under <root>/profiles/ (one <id>.yaml per profile) with metadata in
 * <root>/profiles/index.json; sashd refreshes remote profiles on their
 * configured interval or on manual request. The layout mirrors the classic
 * Clash for Windows data/profiles convention.
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
export const MAX_PROFILE_INTERVAL_HOURS = 24 * 365;
export const PROFILE_INDEX_SIZE_LIMIT = 2 * 1024 * 1024;

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
    Number.isSafeInteger(p.intervalHours) &&
    p.intervalHours >= 0 &&
    p.intervalHours <= MAX_PROFILE_INTERVAL_HOURS &&
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
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(layout.profilesIndexFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { activeId: null, profiles: [] };
    }
    throw err;
  }
  if (!stat.isFile() || stat.size > PROFILE_INDEX_SIZE_LIMIT) {
    throw new Error(
      `Profiles index must be a regular file no larger than ${PROFILE_INDEX_SIZE_LIMIT} bytes: ${layout.profilesIndexFile}`,
    );
  }
  const content = fs.readFileSync(layout.profilesIndexFile);
  if (content.length > PROFILE_INDEX_SIZE_LIMIT) {
    throw new Error(
      `Profiles index must be a regular file no larger than ${PROFILE_INDEX_SIZE_LIMIT} bytes: ${layout.profilesIndexFile}`,
    );
  }
  const text = content.toString("utf8");

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

function readProfileBytes(layout: SashLayout, id: string): Buffer | undefined {
  const file = profileFilePath(layout, id);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  if (!stat.isFile() || stat.size > PROFILE_DOWNLOAD_SIZE_LIMIT) {
    throw new Error(
      `Profile ${id} must be a regular file no larger than ${PROFILE_DOWNLOAD_SIZE_LIMIT} bytes: ${file}`,
    );
  }
  const content = fs.readFileSync(file);
  if (content.length > PROFILE_DOWNLOAD_SIZE_LIMIT) {
    throw new Error(
      `Profile ${id} must be a regular file no larger than ${PROFILE_DOWNLOAD_SIZE_LIMIT} bytes: ${file}`,
    );
  }
  return content;
}

export function profileContentDigest(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export interface ProfileSource {
  doc: Record<string, unknown>;
  yamlText: string;
  digest: string;
}

/** Read, bound and validate a stored profile from one exact byte snapshot. */
export function readProfileSource(layout: SashLayout, id: string): ProfileSource | undefined {
  const content = readProfileBytes(layout, id);
  if (!content) return undefined;
  const yamlText = content.toString("utf8");
  let doc: unknown;
  try {
    doc = YAML.parse(yamlText);
  } catch (err) {
    throw new Error(`Profile ${id} contains invalid YAML: ${(err as Error).message}`);
  }
  if (!isValidMihomoConfig(doc)) {
    throw new Error(`Profile ${id} is not a valid core configuration`);
  }
  return { doc, yamlText, digest: profileContentDigest(content) };
}

/** Digest raw stored bytes without requiring a currently valid YAML document. */
export function readProfileDigest(layout: SashLayout, id: string): string | null {
  const content = readProfileBytes(layout, id);
  return content ? profileContentDigest(content) : null;
}

/** Read and validate a profile's stored document; undefined only when the file is absent. */
export function readProfileDoc(
  layout: SashLayout,
  id: string,
): Record<string, unknown> | undefined {
  return readProfileSource(layout, id)?.doc;
}

/** Allocate a file id which is free in both metadata and the profiles directory. */
export function allocateProfileId(
  index: ProfilesIndex,
  layout: SashLayout,
  nowMs = Date.now(),
): string {
  let candidate = BigInt(nowMs);
  for (;;) {
    const id = candidate.toString();
    if (
      !index.profiles.some((profile) => profile.id === id) &&
      !fs.existsSync(profileFilePath(layout, id))
    ) {
      return id;
    }
    candidate += 1n;
  }
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
