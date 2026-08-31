import { SashDaemonClient } from "../daemon-client.js";
import { evaluateDaemon } from "../daemon-lifecycle.js";
import { log } from "../log.js";
import { fetchSubscription, generateConfig } from "../mihomo-config.js";
import { saveSettings } from "../settings.js";
import { ensureConfig, runtimeContext } from "./shared.js";

/**
 * `sash sub ...`: manage the Clash/mihomo-format subscription.
 * When the daemon is running, mutations go through the daemon API so
 * config is regenerated and the running core reloaded in one step.
 * When offline, changes are written to disk directly.
 */

export async function runSubSet(url: string): Promise<void> {
  const ctx = runtimeContext();
  log.info(`validating subscription: ${url}`);

  const daemonState = await evaluateDaemon(ctx.layout, ctx.settings);
  if (daemonState.running && daemonState.healthy) {
    const client = new SashDaemonClient(ctx.settings.daemonPort, ctx.settings.daemonSecret);
    const result = await client.setSubscription(url);
    log.ok(`subscription saved; config generated (${result.proxyCount} proxies) and reloaded`);
    return;
  }

  // Offline path
  const doc = await fetchSubscription(url);
  ctx.settings.subscriptionUrl = url;
  saveSettings(ctx.settings, ctx.layout);
  const result = await generateConfig({
    layout: ctx.layout,
    settings: ctx.settings,
    subscription: doc,
  });
  log.ok(`subscription saved; config generated (${result.proxyCount} proxies)`);
  log.info("takes effect on next `sash start`");
}

export async function runSubUpdate(): Promise<void> {
  const ctx = runtimeContext();
  if (!ctx.settings.subscriptionUrl) {
    throw new Error("no subscription configured; use `sash sub set <url>` first");
  }

  const daemonState = await evaluateDaemon(ctx.layout, ctx.settings);
  if (daemonState.running && daemonState.healthy) {
    const client = new SashDaemonClient(ctx.settings.daemonPort, ctx.settings.daemonSecret);
    const result = await client.refreshSubscription();
    log.ok(`subscription refetched; config generated (${result.proxyCount} proxies) and reloaded`);
    return;
  }

  // Offline path
  await ensureConfig(ctx, true);
  saveSettings(ctx.settings, ctx.layout);
  log.ok("subscription refetched and config generated");
  log.info("takes effect on next `sash start`");
}

export async function runSubUnset(): Promise<void> {
  const ctx = runtimeContext();
  if (!ctx.settings.subscriptionUrl) {
    log.info("no subscription configured");
    return;
  }

  const daemonState = await evaluateDaemon(ctx.layout, ctx.settings);
  if (daemonState.running && daemonState.healthy) {
    const client = new SashDaemonClient(ctx.settings.daemonPort, ctx.settings.daemonSecret);
    await client.unsetSubscription();
    log.ok("subscription removed; reverted to default config and reloaded");
    return;
  }

  // Offline path
  ctx.settings.subscriptionUrl = "";
  saveSettings(ctx.settings, ctx.layout);
  await generateConfig({ layout: ctx.layout, settings: ctx.settings });
  log.ok("subscription removed; reverted to the DIRECT-only default config");
}

export async function runSubShow(): Promise<void> {
  const ctx = runtimeContext();
  log.kv("subscription", ctx.settings.subscriptionUrl || "(none)");
  log.kv("config file", ctx.layout.configFile);
}
