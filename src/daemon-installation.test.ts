import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { DaemonStatus, HealthInfo } from "./contracts.js";
import { useDaemonTestHarness } from "./testing/daemon-harness.js";

describe("daemon installation identity", () => {
  const h = useDaemonTestHarness();
  it("reports the startup version after the package manifest changes on disk", async () => {
    const root = path.join(h.layout.root, "package");
    fs.mkdirSync(root);
    const file = path.join(root, "package.json");
    const info = {
      name: "@astralyn/sash",
      version: "1.2.3",
      bin: { sash: "dist/cli.js" },
      engines: { node: ">=24" },
    };
    fs.writeFileSync(file, JSON.stringify(info));
    await h.startServer({ packageRoot: root });
    fs.writeFileSync(file, JSON.stringify({ ...info, version: "1.2.4" }));
    const health = (await h.apiRequest("/sash/daemon/health")).data as HealthInfo;
    const status = (await h.apiRequest("/sash/daemon/status")).data as DaemonStatus;
    assert.equal(health.version, "1.2.3");
    assert.equal(status.daemon.version, "1.2.3");
  });
});
