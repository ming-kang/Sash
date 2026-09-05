import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { api } from "./index.js";

const originalFetch = globalThis.fetch;

function respond(document: unknown, status = 200): Response {
  return new Response(JSON.stringify(document), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(handler: (url: string) => Response): void {
  globalThis.fetch = (async (input) => handler(String(input))) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  api.clearSession();
});

describe("WebUI daemon response contracts", () => {
  it("clears an existing session when initialize receives malformed health JSON", async () => {
    const responses = [
      { token: "boot-token", pid: 1234, startedAt: "2026-01-01T00:00:00.000Z" },
      { token: "", pid: 1234, startedAt: "2026-01-01T00:00:00.000Z" },
    ];
    mockFetch(() => respond(responses.shift()));

    await api.initialize();
    assert.equal(api.hasSession(), true);
    assert.equal(api.getSessionDaemonStartedAt(), "2026-01-01T00:00:00.000Z");
    await assert.rejects(() => api.initialize(), /token/);
    assert.equal(api.hasSession(), false);
    assert.equal(api.getSessionDaemonStartedAt(), null);
  });

  it("rejects malformed health and status snapshots instead of trusting casts", async () => {
    mockFetch((url) =>
      url.endsWith("/sash/daemon/health")
        ? respond({ token: "token", pid: 0, startedAt: "invalid" })
        : respond({}),
    );

    await assert.rejects(() => api.getHealth(), /pid/);
    await assert.rejects(() => api.getStatus(), /daemon/);
  });
});

describe("session request ownership", () => {
  it("does not clear a newer session after an older initialize fails", async () => {
    const pending = Promise.withResolvers<Response>();
    globalThis.fetch = async () => pending.promise;
    const old = api.initialize();
    mockFetch(() =>
      respond({ token: "new-token", pid: 1234, startedAt: "2026-01-01T00:00:00.000Z" }),
    );
    await api.initialize();
    pending.reject(new Error("old health failure"));
    await assert.rejects(old, /old health failure/);
    assert.equal(api.hasSession(), true);
    assert.equal(api.getSessionDaemonStartedAt(), "2026-01-01T00:00:00.000Z");
    globalThis.fetch = async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("x-sash-token"), "new-token");
      return respond({});
    };
    await api.getConfigs();
  });

  it("does not clear a session for an inactive poll", async () => {
    mockFetch(() =>
      respond({ token: "new-token", pid: 1234, startedAt: "2026-01-01T00:00:00.000Z" }),
    );
    await api.initialize();
    mockFetch(() => respond({}, 503));
    await assert.rejects(api.initialize(() => false));
    assert.equal(api.hasSession(), true);
    assert.equal(api.getSessionDaemonStartedAt(), "2026-01-01T00:00:00.000Z");
    globalThis.fetch = async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("x-sash-token"), "new-token");
      return respond({});
    };
    await api.getConfigs();
  });
});

for (const cleared of [false, true]) {
  it(`keeps token and boot together after stale initialize succeeds (cleared: ${cleared})`, async () => {
    const pending = Promise.withResolvers<Response>();
    globalThis.fetch = async () => pending.promise;
    const old = api.initialize();
    mockFetch(() =>
      respond({ token: "new-token", pid: 1234, startedAt: "2026-02-01T00:00:00.000Z" }),
    );
    await api.initialize();
    if (cleared) api.clearSession();
    pending.resolve(
      respond({ token: "old-token", pid: 1234, startedAt: "2026-01-01T00:00:00.000Z" }),
    );
    await old;
    assert.equal(api.getSessionDaemonStartedAt(), cleared ? null : "2026-02-01T00:00:00.000Z");
    globalThis.fetch = async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("x-sash-token"), cleared ? null : "new-token");
      return respond({});
    };
    await api.getConfigs();
  });
}
