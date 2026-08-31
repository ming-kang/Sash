import { MihomoApi } from "../api.js";
import { log } from "../log.js";
import { fetchSubscription, generateConfig } from "../mihomo-config.js";
import { evaluateRunning } from "../process.js";
import { saveSettings } from "../settings.js";
import { ensureConfig, runtimeContext } from "./shared.js";

/**
 * `sash sub ...`: manage the Clash/mihomo-format subscription. Sash fetches
 * the subscription itself and merges it with managed keys — the dashboard is
 * only a control panel, so MetaCubeXD's lack of URL-import is not a problem.
 */

async function reloadIfRunning(ctx: ReturnType<typeof runtimeContext>): Promise<void> {
  const state = await evaluateRunning(ctx.layout, ctx.settings);
  if (!state.running) {
    log.info("core is not running; the new config takes effect on next `sash start`");
    return;
  }
  const api = new MihomoApi(ctx.settings.controller, ctx.settings.secret);
  await api.reloadConfig(ctx.layout.configFile);
  log.ok("running core reloaded with the new config");
}

export async function runSubSet(url: string): Promise<void> {
  const ctx = runtimeContext();
  log.info(`validating subscription: ${url}`);
  const doc = await fetchSubscription(url);
  ctx.settings.subscriptionUrl = url;
  saveSettings(ctx.settings, ctx.layout);
  const result = await generateConfig({
    layout: ctx.layout,
    settings: ctx.settings,
    subscription: doc,
  });
  log.ok(`subscription saved; config generated (${result.proxyCount} proxies)`);
  await reloadIfRunning(ctx);
}

export async function runSubUpdate(): Promise<void> {
  const ctx = runtimeContext();
  if (!ctx.settings.subscriptionUrl) {
    throw new Error("no subscription configured; use `sash sub set <url>` first");
  }
  await ensureConfig(ctx, true); // refetch + regenerate
  saveSettings(ctx.settings, ctx.layout);
  await reloadIfRunning(ctx);
}

export async function runSubUnset(): Promise<void> {
  const ctx = runtimeContext();
  if (!ctx.settings.subscriptionUrl) {
    log.info("no subscription configured");
    return;
  }
  ctx.settings.subscriptionUrl = "";
  saveSettings(ctx.settings, ctx.layout);
  await generateConfig({ layout: ctx.layout, settings: ctx.settings });
  log.ok("subscription removed; reverted to the DIRECT-only default config");
  await reloadIfRunning(ctx);
}

export async function runSubShow(): Promise<void> {
  const ctx = runtimeContext();
  log.kv("subscription", ctx.settings.subscriptionUrl || "(none)");
  log.kv("config file", ctx.layout.configFile);
}
