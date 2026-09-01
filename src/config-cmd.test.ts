import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requiresRestart, validateController } from "./commands/config-cmd.js";

describe("requiresRestart", () => {
  it("returns true for listener/auth keys", () => {
    for (const key of ["controller", "secret", "tun", "mixed-port", "allow-lan"]) {
      assert.equal(requiresRestart(key), true, key);
    }
  });

  it("returns false for other keys", () => {
    for (const key of ["mode", "log-level", "dns", "", "unknown"]) {
      assert.equal(requiresRestart(key), false, key);
    }
  });
});

describe("validateController", () => {
  it("accepts loopback host:port addresses", () => {
    for (const v of ["127.0.0.1:9090", "localhost:8080", "[::1]:9090", " 127.0.0.1:9090 "]) {
      assert.equal(validateController(v), true, v);
    }
  });

  it("rejects non-loopback and invalid addresses", () => {
    for (const v of [
      "0.0.0.0:80",
      "192.168.1.2:9090",
      "controller.example:9090",
      "127.0.0.1:0",
      "127.0.0.1:65536",
      "127.0.0.1",
      "",
      "   ",
      "host:abc",
      "[::1]",
      "host:9090/path",
      "host:9090?q=1",
      "user@host:9090",
      "host: 9090",
    ]) {
      assert.equal(validateController(v), false, JSON.stringify(v));
    }
  });
});
