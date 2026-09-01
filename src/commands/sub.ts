import { SashDaemonClient } from "../daemon-client.js";
import { evaluateDaemon } from "../daemon-lifecycle.js";
import { log } from "../log.js";
import { createProfileService, runtimeContext } from "./shared.js";

/** `sash sub ...`: manage subscription profiles through the canonical service. */

export async function runSubSet(url: string): Promise<void> {
  const ctx = runtimeContext();
  log.info(`validating subscription: ${url}`);

  const daemonState = await evaluateDaemon(ctx.layout, ctx.settings);
  if (daemonState.running && daemonState.healthy) {
    const client = new SashDaemonClient(ctx.settings.daemonPort, ctx.settings.daemonSecret);
    const result = await client.addProfile(url, { activate: true });
    const proxies =
      result.proxyCount !== undefined ? ` (${result.proxyCount} proxies) and reloaded` : "";
    log.ok(`profile "${result.profile.name}" saved and activated${proxies}`);
    return;
  }

  const profiles = createProfileService(ctx);
  const result = await profiles.addRemote(url, { activate: true });
  log.ok(
    `profile "${result.profile.name}" saved and activated; config generated (${result.proxyCount ?? 0} proxies)`,
  );
  log.info("takes effect on next `sash start`");
}

export async function runSubUpdate(): Promise<void> {
  const ctx = runtimeContext();
  const profiles = createProfileService(ctx);
  const active = profiles.active();
  if (!active) throw new Error("no active profile; use `sash sub set <url>` first");
  if (!active.url) {
    throw new Error(`profile "${active.name}" is a local file; nothing to update from`);
  }

  const daemonState = await evaluateDaemon(ctx.layout, ctx.settings);
  if (daemonState.running && daemonState.healthy) {
    const client = new SashDaemonClient(ctx.settings.daemonPort, ctx.settings.daemonSecret);
    const result = await client.updateProfile(active.id);
    const proxies =
      result.proxyCount !== undefined ? ` (${result.proxyCount} proxies) and reloaded` : "";
    log.ok(`profile "${active.name}" updated${proxies}`);
    return;
  }

  const result = await profiles.update(active.id);
  log.ok(`profile "${active.name}" updated; config generated (${result.proxyCount ?? 0} proxies)`);
  log.info("takes effect on next `sash start`");
}

export async function runSubUnset(): Promise<void> {
  const ctx = runtimeContext();
  const profiles = createProfileService(ctx);
  const active = profiles.active();
  if (!active) {
    log.info("no active profile");
    return;
  }

  const daemonState = await evaluateDaemon(ctx.layout, ctx.settings);
  if (daemonState.running && daemonState.healthy) {
    const client = new SashDaemonClient(ctx.settings.daemonPort, ctx.settings.daemonSecret);
    await client.setActiveProfile(null);
    log.ok(`profile "${active.name}" deselected; reverted to default config and reloaded`);
    return;
  }

  await profiles.activate(null);
  log.ok(`profile "${active.name}" deselected; reverted to the DIRECT-only default config`);
}

export async function runSubShow(): Promise<void> {
  const ctx = runtimeContext();
  const index = createProfileService(ctx).list();
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
