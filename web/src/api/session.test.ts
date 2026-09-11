import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Window as HappyWindow } from "happy-dom";
import type { HealthInfo } from "../../../src/contracts.js";
import { SashClient } from "../../../src/sash-client.js";
import { sessionReady, webSession } from "./session.js";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const STORAGE_KEY = "sash.control-token";
const bootstrapToken = "b".repeat(64);
const sessionToken = "a".repeat(64);
const health: HealthInfo = {
  token: "public-identity",
  pid: 1234,
  startedAt: "2026-01-01T00:00:00.000Z",
  version: "1.2.3",
};
const client = new SashClient({ baseUrl: "", tokenHeader: "x-sash-token" });
let window: HappyWindow;

function respond(document: unknown, status = 200): Response {
  return Response.json(document, { status });
}

function storedSession(): unknown {
  const stored = window.sessionStorage.getItem(STORAGE_KEY);
  return stored ? JSON.parse(stored) : null;
}

/** Redeem a valid bootstrap handoff against a healthy daemon. */
async function authorize(token = sessionToken, identity = health): Promise<void> {
  window.location.hash = `boot=${bootstrapToken}`;
  globalThis.fetch = async (input, init) => {
    assert.equal(window.location.hash, "#/", "scrub the fragment before fetching");
    if (String(input).endsWith("/sash/web/session")) {
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).has("x-sash-token"), false);
      assert.deepEqual(JSON.parse(String(init?.body)), { token: bootstrapToken });
      return respond({ token, daemonToken: identity.token });
    }
    assert.ok(String(input).endsWith("/sash/daemon/health"));
    assert.equal(new Headers(init?.headers).has("x-sash-token"), false);
    return respond(identity);
  };
  await webSession.initialize(client, () => true);
}

beforeEach(() => {
  window = new HappyWindow({ url: "http://127.0.0.1:29193/ui/" });
  Object.defineProperty(globalThis, "window", { configurable: true, value: window });
  webSession.clear();
});
afterEach(async () => {
  webSession.clear();
  globalThis.fetch = originalFetch;
  await window.happyDOM.close();
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("bootstrap handoff", () => {
  it("redeems the fragment once and scrubs it before any request", async () => {
    const requested: string[] = [];
    window.location.hash = `boot=${bootstrapToken}`;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requested.push(url);
      assert.equal(window.location.hash, "#/", "fragment scrubbed before fetching");
      if (url.endsWith("/sash/web/session")) {
        assert.equal(init?.method, "POST");
        assert.equal(new Headers(init?.headers).has("x-sash-token"), false);
        assert.deepEqual(JSON.parse(String(init?.body)), { token: bootstrapToken });
        return respond({ token: sessionToken, daemonToken: health.token });
      }
      assert.ok(url.endsWith("/sash/daemon/health"));
      assert.equal(new Headers(init?.headers).has("x-sash-token"), false);
      return respond(health);
    };
    const result = await webSession.initialize(client, () => true);
    assert.equal(result.token, health.token);
    assert.equal(result.startedAt, health.startedAt);
    assert.equal(requested.filter((url) => url.endsWith("/sash/web/session")).length, 1);
    assert.equal(webSession.token(), sessionToken);
    assert.equal(sessionReady.value, true);
    assert.equal(webSession.initialized(), true);
    assert.equal(webSession.startedAt(), health.startedAt);
    assert.deepEqual(storedSession(), { token: sessionToken, daemonToken: health.token });
  });

  it("scrubs a malformed fragment without redeeming it", async () => {
    window.location.hash = "boot=not-hex";
    globalThis.fetch = async (input) => {
      assert.ok(String(input).endsWith("/sash/daemon/health"), "no exchange request");
      return respond(health);
    };
    await webSession.initialize(client, () => true);
    assert.equal(window.location.hash, "#/");
    assert.equal(webSession.token(), "");
    assert.equal(webSession.initialized(), true);
  });

  it("continues without a session when the exchange fails", async () => {
    window.location.hash = `boot=${bootstrapToken}`;
    globalThis.fetch = async (input) =>
      String(input).endsWith("/sash/web/session")
        ? respond({ error: { code: "unauthorized", message: "Expired handoff" } }, 401)
        : respond(health);
    await webSession.initialize(client, () => true);
    assert.equal(window.location.hash, "#/", "failed handoffs are still consumed");
    assert.equal(webSession.token(), "");
    assert.equal(sessionReady.value, false);
    assert.equal(webSession.initialized(), true, "public health still initializes the page");
    assert.equal(storedSession(), null);
  });

  it("keeps an exchanged credential dormant when health fails, then adopts it on recovery", async () => {
    window.location.hash = `boot=${bootstrapToken}`;
    globalThis.fetch = async (input) =>
      String(input).endsWith("/sash/web/session")
        ? respond({ token: sessionToken, daemonToken: health.token })
        : respond({ error: { code: "unavailable", message: "daemon down" } }, 503);
    await assert.rejects(webSession.initialize(client, () => true));
    assert.equal(sessionReady.value, false);
    assert.equal(webSession.token(), "");
    assert.equal(webSession.initialized(), false);
    assert.deepEqual(
      storedSession(),
      { token: sessionToken, daemonToken: health.token },
      "the dormant credential survives for the next poll",
    );

    globalThis.fetch = async (input) => {
      assert.ok(String(input).endsWith("/sash/daemon/health"), "no second exchange");
      return respond(health);
    };
    await webSession.initialize(client, () => true);
    assert.equal(webSession.token(), sessionToken);
    assert.equal(sessionReady.value, true);
  });

  it("ignores an inactive poll entirely", async () => {
    window.location.hash = `boot=${bootstrapToken}`;
    globalThis.fetch = async () => respond(health);
    await webSession.initialize(client, () => false);
    assert.equal(window.location.hash, `#boot=${bootstrapToken}`, "fragment untouched");
    assert.equal(webSession.token(), "");
    assert.equal(webSession.initialized(), false);
  });
});

describe("stored session fallback", () => {
  it("restores a stored session for the same daemon without an exchange", async () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ token: sessionToken, daemonToken: health.token }),
    );
    globalThis.fetch = async (input) => {
      assert.ok(String(input).endsWith("/sash/daemon/health"), "no exchange request");
      return respond(health);
    };
    await webSession.initialize(client, () => true);
    assert.equal(webSession.token(), sessionToken);
    assert.equal(sessionReady.value, true);
    assert.equal(webSession.startedAt(), health.startedAt);
  });

  it("keeps a stored session when the daemon restarts", async () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ token: sessionToken, daemonToken: "previous-daemon" }),
    );
    globalThis.fetch = async (input) => {
      assert.ok(String(input).endsWith("/sash/daemon/health"), "no exchange request");
      return respond(health);
    };
    await webSession.initialize(client, () => true);
    assert.equal(webSession.token(), sessionToken);
    assert.equal(sessionReady.value, true);
    assert.deepEqual(storedSession(), { token: sessionToken, daemonToken: health.token });
  });

  it("rejects malformed stored credentials", async () => {
    globalThis.fetch = async () => respond(health);
    for (const stored of ["legacy-token", "null", "{}", JSON.stringify({ token: sessionToken })]) {
      window.sessionStorage.setItem(STORAGE_KEY, stored);
      await webSession.initialize(client, () => true);
      assert.equal(webSession.token(), "");
      assert.equal(storedSession(), null);
    }
  });

  it("continues in memory when sessionStorage access is denied", async () => {
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get: () => {
        throw new Error("Storage blocked");
      },
    });
    await authorize();
    assert.equal(webSession.token(), sessionToken);
    assert.equal(sessionReady.value, true);
  });
});

describe("exchange sharing", () => {
  it("shares a single exchange across concurrent initialization", async () => {
    const pending = Promise.withResolvers<Response>();
    let exchanges = 0;
    window.location.hash = `boot=${bootstrapToken}`;
    globalThis.fetch = async (input) => {
      if (String(input).endsWith("/sash/web/session")) {
        exchanges += 1;
        return pending.promise;
      }
      return respond(health);
    };
    const first = webSession.initialize(client, () => true);
    const second = webSession.initialize(client, () => true);
    pending.resolve(respond({ token: sessionToken, daemonToken: health.token }));
    await Promise.all([first, second]);
    assert.equal(exchanges, 1, "concurrent polls reuse the pending exchange");
    assert.equal(webSession.token(), sessionToken);
    assert.equal(sessionReady.value, true);
  });

  it("does not resurrect a session cleared during the exchange", async () => {
    const pending = Promise.withResolvers<Response>();
    window.location.hash = `boot=${bootstrapToken}`;
    globalThis.fetch = async (input) =>
      String(input).endsWith("/sash/web/session") ? pending.promise : respond(health);
    const initialization = webSession.initialize(client, () => true);
    webSession.clear();
    pending.resolve(respond({ token: sessionToken, daemonToken: health.token }));
    await initialization;
    assert.equal(webSession.token(), "");
    assert.equal(storedSession(), null);
  });
});

describe("credential lifecycle", () => {
  it("revokes only the matching credential", async () => {
    await authorize();
    webSession.reject("f".repeat(64));
    assert.equal(webSession.token(), sessionToken, "a stale rejection is ignored");
    webSession.reject(sessionToken);
    assert.equal(webSession.token(), "");
    assert.equal(sessionReady.value, false);
    assert.equal(storedSession(), null);
  });

  it("matches only the current daemon identity", async () => {
    await authorize();
    assert.equal(webSession.matches(health.token), true);
    assert.equal(webSession.matches("another-daemon"), false);
    assert.equal(webSession.token(), "", "a mismatch invalidates the session");
    assert.equal(sessionReady.value, false);
  });

  it("markDisconnected keeps the dormant credential without reporting ready", async () => {
    await authorize();
    webSession.markDisconnected();
    assert.equal(sessionReady.value, false);
    assert.equal(webSession.token(), "");
    assert.equal(webSession.initialized(), false);
    assert.deepEqual(storedSession(), {
      token: sessionToken,
      daemonToken: health.token,
    });
  });

  it("clear invalidates the session and bumps the generation", async () => {
    await authorize();
    const generation = webSession.generation();
    webSession.clear();
    assert.equal(webSession.generation(), generation + 1);
    assert.equal(webSession.token(), "");
    assert.equal(webSession.startedAt(), null);
    assert.equal(webSession.initialized(), false);
    assert.equal(storedSession(), null);
  });
});
