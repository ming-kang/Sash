import { MihomoApi } from "../api.js";
import { log } from "../log.js";
import { fetchSubscription, generateConfig } from "../mihomo-config.js";
import { evaluateRunning, startDaemon, stopDaemon } from "../process.js";
import { generateSecret, saveSettings } from "../settings.js";
import { runtimeContext } from "./shared.js";

/** `sash config`: inspect Sash settings and adjust managed config keys. */

export async function runConfigShow(): Promise<void> {
  const ctx = runtimeContext();
  log.kv("root", ctx.layout.root);
  log.kv("config file", ctx.layout.configFile);
  log.kv("settings file", ctx.layout.settingsFile);
  log.kv("core binary", ctx.layout.coreExe);
  log.kv("logs", ctx.layout.logsDir);
  console.log("");
  log.kv("subscription", ctx.settings.subscriptionUrl || "(none)");
  log.kv("mixed-port", String(ctx.settings.mixedPort));
  log.kv("controller", ctx.settings.controller);
  log.kv("secret", maskSecret(ctx.settings.secret));
  log.kv("tun", ctx.settings.tun ? "on" : "off");
  log.kv("allow-lan", ctx.settings.allowLan ? "on" : "off");
}

function maskSecret(secret: string): string {
  if (secret.length <= 8) return "********";
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

const SETTABLE_KEYS = ["tun", "allow-lan", "mixed-port", "controller", "secret"] as const;

const USAGE = "\n\nUsage: sash config set <key> <value>";

/**
 * These keys change where/how the core listens or authenticates; a running
 * core cannot apply them via PUT /configs (it would still be on the old
 * address/secret), so they require a restart.
 */
export function requiresRestart(key: string): boolean {
  switch (key) {
    case "controller":
    case "secret":
    case "tun":
    case "mixed-port":
    case "allow-lan":
      return true;
    default:
      return false;
  }
}

export function validateController(v: string): boolean {
  const trimmed = v.trim();
  if (!trimmed) return false;
  if (/[\s/?#@]/.test(trimmed)) return false;
  const match = trimmed.match(/^(.*):(\d+)$/);
  const hostPart = match?.[1];
  const portPart = match?.[2];
  if (!hostPart || !portPart) return false;
  const port = Number.parseInt(portPart, 10);
  if (port < 1 || port > 65535) return false;
  try {
    const url = new URL(`http://${trimmed}`);
    if (!url.hostname) return false;
    if (url.username || url.password) return false;
    if (url.pathname !== "/" || url.search || url.hash) return false;
    return true;
  } catch {
    return false;
  }
}

export async function runConfigSet(key: string, value: string | undefined): Promise<void> {
  const ctx = runtimeContext();
  switch (key) {
    case "tun":
      ctx.settings.tun = parseOnOff(value);
      if (ctx.settings.tun) {
        log.warn(
          "TUN requires Administrator/root privileges for the core. On Windows, run the terminal as Administrator before `sash start`.",
        );
      }
      break;
    case "allow-lan":
      ctx.settings.allowLan = parseOnOff(value);
      break;
    case "mixed-port": {
      const raw = (value ?? "").trim();
      const port = Number.parseInt(raw, 10);
      if (!raw || !Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== raw) {
        throw new Error(`invalid port: ${value ?? ""} (expected 1-65535)${USAGE}`);
      }
      ctx.settings.mixedPort = port;
      break;
    }
    case "controller": {
      const v = (value ?? "").trim();
      if (!v || !validateController(v)) {
        throw new Error(`invalid controller address: ${v} (expected host:port)${USAGE}`);
      }
      ctx.settings.controller = v;
      break;
    }
    case "secret":
      ctx.settings.secret = !value || value === "regenerate" ? generateSecret() : value.trim();
      break;
    default:
      throw new Error(`unknown key: ${key} (settable: ${SETTABLE_KEYS.join(", ")})`);
  }
  saveSettings(ctx.settings, ctx.layout);
  log.ok(`${key} updated`);

  // Regenerate config so managed keys take effect, then apply to a running core.
  const doc = ctx.settings.subscriptionUrl
    ? await fetchSubscription(ctx.settings.subscriptionUrl)
    : undefined;
  await generateConfig({ layout: ctx.layout, settings: ctx.settings, subscription: doc });
  const state = await evaluateRunning(ctx.layout, ctx.settings);
  if (!state.running) {
    log.info("takes effect on next `sash start`");
    return;
  }
  if (requiresRestart(key)) {
    await stopDaemon({ layout: ctx.layout });
    await startDaemon({ layout: ctx.layout, settings: ctx.settings });
    log.ok(`core restarted to apply ${key}`);
  } else {
    const api = new MihomoApi(ctx.settings.controller, ctx.settings.secret);
    await api.reloadConfig(ctx.layout.configFile);
    log.ok("running core reloaded");
  }
}

function parseOnOff(value: string | undefined): boolean {
  if (value === "on" || value === "true" || value === "1") return true;
  if (value === "off" || value === "false" || value === "0") return false;
  throw new Error(`expected on|off, got: ${value ?? ""}${USAGE}`);
}
