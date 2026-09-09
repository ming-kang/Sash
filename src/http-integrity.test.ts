import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { downloadToFile } from "./http.js";

it("authenticates streamed SHA-256 and SHA-512, removes mismatches and keeps archives private", async () => {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "sash-download-digest-"));
  const file = path.join(root, "archive.tgz");
  const body = Buffer.from("verified streamed artifact".repeat(4096));
  const server = http.createServer((_req, res) => {
    res.write(body.subarray(0, 37));
    res.end(body.subarray(37));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    for (const algorithm of ["sha256", "sha512"] as const) {
      const options = {
        allowedHosts: new Set(["127.0.0.1"]),
        integrity: { algorithm, digest: crypto.hash(algorithm, body) },
      };
      const url: string = `http://127.0.0.1:${address.port}/archive`;
      assert.equal(await downloadToFile(url, file, options), body.length);
      assert.deepEqual(fs.readFileSync(file), body);
      if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      await assert.rejects(
        downloadToFile(url, file, {
          ...options,
          integrity: { algorithm, digest: "0".repeat(algorithm === "sha256" ? 64 : 128) },
        }),
        /mismatch/,
      );
      assert.equal(fs.existsSync(file), false);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal(path.dirname(fs.realpathSync(root)), parent);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
