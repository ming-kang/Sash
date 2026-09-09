import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { upgradeChildEnv } from "./upgrade-command.js";
import { assertNoUnknownSashDaemons, type ProcessObservation } from "./upgrade-processes.js";

it("blocks an unidentified live Node owner and disregards its stale census row after exit", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"],
    {
      env: upgradeChildEnv(),
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
    },
  );
  const closed = once(child, "close");
  await once(child, "spawn");
  const pid = child.pid;
  assert.ok(pid);
  const observations: ProcessObservation[] = [
    { pid, name: path.basename(process.execPath), commandLine: null },
  ];
  const root = path.join(os.tmpdir(), "sash-process-census-fixture");
  try {
    assert.throws(
      () => assertNoUnknownSashDaemons(observations, root, [process.execPath], new Set()),
      /Cannot verify all Sash owners/,
    );
    assert.doesNotThrow(() =>
      assertNoUnknownSashDaemons(observations, root, [process.execPath], new Set([pid])),
    );
  } finally {
    child.stdin.end();
    await closed;
  }
  assert.doesNotThrow(() =>
    assertNoUnknownSashDaemons(observations, root, [process.execPath], new Set()),
  );
});
