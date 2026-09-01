import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { confirmDialog, confirmState, settleConfirm } from "./confirm.js";

describe("confirm dialog state", () => {
  afterEach(() => {
    if (confirmState.visible) settleConfirm(false);
  });

  it("settles an older pending confirmation before opening a new one", async () => {
    const first = confirmDialog({ title: "first", message: "first" });
    const second = confirmDialog({ title: "second", message: "second" });

    assert.equal(await first, false);
    settleConfirm(true);
    assert.equal(await second, true);
  });
});
