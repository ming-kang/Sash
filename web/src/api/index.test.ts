import assert from "node:assert/strict";
import { Window as HappyWindow } from "happy-dom";
import { afterEach, beforeEach, describe, it } from "vitest";
import { api } from "./index.js";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
let window: HappyWindow;

function respond(document: unknown, status = 200): Response {
  return Response.json(document, { status });
}

beforeEach(() => {
  window = new HappyWindow({ url: "http://127.0.0.1:29193/ui/" });
  Object.defineProperty(globalThis, "window", { configurable: true, value: window });
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalWebSocket) Object.defineProperty(globalThis, "WebSocket", originalWebSocket);
  else Reflect.deleteProperty(globalThis, "WebSocket");
  await window.happyDOM.close();
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("dashboard transport", () => {
  it("sends Sash and Core requests without any credential of its own", async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = async (input, init) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) });
      return respond(
        String(input).includes("/sash/profiles") ? { activeId: null, profiles: [] } : {},
      );
    };
    await api.getConfigs();
    await api.getProfiles();
    assert.deepEqual(
      seen.map((request) => request.url),
      ["/core/api/configs", "/sash/profiles"],
    );
    for (const request of seen) {
      assert.equal(request.headers.has("authorization"), false, request.url);
      assert.equal(request.headers.has("x-sash-token"), false, request.url);
    }
  });

  it("surfaces a refusal as the daemon's own error", async () => {
    globalThis.fetch = async () =>
      respond({ error: { code: "unauthorized", message: "Unauthorized control request" } }, 401);
    await assert.rejects(api.getConfigs(), /Unauthorized control request/);
  });

  it("opens Core streams on the page's own host without credential subprotocols", () => {
    const sockets: Array<{ url: string; protocols: unknown }> = [];
    class FakeWebSocket {
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(url: string, protocols?: unknown) {
        sockets.push({ url, protocols });
      }
      close(): void {}
    }
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
    const stop = api.connectTraffic(() => undefined);
    stop();
    assert.deepEqual(sockets, [
      { url: "ws://127.0.0.1:29193/core/api/traffic", protocols: undefined },
    ]);
  });
});
