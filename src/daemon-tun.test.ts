import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { describe, it } from "node:test";
import YAML from "yaml";
import type { CoreSupervisor } from "./daemon.js";
import { useDaemonTestHarness } from "./daemon-test-harness.test.js";
import { renderConfig } from "./mihomo-config.js";
import { saveProfiles } from "./profiles.js";

// Real daemon/controller HTTP boundaries, but no Core executable or OS TUN device.
describe("TUN profile reload verification", () => {
  const h = useDaemonTestHarness();

  for (const observation of [true, false, undefined]) {
    it(`verifies ${String(observation)} after a profile changes the TUN stack`, async () => {
      const original = "tun:\n  stack: mixed\nproxies: []\nrules: [MATCH,DIRECT]\n";
      const candidate = original.replace("mixed", "system");
      const profileFile = path.join(h.layout.profilesDir, "1.yaml");
      fs.mkdirSync(h.layout.profilesDir, { recursive: true });
      fs.writeFileSync(profileFile, original);
      saveProfiles(
        {
          activeId: "1",
          profiles: [
            {
              id: "1",
              name: "TUN test",
              url: "",
              intervalHours: 0,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        h.layout,
      );

      let reported: boolean | undefined = true;
      let reloads = 0;
      let probes = 0;
      const server = http.createServer((req, res) => {
        if (req.method === "PUT" && req.url === "/configs?force=true") {
          reloads++;
          reported = fs.readFileSync(h.layout.configFile, "utf8").includes("stack: system")
            ? observation
            : true;
          req.resume();
          res.writeHead(204).end();
        } else if (req.method === "GET" && req.url === "/configs") {
          probes++;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ tun: reported === undefined ? {} : { enable: reported } }));
        } else {
          res.writeHead(404).end();
        }
      });
      h.mockCoreServer = server;
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address === "object");
      h.settings = {
        ...h.settings,
        mixedPort: 27890,
        daemonPort: 29092,
        controller: `127.0.0.1:${address.port}`,
        tun: true,
      };
      const originalConfig = renderConfig(
        YAML.parse(original) as Record<string, unknown>,
        h.settings,
        "subscription",
      ).yaml;
      fs.writeFileSync(h.layout.configFile, originalConfig);
      await h.startServer({
        supervisor: {
          isRunning: () => true,
          stop: async () => {},
          cleanStaleCore: async () => {},
        } as unknown as CoreSupervisor,
      });
      const settingsBefore = fs.readFileSync(h.layout.settingsFile, "utf8");
      const res = await h.apiRequest("/sash/profiles/1/content", {
        method: "PUT",
        body: { content: candidate },
      });
      assert.equal(res.statusCode, observation === true ? 200 : 409);
      if (observation !== true) {
        assert.equal(
          (res.data as { error: { code: string } }).error.code,
          observation === false ? "tun_inactive" : "tun_unverified",
        );
      }
      assert.equal(reloads, observation === true ? 1 : 2);
      assert.equal(probes, reloads);
      assert.equal(
        fs.readFileSync(profileFile, "utf8"),
        observation === true ? candidate : original,
      );
      assert.equal(fs.readFileSync(h.layout.settingsFile, "utf8"), settingsBefore);
      assert.equal(reported, true);
      assert.equal(fs.existsSync(h.layout.managedStateTransactionFile), false);
      if (observation !== true) {
        assert.equal(fs.readFileSync(h.layout.configFile, "utf8"), originalConfig);
      }
    });
  }
});
