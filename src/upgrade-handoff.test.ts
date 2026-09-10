import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { canonicalPath } from "./installation.js";
import { sashLayout } from "./paths.js";
import type { UpgradeAccess } from "./upgrade-access.js";
import {
  readUpgradeHandoff,
  type UpgradeHandoff,
  upgradeHandoffPath,
  writeUpgradeHandoff,
} from "./upgrade-handoff.js";

const access: UpgradeAccess = {
  transactionId: "a".repeat(32),
  installationId: "b".repeat(64),
  grant: "c".repeat(64),
};

describe("upgrade handoff compatibility", () => {
  let root: string;
  let layout: ReturnType<typeof sashLayout>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-handoff-test-"));
    layout = sashLayout(root);
    fs.mkdirSync(layout.stateDir, { recursive: true });
  });

  afterEach(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  function legacyPayload(): Record<string, unknown> {
    return {
      protocol: 1,
      transactionId: access.transactionId,
      installationId: access.installationId,
      dataDir: canonicalPath(layout.root),
      sourceBootId: "d".repeat(48),
      sourceVersion: "0.1.4",
      targetVersion: "0.1.7",
      nodePath: process.execPath,
      nodeHistory: [process.execPath],
      createdAt: new Date(0).toISOString(),
      stateRevision: 0,
      stateSha256: "e".repeat(64),
      coreInstallation: null,
      runtime: { configuration: null, running: false, systemProxyApplied: false, core: null },
      autostart: { state: "off", canEnable: true, reason: null },
      sessions: [],
      continuationExpiresAt: new Date(86_400_000).toISOString(),
      phase: "stopped",
      restoredBootId: null,
    };
  }

  /** Exactly the envelope 0.1.3/0.1.4 write, MAC input included. */
  function writeLegacyEnvelope(payload: Record<string, unknown>): void {
    const mac = crypto
      .createHmac("sha256", access.grant)
      .update(`sash-upgrade-handoff\0${JSON.stringify(payload)}`)
      .digest("hex");
    fs.writeFileSync(upgradeHandoffPath(layout), `${JSON.stringify({ payload, mac })}\n`);
  }

  function readRawPayload(): Record<string, unknown> {
    const value = JSON.parse(fs.readFileSync(upgradeHandoffPath(layout), "utf8")) as {
      payload: Record<string, unknown>;
      mac: string;
    };
    return value.payload;
  }

  function nativeHandoff(): UpgradeHandoff {
    return {
      protocol: 1,
      transactionId: access.transactionId,
      installationId: access.installationId,
      dataDir: canonicalPath(layout.root),
      sourceBootId: "d".repeat(48),
      sourceVersion: "0.1.7",
      targetVersion: "0.1.7",
      nodeHistory: [process.execPath],
      createdAt: new Date(0).toISOString(),
      stateRevision: 0,
      coreInstallation: null,
      runtime: { configuration: null, running: false, systemProxyApplied: false, core: null },
      autostart: { state: "off", canEnable: true, reason: null },
      sessions: [],
      continuationExpiresAt: new Date(86_400_000).toISOString(),
      phase: "reserved",
    };
  }

  it("reads and preserves a handoff written by the 0.1.3/0.1.4 updater", () => {
    const payload = legacyPayload();
    writeLegacyEnvelope(payload);
    const handoff = readUpgradeHandoff(layout, access);
    assert.ok(handoff);
    assert.equal(handoff.phase, "stopped");
    assert.equal(handoff.sourceVersion, "0.1.4");
    assert.deepEqual(handoff.legacy, {
      nodePath: process.execPath,
      stateSha256: "e".repeat(64),
      restoredBootId: null,
    });
  });

  it("writes a legacy-shaped handoff back in the shape its updater expects", () => {
    writeLegacyEnvelope(legacyPayload());
    const handoff = readUpgradeHandoff(layout, access);
    assert.ok(handoff);
    writeUpgradeHandoff(layout, { ...handoff, phase: "restored" }, access);

    const written = JSON.parse(fs.readFileSync(upgradeHandoffPath(layout), "utf8")) as {
      payload: Record<string, unknown>;
      mac: string;
    };
    assert.deepEqual(
      Object.keys(written.payload).sort(),
      Object.keys(legacyPayload()).sort(),
      "the legacy key set must survive phase updates",
    );
    assert.equal(written.payload.phase, "restored");
    assert.equal(written.payload.nodePath, process.execPath);
    assert.equal(written.payload.stateSha256, "e".repeat(64));
    assert.equal(written.payload.restoredBootId, null);
    const legacyMac = crypto
      .createHmac("sha256", access.grant)
      .update(`sash-upgrade-handoff\0${JSON.stringify(written.payload)}`)
      .digest("hex");
    assert.equal(written.mac, legacyMac, "0.1.4's MAC computation must still verify");
    assert.equal(readUpgradeHandoff(layout, access)?.phase, "restored");
  });

  it("keeps native handoffs in the current shape", () => {
    writeUpgradeHandoff(layout, nativeHandoff(), access);
    const written = readRawPayload();
    assert.equal(Object.keys(written).length, 16);
    assert.equal(Object.hasOwn(written, "nodePath"), false);
    const handoff = readUpgradeHandoff(layout, access);
    assert.equal(handoff?.phase, "reserved");
    assert.equal(handoff?.legacy, undefined);
  });

  it("rejects legacy payloads with malformed compatibility fields", () => {
    for (const [name, patch] of [
      ["short stateSha256", { stateSha256: "abc" }],
      ["non-string stateSha256", { stateSha256: 7 }],
      ["malformed restoredBootId", { restoredBootId: "nothex" }],
      ["relative nodePath", { nodePath: "relative\\path" }],
      ["missing restoredBootId", "delete"],
      ["unknown extra field", { extra: true }],
    ] as const) {
      const payload = legacyPayload();
      if (patch === "delete") delete payload.restoredBootId;
      else Object.assign(payload, patch);
      writeLegacyEnvelope(payload);
      assert.throws(() => readUpgradeHandoff(layout, access), Error, name);
    }
    const payload = legacyPayload();
    payload.restoredBootId = "f".repeat(48);
    writeLegacyEnvelope(payload);
    assert.equal(readUpgradeHandoff(layout, access)?.legacy?.restoredBootId, "f".repeat(48));
  });
});
