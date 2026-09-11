import { isPlainObject } from "./json-shape.js";
import type { SubscriptionUserinfo } from "./mihomo-config.js";

export interface ProfileMeta {
  id: string;
  revision: number;
  name: string;
  url: string;
  intervalHours: number;
  createdAt: string;
  updatedAt: string;
  subInfo?: SubscriptionUserinfo;
  homePage?: string;
  lastError?: string;
  lastAttemptAt?: string;
  failureCount?: number;
}

export interface ProfilesIndex {
  activeId: string | null;
  profiles: ProfileMeta[];
}

export const DEFAULT_PROFILE_INTERVAL_HOURS = 24;
export const MAX_PROFILE_INTERVAL_HOURS = 24 * 365;

const EPOCH = new Date(0).toISOString();

/** Reads leniently: unknown fields are ignored, and a damaged entry is skipped
 * rather than discarding the whole index. Entry ids stay path-safe. */
export function parseProfilesIndex(value: unknown): ProfilesIndex {
  if (!isPlainObject(value) || !Array.isArray(value.profiles))
    throw new Error("Profiles index has an invalid shape");
  const profiles: ProfileMeta[] = [];
  const ids = new Set<string>();
  for (const item of value.profiles) {
    const profile = parseProfileMeta(item);
    if (!profile || ids.has(profile.id)) continue;
    ids.add(profile.id);
    profiles.push(profile);
  }
  const activeId =
    typeof value.activeId === "string" && ids.has(value.activeId) ? value.activeId : null;
  return { activeId, profiles };
}

function parseProfileMeta(item: unknown): ProfileMeta | null {
  if (
    !isPlainObject(item) ||
    typeof item.id !== "string" ||
    !/^[0-9]+$/.test(item.id) ||
    typeof item.revision !== "number" ||
    !Number.isSafeInteger(item.revision) ||
    item.revision < 1 ||
    typeof item.url !== "string"
  )
    return null;
  const name =
    typeof item.name === "string" && item.name.trim()
      ? item.name.slice(0, 120)
      : `profile-${item.id}`;
  const intervalHours =
    typeof item.intervalHours === "number" &&
    Number.isSafeInteger(item.intervalHours) &&
    item.intervalHours >= 0
      ? Math.min(item.intervalHours, MAX_PROFILE_INTERVAL_HOURS)
      : DEFAULT_PROFILE_INTERVAL_HOURS;
  const timestamp = (key: "createdAt" | "updatedAt"): string =>
    typeof item[key] === "string" ? (item[key] as string) : EPOCH;
  const subInfo = parseSubInfo(item.subInfo);
  const homePage = httpUrl(item.homePage);
  const lastError = typeof item.lastError === "string" ? item.lastError.slice(0, 300) : undefined;
  const lastAttemptAt = typeof item.lastAttemptAt === "string" ? item.lastAttemptAt : undefined;
  const failureCount =
    typeof item.failureCount === "number" &&
    Number.isSafeInteger(item.failureCount) &&
    item.failureCount >= 0
      ? item.failureCount
      : undefined;
  return {
    id: item.id,
    revision: item.revision,
    name,
    url: item.url,
    intervalHours,
    createdAt: timestamp("createdAt"),
    updatedAt: timestamp("updatedAt"),
    ...(subInfo ? { subInfo } : {}),
    ...(homePage ? { homePage } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
    ...(lastAttemptAt !== undefined ? { lastAttemptAt } : {}),
    ...(failureCount !== undefined ? { failureCount } : {}),
  };
}

function parseSubInfo(value: unknown): SubscriptionUserinfo | undefined {
  if (!isPlainObject(value)) return undefined;
  const number = (key: "upload" | "download" | "total" | "expire"): number | undefined => {
    const candidate = value[key];
    return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
      ? candidate
      : undefined;
  };
  const upload = number("upload");
  const download = number("download");
  const total = number("total");
  if (upload === undefined || download === undefined || total === undefined) return undefined;
  const expire = number("expire");
  return { upload, download, total, ...(expire !== undefined ? { expire } : {}) };
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : undefined;
  } catch {
    return undefined;
  }
}
