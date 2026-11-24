import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, onTestFinished } from "vitest";
import YAML from "yaml";
import { DaemonTestHarness } from "./testing/daemon-harness.js";
import { unsupportedTunPlatform } from "./tun-service.js";

describe("daemon configuration plugins", () => {
  it("lets a user plugin rewrite the generated Core configuration", async () => {
    const h = new DaemonTestHarness();
    h.setup();
    onTestFinished(async () => {
      await h.cleanup();
    });
    fs.mkdirSync(h.layout.pluginsDir, { recursive: true });
    fs.writeFileSync(
      path.join(h.layout.pluginsDir, "marker.js"),
      `module.exports = {
        name: "marker",
        onGenerate(config) {
          config["external-controller"] = "127.0.0.1:39999";
          config.tun = { enable: true, stack: "system" };
          config["x-plugin-marker"] = "applied";
          return config;
        },
      };`,
    );
    await h.startServer();
    assert.equal((await h.apiRequest("/sash/core/start", { method: "POST" })).statusCode, 200);
    const written = YAML.parse(fs.readFileSync(h.layout.configFile, "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(written["x-plugin-marker"], "applied");
    assert.equal(written["external-controller"], "127.0.0.1:39999");
    assert.deepEqual(written.tun, { enable: false, stack: "system" });
  });

  it("re-applies enabled TUN settings after a generation plugin", async () => {
    const h = new DaemonTestHarness();
    h.setup();
    onTestFinished(async () => {
      await h.cleanup();
    });
    fs.mkdirSync(h.layout.pluginsDir, { recursive: true });
    fs.writeFileSync(
      path.join(h.layout.pluginsDir, "tun.js"),
      `module.exports = {
        name: "tun",
        onGenerate(config) {
          config.tun = {
            enable: false,
            stack: "system",
            "auto-route": false,
            mtu: 1400,
            "dns-hijack": ["any:53"],
          };
          config.dns = { enable: false, nameserver: ["1.1.1.1"] };
          return config;
        },
      };`,
    );
    await h.startServer({
      tunPlatform: {
        ...unsupportedTunPlatform(),
        mechanism: "capabilities",
        inspect: async () => ({ state: "ready" }),
      },
    });
    await h.apiRequest("/sash/settings", {
      method: "PATCH",
      body: { tun: { enable: true, stack: "gvisor" } },
    });
    assert.equal(
      await h.apiRequest("/sash/core/restart", { method: "POST" }).then((r) => r.statusCode),
      200,
    );
    const written = YAML.parse(fs.readFileSync(h.layout.configFile, "utf8")) as {
      tun: unknown;
      dns: unknown;
    };
    assert.deepEqual(written.tun, {
      enable: true,
      stack: "gvisor",
      "auto-route": true,
      "strict-route": false,
      "auto-detect-interface": true,
      mtu: 1400,
      "dns-hijack": ["any:53", "tcp://any:53"],
      "route-exclude-address": [],
    });
    assert.deepEqual(written.dns, {
      listen: "127.0.0.1:1053",
      "enhanced-mode": "fake-ip",
      enable: true,
      nameserver: ["1.1.1.1"],
    });
  });

  it("generates an unchanged configuration when no plugins exist", async () => {
    const h = new DaemonTestHarness();
    h.setup();
    onTestFinished(async () => {
      await h.cleanup();
    });
    await h.startServer();
    assert.equal((await h.apiRequest("/sash/core/start", { method: "POST" })).statusCode, 200);
    const written = YAML.parse(fs.readFileSync(h.layout.configFile, "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(written["x-plugin-marker"], undefined);
  });
});
