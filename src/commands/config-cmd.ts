import { SashDaemonClient } from "../daemon-client.js";
import { evaluateDaemon } from "../daemon-lifecycle.js";
import { log } from "../log.js";
import { ProfileService } from "../profile-service.js";
import {
  applyManagedKey,
  requiresCoreRestart,
  SETTABLE_KEYS,
  saveSettings,
  validateController,
} from "../settings.js";
import { createProfileService, runtimeContext } from "./shared.js";

/** Re-export for backwards compatibility */
export const requiresRestart = requiresCoreRestart;
export { validateController };

export async function runConfigShow(): Promise<void> {
  const ctx = runtimeContext();
  log.kv("root", ctx.layout.root);
  log.kv("config file", ctx.layout.configFile);
  log.kv("settings file", ctx.layout.settingsFile);
  log.kv("core binary", ctx.layout.coreExe);
  log.kv("logs", ctx.layout.logsDir);
  console.log("");
  const active = new ProfileService({
    layout: ctx.layout,
    settings: () => ctx.settings,
  }).active();
  log.kv("active profile", active ? `${active.name} (${active.url || "local file"})` : "(none)");
  log.kv("mixed-port", String(ctx.settings.mixedPort));
  log.kv("controller", ctx.settings.controller);
  log.kv("secret", maskSecret(ctx.settings.secret));
  log.kv("tun", ctx.settings.tun ? "on" : "off");
  log.kv("system-proxy", ctx.settings.systemProxy ? "on" : "off");
  log.kv("allow-lan", ctx.settings.allowLan ? "on" : "off");
  log.kv("daemon-port", String(ctx.settings.daemonPort));
}

function maskSecret(secret: string): string {
  if (secret.length <= 8) return "********";
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

export async function runConfigSet(key: string, value: string | undefined): Promise<void> {
  const ctx = runtimeContext();

  const daemonState = await evaluateDaemon(ctx.layout, ctx.settings);
  if (daemonState.running && daemonState.healthy) {
    const client = new SashDaemonClient(ctx.settings.daemonPort, ctx.settings.daemonSecret);
    await client.patchSetting(key, value);
    log.ok(`${key} updated`);
    return;
  }

  // Offline path
  try {
    applyManagedKey(ctx.settings, key, value);
  } catch (err) {
    const usage = `\n\nUsage: sash config set <key> <value>\nSettable keys: ${SETTABLE_KEYS.join(", ")}`;
    throw new Error(`${(err as Error).message}${usage}`);
  }
  saveSettings(ctx.settings, ctx.layout);
  log.ok(`${key} updated`);

  await createProfileService(ctx).reloadActive(false);
  log.info("takes effect on next `sash start`");
}
