import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { readInstallRecord } from "./core.js";
import { commitCoreUpdate, readCoreUpdateTransaction } from "./core-update.js";
import { useDaemonTestHarness } from "./daemon-test-harness.test.js";
import {
  readManagedStateTransactionStatus,
  retainManagedStateTransaction,
} from "./managed-state-transaction.js";
import type { CoreSupervisor } from "./supervisor.js";

describe("daemon startup after a stopped Core update", () => {
  const h = useDaemonTestHarness();
  for (const command of ["start", "restart"]) {
    for (const fails of [false, true]) {
      it(`${command} consumes the retained candidate through health/rollback (failure=${fails})`, async () => {
        const previousConfig = "rules:\n  - MATCH,DIRECT\n# previous\n";
        const candidateConfig = "rules:\n  - MATCH,DIRECT\ntun:\n  enable: false\n# candidate\n";
        let running = false;
        let starts = 0;
        let validations = 0;
        const supervisor = {
          isRunning: () => running,
          start: async () => {
            starts++;
            assert.equal(fs.readFileSync(h.layout.configFile, "utf8"), candidateConfig);
            assert.equal(readManagedStateTransactionStatus(h.layout)?.phase, "retained");
            if (fails) throw new Error("candidate health failed");
            running = true;
            return { pid: 1234, version: process.version };
          },
          restart: async () => {
            assert.fail("pending updates must use the managed start health/rollback path");
          },
          stop: async () => {
            running = false;
          },
        } as unknown as CoreSupervisor;
        await h.startServer({
          supervisor,
          validateConfig: () => {
            validations++;
          },
        });
        fs.writeFileSync(h.layout.configFile, previousConfig);
        await retainManagedStateTransaction(h.layout, {
          config: { yaml: candidateConfig, proxyCount: 0, source: "default" },
          reloadRuntime: false,
        });

        // Node's real executable supplies a portable -v fixture. It is only
        // invoked for version checks; Core startup and OS proxy are injected.
        fs.mkdirSync(h.layout.tempDir, { recursive: true });
        fs.mkdirSync(h.layout.binDir, { recursive: true });
        const stagedExe = path.join(
          h.layout.tempDir,
          process.platform === "win32" ? "version.exe" : "version",
        );
        fs.copyFileSync(process.execPath, stagedExe);
        fs.chmodSync(stagedExe, 0o755);
        await commitCoreUpdate({
          layout: h.layout,
          staged: { exe: stagedExe, version: process.version },
        });

        const response = await h.apiRequest(`/sash/core/${command}`, { method: "POST" });
        assert.equal(response.statusCode, fails ? 500 : 200);
        assert.equal(starts, 1);
        assert.equal(validations, 0, "pending candidate must not be regenerated before startup");
        assert.equal(readCoreUpdateTransaction(h.layout), undefined);
        assert.equal(readManagedStateTransactionStatus(h.layout), undefined);
        assert.equal(fs.existsSync(`${h.layout.coreExe}.bak`), false);
        assert.equal(
          fs.readFileSync(h.layout.configFile, "utf8"),
          fails ? previousConfig : candidateConfig,
        );
        if (fails) {
          assert.equal(readInstallRecord(h.layout), undefined);
          assert.equal(fs.existsSync(h.layout.coreExe), false);
          assert.equal(running, false);
        } else {
          assert.equal(readInstallRecord(h.layout)?.coreVersion, process.version);
          assert.equal(running, true);
        }
      });
    }
  }
});
