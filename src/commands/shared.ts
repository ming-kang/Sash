import { coreInstalled, currentCoreVersion, installCore } from "../core.js";
import { log } from "../log.js";
import { configExists, fetchSubscription, generateConfig } from "../mihomo-config.js";
import { type SashLayout, sashLayout } from "../paths.js";
import { loadSettings, type SashSettings, saveSettings } from "../settings.js";
import { installWebUi, uiInstalled } from "../webui.js";

export interface RuntimeContext {
  layout: SashLayout;
  settings: SashSettings;
}

export function runtimeContext(): RuntimeContext {
  const layout = sashLayout();
  return { layout, settings: loadSettings(layout) };
}

export async function ensureCore(ctx: RuntimeContext): Promise<void> {
  if (coreInstalled(ctx.layout)) return;
  log.info(`mihomo core not installed; downloading latest release...`);
  const { version } = await installCore({ layout: ctx.layout });
  ctx.settings.coreVersion = version;
  log.ok(`mihomo core ${version} installed`);
}

/**
 * Ensure config.yaml exists and reflects the current settings. When a
 * subscription is configured, it is (re)fetched; otherwise a DIRECT-only
 * default is generated.
 */
export async function ensureConfig(ctx: RuntimeContext, force = false): Promise<void> {
  if (!force && configExists(ctx.layout)) return;
  const sub = ctx.settings.subscriptionUrl;
  if (sub) {
    log.info(`fetching subscription: ${sub}`);
    const doc = await fetchSubscription(sub);
    const result = await generateConfig({
      layout: ctx.layout,
      settings: ctx.settings,
      subscription: doc,
    });
    log.ok(`config generated from subscription (${result.proxyCount} proxies)`);
  } else {
    await generateConfig({ layout: ctx.layout, settings: ctx.settings });
    log.ok("config generated (DIRECT-only default; set one up with `sash sub set <url>`)");
  }
}

/** Best-effort dashboard install; failure degrades gracefully to no-UI. */
export async function ensureWebUi(ctx: RuntimeContext): Promise<boolean> {
  if (uiInstalled(ctx.layout)) return true;
  try {
    log.info("downloading MetaCubeXD dashboard...");
    const tag = await installWebUi({ layout: ctx.layout });
    ctx.settings.uiVersion = tag;
    log.ok(`MetaCubeXD ${tag} installed`);
    return true;
  } catch (err) {
    log.warn(`dashboard install failed (core proxying is unaffected): ${(err as Error).message}`);
    return false;
  }
}

/** Persist settings if they were mutated by ensure* helpers. */
export function persistContext(ctx: RuntimeContext): void {
  saveSettings(ctx.settings, ctx.layout);
}

export { currentCoreVersion };
