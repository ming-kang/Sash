import assert from "node:assert/strict";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  type CoreUpdateProgress,
  coreUpdateProgressText,
  updateCoreWithProgress,
} from "./core-update.js";
import { deferred } from "./testing/state.js";

const progress: CoreUpdateProgress = {
  stage: "downloading",
  startedAt: "2026-09-09T00:00:00.000Z",
  target: "v2.0.0",
  downloading: true,
  downloaded: 1048576,
  total: 2097152,
};

it("keeps a Core update alive through a progress read failure and stops polling afterward", async () => {
  const finished = deferred();
  let calls = 0;
  let updates = 0;
  const result = await updateCoreWithProgress(
    {
      updateCore: async (version) => {
        updates += 1;
        assert.equal(version, "v2.0.0");
        await finished.promise;
        return { version };
      },
      coreUpdateProgress: async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient read");
        return progress;
      },
    },
    "v2.0.0",
    () => finished.resolve(),
  );
  assert.deepEqual(result, { version: "v2.0.0" });
  assert.equal(updates, 1);
  assert.equal(calls, 2);
  await delay(550);
  assert.equal(calls, 2);
  assert.match(coreUpdateProgressText(progress), /1\.0 \/ 2\.0 MiB/);
});

it("never polls when progress is not requested and preserves update failures", async () => {
  const client = {
    updateCore: async () => ({ version: "v2.0.0" }),
    coreUpdateProgress: async () => {
      throw new Error("must not poll");
    },
  };
  assert.deepEqual(await updateCoreWithProgress(client), { version: "v2.0.0" });
  await assert.rejects(
    updateCoreWithProgress(
      {
        ...client,
        updateCore: async () => {
          throw new Error("install failed");
        },
      },
      undefined,
      () => {},
    ),
    /install failed/,
  );
});
