import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  clearCommittedManagedStateTransaction,
  commitManagedStateTransaction,
  defaultManagedStateFileOperations,
  markRetainedManagedStateTransactionCommitted,
  readManagedStateTransactionStatus,
  recoverManagedStateTransaction,
  retainManagedStateTransaction,
  rollbackRetainedManagedStateTransaction,
} from "./managed-state-transaction.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { profileFilePath } from "./profiles.js";

function encoded(data: string | null): string | null {
  return data === null ? null : Buffer.from(data).toString("base64");
}

describe("managed-state transaction journal", () => {
  let tmpDir: string;
  let layout: SashLayout;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-profile-transaction-test-"));
    layout = sashLayout(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("restores every partially published file from a crash journal", () => {
    const profile = profileFilePath(layout, "123");
    fs.mkdirSync(layout.profilesDir, { recursive: true });
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.writeFileSync(profile, "new profile");
    fs.writeFileSync(layout.profilesIndexFile, "new index");
    fs.writeFileSync(layout.configFile, "new config");
    fs.writeFileSync(
      layout.managedStateTransactionFile,
      JSON.stringify({
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        index: { data: encoded("old index") },
        profile: { id: "123", data: encoded("old profile") },
        config: { data: encoded("old config") },
      }),
    );

    recoverManagedStateTransaction(layout);

    assert.equal(fs.readFileSync(profile, "utf8"), "old profile");
    assert.equal(fs.readFileSync(layout.profilesIndexFile, "utf8"), "old index");
    assert.equal(fs.readFileSync(layout.configFile, "utf8"), "old config");
    assert.equal(fs.existsSync(layout.managedStateTransactionFile), false);
  });

  it("fails closed on malformed, unknown-field, and oversized journals", () => {
    fs.mkdirSync(layout.stateDir, { recursive: true });
    const invalid = [
      "{not json",
      JSON.stringify({
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        index: { data: null },
        unexpected: true,
      }),
    ];
    for (const journal of invalid) {
      fs.writeFileSync(layout.managedStateTransactionFile, journal);
      let writes = 0;
      assert.throws(
        () =>
          recoverManagedStateTransaction(layout, {
            write: () => {
              writes++;
            },
            remove: () => {
              writes++;
            },
          }),
        /Managed-state transaction journal/,
      );
      assert.equal(writes, 0);
      assert.equal(fs.readFileSync(layout.managedStateTransactionFile, "utf8"), journal);
    }

    fs.writeFileSync(layout.managedStateTransactionFile, "x".repeat(36 * 1024 * 1024 + 1));
    let oversizedWrites = 0;
    assert.throws(
      () =>
        recoverManagedStateTransaction(layout, {
          write: () => {
            oversizedWrites++;
          },
          remove: () => {
            oversizedWrites++;
          },
        }),
      /bounded regular file/,
    );
    assert.equal(oversizedWrites, 0);
    assert.equal(fs.existsSync(layout.managedStateTransactionFile), true);
  });

  it("restores settings and config from a publishing settings transaction journal", () => {
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.writeFileSync(layout.settingsFile, "new settings");
    fs.writeFileSync(layout.configFile, "new config");
    fs.writeFileSync(
      layout.managedStateTransactionFile,
      JSON.stringify({
        version: 2,
        phase: "publishing",
        createdAt: "2026-01-01T00:00:00.000Z",
        index: { data: null },
        settings: { data: encoded("old settings") },
        config: { data: encoded("old config") },
      }),
    );

    recoverManagedStateTransaction(layout);

    assert.equal(fs.readFileSync(layout.settingsFile, "utf8"), "old settings");
    assert.equal(fs.readFileSync(layout.configFile, "utf8"), "old config");
    assert.equal(fs.existsSync(layout.managedStateTransactionFile), false);
  });

  it("finalizes a committed crash journal without rolling published files back", () => {
    fs.mkdirSync(layout.profilesDir, { recursive: true });
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.writeFileSync(layout.profilesIndexFile, "published index");
    fs.writeFileSync(
      layout.managedStateTransactionFile,
      JSON.stringify({
        version: 2,
        phase: "committed",
        createdAt: "2026-01-01T00:00:00.000Z",
        index: { data: encoded("old index") },
      }),
    );

    recoverManagedStateTransaction(layout);

    assert.equal(fs.readFileSync(layout.profilesIndexFile, "utf8"), "published index");
    assert.equal(fs.existsSync(layout.managedStateTransactionFile), false);
  });

  it("retains the journal when exception compensation cannot restore every file", async () => {
    const profile = profileFilePath(layout, "123");
    fs.mkdirSync(layout.profilesDir, { recursive: true });
    fs.writeFileSync(profile, "old profile");
    fs.writeFileSync(layout.profilesIndexFile, "old index");
    let indexWrites = 0;

    await assert.rejects(
      () =>
        commitManagedStateTransaction(
          layout,
          {
            index: { activeId: null, profiles: [] },
            profile: { id: "123", yamlText: "new profile" },
          },
          undefined,
          {
            ...defaultManagedStateFileOperations,
            write: (file, data) => {
              if (file === layout.profilesIndexFile) {
                indexWrites++;
                throw new Error(indexWrites === 1 ? "publish failed" : "restore failed");
              }
              defaultManagedStateFileOperations.write(file, data);
            },
          },
        ),
      /managed-state transaction rollback failed: .*restore failed/,
    );

    assert.equal(fs.readFileSync(profile, "utf8"), "old profile");
    assert.equal(fs.existsSync(layout.managedStateTransactionFile), true);
  });

  it("removes its journal after a successful transaction", async () => {
    await commitManagedStateTransaction(
      layout,
      { index: { activeId: null, profiles: [] }, profile: { id: "123", yamlText: "profile" } },
      undefined,
    );

    assert.equal(fs.existsSync(profileFilePath(layout, "123")), true);
    assert.equal(fs.existsSync(layout.managedStateTransactionFile), false);
  });

  it("retains a Core update publication until explicit rollback", async () => {
    fs.mkdirSync(layout.profilesDir, { recursive: true });
    fs.writeFileSync(layout.profilesIndexFile, "old index");
    fs.writeFileSync(layout.configFile, "old config");

    await retainManagedStateTransaction(layout, {
      index: { activeId: null, profiles: [] },
      config: { yaml: "new config", proxyCount: 0, source: "default" },
      reloadRuntime: false,
    });

    assert.equal(fs.readFileSync(layout.configFile, "utf8"), "new config");
    assert.match(fs.readFileSync(layout.profilesIndexFile, "utf8"), /"activeId": null/);
    assert.deepEqual(readManagedStateTransactionStatus(layout), {
      phase: "retained",
      createdAt: readManagedStateTransactionStatus(layout)?.createdAt,
      coordination: "core-update",
    });
    assert.throws(
      () => recoverManagedStateTransaction(layout),
      /requires coordinated Core update recovery/,
    );

    assert.equal(rollbackRetainedManagedStateTransaction(layout), true);
    assert.equal(fs.readFileSync(layout.profilesIndexFile, "utf8"), "old index");
    assert.equal(fs.readFileSync(layout.configFile, "utf8"), "old config");
    assert.equal(readManagedStateTransactionStatus(layout), undefined);
  });

  it("persists a coordinated commit decision before clearing rollback snapshots", async () => {
    fs.writeFileSync(layout.configFile, "old config");
    await retainManagedStateTransaction(layout, {
      config: { yaml: "new config", proxyCount: 0, source: "default" },
      reloadRuntime: false,
    });

    assert.equal(markRetainedManagedStateTransactionCommitted(layout), true);
    assert.equal(readManagedStateTransactionStatus(layout)?.phase, "committed");
    assert.equal(fs.readFileSync(layout.configFile, "utf8"), "new config");
    assert.equal(clearCommittedManagedStateTransaction(layout), true);
    assert.equal(readManagedStateTransactionStatus(layout), undefined);
    assert.equal(fs.readFileSync(layout.configFile, "utf8"), "new config");
  });

  it("rejects settings or runtime work in a retained Core update publication", async () => {
    await assert.rejects(
      () =>
        retainManagedStateTransaction(layout, {
          settings: {
            schemaVersion: 1,
            tun: false,
            allowLan: false,
            mixedPort: 17890,
            controller: "127.0.0.1:19091",
            secret: "secret",
            daemonPort: 19090,
            daemonSecret: "daemon-secret",
            systemProxy: false,
          },
        }),
      /cannot transition runtime or publish settings/,
    );
    assert.equal(readManagedStateTransactionStatus(layout), undefined);
  });
});
