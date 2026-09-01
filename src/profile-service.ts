import fs from "node:fs";
import YAML from "yaml";
import { atomicWriteFileSync } from "./fs-atomic.js";
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
  addProfile,
  applySubscriptionFetch,
  findProfileByUrl,
  getActiveProfile,
  loadProfiles,
  type ProfileMeta,
  type ProfilesIndex,
  profileDueForUpdate,
  profileFilePath,
  profileNameFromUrl,
  readProfileDoc,
  recordProfileError,
  removeProfile,
  setActiveProfile,
} from "./profiles.js";
import type { SashSettings } from "./settings.js";

interface FileSnapshot {
  path: string;
  data: Buffer | null;
}

export class ProfileInputError extends Error {}
export class ProfileNotFoundError extends Error {}
export class ProfileConflictError extends Error {}

export interface ProfileServiceOptions {
  layout: SashLayout;
  settings: () => SashSettings;
  fetchProfile?: (url: string) => Promise<SubscriptionFetch>;
  /** Reload the running core from configPath; omit when operating offline. */
  reloadConfig?: (configPath: string) => Promise<void>;
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

function snapshotFiles(paths: string[]): FileSnapshot[] {
  return [...new Set(paths)].map((file) => ({
    path: file,
    data: fs.existsSync(file) ? fs.readFileSync(file) : null,
  }));
}

function restoreFiles(snapshots: FileSnapshot[]): void {
  for (const snapshot of snapshots) {
    if (snapshot.data === null) {
      fs.rmSync(snapshot.path, { force: true });
    } else {
      atomicWriteFileSync(snapshot.path, snapshot.data);
    }
  }
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

/** Canonical application layer for all profile mutations and config transitions. */
export class ProfileService {
  private readonly layout: SashLayout;
  private readonly getSettings: () => SashSettings;
  private readonly fetchProfileFn: (url: string) => Promise<SubscriptionFetch>;
  private readonly reloadConfig?: (configPath: string) => Promise<void>;
  private readonly fetches = new Map<string, Promise<SubscriptionFetch>>();
  private commitTail: Promise<void> = Promise.resolve();

  constructor(opts: ProfileServiceOptions) {
    this.layout = opts.layout;
    this.getSettings = opts.settings;
    this.fetchProfileFn = opts.fetchProfile ?? fetchSubscriptionProfile;
    this.reloadConfig = opts.reloadConfig;
  }

  list(): ProfilesIndex {
    return loadProfiles(this.layout);
  }

  active(): ProfileMeta | null {
    return getActiveProfile(this.list());
  }

  private async exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.commitTail.then(operation, operation);
    this.commitTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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

  private render(doc: Record<string, unknown> | null): GeneratedConfig {
    return renderConfig(
      doc ?? buildDefaultConfig(),
      this.getSettings(),
      doc ? "subscription" : "default",
    );
  }

  private async transitionConfig<T>(
    generated: GeneratedConfig,
    mutate: () => T,
    statePaths: string[],
    reloadRuntime = true,
  ): Promise<T> {
    const configSnapshot = snapshotFiles([this.layout.configFile]);
    const stateSnapshots = snapshotFiles(statePaths);
    atomicWriteFileSync(this.layout.configFile, generated.yaml);
    let reloadAttempted = false;
    try {
      if (reloadRuntime && this.reloadConfig) {
        reloadAttempted = true;
        await this.reloadConfig(this.layout.configFile);
      }
      return mutate();
    } catch (err) {
      restoreFiles(stateSnapshots);
      restoreFiles(configSnapshot);
      if (
        reloadRuntime &&
        this.reloadConfig &&
        reloadAttempted &&
        configSnapshot[0]?.data !== null
      ) {
        try {
          await this.reloadConfig(this.layout.configFile);
        } catch (rollbackErr) {
          throw new Error(
            `${(err as Error).message}; config rollback reload failed: ${(rollbackErr as Error).message}`,
          );
        }
      }
      throw err;
    }
  }

  private async activatePrepared(
    id: string | null,
    doc: Record<string, unknown> | null,
  ): Promise<{ activeId: string | null; proxyCount: number }> {
    const generated = this.render(doc);
    await this.transitionConfig(generated, () => setActiveProfile(id, this.layout), [
      this.layout.profilesIndexFile,
    ]);
    return { activeId: id, proxyCount: generated.proxyCount };
  }

  async addRemote(
    url: string,
    opts: { name?: string; activate?: boolean } = {},
  ): Promise<ProfileActionResult> {
    const normalizedUrl = url.trim();
    if (!normalizedUrl) throw new ProfileInputError("Missing required profile URL");
    const fetched = await this.fetch(normalizedUrl);

    return this.exclusive(async () => {
      const before = this.list();
      const existing = findProfileByUrl(before, normalizedUrl);
      let profile: ProfileMeta;
      if (existing) {
        if (before.activeId === existing.id) {
          const generated = this.render(fetched.doc);
          const next = await this.transitionConfig(
            generated,
            () => applySubscriptionFetch(existing.id, fetched, this.layout),
            [this.layout.profilesIndexFile, profileFilePath(this.layout, existing.id)],
          );
          const updated = next.profiles.find((item) => item.id === existing.id);
          if (!updated) throw new ProfileNotFoundError(`profile not found: ${existing.id}`);
          profile = updated;
        } else {
          const next = applySubscriptionFetch(existing.id, fetched, this.layout);
          const updated = next.profiles.find((item) => item.id === existing.id);
          if (!updated) throw new ProfileNotFoundError(`profile not found: ${existing.id}`);
          profile = updated;
        }
      } else {
        profile = addProfile(
          {
            name: opts.name?.trim() || fetched.name || profileNameFromUrl(normalizedUrl),
            url: normalizedUrl,
            yamlText: fetched.yamlText,
            ...(fetched.intervalHours !== undefined
              ? { intervalHours: fetched.intervalHours }
              : {}),
            ...(fetched.subInfo ? { subInfo: fetched.subInfo } : {}),
            ...(fetched.homePage ? { homePage: fetched.homePage } : {}),
          },
          this.layout,
        ).profile;
      }

      const shouldActivate = opts.activate === true || before.activeId === null;
      if (shouldActivate && this.list().activeId !== profile.id) {
        await this.activatePrepared(profile.id, fetched.doc);
      }
      const activated = this.list().activeId === profile.id;
      return {
        profile,
        activated,
        ...(activated ? { proxyCount: this.render(fetched.doc).proxyCount } : {}),
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

    return this.exclusive(async () => {
      const before = this.list();
      const profile = addProfile(
        { name: name.trim() || "imported", url: "", yamlText: content, intervalHours: 0 },
        this.layout,
      ).profile;
      if (before.activeId === null) await this.activatePrepared(profile.id, doc);
      const activated = this.list().activeId === profile.id;
      return {
        profile,
        activated,
        ...(activated ? { proxyCount: this.render(doc).proxyCount } : {}),
      };
    });
  }

  async activate(id: string | null): Promise<{ activeId: string | null; proxyCount: number }> {
    if (id === null) {
      return this.exclusive(() => this.activatePrepared(null, null));
    }

    const initial = this.list().profiles.find((profile) => profile.id === id);
    if (!initial) throw new ProfileNotFoundError(`profile not found: ${id}`);
    let fetched: SubscriptionFetch | undefined;
    const initialDoc = readProfileDoc(this.layout, id);
    if (initialDoc === undefined) {
      if (!initial.url) throw new ProfileInputError(`Local profile file is missing: ${id}`);
      fetched = await this.fetch(initial.url);
    }

    return this.exclusive(async () => {
      const current = this.list().profiles.find((profile) => profile.id === id);
      if (!current) throw new ProfileNotFoundError(`profile not found: ${id}`);
      if (fetched) applySubscriptionFetch(id, fetched, this.layout);
      const doc = fetched?.doc ?? readProfileDoc(this.layout, id);
      if (doc === undefined) throw new ProfileInputError(`Profile file is missing: ${id}`);
      return this.activatePrepared(id, doc);
    });
  }

  private async commitFetched(
    snapshot: ProfileMeta,
    fetched: SubscriptionFetch,
  ): Promise<ProfileUpdateResult> {
    return this.exclusive(async () => {
      const index = this.list();
      const current = index.profiles.find((profile) => profile.id === snapshot.id);
      if (!current || current.url !== snapshot.url) {
        throw new ProfileConflictError(
          `profile changed or was removed during update: ${snapshot.id}`,
        );
      }
      let next: ProfilesIndex;
      let proxyCount: number | undefined;
      if (index.activeId === current.id) {
        const generated = this.render(fetched.doc);
        next = await this.transitionConfig(
          generated,
          () => applySubscriptionFetch(current.id, fetched, this.layout),
          [this.layout.profilesIndexFile, profileFilePath(this.layout, current.id)],
        );
        proxyCount = generated.proxyCount;
      } else {
        next = applySubscriptionFetch(current.id, fetched, this.layout);
      }
      const profile = next.profiles.find((item) => item.id === current.id);
      if (!profile) throw new Error(`profile not found after update: ${current.id}`);
      return { profile, ...(proxyCount !== undefined ? { proxyCount } : {}) };
    });
  }

  async update(id: string): Promise<ProfileUpdateResult> {
    const profile = this.list().profiles.find((item) => item.id === id);
    if (!profile) throw new ProfileNotFoundError(`profile not found: ${id}`);
    if (!profile.url) throw new ProfileInputError("Local profile has no URL to update from");
    try {
      return await this.commitFetched(profile, await this.fetch(profile.url));
    } catch (err) {
      await this.exclusive(() => recordProfileError(id, (err as Error).message, this.layout));
      throw err;
    }
  }

  private async updateProfiles(profiles: ProfileMeta[]): Promise<ProfileUpdateAllResult> {
    type FetchResult =
      | { profile: ProfileMeta; fetched: SubscriptionFetch }
      | { profile: ProfileMeta; error: string };
    const fetched = await mapConcurrent<ProfileMeta, FetchResult>(profiles, 4, async (profile) => {
      try {
        return { profile, fetched: await this.fetch(profile.url) } as const;
      } catch (err) {
        return { profile, error: (err as Error).message } as const;
      }
    });

    let updated = 0;
    let proxyCount: number | undefined;
    const failed: ProfileUpdateAllResult["failed"] = [];
    for (const result of fetched) {
      if (!("fetched" in result)) {
        await this.exclusive(() =>
          recordProfileError(result.profile.id, result.error, this.layout),
        );
        failed.push({ id: result.profile.id, name: result.profile.name, error: result.error });
        continue;
      }
      try {
        const committed = await this.commitFetched(result.profile, result.fetched);
        updated += 1;
        if (committed.proxyCount !== undefined) proxyCount = committed.proxyCount;
      } catch (err) {
        const message = (err as Error).message;
        await this.exclusive(() => recordProfileError(result.profile.id, message, this.layout));
        failed.push({ id: result.profile.id, name: result.profile.name, error: message });
      }
    }
    return { updated, failed, ...(proxyCount !== undefined ? { proxyCount } : {}) };
  }

  async updateAll(): Promise<ProfileUpdateAllResult> {
    return this.updateProfiles(this.list().profiles.filter((profile) => profile.url !== ""));
  }

  async updateDue(nowMs = Date.now()): Promise<ProfileUpdateAllResult> {
    const due = this.list().profiles.filter((profile) => {
      let exists = false;
      try {
        exists = fs.existsSync(profileFilePath(this.layout, profile.id));
      } catch {
        exists = false;
      }
      return profileDueForUpdate(profile, exists, nowMs);
    });
    return this.updateProfiles(due);
  }

  async remove(id: string): Promise<{ wasActive: boolean; proxyCount?: number }> {
    return this.exclusive(async () => {
      const index = this.list();
      const profile = index.profiles.find((item) => item.id === id);
      if (!profile) throw new ProfileNotFoundError(`profile not found: ${id}`);
      const wasActive = index.activeId === id;
      if (!wasActive) {
        removeProfile(id, this.layout);
        return { wasActive: false };
      }
      const generated = this.render(null);
      await this.transitionConfig(generated, () => removeProfile(id, this.layout), [
        this.layout.profilesIndexFile,
        profileFilePath(this.layout, id),
      ]);
      return { wasActive: true, proxyCount: generated.proxyCount };
    });
  }

  async reloadActive(reloadRuntime = true): Promise<GeneratedConfig> {
    const active = this.active();
    if (!active) {
      const generated = this.render(null);
      await this.exclusive(() =>
        this.transitionConfig(generated, () => undefined, [], reloadRuntime),
      );
      return generated;
    }

    let fetched: SubscriptionFetch | undefined;
    const stored = readProfileDoc(this.layout, active.id);
    if (stored === undefined) {
      if (!active.url) {
        throw new ProfileInputError(`Local profile file is missing: ${active.id}`);
      }
      fetched = await this.fetch(active.url);
    }
    return this.exclusive(async () => {
      const current = this.active();
      if (!current || current.id !== active.id) {
        throw new ProfileConflictError("Active profile changed while preparing configuration");
      }
      if (fetched) applySubscriptionFetch(active.id, fetched, this.layout);
      const doc = fetched?.doc ?? readProfileDoc(this.layout, active.id);
      if (doc === undefined) {
        throw new ProfileInputError(`Profile file is missing: ${active.id}`);
      }
      const generated = this.render(doc);
      await this.transitionConfig(generated, () => undefined, [], reloadRuntime);
      return generated;
    });
  }
}
