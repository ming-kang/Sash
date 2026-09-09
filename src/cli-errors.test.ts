import assert from "node:assert/strict";
import { it } from "node:test";
import { withCliErrors } from "./cli-errors.js";
import { commandOutput } from "./cli-output.js";

it("scopes stack traces to SASH_DEBUG and leaves JSON errors on stdout", async (t) => {
  const originalDebug = process.env.DEBUG;
  const originalSashDebug = process.env.SASH_DEBUG;
  const originalExit = process.exitCode;
  const errors: string[] = [];
  let output = "";
  t.mock.method(console, "error", (message: unknown) => errors.push(String(message)));
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  });
  const failure = new Error("fixture failure");
  const action = async () => {
    throw failure;
  };
  try {
    delete process.env.SASH_DEBUG;
    process.env.DEBUG = "true";
    await withCliErrors(action)();
    assert.equal(errors.length, 1);
    process.env.SASH_DEBUG = "1";
    errors.length = 0;
    await withCliErrors(action)();
    assert.equal(errors[1], failure.stack);
    errors.length = 0;
    await commandOutput(true, action, () => {});
    assert.deepEqual(JSON.parse(output), { error: "fixture failure" });
    assert.deepEqual(errors, [failure.stack]);
  } finally {
    if (originalDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = originalDebug;
    if (originalSashDebug === undefined) delete process.env.SASH_DEBUG;
    else process.env.SASH_DEBUG = originalSashDebug;
    process.exitCode = originalExit;
  }
});
