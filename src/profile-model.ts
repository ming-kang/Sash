import { isCanonicalIsoTimestamp, isPlainObject } from "./json-shape.js";
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

export function parseProfilesIndex(value: unknown): ProfilesIndex {
  if (
    !isPlainObject(value) ||
    Object.keys(value).some((key) => key !== "activeId" && key !== "profiles") ||
    !Array.isArray(value.profiles) ||
    (value.activeId !== null && typeof value.activeId !== "string")
  )
    throw new Error("Profiles index has an invalid shape");
  const profiles = value.profiles.map(parseProfileMeta);
  const ids = new Set(profiles.map((profile) => profile.id));
  if (ids.size !== profiles.length) throw new Error("Profiles index has duplicate profile ids");
  if (value.activeId !== null && !ids.has(value.activeId))
    throw new Error("Selected profile is missing");
  return { activeId: value.activeId, profiles };
}

export function parseProfileMeta(item: unknown): ProfileMeta {
  if (
    !isPlainObject(item) ||
    typeof item.id !== "string" ||
    !/^[0-9]+$/.test(item.id) ||
    typeof item.revision !== "number" ||
    !Number.isSafeInteger(item.revision) ||
    item.revision < 1 ||
    typeof item.name !== "string" ||
    !item.name.trim() ||
    item.name.length > 120 ||
    typeof item.url !== "string" ||
    typeof item.intervalHours !== "number" ||
    !Number.isSafeInteger(item.intervalHours) ||
    item.intervalHours < 0 ||
    item.intervalHours > MAX_PROFILE_INTERVAL_HOURS ||
    !isCanonicalIsoTimestamp(item.createdAt) ||
    !isCanonicalIsoTimestamp(item.updatedAt)
  )
    throw new Error("Profiles index has invalid profile metadata");
  if (item.url) {
    const url = new URL(item.url);
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new Error("Invalid profile URL");
  }
  let subInfo: SubscriptionUserinfo | undefined;
  if (item.subInfo !== undefined) {
    const info = item.subInfo;
    if (
      !isPlainObject(info) ||
      typeof info.upload !== "number" ||
      !Number.isFinite(info.upload) ||
      info.upload < 0 ||
      typeof info.download !== "number" ||
      !Number.isFinite(info.download) ||
      info.download < 0 ||
      typeof info.total !== "number" ||
      !Number.isFinite(info.total) ||
      info.total < 0 ||
      (info.expire !== undefined &&
        (typeof info.expire !== "number" || !Number.isFinite(info.expire) || info.expire < 0))
    )
      throw new Error("Invalid subscription quota");
    subInfo = {
      upload: info.upload,
      download: info.download,
      total: info.total,
      ...(typeof info.expire === "number" ? { expire: info.expire } : {}),
    };
  }
  if (item.homePage !== undefined) {
    if (typeof item.homePage !== "string") throw new Error("Invalid profile home page");
    const url = new URL(item.homePage);
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new Error("Invalid profile home page");
  }
  if (
    item.lastError !== undefined &&
    (typeof item.lastError !== "string" || item.lastError.length > 300)
  ) {
    throw new Error("Invalid profile update error");
  }
  if (
    (item.lastAttemptAt !== undefined && !isCanonicalIsoTimestamp(item.lastAttemptAt)) ||
    (item.failureCount !== undefined &&
      (typeof item.failureCount !== "number" ||
        !Number.isSafeInteger(item.failureCount) ||
        item.failureCount < 0 ||
        item.failureCount > 31 ||
        (item.failureCount > 0 && item.lastAttemptAt === undefined)))
  )
    throw new Error("Invalid profile retry metadata");
  return {
    id: item.id,
    revision: item.revision,
    name: item.name,
    url: item.url,
    intervalHours: item.intervalHours,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(subInfo ? { subInfo } : {}),
    ...(typeof item.homePage === "string" ? { homePage: item.homePage } : {}),
    ...(typeof item.lastError === "string" ? { lastError: item.lastError } : {}),
    ...(typeof item.lastAttemptAt === "string" ? { lastAttemptAt: item.lastAttemptAt } : {}),
    ...(typeof item.failureCount === "number" ? { failureCount: item.failureCount } : {}),
  };
}
