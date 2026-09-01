import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { addLog, clearLogs, store } from "./index.js";

describe("web store logs", () => {
  afterEach(() => clearLogs());

  it("keeps stable monotonic ids while trimming to the log limit", () => {
    for (let index = 0; index < 605; index += 1) {
      addLog({ type: "info", payload: `line-${index}` });
    }

    assert.equal(store.logs.length, 600);
    assert.equal(store.logs[0]?.payload, "line-5");
    assert.ok((store.logs.at(-1)?.id ?? 0) > (store.logs[0]?.id ?? 0));
    assert.equal(new Set(store.logs.map((log) => log.id)).size, 600);
  });
});
