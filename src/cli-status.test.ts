import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { printStatus } from "./cli-status.js";
import { runStatus } from "./commands/status.js";
import { readSashPackageInfo } from "./package-info.js";
import { sashLayout } from "./paths.js";
import { cliStatusFromDaemonStatus } from "./status.js";
import { testSettings, testStatus } from "./testing/state.js";

it("renders six aligned summary rows and preserves detail in verbose and JSON output", async (t) => {
  const wire = testStatus();
  wire.daemon.version = readSashPackageInfo().version;
  const status = cliStatusFromDaemonStatus(
    { layout: sashLayout(path.join(os.tmpdir(), "sash-copy-fixture")), settings: testSettings() },
    wire,
    { state: "on", canEnable: true, reason: null },
    { installedCoreVersion: "v1.0.0", uiInstalled: true },
  );
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  printStatus(status);
  assert.equal(lines.length, 6);
  assert.deepEqual(
    lines.map((line) => line.slice(0, 14).trim()),
    ["Status", "Proxy Port", "System Proxy", "WebUI", "Auto Start", "Data Folder"],
  );
  assert.equal(lines[0], "Status        Sash & Core Running");
  lines.length = 0;
  printStatus(status, true);
  assert.ok(lines.some((line) => line.startsWith("Core Config")));
  lines.length = 0;
  await runStatus({ verbose: true, json: true }, async () => status);
  assert.deepEqual(JSON.parse(lines.join("\n")), status);
});

it("does not present stopped or unobserved endpoints as available, and preserves warnings", (t) => {
  const wire = testStatus();
  wire.daemon.version = readSashPackageInfo().version;
  const status = cliStatusFromDaemonStatus(
    { layout: sashLayout(path.join(os.tmpdir(), "sash-copy-fixture")), settings: testSettings() },
    wire,
    { state: "stale", canEnable: true, reason: "Missing launcher" },
    { installedCoreVersion: "v1.0.0", uiInstalled: true },
  );
  const lines: string[] = [];
  const warnings: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  t.mock.method(console, "warn", (line: string) => warnings.push(line));
  status.core.running = false;
  status.systemProxy.osObserved.enabled = true;
  printStatus(status);
  assert.equal(lines[1], "Proxy Port    Off");
  assert.equal(lines[2], "System Proxy  On");
  assert.ok(warnings.some((line) => line.includes("configured Off")));
  assert.ok(lines.some((line) => line.includes("sash auto on")));
  lines.length = 0;
  status.daemon.state = "unhealthy";
  status.core.running = null;
  printStatus(status);
  assert.equal(lines[1], "Proxy Port    Unknown");
  assert.equal(lines[3], "WebUI         Unknown");
});
