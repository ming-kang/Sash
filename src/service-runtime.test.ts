import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { isPlainObject } from "./json-shape.js";
import { sashLayout } from "./paths.js";
import { buildSanitizedEnv } from "./process.js";
import { RuntimeLifecycle } from "./runtime-lifecycle.js";
import { requireActiveService, serviceRequest } from "./service-client.js";
import type { ServiceRuntimeDeps } from "./service-runtime.js";
import {
  createServiceRuntime,
  openServiceBridge,
  parseBridgeReady,
  readServiceSession,
  recoverServiceRuntime,
  ServiceRuntime,
} from "./service-runtime.js";
import { DEFAULT_SETTINGS } from "./settings.js";

function fixture(t: { after(fn: () => void): void }) {
  const layout = sashLayout(fs.mkdtempSync(path.join(os.tmpdir(), "sash-service-test-")));
  t.after(() => fs.rmSync(layout.root, { recursive: true, force: true }));
  atomicWriteFileSync(layout.configFile, "proxies: []\n");
  let state = requireActiveService(
    {
      protocol: 1,
      supported: true,
      installed: true,
      running: true,
      compatible: true,
      root: fs.realpathSync(layout.root),
      version: "0.1.0",
      coreVersion: "v1",
      serviceInstance: "boot-a",
      generation: 0,
      core: { running: false },
    },
    layout,
  );
  let failure = false;
  let closed = 0;
  let session: string | undefined;
  const calls: string[] = [];
  const request: typeof serviceRequest = async (_endpoint, op, body) => {
    calls.push(op);
    if (failure) throw new Error("transport unavailable");
    if (op === "start") {
      assert.ok(isPlainObject(body));
      assert.equal(
        readServiceSession(layout)?.session,
        body.session,
        "session durable before publication",
      );
      assert.equal(typeof body.session, "string");
      session = String(body.session);
      state = {
        ...state,
        generation: state.generation + 1,
        core: {
          running: true,
          pid: 424242,
          healthy: true,
          startedAt: new Date().toISOString(),
          version: "v1",
          tunActive: false,
        },
      };
    } else if (op === "stop" || op === "reload") {
      assert.ok(isPlainObject(body));
      assert.equal(body.session, session);
      assert.equal(body.serviceInstance, state.serviceInstance);
      assert.equal(body.generation, state.core.running ? state.generation : state.generation - 1);
      if (op === "stop" && state.core.running)
        state = {
          ...state,
          generation: state.generation + 1,
          core: { running: false },
        };
    } else if (op === "validate") return undefined;
    return structuredClone(state);
  };
  const bridge = {
    endpoint: { controller: "127.0.0.1:49152", secret: "a".repeat(64) },
    close: async () => {
      closed++;
    },
  };
  const deps: ServiceRuntimeDeps = {
    platform: "win32",
    findHelper: () => "fake-helper",
    runHelper: async () => structuredClone(state),
    openBridge: async () => bridge,
    request,
    prepareBundle: async () => ({ config: {}, assets: [] }),
    monitorMs: 15,
  };
  return {
    layout,
    deps,
    calls,
    bridge,
    state: () => state,
    setState: (next: typeof state) => {
      state = next;
    },
    fail: (value: boolean) => {
      failure = value;
    },
    closed: () => closed,
  };
}

test("ready line only accepts normalized IPv4 loopback and private random token", () => {
  const ready = {
    protocol: 1,
    controller: "127.0.0.1:49152",
    secret: "a".repeat(64),
  };
  assert.deepEqual(parseBridgeReady(ready), {
    controller: ready.controller,
    secret: ready.secret,
  });
  for (const controller of [
    "localhost:49152",
    "127.1:49152",
    "127.0.0.1:049152",
    "127.0.0.1:0",
    "127.0.0.1:65536",
    "127.0.0.1:49152/x",
    "user@127.0.0.1:49152",
    "[::1]:49152",
    "0.0.0.0:49152",
  ])
    assert.throws(() => parseBridgeReady({ ...ready, controller }));
  assert.throws(() => parseBridgeReady({ ...ready, secret: "short" }));
});

test("service start/reload/stop retains full ownership and never writes direct PID metadata", async (t) => {
  const f = fixture(t);
  const runtime = await createServiceRuntime(f.layout, () => DEFAULT_SETTINGS, f.deps);
  assert.ok(runtime);
  t.after(() => runtime.close());
  assert.equal(runtime.installed, true);
  assert.equal(runtime.coreVersion, "v1");
  assert.equal((await runtime.start()).pid, 424242);
  const snapshot = runtime.ownedCoreSnapshot();
  assert.ok(snapshot);
  assert.equal(runtime.ownsCore(snapshot), true);
  assert.equal(fs.existsSync(f.layout.pidFile), false);
  assert.match(readServiceSession(f.layout)?.session ?? "", /^[0-9a-f]{64}$/);
  await runtime.validateConfig("proxies: []");
  await runtime.reloadConfig(f.layout.configFile);
  assert.equal(runtime.ownsCore(snapshot), true);
  await runtime.stop();
  await runtime.stop();
  assert.equal(runtime.isRunning(), false);
  assert.equal(readServiceSession(f.layout), undefined);
  assert.equal(runtime.ownsCore(snapshot), false);
  await runtime.start();
  assert.equal(runtime.ownsCore(snapshot), false, "PID reuse cannot reuse local ownership");
  await runtime.stop();
});

test("uncertain status and stop preserve session ownership; monitor reports one loss per failure streak", async (t) => {
  const f = fixture(t);
  const runtime = await createServiceRuntime(f.layout, () => DEFAULT_SETTINGS, f.deps);
  assert.ok(runtime);
  t.after(() => runtime.close());
  await runtime.start();
  const original = runtime.ownedCoreSnapshot();
  let losses = 0;
  runtime.onAvailabilityLoss(async (snapshot) => {
    assert.deepEqual(snapshot, original);
    losses++;
  });
  f.fail(true);
  await assert.rejects(runtime.status(), /transport/);
  await assert.rejects(runtime.stop(), /transport/);
  assert.equal(runtime.isRunning(), true);
  assert.ok(readServiceSession(f.layout));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(losses, 1);
  f.fail(false);
  await runtime.status();
  f.fail(true);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(losses, 2);
  f.fail(false);
  await runtime.stop();
});

test("service boot and generation replacement fail closed even with identical PID", async (t) => {
  const f = fixture(t);
  const runtime = await createServiceRuntime(f.layout, () => DEFAULT_SETTINGS, f.deps);
  assert.ok(runtime);
  t.after(() => runtime.close());
  await runtime.start();
  const original = f.state();
  f.setState({ ...original, generation: original.generation + 1 });
  await assert.rejects(runtime.status(), /ownership changed/);
  assert.equal(runtime.isRunning(), true);
  f.setState({ ...original, serviceInstance: "boot-b" });
  await assert.rejects(runtime.stop(), /boot identity/);
  assert.ok(readServiceSession(f.layout));
});

test("close only closes bridge; recovery stops positively identified leftover and closes its bridge", async (t) => {
  const f = fixture(t);
  const runtime = await createServiceRuntime(f.layout, () => DEFAULT_SETTINGS, f.deps);
  assert.ok(runtime);
  await runtime.start();
  await runtime.close();
  assert.equal(f.state().core.running, true);
  assert.equal(f.closed(), 1);
  assert.equal(await recoverServiceRuntime(f.layout, DEFAULT_SETTINGS, f.deps), true);
  assert.equal(f.state().core.running, false);
  assert.equal(f.closed(), 2);
  assert.equal(readServiceSession(f.layout), undefined);
});

test("active service without private proof rejects and closes bridge", async (t) => {
  const f = fixture(t);
  const runtime = await createServiceRuntime(f.layout, () => DEFAULT_SETTINGS, f.deps);
  assert.ok(runtime);
  await runtime.start();
  await runtime.close();
  fs.unlinkSync(path.join(f.layout.stateDir, "service-session.json"));
  await assert.rejects(
    createServiceRuntime(f.layout, () => DEFAULT_SETTINGS, f.deps),
    /session proof/,
  );
  assert.equal(f.closed(), 2);
});

test("only confirmed absence/non-Windows permits direct fallback", async (t) => {
  const f = fixture(t);
  assert.equal(
    await createServiceRuntime(f.layout, () => DEFAULT_SETTINGS, {
      platform: "linux",
      findHelper: () => {
        throw new Error("must not query");
      },
    }),
    undefined,
  );
  assert.equal(
    await createServiceRuntime(f.layout, () => DEFAULT_SETTINGS, {
      platform: "win32",
      findHelper: () => undefined,
    }),
    undefined,
  );
  await assert.rejects(
    createServiceRuntime(f.layout, () => DEFAULT_SETTINGS, {
      ...f.deps,
      runHelper: async () => ({
        supported: true,
        installed: true,
        running: false,
      }),
    }),
    /unavailable/,
  );
  await assert.rejects(
    createServiceRuntime(f.layout, () => DEFAULT_SETTINGS, {
      ...f.deps,
      runHelper: async () => {
        throw new Error("query failed");
      },
    }),
    /query failed/,
  );
});

test("session files must be bounded regular files with validated ownership fields", (t) => {
  const f = fixture(t);
  const file = path.join(f.layout.stateDir, "service-session.json");
  atomicWriteFileSync(file, "x".repeat(4097));
  assert.throws(() => readServiceSession(f.layout), /Unsafe/);
  atomicWriteFileSync(
    file,
    JSON.stringify({
      session: "a".repeat(64),
      serviceInstance: "boot",
      generation: -1,
    }),
  );
  assert.throws(() => readServiceSession(f.layout), /Invalid/);
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.throws(() => readServiceSession(f.layout), /Unsafe/);
});

test("fake Node helper bridge uses ephemeral direct HTTP and shuts down on stdin EOF", async (t) => {
  const f = fixture(t);
  const script = `const http=require('node:http');const token='a'.repeat(64);const server=http.createServer((req,res)=>{if(req.headers.authorization!=='Bearer '+token){res.writeHead(403);res.end();return}res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,scrubbed:!process.env.GITHUB_TOKEN}));});server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({protocol:1,controller:'127.0.0.1:'+server.address().port,secret:token})));process.stdin.resume();process.stdin.on('end',()=>server.close());`;
  const bridge = await openServiceBridge(process.execPath, f.layout, {
    spawn: () =>
      spawn(process.execPath, ["-e", script], {
        stdio: ["pipe", "pipe", "pipe"],
        env: buildSanitizedEnv({
          ...process.env,
          GITHUB_TOKEN: "do-not-inherit",
        }),
      }),
  });
  try {
    assert.deepEqual(await serviceRequest(bridge.endpoint, "status"), {
      ok: true,
      scrubbed: true,
    });
  } finally {
    await bridge.close();
  }
});

test("bridge rejects oversized/invalid startup and timeout, then closes helper", async (t) => {
  const f = fixture(t);
  for (const script of [
    "console.log('x'.repeat(16385))",
    "console.log('{}')",
    "setTimeout(()=>{},10000)",
  ]) {
    await assert.rejects(
      openServiceBridge(process.execPath, f.layout, {
        timeoutMs: 100,
        spawn: () =>
          spawn(
            process.execPath,
            ["-e", `${script};process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`],
            { stdio: ["pipe", "pipe", "pipe"], env: buildSanitizedEnv() },
          ),
      }),
    );
  }
});

test("runtime constructor rejects a different private proof generation", async (t) => {
  const f = fixture(t);
  const runtime = await createServiceRuntime(f.layout, () => DEFAULT_SETTINGS, f.deps);
  assert.ok(runtime);
  await runtime.start();
  await runtime.close();
  assert.throws(
    () =>
      new ServiceRuntime(
        f.layout,
        () => DEFAULT_SETTINGS,
        f.bridge,
        { ...f.state(), generation: 99 },
        f.deps,
      ),
    /session proof/,
  );
});

test("monitor observations never overlap and confirmed exit is reported once without respawn", async (t) => {
  const f = fixture(t);
  let concurrent = 0;
  let maximum = 0;
  const baseRequest = f.deps.request;
  assert.ok(baseRequest);
  const runtime = await createServiceRuntime(f.layout, () => DEFAULT_SETTINGS, {
    ...f.deps,
    monitorMs: 5,
    request: async (...args) => {
      concurrent++;
      maximum = Math.max(maximum, concurrent);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return await baseRequest(...args);
      } finally {
        concurrent--;
      }
    },
  });
  assert.ok(runtime);
  t.after(() => runtime.close());
  await runtime.start();
  const snapshot = runtime.ownedCoreSnapshot();
  let exits = 0;
  runtime.onAvailabilityLoss(async (original) => {
    assert.deepEqual(original, snapshot);
    exits++;
  });
  f.setState({
    ...f.state(),
    generation: f.state().generation + 1,
    core: { running: false },
  });
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.equal(maximum, 1);
  assert.equal(exits, 1);
  assert.equal(runtime.isRunning(), false);
  assert.equal(f.calls.filter((op) => op === "start").length, 1);
  assert.ok(readServiceSession(f.layout), "exit observation retains proof for verified cleanup");
  await runtime.stop();
});

test("a failed start retains a durable session and can recover confirmed non-launch", async (t) => {
  const f = fixture(t);
  const request = f.deps.request;
  assert.ok(request);
  const runtime = await createServiceRuntime(f.layout, () => DEFAULT_SETTINGS, {
    ...f.deps,
    request: async (...args) => {
      if (args[1] === "start") {
        assert.ok(readServiceSession(f.layout));
        throw new Error("validation rejected");
      }
      return request(...args);
    },
  });
  assert.ok(runtime);
  t.after(() => runtime.close());
  await assert.rejects(runtime.start(), /validation rejected/);
  assert.equal(runtime.isRunning(), true);
  assert.ok(readServiceSession(f.layout));
  await runtime.stop();
  assert.equal(runtime.isRunning(), false);
  assert.equal(readServiceSession(f.layout), undefined);
});

test("provider refresh timer rebuilds fixed config serially and retries without losing Core", async (t) => {
  const f = fixture(t);
  let tick: (() => void) | undefined;
  let delay = 0;
  let builds = 0;
  let failure = false;
  let concurrent = 0;
  let maximum = 0;
  const runtime = await createServiceRuntime(f.layout, () => DEFAULT_SETTINGS, {
    ...f.deps,
    monitorMs: 1_000_000,
    setRefreshTimer: (callback, ms) => {
      tick = callback;
      delay = ms;
      return setTimeout(() => {}, 1_000_000);
    },
    clearRefreshTimer: (timer) => {
      tick = undefined;
      clearTimeout(timer);
    },
    prepareBundle: async (yaml) => {
      assert.equal(yaml, fs.readFileSync(f.layout.configFile, "utf8"));
      builds++;
      concurrent++;
      maximum = Math.max(maximum, concurrent);
      try {
        await Promise.resolve();
        if (failure) throw new Error("provider unavailable");
        return { config: {}, assets: [], refreshMs: 2000 };
      } finally {
        concurrent--;
      }
    },
  });
  assert.ok(runtime);
  t.after(() => runtime.close());
  await runtime.start();
  const original = runtime.ownedCoreSnapshot();
  assert.equal(delay, 2000);
  assert.ok(tick);
  tick();
  await runtime.status(); // queued behind timer's refresh
  assert.equal(builds, 2);
  assert.equal(f.calls.filter((op) => op === "reload").length, 1);
  failure = true;
  await assert.rejects(runtime.refreshProviders(), /provider unavailable/);
  assert.equal(runtime.isRunning(), true);
  assert.deepEqual(runtime.ownedCoreSnapshot(), original);
  assert.equal(delay, 2000);
  assert.ok(tick, "failed refresh re-arms bounded retry");
  failure = false;
  await Promise.all([runtime.refreshProviders(), runtime.refreshProviders()]);
  assert.equal(maximum, 1);
  await runtime.stop();
  assert.equal(tick, undefined);
});

test("late provider preparation after stop or close cannot publish a reload", async (t) => {
  for (const action of ["stop", "close"] as const) {
    const f = fixture(t);
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const fetching = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let builds = 0;
    const runtime = await createServiceRuntime(f.layout, () => DEFAULT_SETTINGS, {
      ...f.deps,
      monitorMs: 1_000_000,
      prepareBundle: async () => {
        if (++builds === 2) {
          entered?.();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { config: {}, assets: [], refreshMs: 2000 };
      },
    });
    assert.ok(runtime);
    await runtime.start();
    const refresh = runtime.refreshProviders();
    const rejected = assert.rejects(refresh, /superseded/);
    await fetching;
    const done = runtime[action]();
    release?.();
    await rejected;
    await done;
    assert.equal(f.calls.filter((op) => op === "reload").length, 0);
    if (action === "stop") {
      await runtime.start();
      assert.equal(f.calls.filter((op) => op === "reload").length, 0);
      await runtime.stop();
      await runtime.close();
    }
  }
});

test("same-generation unhealthy status reports availability loss once without marking stopped", async (t) => {
  const f = fixture(t);
  const runtime = await createServiceRuntime(f.layout, () => DEFAULT_SETTINGS, f.deps);
  assert.ok(runtime);
  t.after(() => runtime.close());
  await runtime.start();
  const original = runtime.ownedCoreSnapshot();
  let losses = 0;
  runtime.onAvailabilityLoss(async (snapshot) => {
    assert.deepEqual(snapshot, original);
    losses++;
  });
  const healthy = f.state();
  f.setState({ ...healthy, core: { ...healthy.core, healthy: false } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(losses, 1);
  assert.equal(runtime.isRunning(), true);
  assert.deepEqual(runtime.ownedCoreSnapshot(), original);
  f.setState(healthy);
  await runtime.stop();
});

test("native refresh rejection retains the previous running identity and private proof", async (t) => {
  const f = fixture(t);
  const request = f.deps.request;
  assert.ok(request);
  const runtime = await createServiceRuntime(f.layout, () => DEFAULT_SETTINGS, {
    ...f.deps,
    request: async (...args) => {
      if (args[1] === "reload") throw new Error("native validation rejected");
      return request(...args);
    },
  });
  assert.ok(runtime);
  t.after(() => runtime.close());
  await runtime.start();
  const original = runtime.ownedCoreSnapshot();
  const proof = readServiceSession(f.layout);
  await assert.rejects(runtime.refreshProviders(), /native validation rejected/);
  assert.equal(runtime.isRunning(), true);
  assert.deepEqual(runtime.ownedCoreSnapshot(), original);
  assert.deepEqual(readServiceSession(f.layout), proof);
  await runtime.stop();
});

test("explicit recovery retires old-boot proof only after a fresh stopped observation", async (t) => {
  const f = fixture(t);
  const runtime = await createServiceRuntime(f.layout, () => DEFAULT_SETTINGS, f.deps);
  assert.ok(runtime);
  await runtime.start();
  const proof = readServiceSession(f.layout);
  f.setState({
    ...f.state(),
    serviceInstance: "boot-b",
    generation: 0,
    core: { running: false },
  });
  await assert.rejects(runtime.status(), /boot identity changed/);
  assert.deepEqual(readServiceSession(f.layout), proof, "running adapters never adopt a new boot");
  await runtime.close();
  assert.equal(await recoverServiceRuntime(f.layout, DEFAULT_SETTINGS, f.deps), true);
  assert.equal(readServiceSession(f.layout), undefined);
  assert.equal(f.calls.includes("stop"), false, "no stop authority is inferred from the old proof");
  const next = await createServiceRuntime(f.layout, () => DEFAULT_SETTINGS, f.deps);
  assert.ok(next);
  await next.start();
  await next.stop();
  await next.close();
});

test("startup recovery retains old proof for active, unqueryable, mismatched or corrupt observations", async (t) => {
  for (const mode of ["active", "unqueryable", "root", "protocol", "corrupt"] as const) {
    const f = fixture(t);
    const runtime = await createServiceRuntime(f.layout, () => DEFAULT_SETTINGS, f.deps);
    assert.ok(runtime);
    await runtime.start();
    await runtime.close();
    f.setState({
      ...f.state(),
      serviceInstance: "boot-b",
      ...(mode === "active" ? {} : { generation: 0, core: { running: false } }),
    });
    const file = path.join(f.layout.stateDir, "service-session.json");
    if (mode === "corrupt") atomicWriteFileSync(file, "not JSON");
    const before = fs.readFileSync(file, "utf8");
    const request = f.deps.request;
    assert.ok(request);
    await assert.rejects(
      recoverServiceRuntime(f.layout, DEFAULT_SETTINGS, {
        ...f.deps,
        request: async (...args) => {
          if (mode === "unqueryable") throw new Error("no fresh status");
          if (mode === "root") return { ...f.state(), root: path.join(f.layout.root, "other") };
          if (mode === "protocol") return { ...f.state(), protocol: 2 };
          return request(...args);
        },
      }),
    );
    assert.equal(fs.readFileSync(file, "utf8"), before, mode);
    assert.equal(f.calls.includes("stop"), false);
  }
});

test("foreground exit observation retains loss identity until the monitor notifies", async (t) => {
  const f = fixture(t);
  const runtime = await createServiceRuntime(f.layout, () => DEFAULT_SETTINGS, {
    ...f.deps,
    monitorMs: 25,
  });
  assert.ok(runtime);
  t.after(() => runtime.close());
  await runtime.start();
  const original = runtime.ownedCoreSnapshot();
  assert.ok(original);
  let notify: (() => void) | undefined;
  const loss = new Promise<void>((resolve) => {
    notify = resolve;
  });
  f.setState({
    ...f.state(),
    generation: f.state().generation + 1,
    core: { running: false },
  });
  assert.equal((await runtime.status()).running, false);
  assert.equal(runtime.ownedCoreSnapshot(), undefined);
  const deadline = setTimeout(() => {
    notify?.();
  }, 1000);
  let reported = false;
  let releases = 0;
  const lifecycle = new RuntimeLifecycle({
    supervisor: runtime,
    settings: () => DEFAULT_SETTINGS,
    systemProxy: {
      apply: async () => {},
      release: async () => {
        releases++;
      },
      inspect: async () => ({
        applied: false,
        appliedKnown: true,
        stateKnown: false,
        state: { supported: false, enabled: false },
      }),
      isApplied: async () => false,
      getState: async () => ({ supported: false, enabled: false }),
    },
  });
  runtime.onAvailabilityLoss(async (snapshot) => {
    assert.deepEqual(snapshot, original);
    assert.equal(runtime.ownsCore(original), false);
    await lifecycle.handleAvailabilityLoss(snapshot);
    reported = true;
    notify?.();
  });
  try {
    await loss;
    assert.equal(reported, true);
    assert.equal(releases, 1, "confirmed exit must release proxy despite having no current child");
  } finally {
    clearTimeout(deadline);
  }
  await runtime.stop();
});

test("explicit stop acknowledges only a freshly authenticated idle new boot", async (t) => {
  const f = fixture(t);
  const runtime = await createServiceRuntime(f.layout, () => DEFAULT_SETTINGS, f.deps);
  assert.ok(runtime);
  t.after(() => runtime.close());
  await runtime.start();
  const old = runtime.ownedCoreSnapshot();
  const proof = readServiceSession(f.layout);
  f.setState({
    ...f.state(),
    serviceInstance: "boot-b",
    generation: 8,
    core: { running: false },
  });
  await assert.rejects(runtime.status(), /boot identity/);
  await assert.rejects(runtime.start(), /boot identity/);
  assert.deepEqual(readServiceSession(f.layout), proof);
  await runtime.stop();
  assert.equal(runtime.isRunning(), false);
  assert.equal(runtime.ownedCoreSnapshot(), undefined);
  assert.equal(readServiceSession(f.layout), undefined);
  assert.equal(f.calls.includes("stop"), false);
  assert.equal((await runtime.status()).running, false);
  await runtime.start();
  assert.equal(readServiceSession(f.layout)?.serviceInstance, "boot-b");
  assert.notEqual(readServiceSession(f.layout)?.session, proof?.session);
  assert.ok(old);
  assert.equal(runtime.ownsCore(old), false);
  await runtime.stop();
});

test("explicit new-boot stop preserves proof on active, corrupt or unverified observations", async (t) => {
  for (const mode of [
    "active",
    "corrupt",
    "missing",
    "root",
    "protocol",
    "version",
    "unqueryable",
  ] as const) {
    const f = fixture(t);
    const request = f.deps.request;
    assert.ok(request);
    const runtime = await createServiceRuntime(f.layout, () => DEFAULT_SETTINGS, {
      ...f.deps,
      monitorMs: 1_000_000,
      request: async (...args) => {
        const value = await request(...args);
        return mode === "protocol" && f.state().serviceInstance === "boot-b"
          ? { ...f.state(), protocol: 2 }
          : value;
      },
    });
    assert.ok(runtime);
    t.after(() => runtime.close());
    await runtime.start();
    f.setState({
      ...f.state(),
      serviceInstance: "boot-b",
      ...(mode === "active" ? {} : { generation: 0, core: { running: false } }),
      ...(mode === "root" ? { root: path.join(f.layout.root, "other") } : {}),
      ...(mode === "version" ? { version: "" } : {}),
    });
    const file = path.join(f.layout.stateDir, "service-session.json");
    if (mode === "corrupt") atomicWriteFileSync(file, "not JSON");
    if (mode === "missing") fs.unlinkSync(file);
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
    if (mode === "unqueryable") f.fail(true);
    await assert.rejects(runtime.stop());
    assert.equal(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined, before);
    assert.equal(runtime.isRunning(), true);
    assert.equal(f.calls.includes("stop"), false);
    assert.equal(f.calls.filter((op) => op === "start").length, 1);
  }
});

test("daemon lifecycle close and explicit restart recover idle host without adopting foreign Core", async (t) => {
  for (const action of ["close", "restart", "foreign"] as const) {
    const f = fixture(t);
    const runtime = await createServiceRuntime(f.layout, () => DEFAULT_SETTINGS, f.deps);
    assert.ok(runtime);
    t.after(() => runtime.close());
    await runtime.start();
    const proof = readServiceSession(f.layout);
    let releases = 0;
    const lifecycle = new RuntimeLifecycle({
      supervisor: runtime,
      settings: () => DEFAULT_SETTINGS,
      systemProxy: {
        apply: async () => {},
        release: async () => {
          releases++;
        },
        inspect: async () => ({
          applied: false,
          appliedKnown: true,
          stateKnown: true,
          state: { supported: false, enabled: false },
        }),
        isApplied: async () => false,
        getState: async () => ({ supported: false, enabled: false }),
      },
    });
    f.setState({
      ...f.state(),
      serviceInstance: "boot-b",
      ...(action === "foreign" ? {} : { generation: 0, core: { running: false } }),
    });
    await assert.rejects(runtime.status(), /boot identity/);
    if (action === "foreign") {
      await assert.rejects(lifecycle.restart(), /boot identity/);
      assert.deepEqual(readServiceSession(f.layout), proof);
      assert.equal(f.calls.filter((op) => op === "start").length, 1);
    } else if (action === "restart") {
      await lifecycle.restart();
      assert.equal(readServiceSession(f.layout)?.serviceInstance, "boot-b");
      assert.notEqual(readServiceSession(f.layout)?.session, proof?.session);
      await lifecycle.close();
    } else {
      await lifecycle.close();
      assert.equal(f.closed(), 1);
      assert.equal(readServiceSession(f.layout), undefined);
      assert.equal(f.calls.includes("stop"), false);
    }
    assert.ok(releases > 0);
  }
});
