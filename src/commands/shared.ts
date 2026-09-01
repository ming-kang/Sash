import { coreInstalled, currentCoreVersion, installCore } from "../core.js";
import { validateCoreConfigText } from "../core-config-validation.js";
import { log } from "../log.js";
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

export function createProfileService(ctx: RuntimeContext): ProfileService {
  return new ProfileService({
    layout: ctx.layout,
    settings: () => ctx.settings,
    ...(coreInstalled(ctx.layout)
      ? { validateConfig: (generated) => validateCoreConfigText(generated.yaml, ctx.layout) }
      : {}),
  });
}

/**
 * Reconcile config.yaml from the active profile and current settings before
 * every Core start. A missing remote profile is fetched once; with no active
 * profile a DIRECT-only default is generated.
 */
export async function ensureConfig(ctx: RuntimeContext): Promise<void> {
  const profiles = createProfileService(ctx);
  const active = profiles.active();
  const result = await profiles.reloadActive(false);
  if (!active) {
    log.ok("config generated (DIRECT-only default; set one up with `sash sub set <url>`)");
    return;
  }
  log.ok(`config generated from profile "${active.name}" (${result.proxyCount} proxies)`);
}

export { currentCoreVersion };
