import { request } from "undici";
import { directDispatcherForLoopback, ERROR_BODY_LIMIT, fetchWithRetry } from "./http.js";
import { SashClient, type SashClientFetch } from "./sash-client.js";
import type { SashEventFetch } from "./sash-event-client.js";

// Profile metadata can occupy most of the supported 2 MiB application manifest.
const DAEMON_SUCCESS_BODY_LIMIT = 2 * 1024 * 1024;

/** Loopback-only fetch with retries, deadlines, and body caps for the CLI. */
const daemonFetch: SashClientFetch = async (url, init) => {
  const res = await fetchWithRetry(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    direct: true,
    manualRedirect: true,
    deadlineMs: init.timeoutMs,
    headersTimeoutMs: init.timeoutMs,
    ...(init.attempts !== undefined ? { attempts: init.attempts } : {}),
    signal: init.signal,
  });
  return {
    status: res.statusCode,
    text: () =>
      res.text(
        res.statusCode >= 200 && res.statusCode < 300
          ? DAEMON_SUCCESS_BODY_LIMIT
          : ERROR_BODY_LIMIT,
      ),
  };
};

// Event streams are deliberately long-lived. They use idle/header deadlines,
// cancellation and the direct dispatcher, with no redirects or mutation retries.
const daemonEventFetch: SashEventFetch = async (url, init) => {
  const response = await request(url, {
    method: "GET",
    ...init,
    dispatcher: directDispatcherForLoopback(),
    headersTimeout: 8000,
    bodyTimeout: 25_000,
  });
  response.body.on("error", () => undefined);
  return {
    status: response.statusCode,
    contentType: String(response.headers["content-type"] ?? ""),
    body: response.body,
  };
};

/** CLI-facing daemon client: SashClient with the Node transport defaults. */
export type SashDaemonClient = SashClient;

export function createDaemonClient(port: number, secret: string): SashDaemonClient {
  const trimmed = (secret || "").trim();
  return new SashClient({
    baseUrl: `http://127.0.0.1:${port}`,
    token: () => trimmed,
    fetchFn: daemonFetch,
    eventFetchFn: daemonEventFetch,
  });
}
