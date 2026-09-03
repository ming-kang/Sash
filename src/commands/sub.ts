import { log } from "../log.js";
import {
  createProfileService,
  offlineProfileCommit,
  prepareOfflineProfileMutation,
  resolveRuntimeOwner,
  runOfflineMutation,
  runtimeContext,
} from "./shared.js";

/** `sash sub ...`: manage subscription profiles through the canonical service. */

export async function runSubSet(url: string): Promise<void> {
  const ctx = runtimeContext();
  log.info(`validating subscription: ${url}`);

  const owner = await resolveRuntimeOwner(ctx);
  if (owner.kind === "unhealthy") {
    throw new Error("sashd is running but unresponsive; refusing a competing profile mutation");
  }
  if (owner.kind === "daemon") {
    const result = await owner.client.addProfile(url, { activate: true });
    const proxies =
      result.proxyCount !== undefined ? ` (${result.proxyCount} proxies) and reloaded` : "";
    log.ok(`profile "${result.profile.name}" saved and activated${proxies}`);
    return;
  }

  await prepareOfflineProfileMutation(ctx);
  const result = await createProfileService(ctx, offlineProfileCommit(ctx)).addRemote(url, {
    activate: true,
  });
  log.ok(
    `profile "${result.profile.name}" saved and activated; config generated (${result.proxyCount ?? 0} proxies)`,
  );
  log.info("takes effect on next `sash start`");
}

export async function runSubUpdate(): Promise<void> {
  const ctx = runtimeContext();
  const owner = await resolveRuntimeOwner(ctx);
  if (owner.kind === "unhealthy") {
    throw new Error("sashd is running but unresponsive; refusing a competing profile mutation");
  }
  if (owner.kind === "daemon") {
    const index = await owner.client.getProfiles();
    const active = index.profiles.find((profile) => profile.id === index.activeId);
    if (!active) throw new Error("no active profile; use `sash sub set <url>` first");
    if (!active.url) {
      throw new Error(`profile "${active.name}" is a local file; nothing to update from`);
    }
    const result = await owner.client.updateProfile(active.id);
    const proxies =
      result.proxyCount !== undefined ? ` (${result.proxyCount} proxies) and reloaded` : "";
    log.ok(`profile "${active.name}" updated${proxies}`);
    return;
  }

  await prepareOfflineProfileMutation(ctx);
  const profiles = createProfileService(ctx, offlineProfileCommit(ctx));
  const active = profiles.active();
  if (!active) throw new Error("no active profile; use `sash sub set <url>` first");
  if (!active.url) {
    throw new Error(`profile "${active.name}" is a local file; nothing to update from`);
  }
  const result = await profiles.update(active.id);
  log.ok(`profile "${active.name}" updated; config generated (${result.proxyCount ?? 0} proxies)`);
  log.info("takes effect on next `sash start`");
}

export async function runSubUnset(): Promise<void> {
  const ctx = runtimeContext();
  const owner = await resolveRuntimeOwner(ctx);
  if (owner.kind === "unhealthy") {
    throw new Error("sashd is running but unresponsive; refusing a competing profile mutation");
  }
  if (owner.kind === "daemon") {
    const index = await owner.client.getProfiles();
    const active = index.profiles.find((profile) => profile.id === index.activeId);
    if (!active) {
      log.info("no active profile");
      return;
    }
    await owner.client.setActiveProfile(null);
    log.ok(`profile "${active.name}" deselected; reverted to default config and reloaded`);
    return;
  }

  await prepareOfflineProfileMutation(ctx);
  const profiles = createProfileService(ctx, offlineProfileCommit(ctx));
  const active = profiles.active();
  if (!active) {
    log.info("no active profile");
    return;
  }
  await profiles.activate(null);
  log.ok(`profile "${active.name}" deselected; reverted to the DIRECT-only default config`);
}

export async function runSubShow(): Promise<void> {
  const ctx = runtimeContext();
  const owner = await resolveRuntimeOwner(ctx);
  const index =
    owner.kind === "daemon"
      ? await owner.client.getProfiles()
      : await runOfflineMutation(
          ctx,
          "read profiles offline",
          () => createProfileService(ctx).list(),
          { migrateProfiles: true },
        );
  if (index.profiles.length === 0) {
    log.kv("profiles", "(none)");
    log.kv("profiles dir", ctx.layout.profilesDir);
    return;
  }
  for (const profile of index.profiles) {
    const marker = profile.id === index.activeId ? "*" : " ";
    const source = profile.url || "local file";
    const usage =
      profile.subInfo && profile.subInfo.total > 0
        ? ` ${Math.round(((profile.subInfo.upload + profile.subInfo.download) / profile.subInfo.total) * 100)}% used`
        : "";
    log.info(`${marker} ${profile.name}  ${source}  (updated ${profile.updatedAt})${usage}`);
  }
  log.kv("profiles dir", ctx.layout.profilesDir);
}
