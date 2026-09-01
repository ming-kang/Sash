import { coreInstalled, currentCoreVersion, installCore } from "../core.js";
import { log } from "../log.js";
import { configExists } from "../mihomo-config.js";
import { type SashLayout, sashLayout } from "../paths.js";
import { migrateLegacyProfileSetting } from "../profile-migration.js";
import { ProfileService } from "../profile-service.js";
import { loadSettings, type SashSettings } from "../settings.js";

export interface RuntimeContext {
  layout: SashLayout;
  settings: SashSettings;
}

export function runtimeContext(): RuntimeContext {
  const layout = sashLayout();
  const settings = loadSettings(layout);
  migrateLegacyProfileSetting(settings, layout);
  return { layout, settings };
}

export async function ensureCore(ctx: RuntimeContext): Promise<void> {
  if (coreInstalled(ctx.layout)) return;
  log.info("mihomo core not installed; downloading latest release...");
  const { version } = await installCore({ layout: ctx.layout });
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
  const profiles = new ProfileService({ layout: ctx.layout, settings: () => ctx.settings });
  const active = profiles.active();
  const result = await profiles.reloadActive(false);
  if (!active) {
    log.ok("config generated (DIRECT-only default; set one up with `sash sub set <url>`)");
    return;
  }
  log.ok(`config generated from profile "${active.name}" (${result.proxyCount} proxies)`);
}

export { currentCoreVersion };
