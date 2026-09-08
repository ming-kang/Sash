import { ref } from "vue";
import {
  type HealthInfo,
  parseWebSessionInfo,
  type WebSessionInfo,
} from "../../../src/contracts.js";
import { SashApiError, type SashClient } from "../../../src/sash-client.js";

const STORAGE_KEY = "sash.control-token";
let credential: WebSessionInfo | null = null;
let daemonStartedAt: string | null = null;
let generation = 0;
let pendingExchange: Promise<WebSessionInfo> | null = null;
let initialized = false;

export const sessionReady = ref(false);

function readStoredSession(): WebSessionInfo | null {
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    return stored ? parseWebSessionInfo(JSON.parse(stored)) : null;
  } catch {
    // Storage may be disabled, unavailable, or contain an obsolete credential.
    return null;
  }
}

function setCredential(value: WebSessionInfo | null, ready = value !== null): void {
  credential = value;
  sessionReady.value = ready;
  try {
    if (value) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Authorization still works in memory when browser storage is unavailable.
  }
}

/** Consume the fragment before any network request, including invalid handoffs. */
function takeBootstrapToken(): string | null {
  if (typeof window === "undefined" || !window.location) return null;
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (!params.has("boot")) return null;
  const token = params.get("boot") ?? "";
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/`);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}

export const webSession = {
  initialized: (): boolean =>
    initialized && !(typeof window !== "undefined" && /(?:^#|&)boot=/.test(window.location.hash)),
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
    daemonStartedAt = null;
    setCredential(null);
  },

  reject(token: string): void {
    // An old request's 401 must not revoke a newer browser authorization.
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
    // Concurrent polls share a single-use exchange. Only the current poll may
    // adopt it, and explicit session clearing invalidates all pending results.
    const exchange = pendingExchange;
    let candidate = credential ?? readStoredSession();
    try {
      if (exchange) candidate = await exchange.catch(() => null);
      const health = await client.health();
      if (candidate && candidate.daemonToken !== health.token && current()) {
        const continuation = health.webContinuation;
        if (
          continuation &&
          Date.parse(continuation.expiresAt) > Date.now() &&
          continuation.bootIds.includes(candidate.daemonToken)
        ) {
          try {
            candidate = await client.continueWebSession(candidate);
          } catch (error) {
            if (error instanceof SashApiError && [400, 401, 403].includes(error.status))
              candidate = null;
            else throw error;
          }
        } else candidate = null;
      }
      if (current()) {
        initialized = true;
        setCredential(candidate?.daemonToken === health.token ? candidate : null);
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
