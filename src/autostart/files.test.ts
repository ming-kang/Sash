import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { testAutostartContext } from "../testing/autostart-context.js";
import { readRegistration, registerFile } from "./files.js";

describe("autostart registration publication", () => {
  it("restores an earlier launcher after a failed repair and removes a failed first install", async (t) => {
    const { root } = testAutostartContext(t, process.platform);
    const file = path.join(root, "entry");
    const fail = async () => {
      throw new Error("OS registration failed");
    };
    await assert.rejects(registerFile(file, "new", fail), /OS registration failed/);
    assert.equal(readRegistration(file), undefined);
    fs.writeFileSync(file, "previous");
    await assert.rejects(registerFile(file, "new", fail), /OS registration failed/);
    assert.equal(readRegistration(file)?.toString(), "previous");
  });

  it("preserves a concurrent replacement rather than overwriting it during rollback", async (t) => {
    const { root } = testAutostartContext(t, process.platform);
    const file = path.join(root, "entry");
    await assert.rejects(
      registerFile(file, "new", async () => {
        fs.writeFileSync(file, "external edit");
        throw new Error("registration failed");
      }),
      /rollback failed.*preserved it/,
    );
    assert.equal(readRegistration(file)?.toString(), "external edit");
  });

  it("rejects directories and oversized registration files", async (t) => {
    const { root } = testAutostartContext(t, process.platform);
    assert.throws(() => readRegistration(root), /Invalid autostart/);
    const file = path.join(root, "entry");
    fs.writeFileSync(file, Buffer.alloc(64 * 1024 + 1));
    await assert.rejects(
      registerFile(file, "new", async () => {}),
      /Invalid autostart/,
    );
    assert.equal(fs.statSync(file).size, 64 * 1024 + 1);
  });

  it("keeps registration files private without changing a shared parent directory", async (t) => {
    const { root } = testAutostartContext(t, process.platform);
    const directory = path.join(root, "shared");
    fs.mkdirSync(directory, { mode: 0o755 });
    const file = path.join(directory, "entry");
    await registerFile(file, "new", async () => {});
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(directory).mode & 0o777, 0o755);
    }
  });
});
