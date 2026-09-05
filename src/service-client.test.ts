import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { sashLayout } from "./paths.js";
import { SashApiError } from "./sash-client.js";
import {
  inspectService,
  parseServiceStatus,
  requireActiveService,
  runServiceHelper,
  trustedWindowsSystemExecutable,
} from "./service-client.js";

test("service status strictly validates unknown fields used by runtime", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-status-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const layout = sashLayout(root);
  const good = {
    protocol: 1,
    supported: true,
    installed: true,
    running: true,
    compatible: true,
    root: fs.realpathSync(root),
    serviceInstance: "boot",
    version: "0.1.0",
    coreVersion: "v1",
    generation: 3,
    core: {
      running: true,
      pid: 123,
      healthy: true,
      startedAt: "2026-01-01T00:00:00.123456789Z",
      tunActive: false,
    },
  };
  assert.equal(requireActiveService(good, layout).core.pid, 123);
  for (const bad of [
    null,
    [],
    { ...good, installed: "yes" },
    { ...good, coreVersion: 1 },
    { ...good, generation: 0.5 },
    { ...good, generation: Number.MAX_SAFE_INTEGER + 1 },
    { ...good, core: { ...good.core, pid: -1 } },
    { ...good, core: { ...good.core, healthy: 1 } },
    { ...good, core: { ...good.core, startedAt: "yesterday" } },
    { ...good, core: { ...good.core, tunActive: "false" } },
    { ...good, core: { ...good.core, running: false } },
  ])
    assert.throws(() => parseServiceStatus(bad));
  for (const bad of [
    { ...good, root: path.dirname(root) },
    { ...good, compatible: false },
    { ...good, protocol: 2 },
    { ...good, serviceInstance: "" },
    { ...good, core: undefined },
  ])
    assert.throws(() => requireActiveService(bad, layout));
});

test("native helper JSON error retains code even with exit status 1", async () => {
  await assert.rejects(
    runServiceHelper(process.execPath, [
      "-e",
      "console.log(JSON.stringify({error:{code:'RECOVERY_REQUIRED',message:'review protected installation'}}));process.exitCode=1",
    ]),
    (error: unknown) =>
      error instanceof SashApiError &&
      error.code === "RECOVERY_REQUIRED" &&
      error.message === "review protected installation",
  );
  await assert.rejects(
    runServiceHelper(process.execPath, ["-e", "console.log('not json')"]),
    /Invalid JSON/,
  );
});

test("management reports installed unavailable only after confirmed SCM observation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-inspect-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const deps = {
    platform: "win32" as const,
    findHelper: () => "fake",
    runHelper: async () => {
      throw new SashApiError(503, "SERVICE_UNAVAILABLE", "offline");
    },
    queryState: () => "unavailable" as const,
  };
  assert.deepEqual(await inspectService(sashLayout(root), deps), {
    supported: true,
    installed: true,
    running: false,
  });
  await assert.rejects(
    inspectService(sashLayout(root), {
      ...deps,
      queryState: () => {
        throw new Error("SCM query failed");
      },
    }),
    /SCM query failed/,
  );
  await assert.rejects(
    inspectService(sashLayout(root), {
      ...deps,
      runHelper: async () => {
        throw new SashApiError(503, "RECOVERY_REQUIRED", "protected root remains");
      },
    }),
    (error: unknown) => error instanceof SashApiError && error.code === "RECOVERY_REQUIRED",
  );
});

test("trusted Windows tool resolution ignores inherited SystemRoot", {
  skip: process.platform !== "win32",
}, () => {
  const prior = process.env.SystemRoot;
  try {
    process.env.SystemRoot = "C:/untrusted";
    const executable = trustedWindowsSystemExecutable("cmd.exe");
    assert.equal(fs.statSync(executable).isFile(), true);
    const result = spawnSync(executable, ["/d", "/c", "exit", "0"], { windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, 0);
  } finally {
    if (prior === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = prior;
  }
});
