import { SashDaemonClient } from "../daemon-client.js";
import { evaluateDaemon } from "../daemon-lifecycle.js";
import { log } from "../log.js";
import { buildDefaultConfig, fetchSubscriptionProfile, generateConfig } from "../mihomo-config.js";
import {
  addProfile,
  applySubscriptionFetch,
  findProfileByUrl,
  getActiveProfile,
  loadProfiles,
  migrateLegacySubscription,
  profileNameFromUrl,
  setActiveProfile,
} from "../profiles.js";
import { saveSettings } from "../settings.js";
import { runtimeContext } from "./shared.js";

/**
 * `sash sub ...`: manage subscription profiles.
 * When the daemon is running, mutations go through the daemon API so
 * config is regenerated and the running core reloaded in one step.
 * When offline, changes are written to disk directly.
 */

/** Fold a legacy settings.subscriptionUrl into the profiles store, once. */
function migrateLegacy(ctx: ReturnType<typeof runtimeContext>): void {
  if (ctx.settings.subscriptionUrl) {
    migrateLegacySubscription(ctx.settings.subscriptionUrl, ctx.layout);
  }
}

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

  // Offline path
  migrateLegacy(ctx);
  const fetched = await fetchSubscriptionProfile(url);
  const existing = findProfileByUrl(loadProfiles(ctx.layout), url);
  let name: string;
  if (existing) {
    applySubscriptionFetch(existing.id, fetched, ctx.layout);
    name = existing.name;
    setActiveProfile(existing.id, ctx.layout);
  } else {
    const added = addProfile(
      { name: fetched.name || profileNameFromUrl(url), url, yamlText: fetched.yamlText },
      ctx.layout,
    );
    name = added.profile.name;
    setActiveProfile(added.profile.id, ctx.layout);
  }
  ctx.settings.subscriptionUrl = url;
  saveSettings(ctx.settings, ctx.layout);
  const result = await generateConfig({
    layout: ctx.layout,
    settings: ctx.settings,
    subscription: fetched.doc,
  });
  log.ok(`profile "${name}" saved and activated; config generated (${result.proxyCount} proxies)`);
  log.info("takes effect on next `sash start`");
}

export async function runSubUpdate(): Promise<void> {
  const ctx = runtimeContext();
  migrateLegacy(ctx);
  const active = getActiveProfile(loadProfiles(ctx.layout));
  if (!active) {
    throw new Error("no active profile; use `sash sub set <url>` first");
  }
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

  // Offline path
  const fetched = await fetchSubscriptionProfile(active.url);
  applySubscriptionFetch(active.id, fetched, ctx.layout);
  const result = await generateConfig({
    layout: ctx.layout,
    settings: ctx.settings,
    subscription: fetched.doc,
  });
  log.ok(`profile "${active.name}" updated; config generated (${result.proxyCount} proxies)`);
  log.info("takes effect on next `sash start`");
}

export async function runSubUnset(): Promise<void> {
  const ctx = runtimeContext();
  migrateLegacy(ctx);
  const active = getActiveProfile(loadProfiles(ctx.layout));
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

  // Offline path: the profile files stay on disk, only the selection is cleared.
  setActiveProfile(null, ctx.layout);
  ctx.settings.subscriptionUrl = "";
  saveSettings(ctx.settings, ctx.layout);
  await generateConfig({
    layout: ctx.layout,
    settings: ctx.settings,
    subscription: buildDefaultConfig(),
  });
  log.ok(`profile "${active.name}" deselected; reverted to the DIRECT-only default config`);
}

export async function runSubShow(): Promise<void> {
  const ctx = runtimeContext();
  const index = loadProfiles(ctx.layout);
  if (index.profiles.length === 0) {
    log.kv("profiles", "(none)");
    if (ctx.settings.subscriptionUrl) {
      log.kv("legacy subscription", `${ctx.settings.subscriptionUrl} (migrates on next start)`);
    }
    log.kv("profiles dir", ctx.layout.profilesDir);
    return;
  }
  for (const p of index.profiles) {
    const marker = p.id === index.activeId ? "*" : " ";
    const source = p.url || "local file";
    const usage = p.subInfo
      ? ` ${Math.round(((p.subInfo.upload + p.subInfo.download) / p.subInfo.total) * 100)}% used`
      : "";
    log.info(`${marker} ${p.name}  ${source}  (updated ${p.updatedAt})${usage}`);
  }
  log.kv("profiles dir", ctx.layout.profilesDir);
}
