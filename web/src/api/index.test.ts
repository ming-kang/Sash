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
    await assert.rejects(() => api.initialize(), /token/);
    assert.equal(api.hasSession(), false);
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
