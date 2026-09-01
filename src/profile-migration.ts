import type { SashLayout } from "./paths.js";
import { migrateLegacySubscription } from "./profiles.js";
import { type SashSettings, saveSettings } from "./settings.js";

/** Migrate and permanently remove the legacy single-subscription settings key. */
export function migrateLegacyProfileSetting(settings: SashSettings, layout: SashLayout): boolean {
  if (!("subscriptionUrl" in settings)) return false;
  const url = settings.subscriptionUrl?.trim() ?? "";
  if (url) migrateLegacySubscription(url, layout);
  delete settings.subscriptionUrl;
  saveSettings(settings, layout);
  return true;
}
