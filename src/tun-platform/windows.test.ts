import assert from "node:assert/strict";
import { it } from "vitest";
import {
  helperManifestSchema,
  helperPipePath,
  helperProtectedDir,
  WINTUN_SHA256,
} from "./windows-shared.js";

const SID = "S-1-5-21-1234-5678-9012-1000";

it("locks the protected directory under ProgramData by default", () => {
  const dir = helperProtectedDir({ ProgramData: "C:\\ProgramData" });
  assert.equal(dir, "C:\\ProgramData\\Sash\\core");
  // The env override is honored only in test contexts.
  assert.equal(
    helperProtectedDir({ SASH_HELPER_DIR: "C:\\alt\\core", NODE_ENV: "test" }),
    "C:\\alt\\core",
  );
  assert.equal(helperProtectedDir({ SASH_HELPER_DIR: "C:\\alt\\core" }), dir);
  assert.equal(
    helperProtectedDir({ SASH_HELPER_DIR: "C:\\alt\\core", NODE_ENV: "production" }),
    dir,
  );
  assert.equal(helperProtectedDir({ SASH_HELPER_DIR: "relative" }), dir);
});

it("accepts only well-formed manifests", () => {
  const manifest = {
    version: 1,
    installerSid: SID,
    coreSha256: "a".repeat(64),
    helperSha256: "b".repeat(64),
    helperVersion: "0.6.1",
    winswSha256: "d".repeat(64),
    wintunSha256: "c".repeat(64),
    coreVersion: "v1.2.3",
    installedAt: new Date(0).toISOString(),
  };
  assert.deepEqual(helperManifestSchema.parse(manifest), manifest);
  assert.throws(() => helperManifestSchema.parse({ ...manifest, coreSha256: "zz" }));
  assert.throws(() => helperManifestSchema.parse({ ...manifest, installerSid: "everyone" }));
  assert.throws(() => helperManifestSchema.parse({ ...manifest, extra: true }));
});

it("pins the bundled payloads to fixed release digests per arch", () => {
  assert.match(WINTUN_SHA256.x64, /^[a-f0-9]{64}$/);
  assert.match(WINTUN_SHA256.arm64, /^[a-f0-9]{64}$/);
  assert.equal(helperPipePath("x"), "\\\\.\\pipe\\x");
});

it("runs the verifyEndpoint hook before any transport is opened", async () => {
  const { createIpcHelperClient } = await import("../launcher/ipc.js");
  const endpoint =
    process.platform === "win32" ? "\\\\.\\pipe\\sash-hook-test" : "/tmp/sash-hook-test.sock";
  const seen: string[] = [];
  assert.throws(
    () =>
      createIpcHelperClient(endpoint, 1_000, (candidate) => {
        seen.push(candidate);
        throw new Error("endpoint rejected");
      }),
    /endpoint rejected/,
  );
  assert.deepEqual(seen, [endpoint]);
});
