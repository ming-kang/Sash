import assert from "node:assert/strict";
import { it } from "node:test";
import { displayWidth, log } from "./log.js";

it("aligns Unicode columns and escapes terminal control characters", (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  log.table([
    ["名称", "Value"],
    ["Name", "\x1b[31mvalue"],
  ]);
  assert.equal(displayWidth("名称"), 4);
  assert.equal(displayWidth("e\u0301"), 1);
  assert.equal(lines[0], "名称  Value");
  assert.equal(lines[1], "Name  \\u001b[31mvalue");
});
