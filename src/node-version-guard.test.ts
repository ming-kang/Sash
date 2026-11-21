import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("node-version-guard", () => {
  for (const entry of ["cli.ts", path.join("daemon", "entry.ts")]) {
    it(`${entry} runs the Node version check before any other module`, () => {
      const source = fs.readFileSync(path.join(here, entry), "utf8");
      const firstImport = source.match(/^import\s.+$/m)?.[0] ?? "";
      assert.match(firstImport, /node-version-guard\.js";$/);
    });
  }
});
