import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DaemonStatus } from "../contracts.js";
import { SashDaemonClient } from "../daemon-client.js";
import { sashLayout } from "../paths.js";
import type { CommandRuntimeOwner } from "../runtime-owner.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import { runWeb, type WebCommandDeps } from "./web.js";

function fixture(running: boolean | null | Error) {
  const client = new SashDaemonClient(29193, "test-only");
  client.status = async () => {
    if (running instanceof Error) throw running;
    return { core: { running } } as DaemonStatus;
  };
  const healthy: CommandRuntimeOwner = {
    kind: "daemon",
    daemon: { kind: "healthy", running: true, healthy: true, pid: 12345, port: 29193 },
    client,
  };
  const offline: CommandRuntimeOwner = {
    kind: "offline",
    daemon: { kind: "stopped", running: false, healthy: false },
  };
  const unhealthy: CommandRuntimeOwner = {
    kind: "unhealthy",
    daemon: { kind: "unhealthy", running: true, healthy: false },
  };
  const events: string[] = [];
  const warnings: string[] = [];
  const successes: string[] = [];
  const deps: WebCommandDeps = {
    runtimeContext: () => ({
      layout: sashLayout(path.join(os.tmpdir(), "sash-web-injected-no-io")),
      settings: { ...DEFAULT_SETTINGS, daemonPort: 29193, tun: true },
    }),
    resolveRuntimeOwner: async () => {
      events.push("resolve");
      return healthy;
    },
    runStart: async () => {
      events.push("start");
    },
    openInBrowser: (url) => {
      events.push(`open ${url}`);
    },
    log: {
      info: () => {},
      warn: (message) => warnings.push(message),
      ok: (message) => successes.push(message),
    },
  };
  return { deps, healthy, offline, unhealthy, events, warnings, successes };
}

test("known stopped Core attempts start and opens healthy recovery UI on service-required failure", async () => {
  for (const noOpen of [false, true]) {
    const f = fixture(false);
    f.deps.runStart = async () => {
      f.events.push("start");
      throw new Error("Windows TUN requires the service");
    };
    await runWeb({ noOpen }, f.deps);
    assert.deepEqual(f.events, [
      "resolve",
      "start",
      "resolve",
      ...(!noOpen ? ["open http://127.0.0.1:29193/ui/"] : []),
    ]);
    assert.match(
      f.warnings.join("\n"),
      /Core startup failed.*recovery.*Windows TUN requires the service/,
    );
    assert.deepEqual(f.successes, ["dashboard: http://127.0.0.1:29193/ui/"]);
  }
});

test("failed start preserves original error if daemon is offline, unhealthy, or resolution fails", async () => {
  for (const outcome of ["offline", "unhealthy", "throws"] as const) {
    const f = fixture(false);
    const original = new Error("original start failure");
    let resolutions = 0;
    f.deps.resolveRuntimeOwner = async () => {
      resolutions++;
      if (resolutions === 1) return f.healthy;
      if (outcome === "throws") throw new Error("secondary discovery error");
      return f[outcome];
    };
    f.deps.runStart = async () => {
      f.events.push("start");
      throw original;
    };
    await assert.rejects(runWeb({}, f.deps), (error) => error === original);
    assert.deepEqual(f.events, ["start"]);
    assert.equal(resolutions, 2);
    assert.deepEqual(f.successes, []);
  }
});

test("running, null and unavailable Core observations never authorize a start", async () => {
  for (const running of [true, null, new Error("status unavailable")]) {
    const f = fixture(running);
    await runWeb({}, f.deps);
    assert.deepEqual(f.events, ["resolve", "open http://127.0.0.1:29193/ui/"]);
  }
});

test("offline and known-stopped starts still open the dashboard after success", async () => {
  for (const offline of [false, true]) {
    const f = fixture(false);
    let calls = 0;
    f.deps.resolveRuntimeOwner = async () => {
      calls++;
      return offline && calls === 1 ? f.offline : f.healthy;
    };
    await runWeb({}, f.deps);
    assert.equal(calls, 2);
    assert.deepEqual(f.events, ["start", "open http://127.0.0.1:29193/ui/"]);
    assert.deepEqual(f.warnings, []);
  }
});

test("initial unhealthy daemon never authorizes a competing start or browser open", async () => {
  const f = fixture(false);
  f.deps.resolveRuntimeOwner = async () => f.unhealthy;
  await assert.rejects(runWeb({}, f.deps), /did not become healthy/);
  assert.deepEqual(f.events, []);
});
