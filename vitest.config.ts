import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

const isolation = mkdtempSync(path.join(os.tmpdir(), "sash-test-run-"));
process.env.SASH_TEST_ISOLATION = isolation;

// Local fixtures must never be sent through a developer's configured proxy
// (which may itself be a running Sash/Core instance).
const noProxy = [
  ...new Set(
    [process.env.NO_PROXY, process.env.no_proxy, "127.0.0.1", "localhost", "::1"]
      .filter(Boolean)
      .flatMap((value) => (value ?? "").split(","))
      .map((value) => value.trim())
      .filter(Boolean),
  ),
].join(",");

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "web/src/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    restoreMocks: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    globalSetup: "./src/testing/vitest-global.ts",
    env: {
      NO_PROXY: noProxy,
      no_proxy: noProxy,
      SASH_HOME: path.join(isolation, "data"),
      LOCALAPPDATA: path.join(isolation, "local"),
      XDG_STATE_HOME: path.join(isolation, "xdg-state"),
    },
    // Windows integration tests launch system helpers and configuration
    // workers; limit file concurrency so their startup stays within budget.
    ...(process.platform === "win32" ? { maxWorkers: 2 } : {}),
  },
});
