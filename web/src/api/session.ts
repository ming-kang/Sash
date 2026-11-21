import { ref } from "vue";
import type { HealthInfo, WebSessionInfo } from "../../../src/contracts.js";
import type { SashClient } from "../../../src/sash-client.js";

const STORAGE_KEY = "sash.control-token";
let credential: WebSessionInfo | null = null;
let daemonStartedAt: string | null = null;
let generation = 0;
let pendingExchange: Promise<WebSessionInfo> | null = null;
let initialized = false;

export const sessionReady = ref(false);

// Boot links hand off `#boot=<token>` through the location fragment. A same-tab
// fragment change reaches popstate/hashchange listeners in registration order,
// and vue-router installs later — it rewrites the fragment into a route and the
// token is lost before any session code can read it. Capture at module load so
// this listener runs before the router's own navigation handlers.
let pendingBootHash: string | null = null;
function captureBootHash(): void {
  if (typeof window === "undefined" || !window.location) return;
  if (/(?:^#|&)boot=/.test(window.location.hash)) pendingBootHash = window.location.hash;
}
if (typeof window !== "undefined" && window.addEventListener) {
  captureBootHash();
  window.addEventListener("popstate", captureBootHash);
  window.addEventListener("hashchange", captureBootHash);
}

function readStoredSession(): WebSessionInfo | null {
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as { token?: unknown; daemonToken?: unknown } | null;
    if (typeof parsed?.token !== "string" || typeof parsed?.daemonToken !== "string") return null;
    return { token: parsed.token, daemonToken: parsed.daemonToken };
  } catch {
    return null;
  }
}

function setCredential(value: WebSessionInfo | null, ready = value !== null): void {
  credential = value;
  sessionReady.value = ready;
  try {
    if (value) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
}

/** Consume the captured fragment before any network request, including invalid handoffs. */
function takeBootstrapToken(): string | null {
  const live = typeof window !== "undefined" && window.location ? window.location.hash : null;
  const hash = pendingBootHash ?? live;
  pendingBootHash = null;
  if (hash === null) return null;
  const params = new URLSearchParams(hash.slice(1).replace(/^\//, ""));
  if (!params.has("boot")) return null;
  const token = params.get("boot") ?? "";
  // Scrub the credential from the address bar — unless the router already
  // rewrote the fragment, in which case the location is left alone.
  if (
    typeof window !== "undefined" &&
    window.location &&
    /(?:^#|&)boot=/.test(window.location.hash)
  ) {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/`);
  }
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}

export const webSession = {
  initialized: (): boolean =>
    initialized &&
    pendingBootHash === null &&
    !(
      typeof window !== "undefined" &&
      window.location &&
      /(?:^#|&)boot=/.test(window.location.hash)
    ),
  markDisconnected(): void {
    initialized = false;
    sessionReady.value = false;
  },
  matches(bootId: string): boolean {
    if (credential?.daemonToken === bootId && sessionReady.value) return true;
    if (credential) {
      generation += 1;
      sessionReady.value = false;
      initialized = false;
    }
    return false;
  },
  token: (): string => (sessionReady.value ? (credential?.token ?? "") : ""),
  generation: (): number => generation,
  startedAt: (): string | null => daemonStartedAt,

  clear(): void {
    initialized = false;
    generation += 1;
    pendingExchange = null;
    pendingBootHash = null;
    daemonStartedAt = null;
    setCredential(null);
  },

  reject(token: string): void {
    if (token && token === credential?.token && sessionReady.value) {
      generation += 1;
      setCredential(null);
    }
  },

  async initialize(client: SashClient, isActive: () => boolean): Promise<HealthInfo> {
    const request = ++generation;
    const current = () => isActive() && request === generation;
    const bootstrap = isActive() ? takeBootstrapToken() : null;
    if (bootstrap) pendingExchange = client.redeemWebBootstrap(bootstrap);
    const exchange = pendingExchange;
    let candidate = credential ?? readStoredSession();
    try {
      if (exchange) candidate = await exchange.catch(() => null);
      const health = await client.health();
      if (current()) {
        initialized = true;
        // Session tokens outlive the daemon that issued them: it reloads their
        // hashes at boot, so a restart only changes the boot identity. An
        // expired or revoked token surfaces as a 401 and clears the session.
        setCredential(
          candidate && health.bootId ? { ...candidate, daemonToken: health.bootId } : null,
        );
        daemonStartedAt = health.startedAt;
      }
      return health;
    } catch (error) {
      if (current()) {
        initialized = false;
        setCredential(candidate, false);
        daemonStartedAt = null;
      }
      throw error;
    } finally {
      if (current() && pendingExchange === exchange) pendingExchange = null;
    }
  },
};
