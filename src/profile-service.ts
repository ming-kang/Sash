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
  fetchSubscriptionProfile,
  type GeneratedConfig,
  isValidMihomoConfig,
  renderConfig,
  type SubscriptionFetch,
} from "./mihomo-config.js";
import type { SashLayout } from "./paths.js";
import {
  allocateProfileId,
  findProfileByUrl,
  getActiveProfile,
  loadProfiles,
  MAX_PROFILE_INTERVAL_HOURS,
  type ProfileMeta,
  type ProfilesIndex,
  profileDueForUpdate,
  profileFilePath,
  profileNameFromUrl,
  readProfileDigest,
  readProfileSource,
} from "./profiles.js";
import type { SashSettings } from "./settings.js";

export class ProfileInputError extends Error {}
export class ProfileNotFoundError extends Error {}
export class ProfileConflictError extends Error {}

export type ProfileCommitBoundary = <T>(
  purpose: string,
  action: () => T | Promise<T>,
) => Promise<T>;

export interface ProfileServiceOptions {
  layout: SashLayout;
  settings: () => SashSettings;
  fetchProfile?: (url: string) => Promise<SubscriptionFetch>;
  /** Validate the exact generated config before any file or runtime transition. */
  validateConfig?: (generated: GeneratedConfig) => Promise<void> | void;
  /** Reload the running core from configPath; omit when operating offline. */
  reloadConfig?: (configPath: string) => Promise<void>;
  /** Owns the short cross-process publication boundary when supplied. */
  commit?: ProfileCommitBoundary;
  /** Notifies the daemon after a durable profile/index publication. */
  onChange?: () => void;
  /** Injectable only for deterministic persistence-failure regression tests. */
  fileOperations?: ManagedStateFileOperations;
}

export interface ProfileActionResult {
  profile: ProfileMeta;
  activated: boolean;
  proxyCount?: number;
}

export interface ProfileUpdateResult {
  profile: ProfileMeta;
  proxyCount?: number;
}

export interface ProfileUpdateAllResult {
  updated: number;
  failed: Array<{ id: string; name: string; error: string }>;
  proxyCount?: number;
}

/** Candidate active configuration prepared without entering the commit boundary. */
export interface PreparedActiveConfig {
  generated: GeneratedConfig;
  activeId: string | null;
  sourceDigest: string | null;
  active?: Pick<ProfileMeta, "id" | "url">;
  fetched?: SubscriptionFetch;
}

interface ProfileUpdateSnapshot {
  profile: ProfileMeta;
  activeId: string | null;
  contentDigest: string | null;
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item);
    }
  });
  await Promise.all(runners);
  return results;
}

function sameProfileState(before: ProfilesIndex, current: ProfilesIndex): boolean {
  return isDeepStrictEqual(before, current);
}

function currentProfile(
  index: ProfilesIndex,
  snapshot: ProfileMeta,
  activeId: string | null,
): ProfileMeta {
  const profile = index.profiles.find((item) => item.id === snapshot.id);
  if (!profile || !isDeepStrictEqual(profile, snapshot) || index.activeId !== activeId) {
    throw new ProfileConflictError(`profile changed or was removed during update: ${snapshot.id}`);
  }
  return profile;
}

function validFetchedInterval(value: number | undefined, fallback: number): number {
  return value !== undefined &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_PROFILE_INTERVAL_HOURS
    ? value
    : fallback;
}

function withFetchedContent(profile: ProfileMeta, fetched: SubscriptionFetch): ProfileMeta {
  return {
    ...profile,
    updatedAt: new Date().toISOString(),
    ...(fetched.subInfo ? { subInfo: fetched.subInfo } : {}),
    ...(fetched.homePage ? { homePage: fetched.homePage } : {}),
    intervalHours: validFetchedInterval(fetched.intervalHours, profile.intervalHours),
    lastError: undefined,
  };
}

/** Canonical application layer for profile/config publication transactions. */
export class ProfileService {
  private readonly layout: SashLayout;
  private readonly getSettings: () => SashSettings;
  private readonly fetchProfileFn: (url: string) => Promise<SubscriptionFetch>;
  private readonly validateConfig?: (generated: GeneratedConfig) => Promise<void> | void;
  private readonly reloadConfig?: (configPath: string) => Promise<void>;
  private readonly commitBoundary?: ProfileCommitBoundary;
  private readonly onChange?: () => void;
  private readonly files: ManagedStateFileOperations;
  private readonly fetches = new Map<string, Promise<SubscriptionFetch>>();
  private commitTail: Promise<void> = Promise.resolve();

  constructor(opts: ProfileServiceOptions) {
    this.layout = opts.layout;
    this.getSettings = opts.settings;
    this.fetchProfileFn = opts.fetchProfile ?? fetchSubscriptionProfile;
    this.validateConfig = opts.validateConfig;
    this.reloadConfig = opts.reloadConfig;
    this.commitBoundary = opts.commit;
    this.onChange = opts.onChange;
    this.files = opts.fileOperations ?? defaultManagedStateFileOperations;
  }

  list(): ProfilesIndex {
    return loadProfiles(this.layout);
  }

  active(): ProfileMeta | null {
    return getActiveProfile(this.list());
  }

  private commit<T>(purpose: string, action: () => Promise<T>): Promise<T> {
    if (this.commitBoundary) return this.commitBoundary(purpose, action);
    const next = this.commitTail.then(action, action);
    this.commitTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private fetch(url: string): Promise<SubscriptionFetch> {
    const existing = this.fetches.get(url);
    if (existing) return existing;
    const pending = this.fetchProfileFn(url).finally(() => {
      if (this.fetches.get(url) === pending) this.fetches.delete(url);
    });
    this.fetches.set(url, pending);
    return pending;
  }

  private settingsSnapshot(): SashSettings {
    return { ...this.getSettings() };
  }

  private assertSettingsUnchanged(snapshot: SashSettings): void {
    if (JSON.stringify(this.getSettings()) !== JSON.stringify(snapshot)) {
      throw new ProfileConflictError("Settings changed while preparing profile configuration");
    }
  }

  private assertProfileContentCurrent(
    id: string,
    digest: string | null,
    message = "Profile content changed while preparing configuration",
  ): void {
    if (readProfileDigest(this.layout, id) !== digest) {
      throw new ProfileConflictError(`${message}: ${id}`);
    }
  }

  private updateSnapshot(profile: ProfileMeta, activeId: string | null): ProfileUpdateSnapshot {
    return {
      profile,
      activeId,
      contentDigest: readProfileDigest(this.layout, profile.id),
    };
  }

  /** Render and Core-validate an active candidate outside the mutation lock. */
  async prepareActiveConfig(settings: SashSettings): Promise<PreparedActiveConfig> {
    const index = this.list();
    const active = getActiveProfile(index);
    const stored = active ? readProfileSource(this.layout, active.id) : undefined;
    const fetched =
      active && stored === undefined && active.url ? await this.fetch(active.url) : undefined;
    if (active && stored === undefined && !fetched) {
      throw new ProfileInputError(`Local profile file is missing: ${active.id}`);
    }
    return {
      generated: await this.prepare(fetched?.doc ?? stored?.doc ?? null, settings),
      activeId: index.activeId,
      sourceDigest: stored?.digest ?? null,
      ...(active ? { active: { id: active.id, url: active.url } } : {}),
      ...(fetched ? { fetched } : {}),
    };
  }

  /** Recheck the active source after an out-of-lock settings preparation. */
  assertPreparedActiveCurrent(prepared: PreparedActiveConfig): void {
    const index = this.list();
    if (index.activeId !== prepared.activeId) {
      throw new ProfileConflictError("Active profile changed while preparing configuration");
    }
    if (prepared.active) {
      const active = getActiveProfile(index);
      if (!active || active.id !== prepared.active.id || active.url !== prepared.active.url) {
        throw new ProfileConflictError("Active profile changed while preparing configuration");
      }
      this.assertProfileContentCurrent(active.id, prepared.sourceDigest);
    }
  }

  /** Materialize a fetched missing-profile candidate after the commit recheck. */
  preparedActivePublication(prepared: PreparedActiveConfig): {
    index?: ProfilesIndex;
    profile?: { id: string; yamlText: string };
  } {
    if (!prepared.active || !prepared.fetched) return {};
    const index = this.list();
    const active = getActiveProfile(index);
    if (!active || active.id !== prepared.active.id || active.url !== prepared.active.url) {
      throw new ProfileConflictError("Active profile changed while preparing configuration");
    }
    this.assertProfileContentCurrent(active.id, prepared.sourceDigest);
    const updated = withFetchedContent(active, prepared.fetched);
    return {
      index: {
        ...index,
        profiles: index.profiles.map((profile) => (profile.id === updated.id ? updated : profile)),
      },
      profile: { id: updated.id, yamlText: prepared.fetched.yamlText },
    };
  }

  /** Notify observers when SettingsService published fetched profile content. */
  notifyPreparedActivePublished(prepared: PreparedActiveConfig): void {
    if (prepared.fetched) this.notifyChange();
  }

  private notifyChange(): void {
    try {
      this.onChange?.();
    } catch {
      // An in-memory observer must never turn a durable commit into a failure.
    }
  }

  private async prepare(
    doc: Record<string, unknown> | null,
    settings: SashSettings,
  ): Promise<GeneratedConfig> {
    const generated = renderConfig(
      doc ?? buildDefaultConfig(),
      settings,
      doc ? "subscription" : "default",
    );
    try {
      await this.validateConfig?.(generated);
    } catch (err) {
      throw new ProfileInputError((err as Error).message);
    }
    return generated;
  }

  private async publish(
    index: ProfilesIndex,
    opts: {
      profile?: { id: string; yamlText: string | null };
      config?: GeneratedConfig;
      reloadRuntime?: boolean;
    } = {},
  ): Promise<void> {
    await commitManagedStateTransaction(
      this.layout,
      { index, ...opts },
      this.reloadConfig,
      this.files,
    );
    this.notifyChange();
  }

  async addRemote(
    url: string,
    opts: { name?: string; activate?: boolean } = {},
  ): Promise<ProfileActionResult> {
    const normalizedUrl = url.trim();
    if (!normalizedUrl) throw new ProfileInputError("Missing required profile URL");
    const before = this.list();
    const settings = this.settingsSnapshot();
    const known = findProfileByUrl(before, normalizedUrl);
    const knownDigest = known ? readProfileDigest(this.layout, known.id) : null;
    const fetched = await this.fetch(normalizedUrl);
    const prepared = await this.prepare(fetched.doc, settings);

    return this.commit("add profile", async () => {
      this.assertSettingsUnchanged(settings);
      const current = this.list();
      let profile: ProfileMeta;
      let profileChange: { id: string; yamlText: string };
      if (known) {
        const existing = currentProfile(current, known, before.activeId);
        this.assertProfileContentCurrent(
          existing.id,
          knownDigest,
          "Profile changed while updating",
        );
        profile = withFetchedContent(existing, fetched);
        profileChange = { id: profile.id, yamlText: fetched.yamlText };
      } else {
        if (!sameProfileState(before, current) || findProfileByUrl(current, normalizedUrl)) {
          throw new ProfileConflictError("Profiles changed while adding a remote profile");
        }
        const id = allocateProfileId(current, this.layout);
        const now = new Date().toISOString();
        profile = {
          id,
          name: opts.name?.trim() || fetched.name || profileNameFromUrl(normalizedUrl),
          url: normalizedUrl,
          intervalHours: validFetchedInterval(fetched.intervalHours, 24),
          createdAt: now,
          updatedAt: now,
          ...(fetched.subInfo ? { subInfo: fetched.subInfo } : {}),
          ...(fetched.homePage ? { homePage: fetched.homePage } : {}),
        };
        profileChange = { id, yamlText: fetched.yamlText };
      }
      const shouldActivate = opts.activate === true || current.activeId === null;
      const index: ProfilesIndex = {
        activeId: shouldActivate ? profile.id : current.activeId,
        profiles: known
          ? current.profiles.map((item) => (item.id === profile.id ? profile : item))
          : [...current.profiles, profile],
      };
      await this.publish(index, {
        profile: profileChange,
        ...(shouldActivate ? { config: prepared } : {}),
      });
      return {
        profile,
        activated: shouldActivate,
        ...(shouldActivate ? { proxyCount: prepared.proxyCount } : {}),
      };
    });
  }

  async importLocal(name: string, content: string): Promise<ProfileActionResult> {
    if (!content.trim()) throw new ProfileInputError("Missing required profile content");
    let doc: unknown;
    try {
      doc = YAML.parse(content);
    } catch (err) {
      throw new ProfileInputError(`Content is not valid YAML: ${(err as Error).message}`);
    }
    if (!isValidMihomoConfig(doc)) {
      throw new ProfileInputError(
        "Content is not a valid core configuration (missing proxies/rules)",
      );
    }
    const settings = this.settingsSnapshot();
    const prepared = await this.prepare(doc, settings);
    const before = this.list();

    return this.commit("import profile", async () => {
      this.assertSettingsUnchanged(settings);
      const current = this.list();
      if (!sameProfileState(before, current)) {
        throw new ProfileConflictError("Profiles changed while importing a local profile");
      }
      const id = allocateProfileId(current, this.layout);
      const now = new Date().toISOString();
      const profile: ProfileMeta = {
        id,
        name: name.trim() || "imported",
        url: "",
        intervalHours: 0,
        createdAt: now,
        updatedAt: now,
      };
      const activated = current.activeId === null;
      await this.publish(
        { activeId: activated ? id : current.activeId, profiles: [...current.profiles, profile] },
        {
          profile: { id, yamlText: content },
          ...(activated ? { config: prepared } : {}),
        },
      );
      return { profile, activated, ...(activated ? { proxyCount: prepared.proxyCount } : {}) };
    });
  }

  async activate(id: string | null): Promise<{ activeId: string | null; proxyCount: number }> {
    const before = this.list();
    const settings = this.settingsSnapshot();
    if (id === null) {
      const prepared = await this.prepare(null, settings);
      return this.commit("deselect profile", async () => {
        this.assertSettingsUnchanged(settings);
        const current = this.list();
        if (current.activeId !== before.activeId) {
          throw new ProfileConflictError("Active profile changed while preparing configuration");
        }
        await this.publish({ ...current, activeId: null }, { config: prepared });
        return { activeId: null, proxyCount: prepared.proxyCount };
      });
    }

    const initial = before.profiles.find((profile) => profile.id === id);
    if (!initial) throw new ProfileNotFoundError(`profile not found: ${id}`);
    const stored = readProfileSource(this.layout, id);
    const fetched = stored === undefined && initial.url ? await this.fetch(initial.url) : undefined;
    if (stored === undefined && !fetched) {
      throw new ProfileInputError(`Local profile file is missing: ${id}`);
    }
    const sourceDigest = stored?.digest ?? null;
    const prepared = await this.prepare(fetched?.doc ?? stored?.doc ?? null, settings);

    return this.commit("activate profile", async () => {
      this.assertSettingsUnchanged(settings);
      const current = this.list();
      const profile = currentProfile(current, initial, before.activeId);
      this.assertProfileContentCurrent(profile.id, sourceDigest);
      const updated = fetched ? withFetchedContent(profile, fetched) : profile;
      await this.publish(
        {
          activeId: id,
          profiles: current.profiles.map((item) => (item.id === id ? updated : item)),
        },
        {
          ...(fetched ? { profile: { id, yamlText: fetched.yamlText } } : {}),
          config: prepared,
        },
      );
      return { activeId: id, proxyCount: prepared.proxyCount };
    });
  }

  private async commitFetched(
    snapshot: ProfileUpdateSnapshot,
    fetched: SubscriptionFetch,
  ): Promise<ProfileUpdateResult> {
    const settings = this.settingsSnapshot();
    const prepared = await this.prepare(fetched.doc, settings);
    return this.commit("update profile", async () => {
      this.assertSettingsUnchanged(settings);
      const index = this.list();
      const current = currentProfile(index, snapshot.profile, snapshot.activeId);
      this.assertProfileContentCurrent(
        current.id,
        snapshot.contentDigest,
        "Profile changed while updating",
      );
      const profile = withFetchedContent(current, fetched);
      const active = index.activeId === current.id;
      await this.publish(
        {
          ...index,
          profiles: index.profiles.map((item) => (item.id === current.id ? profile : item)),
        },
        {
          profile: { id: current.id, yamlText: fetched.yamlText },
          ...(active ? { config: prepared } : {}),
        },
      );
      return { profile, ...(active ? { proxyCount: prepared.proxyCount } : {}) };
    });
  }

  private async recordError(snapshot: ProfileUpdateSnapshot, error: string): Promise<void> {
    await this.commit("record profile update error", async () => {
      const index = this.list();
      let current: ProfileMeta;
      try {
        current = currentProfile(index, snapshot.profile, snapshot.activeId);
        this.assertProfileContentCurrent(
          current.id,
          snapshot.contentDigest,
          "Profile changed while recording an update error",
        );
      } catch (err) {
        if (err instanceof ProfileConflictError) return;
        throw err;
      }
      const profile = { ...current, lastError: error.slice(0, 300) };
      await this.publish({
        ...index,
        profiles: index.profiles.map((item) => (item.id === current.id ? profile : item)),
      });
    });
  }

  async update(id: string): Promise<ProfileUpdateResult> {
    const index = this.list();
    const profile = index.profiles.find((item) => item.id === id);
    if (!profile) throw new ProfileNotFoundError(`profile not found: ${id}`);
    if (!profile.url) throw new ProfileInputError("Local profile has no URL to update from");
    const snapshot = this.updateSnapshot(profile, index.activeId);
    try {
      return await this.commitFetched(snapshot, await this.fetch(profile.url));
    } catch (err) {
      await this.recordError(snapshot, (err as Error).message);
      throw err;
    }
  }

  private async updateProfiles(profiles: ProfileUpdateSnapshot[]): Promise<ProfileUpdateAllResult> {
    type FetchResult =
      | { snapshot: ProfileUpdateSnapshot; fetched: SubscriptionFetch }
      | { snapshot: ProfileUpdateSnapshot; error: string };
    const fetched = await mapConcurrent(profiles, 4, async (snapshot): Promise<FetchResult> => {
      try {
        return { snapshot, fetched: await this.fetch(snapshot.profile.url) };
      } catch (err) {
        return { snapshot, error: (err as Error).message };
      }
    });

    let updated = 0;
    let proxyCount: number | undefined;
    const failed: ProfileUpdateAllResult["failed"] = [];
    for (const result of fetched) {
      const { profile } = result.snapshot;
      if (!("fetched" in result)) {
        await this.recordError(result.snapshot, result.error);
        failed.push({ id: profile.id, name: profile.name, error: result.error });
        continue;
      }
      try {
        const committed = await this.commitFetched(result.snapshot, result.fetched);
        updated += 1;
        if (committed.proxyCount !== undefined) proxyCount = committed.proxyCount;
      } catch (err) {
        const message = (err as Error).message;
        await this.recordError(result.snapshot, message);
        failed.push({ id: profile.id, name: profile.name, error: message });
      }
    }
    return { updated, failed, ...(proxyCount !== undefined ? { proxyCount } : {}) };
  }

  async updateAll(): Promise<ProfileUpdateAllResult> {
    const index = this.list();
    return this.updateProfiles(
      index.profiles
        .filter((profile) => profile.url !== "")
        .map((profile) => this.updateSnapshot(profile, index.activeId)),
    );
  }

  async updateDue(nowMs = Date.now()): Promise<ProfileUpdateAllResult> {
    const index = this.list();
    return this.updateProfiles(
      index.profiles
        .filter((profile) => {
          let exists = false;
          try {
            exists = fs.existsSync(profileFilePath(this.layout, profile.id));
          } catch {
            // An invalid id is rejected when the index is loaded; retain this guard for I/O errors.
          }
          return profileDueForUpdate(profile, exists, nowMs);
        })
        .map((profile) => this.updateSnapshot(profile, index.activeId)),
    );
  }

  async remove(id: string): Promise<{ wasActive: boolean; proxyCount?: number }> {
    const before = this.list();
    const initial = before.profiles.find((profile) => profile.id === id);
    if (!initial) throw new ProfileNotFoundError(`profile not found: ${id}`);
    const sourceDigest = readProfileDigest(this.layout, id);
    const settings = this.settingsSnapshot();
    const prepared = before.activeId === id ? await this.prepare(null, settings) : undefined;

    return this.commit("remove profile", async () => {
      this.assertSettingsUnchanged(settings);
      const index = this.list();
      const profile = currentProfile(index, initial, before.activeId);
      this.assertProfileContentCurrent(profile.id, sourceDigest, "Profile changed while deleting");
      const wasActive = index.activeId === profile.id;
      await this.publish(
        {
          activeId: wasActive ? null : index.activeId,
          profiles: index.profiles.filter((item) => item.id !== id),
        },
        {
          profile: { id, yamlText: null },
          ...(prepared ? { config: prepared } : {}),
        },
      );
      return { wasActive, ...(prepared ? { proxyCount: prepared.proxyCount } : {}) };
    });
  }

  /** `commit` is false only for callers which already own the mutation boundary. */
  async reloadActive(reloadRuntime = true, commit = true): Promise<GeneratedConfig> {
    const before = this.list();
    const active = getActiveProfile(before);
    const stored = active ? readProfileSource(this.layout, active.id) : undefined;
    const fetched =
      active && stored === undefined && active.url ? await this.fetch(active.url) : undefined;
    if (active && stored === undefined && !fetched) {
      throw new ProfileInputError(`Local profile file is missing: ${active.id}`);
    }
    const sourceDigest = stored?.digest ?? null;
    const settings = this.settingsSnapshot();
    const generated = await this.prepare(fetched?.doc ?? stored?.doc ?? null, settings);
    const action = async (): Promise<GeneratedConfig> => {
      this.assertSettingsUnchanged(settings);
      const index = this.list();
      if (index.activeId !== before.activeId) {
        throw new ProfileConflictError("Active profile changed while preparing configuration");
      }
      if (!active) {
        await this.publish(index, { config: generated, reloadRuntime });
        return generated;
      }
      const profile = currentProfile(index, active, before.activeId);
      this.assertProfileContentCurrent(profile.id, sourceDigest);
      const updated = fetched ? withFetchedContent(profile, fetched) : profile;
      await this.publish(
        {
          ...index,
          profiles: index.profiles.map((item) => (item.id === profile.id ? updated : item)),
        },
        {
          ...(fetched ? { profile: { id: profile.id, yamlText: fetched.yamlText } } : {}),
          config: generated,
          reloadRuntime,
        },
      );
      return generated;
    };
    return commit ? this.commit("reload active profile", action) : action();
  }
}
