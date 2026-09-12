import { loadProfiles } from "../app-state.js";
import { commandOutput } from "../cli-output.js";
import { log } from "../log.js";
import { getActiveProfile, type ProfileMeta, type ProfilesIndex } from "../profiles.js";
import { ensureManagement, type RuntimeContext, resolveRuntimeOwner } from "../runtime-owner.js";
import { runtimeContext } from "./shared.js";

/** IDs are unambiguous; display names must match exactly and uniquely. */
export function resolveProfileReference(index: ProfilesIndex, reference?: string): ProfileMeta {
  if (reference === undefined) {
    const active = getActiveProfile(index);
    if (!active)
      throw new Error("No profile is selected — name one from sash profile list or pass --all");
    return active;
  }
  const id = index.profiles.find((profile) => profile.id === reference);
  if (id) return id;
  const matches = index.profiles.filter((profile) => profile.name === reference);
  if (matches.length > 1)
    throw new Error(
      `Profile name ${JSON.stringify(reference)} is ambiguous — use its ID from sash profile list`,
    );
  if (!matches[0])
    throw new Error(`Profile ${JSON.stringify(reference)} was not found — run sash profile list`);
  return matches[0];
}

/** Offline reads are observational; all mutations use the daemon's existing profile API. */
export class CliProfiles {
  constructor(private readonly context: RuntimeContext) {}

  async list(): Promise<ProfilesIndex> {
    const owner = await resolveRuntimeOwner(this.context);
    if (owner.kind === "unhealthy")
      throw new Error("Cannot verify the running Sash — run sash doctor to diagnose");
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

const profiles = () => new CliProfiles(runtimeContext());
type OutputOptions = { json?: boolean };

export async function runProfileList(options: OutputOptions = {}): Promise<void> {
  await commandOutput(
    options.json,
    () => profiles().list(),
    (index) => {
      if (!index.profiles.length) log.info("No profiles saved — using the built-in configuration");
      for (const profile of index.profiles)
        process.stdout.write(
          `${profile.id === index.activeId ? "*" : " "}  ${profile.id}  ${JSON.stringify(profile.name)}  ${profile.url ? "subscription" : "local file"}${profile.lastError ? `  last error: ${JSON.stringify(profile.lastError)}` : ""}\n`,
        );
      if (index.profiles.length) log.info("* selected — run sash restart to apply");
    },
  );
}

export async function runProfileUse(
  reference?: string,
  options: OutputOptions & { default?: boolean } = {},
): Promise<void> {
  await commandOutput(
    options.json,
    () => profiles().use(reference, options.default),
    (result) => {
      log.info(
        `Selected ${result.name === null ? "the built-in configuration" : JSON.stringify(result.name)} — run sash restart to apply`,
      );
    },
  );
}

export async function runProfileAdd(
  url: string,
  options: OutputOptions & { name?: string; use?: boolean } = {},
): Promise<void> {
  await commandOutput(
    options.json,
    () => profiles().add(url, options),
    (result) => {
      log.info(
        `Saved ${JSON.stringify(result.profile.name)}${result.activated ? " and selected it — run sash restart to apply" : ""}`,
      );
    },
  );
}

export async function runProfileUpdate(
  reference?: string,
  options: OutputOptions & { all?: boolean } = {},
): Promise<void> {
  await commandOutput(
    options.json,
    async () => {
      const result = await profiles().update(reference, options.all);
      if ("failed" in result && result.failed.length) process.exitCode = 1;
      return result;
    },
    (result) => {
      if ("profile" in result)
        log.info(`Saved ${JSON.stringify(result.profile.name)} — run sash restart to apply`);
      else {
        log.info(
          `Updated ${result.updated} ${result.updated === 1 ? "profile" : "profiles"}, ${result.failed.length} failed — run sash restart to apply`,
        );
        for (const failure of result.failed)
          log.warn(`${JSON.stringify(failure.name)}: ${failure.error}`);
      }
    },
  );
}

export async function runProfileRename(
  reference: string,
  name: string,
  options: OutputOptions = {},
): Promise<void> {
  await commandOutput(
    options.json,
    () => profiles().rename(reference, name),
    ({ profile }) => {
      log.info(`Renamed to ${JSON.stringify(profile.name)}`);
    },
  );
}

export async function runProfileRemove(
  reference: string,
  options: OutputOptions = {},
): Promise<void> {
  await commandOutput(
    options.json,
    () => profiles().remove(reference),
    (result) => {
      log.info(
        `Removed ${JSON.stringify(result.name)}${result.wasActive ? " · using the built-in configuration from now on" : ""}`,
      );
    },
  );
}
