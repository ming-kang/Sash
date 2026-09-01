import { coreInstalled, currentCoreVersion, installCore } from "../core.js";
import { log } from "../log.js";
import { configExists, fetchSubscriptionProfile, generateConfig } from "../mihomo-config.js";
import { type SashLayout, sashLayout } from "../paths.js";
import {
  applySubscriptionFetch,
  getActiveProfile,
  loadProfiles,
  migrateLegacySubscription,
  readProfileDoc,
} from "../profiles.js";
import { loadSettings, type SashSettings, saveSettings } from "../settings.js";

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
  log.info("mihomo core not installed; downloading latest release...");
  const { version } = await installCore({ layout: ctx.layout });
  ctx.settings.coreVersion = version;
  log.ok(`mihomo core ${version} installed`);
}

/**
 * Ensure config.yaml exists and reflects the current settings. The active
 * profile's stored document is used; a profile whose content was never
 * downloaded (e.g. freshly migrated) is fetched once. With no active
 * profile a DIRECT-only default is generated.
 */
export async function ensureConfig(ctx: RuntimeContext, force = false): Promise<void> {
  if (!force && configExists(ctx.layout)) return;
  if (ctx.settings.subscriptionUrl) {
    migrateLegacySubscription(ctx.settings.subscriptionUrl, ctx.layout);
  }
  const active = getActiveProfile(loadProfiles(ctx.layout));
  if (!active) {
    await generateConfig({ layout: ctx.layout, settings: ctx.settings });
    log.ok("config generated (DIRECT-only default; set one up with `sash sub set <url>`)");
    return;
  }
  let doc = readProfileDoc(ctx.layout, active.id);
  if (doc === undefined && active.url) {
    log.info(`fetching subscription: ${active.url}`);
    const fetched = await fetchSubscriptionProfile(active.url);
    applySubscriptionFetch(active.id, fetched, ctx.layout);
    doc = fetched.doc;
  }
  const result = await generateConfig({
    layout: ctx.layout,
    settings: ctx.settings,
    subscription: doc,
  });
  log.ok(`config generated from profile "${active.name}" (${result.proxyCount} proxies)`);
}

/** Persist settings if they were mutated by ensure* helpers. */
export function persistContext(ctx: RuntimeContext): void {
  saveSettings(ctx.settings, ctx.layout);
}

export { currentCoreVersion };
