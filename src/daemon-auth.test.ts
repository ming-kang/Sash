import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";
import {
  isControlMutation,
  isControlRequestAuthorized,
  isLoopbackHostHeader,
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
});
