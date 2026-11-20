import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, onTestFinished } from "vitest";
import YAML from "yaml";
import { DaemonTestHarness } from "./testing/daemon-harness.js";

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
