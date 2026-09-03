import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";
import {
  coreWebSocketProtocols,
  isControlMutation,
  isControlRequestAuthorized,
  isLoopbackHostHeader,
  isLoopbackOriginHeader,
  isWebSocketRequestAuthorized,
  webSocketAuthResponseProtocol,
} from "./daemon-auth.js";

function request(headers: IncomingMessage["headers"]): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("daemon control authorization", () => {
  const opts = { daemonSecret: "persistent-secret", bootToken: "boot-token" };

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

  it("accepts the CLI bearer or WebUI boot token and rejects invalid credentials", () => {
    assert.equal(
      isControlRequestAuthorized(request({ authorization: "Bearer persistent-secret" }), opts),
      true,
    );
    assert.equal(isControlRequestAuthorized(request({ "x-sash-token": "boot-token" }), opts), true);
    assert.equal(
      isControlRequestAuthorized(request({ authorization: "Bearer wrong" }), opts),
      false,
    );
    assert.equal(isControlRequestAuthorized(request({}), opts), false);
  });

  it("accepts WebSocket bearer/header auth or the private token subprotocol", () => {
    assert.equal(
      isWebSocketRequestAuthorized(
        request({ "sec-websocket-protocol": "chat, sash-token.boot-token" }),
        opts,
      ),
      true,
    );
    assert.equal(
      isWebSocketRequestAuthorized(request({ authorization: "Bearer persistent-secret" }), opts),
      true,
    );
    assert.equal(
      isWebSocketRequestAuthorized(request({ "sec-websocket-protocol": "sash-token.wrong" }), opts),
      false,
    );
    assert.equal(
      coreWebSocketProtocols("sash, chat, sash-token.boot-token, telemetry"),
      "chat, telemetry",
    );
    assert.equal(coreWebSocketProtocols("sash, sash-token.boot-token"), undefined);
    assert.equal(webSocketAuthResponseProtocol("sash, sash-token.boot-token"), "sash");
    assert.equal(webSocketAuthResponseProtocol("sash-token.boot-token"), "sash-token.boot-token");
  });
});
