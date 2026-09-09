import type { ProfileMeta, ProfilesIndex } from "./profile-model.js";
import { getActiveProfile, loadProfiles } from "./profiles.js";
import { ensureManagement, type RuntimeContext, resolveRuntimeOwner } from "./runtime-owner.js";

/** IDs are unambiguous; display names must match exactly and uniquely. */
export function resolveProfileReference(index: ProfilesIndex, reference?: string): ProfileMeta {
  if (reference === undefined) {
    const active = getActiveProfile(index);
    if (!active) throw new Error("No saved profile is selected; specify a profile or use --all");
    return active;
  }
  const id = index.profiles.find((profile) => profile.id === reference);
  if (id) return id;
  const matches = index.profiles.filter((profile) => profile.name === reference);
  if (matches.length > 1)
    throw new Error(
      `Profile name ${JSON.stringify(reference)} is ambiguous; use its ID from sash profile list`,
    );
  if (!matches[0])
    throw new Error(`Profile ${JSON.stringify(reference)} was not found; run sash profile list`);
  return matches[0];
}

/** Offline reads are observational; all mutations use the daemon's existing profile API. */
export class CliProfiles {
  constructor(private readonly context: RuntimeContext) {}

  async list(): Promise<ProfilesIndex> {
    const owner = await resolveRuntimeOwner(this.context);
    if (owner.kind === "unhealthy")
      throw new Error("Cannot verify the management daemon; inspect sash status");
    return owner.kind === "daemon"
      ? owner.client.listProfiles()
      : loadProfiles(this.context.layout);
  }

  async use(reference?: string, useDefault = false) {
    if (useDefault ? reference !== undefined : reference === undefined)
      throw new Error("Specify one profile ID/name or --default");
    const { client } = await ensureManagement(this.context);
    const profile = useDefault
      ? null
      : resolveProfileReference(await client.listProfiles(), reference);
    return { ...(await client.activateProfile(profile?.id ?? null)), name: profile?.name ?? null };
  }

  async add(url: string, options: { name?: string; use?: boolean }) {
    const { client } = await ensureManagement(this.context);
    return client.addProfile(url, { name: options.name, activate: options.use });
  }

  async update(reference?: string, all = false) {
    if (all && reference !== undefined) throw new Error("Use a profile ID/name or --all, not both");
    const { client } = await ensureManagement(this.context);
    if (all) return client.updateAllProfiles();
    const profile = resolveProfileReference(await client.listProfiles(), reference);
    return client.updateProfile(profile.id);
  }

  async rename(reference: string, name: string) {
    const { client } = await ensureManagement(this.context);
    const profile = resolveProfileReference(await client.listProfiles(), reference);
    return client.renameProfile(profile.id, name);
  }

  async remove(reference: string) {
    const { client } = await ensureManagement(this.context);
    const profile = resolveProfileReference(await client.listProfiles(), reference);
    return { ...(await client.removeProfile(profile.id)), id: profile.id, name: profile.name };
  }
}
