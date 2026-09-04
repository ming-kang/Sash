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
import { type SashSettings, sameSettings } from "./settings.js";

export class ProfileInputError extends Error {}

/** The rendered config.yaml failed validation; a server-side state problem, not bad request input. */
export class GeneratedConfigError extends Error {}
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

declare const preparedActiveConfigBrand: unique symbol;
export type PreparedActiveConfig = Readonly<{ [preparedActiveConfigBrand]: never }>;

declare const preparedActiveReloadBrand: unique symbol;
export type PreparedActiveReload = Readonly<{ [preparedActiveReloadBrand]: never }>;

export interface PreparedActivePublication {
  readonly config: GeneratedConfig;
  readonly rollback: PreparedActiveReload;
  readonly index?: ProfilesIndex;
  readonly profile?: Readonly<{ id: string; yamlText: string }>;
}

export interface PreparedActiveReloadPublication {
  readonly config: GeneratedConfig;
  readonly index: ProfilesIndex;
  readonly profile?: Readonly<{ id: string; yamlText: string }>;
}

export interface CommitPreparedActiveReloadOptions {
  reloadRuntime?: boolean;
  boundary?: "acquire" | "already-held";
}

export interface ReloadActiveOptions {
  reloadRuntime?: boolean;
}

type PreparedConfigResult = { readonly generated: GeneratedConfig } | { readonly error: unknown };

interface PreparedActiveConfigState {
  generated: GeneratedConfig;
  rollbackConfig: PreparedConfigResult;
  rollbackSettings: SashSettings;
  activeId: string | null;
  sourceDigest: string | null;
  active?: Pick<ProfileMeta, "id" | "url">;
  fetched?: SubscriptionFetch;
}

type PreparedActiveReloadState = PreparedConfigResult & {
  settings: SashSettings;
  activeId: string | null;
  sourceDigest: string | null;
  active?: ProfileMeta;
  fetched?: SubscriptionFetch;
};

interface ProfileSnapshot {
  profile: ProfileMeta;
  activeId: string | null;
  contentDigest: string | null;
}

interface ActiveProfileSource {
  activeId: string | null;
  active: ProfileMeta | null;
  sourceDigest: string | null;
  doc: Record<string, unknown> | null;
  fetched?: SubscriptionFetch;
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

function opaqueToken<T extends object>(): T {
  return Object.freeze({}) as T;
}

function replaceProfileMeta(index: ProfilesIndex, replacement: ProfileMeta): ProfilesIndex {
  return {
    ...index,
    profiles: index.profiles.map((profile) =>
      profile.id === replacement.id ? replacement : profile,
    ),
  };
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
  private readonly preparedActiveConfigs = new WeakMap<
    PreparedActiveConfig,
    PreparedActiveConfigState
  >();
  private readonly preparedActiveReloads = new WeakMap<
    PreparedActiveReload,
    PreparedActiveReloadState
  >();
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
    if (!sameSettings(this.getSettings(), snapshot)) {
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

  private updateSnapshot(
    profile: ProfileMeta,
    activeId: string | null,
    contentDigest = readProfileDigest(this.layout, profile.id),
  ): ProfileSnapshot {
    return { profile, activeId, contentDigest };
  }

  private recheckProfileSnapshot(
    index: ProfilesIndex,
    snapshot: ProfileSnapshot,
    contentMessage = "Profile content changed while preparing configuration",
  ): ProfileMeta {
    const profile = currentProfile(index, snapshot.profile, snapshot.activeId);
    this.assertProfileContentCurrent(profile.id, snapshot.contentDigest, contentMessage);
    return profile;
  }

  private async resolveActiveSource(index: ProfilesIndex): Promise<ActiveProfileSource> {
    const active = getActiveProfile(index);
    if (!active) {
      return {
        activeId: index.activeId,
        active: null,
        sourceDigest: null,
        doc: null,
      };
    }

    const stored = readProfileSource(this.layout, active.id);
    const fetched = stored === undefined && active.url ? await this.fetch(active.url) : undefined;
    if (stored === undefined && !fetched) {
      throw new ProfileInputError(`Local profile file is missing: ${active.id}`);
    }
    return {
      activeId: index.activeId,
      active,
      sourceDigest: stored?.digest ?? null,
      doc: fetched?.doc ?? stored?.doc ?? null,
      ...(fetched ? { fetched } : {}),
    };
  }

  private takePreparedActiveConfig(prepared: PreparedActiveConfig): PreparedActiveConfigState {
    const state = this.preparedActiveConfigs.get(prepared);
    if (!state) {
      throw new TypeError("Prepared active configuration is invalid or already consumed");
    }
    this.preparedActiveConfigs.delete(prepared);
    return state;
  }

  private takePreparedActiveReload(prepared: PreparedActiveReload): PreparedActiveReloadState {
    const state = this.preparedActiveReloads.get(prepared);
    if (!state) {
      throw new TypeError("Prepared active reload is invalid or already consumed");
    }
    this.preparedActiveReloads.delete(prepared);
    return state;
  }

  private preparedActiveReload(state: PreparedActiveReloadState): PreparedActiveReload {
    const prepared = opaqueToken<PreparedActiveReload>();
    this.preparedActiveReloads.set(prepared, state);
    return prepared;
  }

  /** Render and Core-validate a settings candidate outside the mutation lock. */
  async prepareActiveConfig(
    settings: SashSettings,
    rollbackSettings: SashSettings = this.settingsSnapshot(),
  ): Promise<PreparedActiveConfig> {
    const rollbackSnapshot = { ...rollbackSettings };
    const source = await this.resolveActiveSource(this.list());
    const generated = await this.prepare(source.doc, settings);
    let rollbackConfig: PreparedConfigResult;
    if (sameSettings(settings, rollbackSnapshot)) {
      rollbackConfig = { generated };
    } else {
      try {
        rollbackConfig = { generated: await this.prepare(source.doc, rollbackSnapshot) };
      } catch (error) {
        // A valid candidate must be able to repair an invalid current config.
        // Preserve the old preparation failure and surface it only if rollback
        // is actually required after the durable candidate transaction fails.
        rollbackConfig = { error };
      }
    }
    const prepared = opaqueToken<PreparedActiveConfig>();
    this.preparedActiveConfigs.set(prepared, {
      generated,
      rollbackConfig,
      rollbackSettings: rollbackSnapshot,
      activeId: source.activeId,
      sourceDigest: source.sourceDigest,
      ...(source.active ? { active: { id: source.active.id, url: source.active.url } } : {}),
      ...(source.fetched ? { fetched: source.fetched } : {}),
    });
    return prepared;
  }

  /** Recheck and lend one fixed-role settings publication inside the caller-owned boundary. */
  async withPreparedActivePublication<T>(
    prepared: PreparedActiveConfig,
    callback: (publication: PreparedActivePublication) => T | Promise<T>,
  ): Promise<T> {
    const state = this.takePreparedActiveConfig(prepared);
    this.assertSettingsUnchanged(state.rollbackSettings);
    const index = this.list();
    if (index.activeId !== state.activeId) {
      throw new ProfileConflictError("Active profile changed while preparing configuration");
    }

    let active: ProfileMeta | null = null;
    if (state.active) {
      active = getActiveProfile(index);
      if (!active || active.id !== state.active.id || active.url !== state.active.url) {
        throw new ProfileConflictError("Active profile changed while preparing configuration");
      }
      this.assertProfileContentCurrent(active.id, state.sourceDigest);
    }

    const rollback = this.preparedActiveReload({
      ...state.rollbackConfig,
      settings: state.rollbackSettings,
      activeId: index.activeId,
      sourceDigest: state.sourceDigest,
      ...(active ? { active } : {}),
      // The candidate transaction owns fetched profile publication. If that
      // transaction fails, rollback restores only the old generated config.
    });
    const publication: PreparedActivePublication =
      active && state.fetched
        ? {
            config: state.generated,
            rollback,
            index: replaceProfileMeta(index, withFetchedContent(active, state.fetched)),
            profile: { id: active.id, yamlText: state.fetched.yamlText },
          }
        : { config: state.generated, rollback };

    const result = await callback(publication);
    if (publication.profile) this.notifyChange();
    return result;
  }

  /** Prepare the strict current-settings reload path without owning the mutation boundary. */
  async prepareActiveReload(): Promise<PreparedActiveReload> {
    const source = await this.resolveActiveSource(this.list());
    const settings = this.settingsSnapshot();
    return this.preparedActiveReload({
      generated: await this.prepare(source.doc, settings),
      settings,
      activeId: source.activeId,
      sourceDigest: source.sourceDigest,
      ...(source.active ? { active: source.active } : {}),
      ...(source.fetched ? { fetched: source.fetched } : {}),
    });
  }

  /**
   * Recheck and lend one strict active-profile publication inside a caller-owned
   * mutation boundary. The one-shot capability is consumed before the callback.
   */
  async withPreparedActiveReloadPublication<T>(
    prepared: PreparedActiveReload,
    callback: (publication: PreparedActiveReloadPublication) => T | Promise<T>,
  ): Promise<T> {
    const state = this.takePreparedActiveReload(prepared);
    if ("error" in state) throw state.error;
    this.assertSettingsUnchanged(state.settings);
    const index = this.list();
    if (index.activeId !== state.activeId) {
      throw new ProfileConflictError("Active profile changed while preparing configuration");
    }

    let publication: PreparedActiveReloadPublication;
    if (!state.active) {
      publication = { config: state.generated, index };
    } else {
      const profile = this.recheckProfileSnapshot(
        index,
        this.updateSnapshot(state.active, state.activeId, state.sourceDigest),
      );
      const updated = state.fetched ? withFetchedContent(profile, state.fetched) : profile;
      publication = {
        config: state.generated,
        index: replaceProfileMeta(index, updated),
        ...(state.fetched ? { profile: { id: profile.id, yamlText: state.fetched.yamlText } } : {}),
      };
    }

    const result = await callback(publication);
    this.notifyChange();
    return result;
  }

  /** Commit an already-prepared strict reload, optionally inside a caller-owned boundary. */
  async commitPreparedActiveReload(
    prepared: PreparedActiveReload,
    options: CommitPreparedActiveReloadOptions = {},
  ): Promise<GeneratedConfig> {
    const reloadRuntime = options.reloadRuntime ?? true;
    const boundary = options.boundary ?? "acquire";
    if (boundary !== "acquire" && boundary !== "already-held") {
      throw new TypeError(`Unknown profile commit boundary: ${String(boundary)}`);
    }

    const action = () =>
      this.withPreparedActiveReloadPublication(prepared, async (publication) => {
        await this.publishTransaction(publication.index, {
          ...(publication.profile ? { profile: publication.profile } : {}),
          config: publication.config,
          reloadRuntime,
        });
        return publication.config;
      });

    return boundary === "acquire" ? this.commit("reload active profile", action) : action();
  }

  async reloadActive(options: ReloadActiveOptions = {}): Promise<GeneratedConfig> {
    return this.commitPreparedActiveReload(await this.prepareActiveReload(), options);
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
      throw new GeneratedConfigError((err as Error).message);
    }
    return generated;
  }

  private async publishTransaction(
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
  }

  private async publish(
    index: ProfilesIndex,
    opts: {
      profile?: { id: string; yamlText: string | null };
      config?: GeneratedConfig;
      reloadRuntime?: boolean;
    } = {},
  ): Promise<void> {
    await this.publishTransaction(index, opts);
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

  /** Return the stored YAML text of a profile for the dashboard editor. */
  readContent(id: string): { name: string; content: string } {
    const profile = this.list().profiles.find((item) => item.id === id);
    if (!profile) throw new ProfileNotFoundError(`profile not found: ${id}`);
    let content: string;
    try {
      content = fs.readFileSync(profileFilePath(this.layout, profile.id), "utf8");
    } catch {
      throw new ProfileNotFoundError(`profile file is missing: ${profile.id}`);
    }
    return { name: profile.name, content };
  }

  /**
   * Replace a profile's YAML text from the dashboard editor. The content is
   * untrusted input: it must parse and pass the core-format check, then the
   * merged config is Core-validated before publication. When the profile is
   * active, the new config is published and reloaded atomically.
   */
  async writeContent(id: string, content: string): Promise<ProfileUpdateResult> {
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
    const before = this.list();
    const target = before.profiles.find((item) => item.id === id);
    if (!target) throw new ProfileNotFoundError(`profile not found: ${id}`);
    const snapshot = this.updateSnapshot(target, before.activeId);
    const settings = this.settingsSnapshot();
    const prepared = await this.prepare(doc, settings);

    return this.commit("edit profile", async () => {
      this.assertSettingsUnchanged(settings);
      const index = this.list();
      const profile = this.recheckProfileSnapshot(index, snapshot, "Profile changed while editing");
      const updated: ProfileMeta = {
        ...profile,
        updatedAt: new Date().toISOString(),
        lastError: undefined,
      };
      const active = index.activeId === profile.id;
      await this.publish(
        {
          ...index,
          profiles: index.profiles.map((item) => (item.id === profile.id ? updated : item)),
        },
        {
          profile: { id: profile.id, yamlText: content },
          ...(active ? { config: prepared } : {}),
        },
      );
      return { profile: updated, ...(active ? { proxyCount: prepared.proxyCount } : {}) };
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
    snapshot: ProfileSnapshot,
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

  private async recordError(snapshot: ProfileSnapshot, error: string): Promise<void> {
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

  private async updateProfiles(profiles: ProfileSnapshot[]): Promise<ProfileUpdateAllResult> {
    type FetchResult =
      | { snapshot: ProfileSnapshot; fetched: SubscriptionFetch }
      | { snapshot: ProfileSnapshot; error: string };
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

  /**
   * Rename a profile. Display-only change: the YAML file name is the
   * timestamp id and the name never enters the generated core config, so no
   * reload is needed. Remote updates never overwrite the name (like Clash
   * Verge Rev), so a user-chosen name sticks.
   */
  async rename(id: string, name: string): Promise<{ profile: ProfileMeta }> {
    const trimmed = name.trim();
    if (!trimmed) throw new ProfileInputError("Missing required profile name");
    if (trimmed.length > 120) throw new ProfileInputError("Profile name is too long");

    return this.commit("rename profile", async () => {
      const index = this.list();
      const profile = index.profiles.find((item) => item.id === id);
      if (!profile) throw new ProfileNotFoundError(`profile not found: ${id}`);
      const updated: ProfileMeta = { ...profile, name: trimmed };
      await this.publish({
        ...index,
        profiles: index.profiles.map((item) => (item.id === id ? updated : item)),
      });
      return { profile: updated };
    });
  }
}
