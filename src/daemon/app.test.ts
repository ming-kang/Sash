import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { sashLayout } from "../paths.js";
import type { SystemProxyController } from "../sysproxy/manager.js";
import { FakeCoreSupervisor, testSettings } from "../testing/state.js";
import { HELPER_PROTOCOL } from "../tun-platform/helper-pipe.js";
import { type WindowsGuardHost, WindowsTunGuard } from "../tun-platform/windows-guard.js";
import type { TunPlatform } from "../tun-service.js";
import { buildDaemonContext } from "./app.js";

function systemProxy(): SystemProxyController {
  return {
    supported: true,
    apply: async () => {},
    release: async () => {},
    inspect: async () => ({
      applied: false,
      appliedKnown: true,
      stateKnown: true,
      state: { supported: true, enabled: false },
    }),
  };
}

describe("buildDaemonContext TUN guard selection", () => {
  it.skipIf(process.platform !== "win32")(
    "uses the Windows adapter and tears the guard down even when no Core is tracked",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-daemon-app-test-"));
      try {
        const layout = sashLayout(root);
        const settings = testSettings();
        const host: WindowsGuardHost & { unguards: number; stops: number } = {
          unguards: 0,
          stops: 0,
          async start() {
            return { pid: 77 };
          },
          async stop() {
            host.stops += 1;
          },
          async unguard() {
            host.unguards += 1;
          },
          async status() {
            return { running: false, pid: null };
          },
          async probeGuard() {
            return {
              ok: true,
              protocol: HELPER_PROTOCOL,
              home: layout.root,
              running: false,
            };
          },
        };
        const tunPlatform: TunPlatform = {
          mechanism: "service",
          inspect: async () => ({ state: "ready" }),
          install: async () => {},
          uninstall: async () => {},
          host: () => host,
        };
        const app = buildDaemonContext({
          layout,
          settings,
          supervisor: new FakeCoreSupervisor(layout, settings),
          systemProxy: systemProxy(),
          tunPlatform,
        });

        assert.ok(app.lifecycle.tunGuard instanceof WindowsTunGuard);
        await app.lifecycle.stop();
        assert.equal(host.unguards, 0);
        await app.lifecycle.stop({ final: true });
        assert.equal(host.stops, 0);
        assert.equal(host.unguards, 1);
        assert.equal(app.lifecycle.tunGuard.lastResult()?.state, "ok");
        assert.equal(app.lifecycle.tunGuard.lastResult()?.verb, "teardown");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
