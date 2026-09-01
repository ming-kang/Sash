import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import {
  commitManagedStateTransaction,
  defaultManagedStateFileOperations,
  type ManagedStateFileOperations,
} from "./managed-state-transaction.js";
import {
  buildDefaultConfig,
  isValidMihomoConfig,
  PROFILE_DOWNLOAD_SIZE_LIMIT,
  stripManagedKeys,
} from "./mihomo-config.js";
import type { SashLayout } from "./paths.js";
import {
  DEFAULT_PROFILE_INTERVAL_HOURS,
  findProfileByUrl,
  loadProfiles,
  NEVER_UPDATED,
  type ProfileMeta,
  type ProfilesIndex,
  profileFilePath,
  profileNameFromUrl,
} from "./profiles.js";
import type { SashSettings } from "./settings.js";

export const IMPORTED_CONFIG_PROFILE_NAME = "Imported config";

function nextProfileId(index: ProfilesIndex, layout: SashLayout): string {
  let id = String(Date.now());
  while (
    index.profiles.some((profile) => profile.id === id) ||
    fs.existsSync(profileFilePath(layout, id))
  ) {
    id = String(Number(id) + 1);
  }
  return id;
}

/** Migrate and permanently remove the legacy single-subscription settings key. */
export async function migrateLegacyProfileSetting(
  settings: SashSettings,
  layout: SashLayout,
  files: ManagedStateFileOperations = defaultManagedStateFileOperations,
): Promise<boolean> {
  if (!("subscriptionUrl" in settings)) return false;

  const candidate = { ...settings };
  const url = candidate.subscriptionUrl?.trim() ?? "";
  delete candidate.subscriptionUrl;

  let migratedIndex: ProfilesIndex | undefined;
  if (url) {
    const index = loadProfiles(layout);
    if (!findProfileByUrl(index, url)) {
      const now = new Date().toISOString();
      const profile: ProfileMeta = {
        id: nextProfileId(index, layout),
        name: profileNameFromUrl(url),
        url,
        intervalHours: DEFAULT_PROFILE_INTERVAL_HOURS,
        createdAt: now,
        updatedAt: NEVER_UPDATED,
      };
      migratedIndex = {
        activeId: index.activeId ?? profile.id,
        profiles: [...index.profiles, profile],
      };
    }
  }

  await commitManagedStateTransaction(
    layout,
    { ...(migratedIndex ? { index: migratedIndex } : {}), settings: candidate },
    undefined,
    files,
  );
  delete settings.subscriptionUrl;
  return true;
}

function hasMeaningfulRoutingContent(doc: Record<string, unknown>): boolean {
  const unmanaged = stripManagedKeys(doc);
  const defaultConfig = buildDefaultConfig();
  if (isDeepStrictEqual(unmanaged, defaultConfig)) return false;

  if (Array.isArray(unmanaged.proxies) && unmanaged.proxies.length > 0) return true;
  const providers = unmanaged["proxy-providers"];
  if (
    typeof providers === "object" &&
    providers !== null &&
    !Array.isArray(providers) &&
    Object.keys(providers).length > 0
  ) {
    return true;
  }
  const groups = unmanaged["proxy-groups"];
  if (
    Array.isArray(groups) &&
    groups.length > 0 &&
    !isDeepStrictEqual(groups, defaultConfig["proxy-groups"])
  ) {
    return true;
  }
  return (
    Array.isArray(unmanaged.rules) &&
    unmanaged.rules.length > 0 &&
    !isDeepStrictEqual(unmanaged.rules, defaultConfig.rules)
  );
}

/**
 * Import a pre-profile config.yaml exactly once. Call only while owning
 * mutation.lock, after managed-state recovery and legacy URL migration.
 *
 * With no provenance marker, only an absent profiles/index.json proves that
 * profile state has never been initialized. A present-but-empty index opts out.
 * The config must also contain non-default routing content after Sash-managed
 * operational keys are removed. Invalid candidates fail closed and are left
 * untouched; the existing config remains the runtime file after import.
 */
export async function migrateUnmanagedConfig(
  layout: SashLayout,
  files: ManagedStateFileOperations = defaultManagedStateFileOperations,
): Promise<boolean> {
  if (fs.existsSync(layout.profilesIndexFile) || !fs.existsSync(layout.configFile)) return false;

  const stat = fs.lstatSync(layout.configFile);
  if (!stat.isFile() || stat.size > PROFILE_DOWNLOAD_SIZE_LIMIT) {
    throw new Error(
      `Unmanaged config must be a regular file no larger than ${PROFILE_DOWNLOAD_SIZE_LIMIT} bytes: ${layout.configFile}`,
    );
  }
  const yamlText = fs.readFileSync(layout.configFile, "utf8");
  let doc: unknown;
  try {
    doc = YAML.parse(yamlText);
  } catch (err) {
    throw new Error(
      `Unmanaged config is invalid YAML and was left unchanged: ${layout.configFile}: ${(err as Error).message}`,
    );
  }
  if (!isValidMihomoConfig(doc)) {
    throw new Error(
      `Unmanaged config is not a valid core configuration and was left unchanged: ${layout.configFile}`,
    );
  }
  if (!hasMeaningfulRoutingContent(doc)) return false;

  const now = new Date().toISOString();
  const id = nextProfileId({ activeId: null, profiles: [] }, layout);
  const profile: ProfileMeta = {
    id,
    name: IMPORTED_CONFIG_PROFILE_NAME,
    url: "",
    intervalHours: 0,
    createdAt: now,
    updatedAt: now,
  };
  await commitManagedStateTransaction(
    layout,
    {
      index: { activeId: id, profiles: [profile] },
      profile: { id, yamlText },
    },
    undefined,
    files,
  );
  return true;
}

/** Recovery callers use this ordering so a legacy URL remains the canonical priority. */
export async function migrateProfileState(
  settings: SashSettings,
  layout: SashLayout,
  files: ManagedStateFileOperations = defaultManagedStateFileOperations,
): Promise<{ legacySubscription: boolean; unmanagedConfig: boolean }> {
  const legacySubscription = await migrateLegacyProfileSetting(settings, layout, files);
  const unmanagedConfig = await migrateUnmanagedConfig(layout, files);
  return { legacySubscription, unmanagedConfig };
}
