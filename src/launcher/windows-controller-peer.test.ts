import assert from "node:assert/strict";
import { it } from "vitest";
import { windowsOwnsControllerConnection } from "./windows-controller-peer.js";

it("requires the Core PID on the exact established server side of a loopback connection", () => {
  const table = [
    "TCP  127.0.0.1:4000  0.0.0.0:0  LISTENING  42",
    "TCP  127.0.0.1:4000  127.0.0.1:6000  ESTABLISHED  17",
    "TCP  127.0.0.1:6000  127.0.0.1:4000  ESTABLISHED  42",
    "TCP  127.0.0.1:4000  127.0.0.1:6001  ESTABLISHED  42",
  ].join("\r\n");
  assert.equal(windowsOwnsControllerConnection(table, 4000, 6001, 42), true);
  assert.equal(windowsOwnsControllerConnection(table, 4000, 6000, 42), false);
  assert.equal(windowsOwnsControllerConnection(table, 4000, 6002, 42), false);
});
