import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Window as HappyWindow } from "happy-dom";
import type { HealthInfo } from "../../../src/contracts.js";
import { api, sessionReady } from "./index.js";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const STORAGE_KEY = "sash.control-token";
const bootstrapToken = "b".repeat(64);
const sessionToken = "a".repeat(64);
const health: HealthInfo = {
  token: "public-identity",
  pid: 1234,
  startedAt: "2026-01-01T00:00:00.000Z",
};
let window: HappyWindow;

function respond(document: unknown, status = 200): Response {
  return Response.json(document, { status });
}

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
    return respond(identity);
  };
  await api.initialize();
}

beforeEach(() => {
  window = new HappyWindow({ url: "http://127.0.0.1:29193/ui/" });
  Object.defineProperty(globalThis, "window", { configurable: true, value: window });
  api.clearSession();
});
afterEach(async () => {
  api.clearSession();
  globalThis.fetch = originalFetch;
  await window.happyDOM.close();
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("browser authorization", () => {
  it("keeps a dormant credential through disconnection and exchanges it only for an advertised upgrade", async () => {
    const source = { ...health, token: "b".repeat(48) };
    const target = {
      ...health,
      token: "c".repeat(48),
      webContinuation: {
        bootIds: [source.token],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    await authorize(sessionToken, source);
    api.markDisconnected();
    globalThis.fetch = async () => {
      throw new Error("connection refused");
    };
    await assert.rejects(api.initialize(), /connection refused/);
    assert.equal(api.hasSession(), false);
    assert.ok(window.sessionStorage.getItem(STORAGE_KEY));
    assert.equal(api.sessionMatches(target.token), false);
    const renewed = "d".repeat(64);
    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith("/sash/web/continue")) {
        assert.deepEqual(JSON.parse(String(init?.body)), {
          token: sessionToken,
          daemonToken: source.token,
        });
        assert.equal(new Headers(init?.headers).has("x-sash-token"), false);
        return respond({ token: renewed, daemonToken: target.token });
      }
      return respond(target);
    };
    await api.initialize();
    assert.equal(api.hasSession(), true);
    assert.deepEqual(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? ""), {
      token: renewed,
      daemonToken: target.token,
    });
  });

  it("does not resurrect an explicitly cleared credential during upgrade continuation", async () => {
    const source = { ...health, token: "b".repeat(48) };
    await authorize(sessionToken, source);
    const pending = Promise.withResolvers<Response>();
    const entered = Promise.withResolvers<void>();
    globalThis.fetch = async (input) => {
      if (String(input).endsWith("/sash/web/continue")) {
        entered.resolve();
        return pending.promise;
      }
      return respond({
        ...health,
        token: "c".repeat(48),
        webContinuation: {
          bootIds: [source.token],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
    };
    const initialization = api.initialize();
    await entered.promise;
    api.clearSession();
    pending.resolve(respond({ token: "d".repeat(64), daemonToken: "c".repeat(48) }));
    await initialization;
    assert.equal(api.hasSession(), false);
    assert.equal(window.sessionStorage.getItem(STORAGE_KEY), null);
  });
  it("never acquires a control session from public health", async () => {
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return respond(health);
    };
    await api.initialize();
    assert.equal(api.hasSession(), false);
    assert.equal(sessionReady.value, false);
    await assert.rejects(api.getConfigs(), /sash web/);
    assert.equal(requests, 1, "no unauthorized Core request");
  });

  it("exchanges the handoff once, retains a daemon-bound session, and uses private headers", async () => {
    await authorize();
    assert.equal(api.hasSession(), true);
    assert.equal(sessionReady.value, true);
    assert.equal(api.getSessionDaemonStartedAt(), health.startedAt);
    assert.deepEqual(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? ""), {
      token: sessionToken,
      daemonToken: health.token,
    });
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input).includes(sessionToken), false);
      assert.equal(new Headers(init?.headers).get("x-sash-token"), sessionToken);
      return respond({});
    };
    await api.getConfigs();
  });

  it("restores only a saved session belonging to the same daemon", async () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ token: sessionToken, daemonToken: health.token }),
    );
    globalThis.fetch = async (input, init) => {
      assert.ok(String(input).endsWith("/sash/daemon/health"));
      assert.equal(new Headers(init?.headers).has("x-sash-token"), false);
      return respond(health);
    };
    await api.initialize();
    assert.equal(api.hasSession(), true);
    // The nonce distinguishes restarts even if wall-clock timestamps coincide.
    globalThis.fetch = async () => respond({ ...health, token: "restarted" });
    await api.initialize();
    assert.equal(api.hasSession(), false);
    assert.equal(window.sessionStorage.getItem(STORAGE_KEY), null);
  });

  it("rejects obsolete or malformed stored credentials", async () => {
    globalThis.fetch = async () => respond(health);
    for (const stored of [
      "legacy-boot-token",
      "null",
      "{}",
      JSON.stringify({ token: health.token }),
    ]) {
      window.sessionStorage.setItem(STORAGE_KEY, stored);
      await api.initialize();
      assert.equal(api.hasSession(), false);
      assert.equal(window.sessionStorage.getItem(STORAGE_KEY), null);
    }
  });

  it("recovers from expired or replayed handoffs through a fresh sash web authorization", async () => {
    window.location.hash = `boot=${bootstrapToken}`;
    globalThis.fetch = async (input) =>
      String(input).endsWith("/sash/web/session")
        ? respond({ error: { code: "unauthorized", message: "Expired" } }, 401)
        : respond(health);
    await api.initialize();
    assert.equal(window.location.hash, "#/");
    assert.equal(api.hasSession(), false);
    await authorize();
    assert.equal(api.hasSession(), true);
  });

  it("scrubs malformed fragments without trying to redeem them", async () => {
    window.location.hash = "boot=invalid";
    globalThis.fetch = async (input) => {
      assert.ok(String(input).endsWith("/sash/daemon/health"));
      return respond(health);
    };
    await api.initialize();
    assert.equal(window.location.hash, "#/");
    assert.equal(api.hasSession(), false);
  });

  it("continues in memory when sessionStorage access is denied", async () => {
    Object.defineProperty(window, "sessionStorage", {
      get: () => {
        throw new Error("Storage blocked");
      },
    });
    await authorize();
    assert.equal(api.hasSession(), true);
    api.clearSession();
    assert.equal(api.hasSession(), false);
  });

  it("clears an existing session on malformed health and rejects malformed status", async () => {
    await authorize();
    globalThis.fetch = async () => respond({ ...health, token: "" });
    await assert.rejects(api.initialize(), /token/);
    assert.equal(api.hasSession(), false);
    assert.equal(api.getSessionDaemonStartedAt(), null);
    globalThis.fetch = async () => respond({});
    await assert.rejects(api.getStatus(), /daemon/);
  });
});

describe("session request ownership", () => {
  it("shares a single-use exchange across overlapping initialization", async () => {
    const pending = Promise.withResolvers<Response>();
    let exchanges = 0;
    window.location.hash = `boot=${bootstrapToken}`;
    globalThis.fetch = async (input) => {
      if (String(input).endsWith("/sash/web/session")) {
        exchanges++;
        return pending.promise;
      }
      return respond(health);
    };
    const old = api.initialize();
    const newer = api.initialize();
    pending.resolve(respond({ token: sessionToken, daemonToken: health.token }));
    await Promise.all([old, newer]);
    assert.equal(exchanges, 1);
    assert.equal(api.hasSession(), true);
  });

  it("does not resurrect a session cleared during bootstrap exchange", async () => {
    const pending = Promise.withResolvers<Response>();
    window.location.hash = `boot=${bootstrapToken}`;
    globalThis.fetch = async (input) =>
      String(input).endsWith("/sash/web/session") ? pending.promise : respond(health);
    const old = api.initialize();
    api.clearSession();
    pending.resolve(respond({ token: sessionToken, daemonToken: health.token }));
    await old;
    assert.equal(api.hasSession(), false);
    assert.equal(window.sessionStorage.getItem(STORAGE_KEY), null);
  });

  it("does not clear a newer session after an older initialize fails", async () => {
    const pending = Promise.withResolvers<Response>();
    globalThis.fetch = async () => pending.promise;
    const old = api.initialize();
    await authorize();
    pending.reject(new Error("old health failure"));
    await assert.rejects(old, /old health failure/);
    assert.equal(api.hasSession(), true);
    assert.equal(api.getSessionDaemonStartedAt(), health.startedAt);
  });

  it("does not adopt or clear credentials for an inactive poll", async () => {
    await authorize();
    globalThis.fetch = async () => respond({}, 503);
    await assert.rejects(api.initialize(() => false));
    assert.equal(api.hasSession(), true);
    assert.equal(api.getSessionDaemonStartedAt(), health.startedAt);
  });

  for (const cleared of [false, true]) {
    it(`keeps credentials and daemon identity together after stale health succeeds (cleared: ${cleared})`, async () => {
      const pending = Promise.withResolvers<Response>();
      globalThis.fetch = async () => pending.promise;
      const old = api.initialize();
      await authorize();
      if (cleared) api.clearSession();
      pending.resolve(
        respond({ ...health, token: "old-identity", startedAt: "2025-01-01T00:00:00.000Z" }),
      );
      await old;
      assert.equal(api.getSessionDaemonStartedAt(), cleared ? null : health.startedAt);
      assert.equal(api.hasSession(), !cleared);
    });
  }

  for (const gateway of [false, true]) {
    it(`ignores an old credential rejection after reauthorization (gateway: ${gateway})`, async () => {
      await authorize();
      const pending = Promise.withResolvers<Response>();
      globalThis.fetch = async () => pending.promise;
      const old = gateway ? api.getConfigs() : api.getProfiles();
      await authorize("c".repeat(64));
      pending.resolve(
        respond({ error: { code: "unauthorized", message: "Expired session" } }, 401),
      );
      await assert.rejects(old);
      assert.equal(api.hasSession(), true);
      globalThis.fetch = async (_input, init) => {
        assert.equal(new Headers(init?.headers).get("x-sash-token"), "c".repeat(64));
        return respond({});
      };
      await api.getConfigs();
    });
  }
});
