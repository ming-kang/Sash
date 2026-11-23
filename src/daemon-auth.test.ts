import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { describe, it } from "vitest";
import {
  isControlMutation,
  isControlRequestAuthorized,
  isLoopbackHostHeader,
  isLoopbackOriginHeader,
  isSameOriginBrowserRequest,
} from "./daemon/auth.js";

function request(headers: IncomingMessage["headers"]): IncomingMessage {
  return { headers: { host: "127.0.0.1:19090", ...headers } } as IncomingMessage;
}

describe("daemon control authorization", () => {
  it("accepts only loopback Host headers", () => {
    assert.equal(isLoopbackHostHeader("127.0.0.1:19090"), true);
    assert.equal(isLoopbackHostHeader("localhost:19090"), true);
    assert.equal(isLoopbackHostHeader("[::1]:19090"), true);
    assert.equal(isLoopbackHostHeader("attacker.example:19090"), false);
    assert.equal(isLoopbackHostHeader(undefined), false);
  });

  it("accepts missing or loopback Origins and rejects remote Origins", () => {
    assert.equal(isLoopbackOriginHeader(undefined), true);
    assert.equal(isLoopbackOriginHeader("http://127.0.0.1:19090"), true);
    assert.equal(isLoopbackOriginHeader("http://localhost:19090"), true);
    assert.equal(isLoopbackOriginHeader("https://attacker.example"), false);
    assert.equal(isLoopbackOriginHeader("not a url"), false);
  });

  it("classifies only state-changing methods as mutations", () => {
    assert.equal(isControlMutation("GET"), false);
    assert.equal(isControlMutation("HEAD"), false);
    assert.equal(isControlMutation("OPTIONS"), false);
    assert.equal(isControlMutation("POST"), true);
    assert.equal(isControlMutation("PATCH"), true);
  });

  it("recognizes requests from a page on the daemon's own origin", () => {
    assert.equal(isSameOriginBrowserRequest(request({ origin: "http://127.0.0.1:19090" })), true);
    assert.equal(isSameOriginBrowserRequest(request({ "sec-fetch-site": "same-origin" })), true);
    assert.equal(
      isSameOriginBrowserRequest(
        request({ host: "localhost:19090", origin: "http://LOCALHOST:19090" }),
      ),
      true,
    );
  });

  it("refuses other origins, other provenance and non-loopback hosts", () => {
    for (const headers of [
      { origin: "http://127.0.0.1:19091" },
      { origin: "http://localhost:19090" },
      { origin: "https://127.0.0.1:19090" },
      { origin: "null" },
      { origin: "http://127.0.0.1:19091", "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "none" },
      {},
      { host: "attacker.example:19090", origin: "http://attacker.example:19090" },
      { host: "attacker.example:19090", "sec-fetch-site": "same-origin" },
    ]) {
      assert.equal(isSameOriginBrowserRequest(request(headers)), false, JSON.stringify(headers));
    }
  });

  it("accepts the CLI bearer or the dashboard origin, and an explicit bearer must be right", () => {
    const secret = "persistent-secret";
    assert.equal(
      isControlRequestAuthorized(request({ authorization: "Bearer persistent-secret" }), secret),
      true,
    );
    assert.equal(
      isControlRequestAuthorized(request({ "sec-fetch-site": "same-origin" }), secret),
      true,
    );
    assert.equal(
      isControlRequestAuthorized(
        request({ authorization: "Bearer wrong", "sec-fetch-site": "same-origin" }),
        secret,
      ),
      false,
    );
    assert.equal(
      isControlRequestAuthorized(request({ authorization: "Bearer wrong" }), secret),
      false,
    );
    assert.equal(isControlRequestAuthorized(request({}), secret), false);
  });
});
