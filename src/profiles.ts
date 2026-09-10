import fs from "node:fs";
import path from "node:path";
import { readState, type SashState } from "./app-state.js";
import { parseCoreYaml } from "./core-yaml.js";
import {
  asCoreConfigDocument,
  buildDefaultConfig,
  type GeneratedConfig,
  PROFILE_DOWNLOAD_SIZE_LIMIT,
  renderConfig,
} from "./mihomo-config.js";
import type { SashLayout } from "./paths.js";
import type { ProfileMeta, ProfilesIndex } from "./profile-model.js";

export type { ProfileMeta, ProfilesIndex } from "./profile-model.js";
export { DEFAULT_PROFILE_INTERVAL_HOURS, MAX_PROFILE_INTERVAL_HOURS } from "./profile-model.js";

export function profileFilePath(layout: SashLayout, id: string, revision: number): string {
  if (!/^[0-9]+$/.test(id) || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("Invalid profile id or revision");
  }
  return path.join(layout.profilesDir, id, `${revision}.yaml`);
}

/** The single validation point for profile text entering Sash from any source. */
export function parseProfileText(text: string): Record<string, unknown> {
  if (!text.trim() || Buffer.byteLength(text) > PROFILE_DOWNLOAD_SIZE_LIMIT) {
    throw new Error("Profile content must be non-empty and no larger than 8 MiB");
  }
  return asCoreConfigDocument(parseCoreYaml(text));
}

export function readProfileSource(
  layout: SashLayout,
  profile: Pick<ProfileMeta, "id" | "revision">,
): { doc: Record<string, unknown>; yamlText: string } {
  const file = profileFilePath(layout, profile.id, profile.revision);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > PROFILE_DOWNLOAD_SIZE_LIMIT)
    throw new Error("Profile must be a bounded regular file");
  const yamlText = fs.readFileSync(file, "utf8");
  return { yamlText, doc: parseProfileText(yamlText) };
}

export function loadProfiles(layout: SashLayout): ProfilesIndex {
  return readState(layout)?.profiles ?? { activeId: null, profiles: [] };
}

export function getActiveProfile(index: ProfilesIndex): ProfileMeta | null {
  return index.profiles.find((profile) => profile.id === index.activeId) ?? null;
}

export function renderActiveConfig(state: SashState, layout: SashLayout): GeneratedConfig {
  const active = getActiveProfile(state.profiles);
  return renderConfig(
    active ? readProfileSource(layout, active).doc : buildDefaultConfig(),
    state.settings,
    active ? "subscription" : "default",
  );
}

export function allocateProfileId(index: ProfilesIndex, layout: SashLayout): string {
  let id = BigInt(Date.now());
  while (
    index.profiles.some((profile) => profile.id === String(id)) ||
    fs.existsSync(path.join(layout.profilesDir, String(id)))
  )
    id += 1n;
  return String(id);
}

export function profileNameFromUrl(url: string): string {
  return new URL(url).hostname || "profile";
}

export function profileDueForUpdate(profile: ProfileMeta, nowMs = Date.now()): boolean {
  if (!profile.url || profile.intervalHours <= 0) return false;
  let dueAt = Date.parse(profile.updatedAt) + profile.intervalHours * 3_600_000;
  const failures = profile.failureCount ?? 0;
  if (failures > 0 && profile.lastAttemptAt) {
    const backoff = Math.min(24 * 3_600_000, 15 * 60_000 * 2 ** Math.min(failures - 1, 7));
    dueAt = Math.max(dueAt, Date.parse(profile.lastAttemptAt) + backoff);
  }
  return nowMs >= dueAt;
}
