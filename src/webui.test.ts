import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSafeUiEntry } from "./webui.js";

const file = { type: "File" } as const;
const directory = { type: "Directory" } as const;

describe("isSafeUiEntry", () => {
  it("accepts regular files and directories at relative paths", () => {
    assert.equal(isSafeUiEntry("index.html", file), true);
    assert.equal(isSafeUiEntry("assets/app.js", file), true);
    assert.equal(isSafeUiEntry("assets", directory), true);
  });

  it("accepts filenames that merely contain consecutive dots", () => {
    // A substring test for ".." rejected legitimate names like this one.
    assert.equal(isSafeUiEntry("assets/vendor..chunk.js", file), true);
  });

  it("rejects parent-directory traversal in any segment", () => {
    for (const entryPath of ["..", "../evil", "a/../../evil", "..\\evil", "a/.."]) {
      assert.equal(isSafeUiEntry(entryPath, file), false, entryPath);
    }
  });

  it("rejects absolute paths on both path flavours", () => {
    for (const entryPath of ["/etc/passwd", "C:\\Windows\\system32\\x.dll", "c:/x"]) {
      assert.equal(isSafeUiEntry(entryPath, file), false, entryPath);
    }
  });

  it("rejects links and device nodes regardless of path", () => {
    // A symlink or hardlink entry could otherwise redirect a later write
    // outside the staging directory.
    const types = ["SymbolicLink", "Link", "CharacterDevice", "BlockDevice", "FIFO"] as const;
    for (const type of types) {
      assert.equal(isSafeUiEntry("index.html", { type }), false, type);
    }
  });
});
