import fs from "node:fs";
import { type SashStateStore, StateConflictError } from "./app-state.js";
import { errorDetail, errorMessage } from "./error-utils.js";
import { atomicWriteFileSync, durableRemoveFileSync } from "./fs-atomic.js";
import { fetchSubscriptionProfile, type SubscriptionFetch } from "./mihomo-config.js";
import type { SashLayout } from "./paths.js";
import { pruneProfileFiles } from "./profile-cleanup.js";
import { ProfileSourceCache } from "./profile-source-cache.js";
import {
  allocateProfileId,
  getActiveProfile,
  MAX_PROFILE_INTERVAL_HOURS,
  type ProfileMeta,
  type ProfilesIndex,
  parseProfileText,
  profileDueForUpdate,
  profileFilePath,
  profileNameFromUrl,
} from "./profiles.js";

export class ProfileInputError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "ProfileInputError";
  }
}
export class ProfileNotFoundError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "ProfileNotFoundError";
  }
}
export { StateConflictError as ProfileConflictError } from "./app-state.js";

export type ProfileCommitBoundary = <T>(
  purpose: string,
  action: () => T | Promise<T>,
) => Promise<T>;

export interface ProfileServiceOptions {
  layout: SashLayout;
  state: SashStateStore;
  commit: ProfileCommitBoundary;
  assertMutable?: () => void;
  fetchProfile?: (url: string, signal?: AbortSignal) => Promise<SubscriptionFetch>;
  sources?: ProfileSourceCache;
  canCleanTemp?: () => boolean;
}

export interface ProfileActionResult {
  profile: ProfileMeta;
  activated: boolean;
}
export interface ProfileUpdateResult {
  profile: ProfileMeta;
}
export interface ProfileUpdateAllResult {
  updated: number;
  failed: Array<{ id: string; name: string; error: string }>;
}

function profileInput(content: string): Record<string, unknown> {
  try {
    return parseProfileText(content);
  } catch (error) {
    throw new ProfileInputError(errorMessage(error));
  }
}

function validName(name: string): string {
  const result = name.trim();
  if (!result || result.length > 120)
    throw new ProfileInputError("Profile name must contain 1 to 120 characters");
  return result;
}

/** Saves immutable profile sources. Runtime changes are exclusively owned by App / Runtime. */
export class ProfileService {
  private readonly downloads = new Set<AbortController>();
  private readonly updates = new Map<string, Promise<ProfileUpdateResult>>();
  private downloadGeneration = 0;
  private readonly sources: ProfileSourceCache;

  constructor(private readonly options: ProfileServiceOptions) {
    this.sources = options.sources ?? new ProfileSourceCache(options.layout);
  }

  list(): ProfilesIndex {
    return this.options.state.snapshot().profiles;
  }
  active(): ProfileMeta | null {
    return getActiveProfile(this.list());
  }

  cancelDownloads(): void {
    this.downloadGeneration += 1;
    for (const download of this.downloads)
      download.abort(new StateConflictError("Profile download cancelled"));
  }

  private async fetch(url: string): Promise<SubscriptionFetch> {
    this.options.assertMutable?.();
    const controller = new AbortController();
    this.downloads.add(controller);
    try {
      const fetched = await (this.options.fetchProfile ?? fetchSubscriptionProfile)(
        url,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      return fetched;
    } catch (error) {
      controller.signal.throwIfAborted();
      throw error;
    } finally {
      this.downloads.delete(controller);
    }
  }

  private requireProfile(index: ProfilesIndex, id: string): ProfileMeta {
    const profile = index.profiles.find((item) => item.id === id);
    if (!profile) throw new ProfileNotFoundError(`Profile not found: ${id}`);
    return profile;
  }

  private recheck(index: ProfilesIndex, before: ProfileMeta): ProfileMeta {
    const current = this.requireProfile(index, before.id);
    if (current.revision !== before.revision || current.url !== before.url) {
      throw new StateConflictError(
        "Profile changed while downloading or editing; refresh and retry",
      );
    }
    return current;
  }

  /** Write the source first, then publish its reference through the one state file. */
  private publishSource(
    index: ProfilesIndex,
    profile: ProfileMeta,
    text: string,
    select: boolean,
  ): ProfileMeta {
    const state = this.options.state.snapshot();
    const previous = index.profiles.find((item) => item.id === profile.id);
    let unchanged = false;
    if (previous) {
      try {
        unchanged = this.sources.read(previous).yamlText === text;
      } catch {
        /* A valid update can replace a missing or damaged source. */
      }
    }
    let revision = profile.revision;
    if (unchanged && previous) revision = previous.revision;
    else
      while (fs.existsSync(profileFilePath(this.options.layout, profile.id, revision)))
        revision += 1;
    const next = { ...profile, revision };
    const file = profileFilePath(this.options.layout, next.id, next.revision);
    if (!unchanged) atomicWriteFileSync(file, text);
    const profiles = previous
      ? index.profiles.map((item) => (item.id === next.id ? next : item))
      : [...index.profiles, next];
    this.options.state.commit({
      ...state,
      profiles: { activeId: select ? next.id : index.activeId, profiles },
    });
    if (previous && previous.revision !== next.revision) {
      // Core consumes a separate generated config; it never holds a profile source open.
      try {
        durableRemoveFileSync(profileFilePath(this.options.layout, previous.id, previous.revision));
      } catch {
        /* A failed cleanup leaves an unreferenced source; the committed state is complete. */
      }
    }
    return next;
  }

  private fetchedMeta(
    profile: ProfileMeta,
    fetched: SubscriptionFetch,
    attemptedAt: string,
  ): ProfileMeta {
    const interval = fetched.intervalHours;
    return {
      ...profile,
      revision: profile.revision + 1,
      updatedAt: new Date().toISOString(),
      ...(fetched.subInfo ? { subInfo: fetched.subInfo } : {}),
      ...(fetched.homePage ? { homePage: fetched.homePage } : {}),
      intervalHours:
        interval !== undefined &&
        Number.isSafeInteger(interval) &&
        interval > 0 &&
        interval <= MAX_PROFILE_INTERVAL_HOURS
          ? interval
          : profile.intervalHours,
      lastError: undefined,
      lastAttemptAt: attemptedAt,
      failureCount: 0,
    };
  }

  async addRemote(
    url: string,
    opts: { name?: string; activate?: boolean } = {},
  ): Promise<ProfileActionResult> {
    const normalized = url.trim();
    if (!normalized) throw new ProfileInputError("Missing required profile URL");
    const known = this.list().profiles.find((profile) => profile.url === normalized);
    const attemptedAt = new Date().toISOString();
    const fetched = await this.fetch(normalized);
    return this.options.commit("save remote profile", () => {
      const index = this.list();
      const now = new Date().toISOString();
      const existing = known ? this.recheck(index, known) : undefined;
      if (!known && index.profiles.some((profile) => profile.url === normalized))
        throw new StateConflictError("Profile was added during download");
      const base: ProfileMeta = existing ?? {
        id: allocateProfileId(index, this.options.layout),
        revision: 0,
        name: validName(opts.name ?? fetched.name?.slice(0, 120) ?? profileNameFromUrl(normalized)),
        url: normalized,
        intervalHours: 24,
        createdAt: now,
        updatedAt: now,
      };
      const activated = opts.activate === true || index.activeId === null;
      const profile = this.publishSource(
        index,
        this.fetchedMeta(base, fetched, attemptedAt),
        fetched.yamlText,
        activated,
      );
      return { profile, activated };
    });
  }

  async importLocal(name: string, content: string): Promise<ProfileActionResult> {
    profileInput(content);
    const displayName = validName(name);
    return this.options.commit("import profile", () => {
      const index = this.list();
      const now = new Date().toISOString();
      const activated = index.activeId === null;
      const profile = this.publishSource(
        index,
        {
          id: allocateProfileId(index, this.options.layout),
          revision: 1,
          name: displayName,
          url: "",
          intervalHours: 0,
          createdAt: now,
          updatedAt: now,
        },
        content,
        activated,
      );
      return { profile, activated };
    });
  }

  readContent(id: string): { name: string; content: string; revision: number } {
    const profile = this.requireProfile(this.list(), id);
    return {
      name: profile.name,
      content: this.sources.read(profile).yamlText,
      revision: profile.revision,
    };
  }

  async writeContent(id: string, content: string, revision: number): Promise<ProfileUpdateResult> {
    profileInput(content);
    return this.options.commit("save profile edit", () => {
      const index = this.list();
      const before = this.requireProfile(index, id);
      if (before.revision !== revision)
        throw new StateConflictError(
          "Profile changed since the editor opened; reload before saving",
        );
      const profile = this.publishSource(
        index,
        {
          ...before,
          revision: before.revision + 1,
          updatedAt: new Date().toISOString(),
          lastError: undefined,
          failureCount: 0,
        },
        content,
        false,
      );
      return { profile };
    });
  }

  async activate(id: string | null): Promise<{ activeId: string | null; proxyCount: number }> {
    return this.options.commit("select profile", () => {
      const state = this.options.state.snapshot();
      const profile = id === null ? null : this.requireProfile(state.profiles, id);
      const doc = profile ? this.sources.read(profile).doc : null;
      if (state.profiles.activeId !== id)
        this.options.state.commit({ ...state, profiles: { ...state.profiles, activeId: id } });
      return { activeId: id, proxyCount: Array.isArray(doc?.proxies) ? doc.proxies.length : 0 };
    });
  }

  update(id: string): Promise<ProfileUpdateResult> {
    const existing = this.updates.get(id);
    if (existing) return existing;
    const pending = this.updateOnce(id).finally(() => {
      if (this.updates.get(id) === pending) this.updates.delete(id);
    });
    this.updates.set(id, pending);
    return pending;
  }

  private async updateOnce(id: string): Promise<ProfileUpdateResult> {
    const before = this.requireProfile(this.list(), id);
    if (!before.url) throw new ProfileInputError("Local profile has no URL to update from");
    const attemptedAt = new Date().toISOString();
    try {
      const fetched = await this.fetch(before.url);
      return await this.options.commit("update profile", () => {
        const index = this.list();
        const current = this.recheck(index, before);
        return {
          profile: this.publishSource(
            index,
            this.fetchedMeta(current, fetched, attemptedAt),
            fetched.yamlText,
            false,
          ),
        };
      });
    } catch (error) {
      if (error instanceof StateConflictError) throw error;
      await this.options
        .commit("record profile error", () => {
          const state = this.options.state.snapshot();
          const current = state.profiles.profiles.find((profile) => profile.id === id);
          if (!current || current.revision !== before.revision || current.url !== before.url)
            return;
          const message = errorDetail(error);
          this.options.state.commit({
            ...state,
            profiles: {
              ...state.profiles,
              profiles: state.profiles.profiles.map((profile) =>
                profile.id === id
                  ? {
                      ...profile,
                      lastError: message,
                      lastAttemptAt: attemptedAt,
                      failureCount: Math.min((profile.failureCount ?? 0) + 1, 31),
                    }
                  : profile,
              ),
            },
          });
        })
        .catch(() => undefined);
      throw error;
    }
  }

  private async updateProfiles(profiles: ProfileMeta[]): Promise<ProfileUpdateAllResult> {
    const result: ProfileUpdateAllResult = { updated: 0, failed: [] };
    const generation = this.downloadGeneration;
    for (let start = 0; start < profiles.length; start += 4) {
      if (generation !== this.downloadGeneration) {
        result.failed.push(
          ...profiles.slice(start).map((profile) => ({
            id: profile.id,
            name: profile.name,
            error: "Profile update cancelled",
          })),
        );
        break;
      }
      await Promise.all(
        profiles.slice(start, start + 4).map(async (profile) => {
          try {
            await this.update(profile.id);
            result.updated += 1;
          } catch (error) {
            result.failed.push({
              id: profile.id,
              name: profile.name,
              error: errorMessage(error),
            });
          }
        }),
      );
    }
    return result;
  }

  updateAll(): Promise<ProfileUpdateAllResult> {
    return this.updateProfiles(this.list().profiles.filter((profile) => profile.url));
  }

  async updateDue(nowMs = Date.now()): Promise<ProfileUpdateAllResult> {
    return this.updateProfiles(
      this.list().profiles.filter((profile) => profileDueForUpdate(profile, nowMs)),
    );
  }

  cleanup(nowMs = Date.now()): Promise<number> {
    return this.options.commit("clean orphaned profile files", () => {
      const state = this.options.state.snapshot();
      this.options.state.assertCurrent(state.revision);
      return pruneProfileFiles(this.options.layout, state.profiles, {
        nowMs,
        cleanTemp: this.options.canCleanTemp?.() ?? true,
      });
    });
  }

  async remove(id: string): Promise<{ wasActive: boolean }> {
    return this.options.commit("remove profile", () => {
      const state = this.options.state.snapshot();
      const profile = this.requireProfile(state.profiles, id);
      const wasActive = state.profiles.activeId === id;
      this.options.state.commit({
        ...state,
        profiles: {
          activeId: wasActive ? null : state.profiles.activeId,
          profiles: state.profiles.profiles.filter((item) => item.id !== id),
        },
      });
      try {
        durableRemoveFileSync(profileFilePath(this.options.layout, profile.id, profile.revision));
      } catch {
        /* State no longer references this file. */
      }
      return { wasActive };
    });
  }

  async reorder(ids: readonly string[]): Promise<ProfilesIndex> {
    return this.options.commit("reorder profiles", () => {
      const state = this.options.state.snapshot();
      if (ids.length !== state.profiles.profiles.length || new Set(ids).size !== ids.length)
        throw new ProfileInputError("Profile order must contain every profile exactly once");
      const profiles = ids.map((id) => this.requireProfile(state.profiles, id));
      if (profiles.every((profile, i) => profile.id === state.profiles.profiles[i]?.id))
        return state.profiles;
      return this.options.state.commit({ ...state, profiles: { ...state.profiles, profiles } })
        .profiles;
    });
  }

  async rename(id: string, name: string): Promise<{ profile: ProfileMeta }> {
    const displayName = validName(name);
    return this.options.commit("rename profile", () => {
      const state = this.options.state.snapshot();
      const profile = { ...this.requireProfile(state.profiles, id), name: displayName };
      this.options.state.commit({
        ...state,
        profiles: {
          ...state.profiles,
          profiles: state.profiles.profiles.map((item) => (item.id === id ? profile : item)),
        },
      });
      return { profile };
    });
  }
}
