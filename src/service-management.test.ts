import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { RuntimeContext } from "./offline-mutation.js";
import { sashLayout } from "./paths.js";
import { SashApiError } from "./sash-client.js";
import {
  installService,
  type ServiceManagementDeps,
  serviceStatus,
  uninstallService,
  updateServiceCore,
} from "./service-management.js";
import { DEFAULT_SETTINGS } from "./settings.js";

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sash-management-test-")));
  const ctx: RuntimeContext = {
    layout: sashLayout(root),
    settings: { ...DEFAULT_SETTINGS, tun: true },
  };
  const programFiles = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "sash-program-files-test-")),
  );
  const events: string[] = [];
  let installed = true;
  const deps: ServiceManagementDeps = {
    platform: "win32",
    packageVersion: "0.1.0",
    tempRoot: root,
    knownProgramFiles: () => programFiles,
    localHelper: () => undefined,
    bootstrapPrivileges: () => {
      events.push("preflight");
      return { elevated: true, ownerMatches: true };
    },
    findHelper: () => "fake-helper",
    queryState: () => (installed ? "running" : "absent"),
    runHelper: async (_helper, args) => {
      events.push(args.join(" "));
      if (args[0] === "version") return { protocol: 1, version: "0.1.0" };
      if (args[0] === "privileges") return { elevated: true, ownerMatches: true };
      if (args[0] === "stage-maintenance") {
        const directory = path.join(programFiles, `SashService-maintenance-${"a".repeat(64)}`);
        fs.mkdirSync(directory);
        const helperPath = path.join(directory, "sash-service.exe");
        fs.writeFileSync(helperPath, "verified helper mock");
        return { protocol: 1, directory, helperPath };
      }
      if (args[0] === "install" || args[0] === "uninstall") {
        assert.notEqual(_helper, "fake-helper");
        assert.equal(fs.existsSync(_helper), true);
        events.push("copy-exiting");
      }
      if (args[0] === "status")
        return {
          supported: true,
          installed,
          running: installed,
          compatible: true,
          protocol: 1,
          root: fs.realpathSync(root),
          coreVersion: "v1.2.3",
          version: "0.1.0",
        };
      return { protocol: 1, installed: args[0] !== "uninstall" };
    },
    stageCore: async (opts) => {
      events.push(`stage ${opts?.tag ?? "latest"}`);
      assert.notEqual(opts?.layout?.root, ctx.layout.root);
      assert.ok(opts?.layout);
      const exe = path.join(opts.layout.root, "core.exe");
      fs.writeFileSync(exe, "fake Core");
      return { exe, version: opts?.tag ?? "v2.0.0" };
    },
    maintenance: async () => {
      events.push("maintenance");
      return {
        daemonWasRunning: true,
        legacyDaemon: false,
        coreWasRunning: true,
      };
    },
    evaluateDaemon: async () => ({
      kind: "stopped",
      running: false,
      healthy: false,
    }),
    loadSettings: () => ctx.settings,
    releaseProxy: async () => {
      events.push("proxy");
    },
    cleanDirectCore: async () => {
      events.push("clean");
    },
    withLock: async (_file, _opts, action) => action(),
  };
  return {
    root,
    programFiles,
    ctx,
    events,
    deps,
    absent: () => {
      installed = false;
    },
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(programFiles, { recursive: true, force: true });
    },
  };
}

test("administrative preflight rejects normal and alternate users before all effects", async () => {
  for (const privileges of [
    { elevated: false, ownerMatches: true },
    { elevated: true, ownerMatches: false },
  ]) {
    const f = fixture();
    try {
      f.deps.bootstrapPrivileges = () => privileges;
      for (const op of [installService, updateServiceCore])
        await assert.rejects(op(f.ctx, {}, f.deps), /same Windows user/);
      await assert.rejects(uninstallService(f.ctx, f.deps), /same Windows user/);
      assert.deepEqual(f.events, []);
      assert.deepEqual(fs.readdirSync(f.root), []);
    } finally {
      f.cleanup();
    }
  }
});

test("install retains approved version; update chooses requested or latest; no user records or backups change", async () => {
  for (const target of ["install", "v3.0.0", "latest"]) {
    const f = fixture();
    try {
      fs.mkdirSync(f.ctx.layout.binDir);
      fs.writeFileSync(`${f.ctx.layout.coreExe}.bak`, "protected user backup");
      if (target === "install") await installService(f.ctx, {}, f.deps);
      else await updateServiceCore(f.ctx, target === "latest" ? {} : { version: target }, f.deps);
      assert.ok(f.events.includes(`stage ${target === "install" ? "v1.2.3" : target}`));
      assert.ok(f.events.indexOf("proxy") < f.events.indexOf("clean"));
      assert.ok(
        f.events.findIndex((e) => e.startsWith("install --root")) > f.events.indexOf("clean"),
      );
      assert.equal(fs.readFileSync(`${f.ctx.layout.coreExe}.bak`, "utf8"), "protected user backup");
      assert.equal(fs.existsSync(f.ctx.layout.installFile), false);
      assert.deepEqual(fs.readdirSync(f.root), ["bin"]);
      assert.equal(f.ctx.settings.tun, true);
      assert.deepEqual(fs.readdirSync(f.programFiles), []);
      assert.ok(f.events.includes("copy-exiting"));
    } finally {
      f.cleanup();
    }
  }
});

test("update absent service refuses before staging or maintenance", async () => {
  const f = fixture();
  try {
    f.absent();
    await assert.rejects(updateServiceCore(f.ctx, {}, f.deps), /not installed/);
    assert.ok(!f.events.includes("maintenance"));
    assert.ok(!f.events.some((e) => e.startsWith("stage ")));
  } finally {
    f.cleanup();
  }
});

test("failed shutdown never forces native install; staging is cleaned", async () => {
  const f = fixture();
  try {
    f.deps.maintenance = async () => {
      throw new Error("secret diagnostics");
    };
    await assert.rejects(installService(f.ctx, {}, f.deps), /SCM stop will not be forced/);
    assert.ok(!f.events.some((e) => e.startsWith("install --root")));
    assert.deepEqual(fs.readdirSync(f.root), []);
  } finally {
    f.cleanup();
  }
});

test("native error codes preserved and temporary Core cleaned on failure", async () => {
  const f = fixture();
  try {
    const run = f.deps.runHelper;
    assert.ok(run);
    f.deps.runHelper = async (helper, args) => {
      if (args[0] === "install") throw new SashApiError(409, "RECOVERY_REQUIRED", "repair");
      return run(helper, args);
    };
    await assert.rejects(
      installService(f.ctx, {}, f.deps),
      (e: unknown) => e instanceof SashApiError && e.code === "RECOVERY_REQUIRED",
    );
    assert.deepEqual(fs.readdirSync(f.root), []);
  } finally {
    f.cleanup();
  }
});

test("status projects codes without leaking helper diagnostics and rejects conflicting root", async () => {
  const f = fixture();
  try {
    for (const [code, state] of [
      ["ROOT_MISMATCH", "root-mismatch"],
      ["OWNER_MISMATCH", "root-mismatch"],
      ["PROTOCOL_MISMATCH", "incompatible"],
      ["SERVICE_UNAVAILABLE", "unavailable"],
    ]) {
      f.deps.runHelper = async () => {
        throw new SashApiError(503, code, "secret bridge credential");
      };
      const result = await serviceStatus(f.ctx.layout, f.deps);
      assert.equal(result.state, state);
      assert.ok(!JSON.stringify(result).includes("credential"));
    }
    f.deps.runHelper = async () => ({
      supported: true,
      installed: true,
      running: true,
      root: "other",
    });
    assert.equal((await serviceStatus(f.ctx.layout, f.deps)).state, "root-mismatch");
    assert.equal((await serviceStatus(f.ctx.layout, { platform: "linux" })).supported, false);
  } finally {
    f.cleanup();
  }
});

test("uninstall restores proxy first and preserves user files and desired TUN", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.ctx.layout.settingsFile, "keep");
    await uninstallService(f.ctx, f.deps);
    assert.equal(fs.readFileSync(f.ctx.layout.settingsFile, "utf8"), "keep");
    assert.equal(f.ctx.settings.tun, true);
    assert.ok(
      f.events.indexOf("proxy") < f.events.findIndex((e) => e.startsWith("uninstall --root")),
    );
    assert.ok(!f.events.some((e) => e.startsWith("stage ")));
  } finally {
    f.cleanup();
  }
});

test("downloaded helper uses exact package release and architecture then validates protocol", async () => {
  const f = fixture();
  try {
    f.absent();
    f.deps.findHelper = () => undefined;
    f.deps.arch = "arm64";
    f.deps.listAssets = async (repo, tag) => {
      assert.equal(repo, "ming-kang/Sash");
      assert.equal(tag, "v0.1.0");
      return [];
    };
    f.deps.downloadAsset = async (opts) => {
      assert.deepEqual(opts.candidates, ["sash-service-windows-arm64.exe"]);
      fs.writeFileSync(opts.dest, "verified helper mock");
      return "sash-service-windows-arm64.exe";
    };
    f.deps.runHelper = async () => ({ protocol: 99, version: "0.1.0" });
    await assert.rejects(installService(f.ctx, {}, f.deps), /version\/protocol/);
    assert.deepEqual(fs.readdirSync(f.root), []);
    assert.ok(!f.events.includes("maintenance"));
    f.deps.downloadAsset = async () => {
      throw new Error("digest mismatch");
    };
    await assert.rejects(installService(f.ctx, {}, f.deps), /npm run build:service/);
    assert.deepEqual(fs.readdirSync(f.root), []);
  } finally {
    f.cleanup();
  }
});

test("native owner and root conflicts reject before staging or stopping", async () => {
  for (const conflict of ["owner", "root"]) {
    const f = fixture();
    try {
      const run = f.deps.runHelper;
      assert.ok(run);
      f.deps.runHelper = async (helper, args) => {
        if (conflict === "owner" && args[0] === "privileges")
          return { elevated: true, ownerMatches: false };
        if (conflict === "root" && args[0] === "status")
          return {
            supported: true,
            installed: true,
            running: true,
            root: "different",
          };
        return run(helper, args);
      };
      await assert.rejects(installService(f.ctx, {}, f.deps), /same Windows user|different root/);
      assert.ok(!f.events.includes("maintenance"));
      assert.ok(!f.events.some((e) => e.startsWith("stage ")));
    } finally {
      f.cleanup();
    }
  }
});

test("uncertain direct ownership stops cutover after proxy recovery without forcing native SCM", async () => {
  const f = fixture();
  try {
    f.deps.cleanDirectCore = async () => {
      throw new Error("unknown identity");
    };
    await assert.rejects(installService(f.ctx, {}, f.deps), /unknown identity/);
    assert.ok(f.events.includes("proxy"));
    assert.ok(!f.events.some((e) => e.startsWith("install --root")));
    assert.deepEqual(fs.readdirSync(f.root), []);
  } finally {
    f.cleanup();
  }
});

test("maintenance copy exits before cleanup and original helper only performs short calls", async () => {
  const f = fixture();
  try {
    const run = f.deps.runHelper;
    assert.ok(run);
    let copy: string | undefined;
    f.deps.runHelper = async (helper, args) => {
      if (args[0] === "stage-maintenance") {
        assert.equal(helper, "fake-helper");
        assert.ok(f.events.some((event) => event.startsWith("privileges --root")));
      }
      if (args[0] === "install") {
        copy = helper;
        assert.ok(
          f.events.indexOf(`stage-maintenance --root ${fs.realpathSync(f.root)}`) <
            f.events.indexOf("maintenance"),
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(fs.existsSync(helper), true);
      }
      return run(helper, args);
    };
    await installService(f.ctx, {}, f.deps);
    assert.ok(copy);
    assert.equal(fs.existsSync(copy), false);
    assert.deepEqual(fs.readdirSync(f.programFiles), []);
  } finally {
    f.cleanup();
  }
});

test("malformed or pre-existing maintenance paths are never launched or removed", async () => {
  for (const kind of ["relative", "outside", "parent", "basename", "prefix", "existing", "link"]) {
    const f = fixture();
    try {
      const directory = path.join(f.programFiles, `SashService-maintenance-${"b".repeat(64)}`);
      const outside = path.join(f.root, "keep");
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "keep.txt"), "untouched");
      if (kind === "existing") fs.mkdirSync(directory);
      const run = f.deps.runHelper;
      assert.ok(run);
      f.deps.runHelper = async (helper, args) => {
        if (args[0] !== "stage-maintenance") return run(helper, args);
        if (kind === "link") fs.symlinkSync(outside, directory, "junction");
        return {
          protocol: 1,
          directory:
            kind === "relative"
              ? "relative"
              : kind === "outside"
                ? outside
                : kind === "prefix"
                  ? path.join(f.programFiles, "SashService")
                  : directory,
          helperPath: path.join(
            kind === "outside" ? outside : directory,
            kind === "basename"
              ? "other.exe"
              : kind === "parent"
                ? "nested/sash-service.exe"
                : "sash-service.exe",
          ),
        };
      };
      await assert.rejects(installService(f.ctx, {}, f.deps), /Invalid protected maintenance/);
      assert.ok(!f.events.includes("maintenance"));
      assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "untouched");
      if (kind === "existing") assert.equal(fs.existsSync(directory), true);
    } finally {
      f.cleanup();
    }
  }
});

test("cleanup failure is reported without masking the native error", async (t) => {
  const f = fixture();
  const run = f.deps.runHelper;
  assert.ok(run);
  const primary = new SashApiError(409, "RECOVERY_REQUIRED", "original repair error");
  const warnings: string[] = [];
  const remove = fs.unlinkSync;
  t.mock.method(console, "warn", (message: string) => warnings.push(message));
  t.mock.method(fs, "unlinkSync", ((file) => {
    if (String(file).includes("SashService-maintenance-")) throw new Error("locked");
    return remove(file);
  }) as typeof fs.unlinkSync);
  try {
    f.deps.runHelper = async (helper, args) => {
      if (args[0] === "install") throw primary;
      return run(helper, args);
    };
    await assert.rejects(installService(f.ctx, {}, f.deps), (error) => error === primary);
    assert.ok(warnings.some((message) => message.includes("Could not remove service staging")));
  } finally {
    t.mock.restoreAll();
    f.cleanup();
  }
});

test("default old helper bootstraps a verified matching release before shutdown", async () => {
  for (const fails of [false, true]) {
    const f = fixture();
    try {
      const run = f.deps.runHelper;
      assert.ok(run);
      f.deps.runHelper = async (helper, args) =>
        helper === "fake-helper" && args[0] === "version"
          ? { protocol: 1, version: "0.0.1" }
          : run(helper, args);
      f.deps.listAssets = async () => [];
      f.deps.downloadAsset = async (opts) => {
        assert.ok(f.events.includes("preflight"));
        assert.ok(!f.events.includes("maintenance"));
        if (fails) throw new Error("digest mismatch");
        fs.writeFileSync(opts.dest, "verified helper mock");
        return "sash-service-windows-amd64.exe";
      };
      if (fails) {
        await assert.rejects(updateServiceCore(f.ctx, {}, f.deps), /No verified/);
        assert.ok(!f.events.includes("maintenance"));
        assert.ok(!f.events.includes("proxy"));
      } else await updateServiceCore(f.ctx, {}, f.deps);
      assert.deepEqual(fs.readdirSync(f.root), []);
      assert.deepEqual(fs.readdirSync(f.programFiles), []);
    } finally {
      f.cleanup();
    }
  }
});

test("explicit old helper fails without replacing the selection or downloading", async () => {
  const f = fixture();
  try {
    const helper = path.join(f.root, "explicit.exe");
    fs.writeFileSync(helper, "keep");
    f.deps.runHelper = async () => ({ protocol: 1, version: "0.0.1" });
    f.deps.listAssets = async () => {
      assert.fail("must not download");
    };
    await assert.rejects(
      installService(f.ctx, { helperPath: helper }, f.deps),
      /version\/protocol/,
    );
    assert.equal(fs.readFileSync(helper, "utf8"), "keep");
    assert.ok(!f.events.includes("maintenance"));
  } finally {
    f.cleanup();
  }
});

test("status never claims ready with missing versions, malformed root or unknown compatibility", async () => {
  const f = fixture();
  try {
    for (const overrides of [
      { version: "" },
      { coreVersion: "" },
      { root: "" },
      { compatible: undefined },
    ]) {
      f.deps.runHelper = async () => ({
        supported: true,
        installed: true,
        running: true,
        protocol: 1,
        compatible: true,
        root: fs.realpathSync(f.root),
        version: "0.1.0",
        coreVersion: "v1.2.3",
        ...overrides,
      });
      assert.notEqual((await serviceStatus(f.ctx.layout, f.deps)).state, "ready");
    }
  } finally {
    f.cleanup();
  }
});

test("matching local build upgrades the default helper without downloads", async () => {
  const f = fixture();
  try {
    const local = path.join(f.root, "local.exe");
    fs.writeFileSync(local, "local build");
    f.deps.localHelper = () => local;
    f.deps.listAssets = async () => {
      assert.fail("local matching build must not download");
    };
    const run = f.deps.runHelper;
    assert.ok(run);
    f.deps.runHelper = async (helper, args) =>
      helper === "fake-helper" && args[0] === "version"
        ? { protocol: 1, version: "0.0.1" }
        : run(helper, args);
    await updateServiceCore(f.ctx, {}, f.deps);
    assert.equal(fs.readFileSync(local, "utf8"), "local build");
  } finally {
    f.cleanup();
  }
});

test("staged helper identity and privileges are checked before runtime shutdown", async () => {
  for (const failure of ["version", "privileges", "root", "nonfile"]) {
    const f = fixture();
    try {
      const run = f.deps.runHelper;
      assert.ok(run);
      f.deps.runHelper = async (helper, args) => {
        const value = await run(helper, args);
        if (args[0] === "stage-maintenance" && failure === "nonfile") {
          const directory = path.join(f.programFiles, `SashService-maintenance-${"a".repeat(64)}`);
          fs.unlinkSync(path.join(directory, "sash-service.exe"));
          fs.mkdirSync(path.join(directory, "sash-service.exe"));
        }
        if (helper.includes("SashService-maintenance-")) {
          if (failure === "version" && args[0] === "version")
            return { protocol: 2, version: "0.1.0" };
          if (failure === "privileges" && args[0] === "privileges")
            return { elevated: true, ownerMatches: false };
          if (failure === "root" && args[0] === "status")
            return {
              supported: true,
              installed: true,
              running: false,
              root: "other",
            };
        }
        return value;
      };
      await assert.rejects(
        installService(f.ctx, {}, f.deps),
        /version\/protocol|same Windows user|different root|regular non-link/,
      );
      assert.ok(!f.events.includes("maintenance"));
      assert.ok(!f.events.includes("proxy"));
    } finally {
      f.cleanup();
    }
  }
});

test("orphaned first install retries using verified protected repair metadata before cutover", async () => {
  for (const discovery of [true, false]) {
    const f = fixture();
    try {
      f.absent();
      const helper = path.join(f.root, "local.exe");
      fs.writeFileSync(helper, "matching helper");
      f.deps.localHelper = () => helper;
      if (discovery)
        f.deps.findHelper = () => {
          throw new SashApiError(409, "RECOVERY_REQUIRED", "orphan");
        };
      const run = f.deps.runHelper;
      assert.ok(run);
      f.deps.runHelper = async (selected, args) => {
        if (args[0] === "status") throw new SashApiError(409, "RECOVERY_REQUIRED", "orphan");
        if (args[0] === "repair-status") {
          assert.ok(selected.includes("SashService-maintenance-"));
          assert.ok(!f.events.includes("maintenance"));
          f.events.push("repair");
          return {
            protocol: 1,
            supported: true,
            installed: false,
            running: false,
            compatible: true,
            root: fs.realpathSync(f.root),
            version: "0.1.0",
            coreVersion: "v-approved",
          };
        }
        return run(selected, args);
      };
      await installService(f.ctx, discovery ? {} : { helperPath: helper }, f.deps);
      assert.ok(f.events.includes("repair"));
      assert.ok(f.events.includes("stage v-approved"));
      assert.ok(f.events.some((event) => event.startsWith("install --root")));
      assert.deepEqual(fs.readdirSync(f.programFiles), []);
    } finally {
      f.cleanup();
    }
  }
});

test("orphan recovery never converts other errors, installed SCM, updates or unknown Core into absence", async () => {
  for (const kind of [
    "owner",
    "scm",
    "update",
    "uninstall",
    "active",
    "wrong-root",
    "unknown-core",
  ]) {
    const f = fixture();
    try {
      if (kind !== "scm") f.absent();
      const run = f.deps.runHelper;
      assert.ok(run);
      f.deps.runHelper = async (helper, args) => {
        if (args[0] === "status")
          throw new SashApiError(
            409,
            kind === "owner" ? "OWNER_MISMATCH" : "RECOVERY_REQUIRED",
            "blocked",
          );
        if (args[0] === "repair-status") {
          if (kind === "active")
            throw new SashApiError(409, "RECOVERY_REQUIRED", "launch evidence");
          return {
            protocol: 1,
            supported: true,
            installed: false,
            running: false,
            compatible: true,
            version: "0.1.0",
            root: kind === "wrong-root" ? "other" : fs.realpathSync(f.root),
            ...(kind === "unknown-core" ? { core: { running: false } } : {}),
          };
        }
        return run(helper, args);
      };
      const action =
        kind === "update"
          ? updateServiceCore(f.ctx, {}, f.deps)
          : kind === "uninstall"
            ? uninstallService(f.ctx, f.deps)
            : installService(f.ctx, {}, f.deps);
      await assert.rejects(action);
      assert.ok(!f.events.includes("maintenance"));
      assert.ok(!f.events.some((event) => event.startsWith("install --root")));
    } finally {
      f.cleanup();
    }
  }
});

test("installed unavailable host is started idle before graceful install/update maintenance only", async () => {
  for (const operation of ["install", "update", "uninstall"] as const) {
    const f = fixture();
    try {
      f.deps.queryState = () => "unavailable";
      f.deps.evaluateDaemon = async () =>
        f.events.includes("maintenance")
          ? { kind: "stopped", running: false, healthy: false }
          : { kind: "healthy", running: true, healthy: true, pid: 424242, port: 49152 };
      const run = f.deps.runHelper;
      assert.ok(run);
      f.deps.runHelper = async (helper, args, timeout) => {
        const value = await run(helper, args, timeout);
        if (args[0] === "status") return { ...(value as object), running: false };
        if (args[0] === "start-service") {
          assert.ok(helper.includes("SashService-maintenance-"));
          assert.ok(!f.events.includes("maintenance"));
          assert.ok(!f.events.includes("proxy"));
          assert.ok(!f.events.some((event) => event.startsWith("install --root")));
          return {
            protocol: 1,
            supported: true,
            installed: true,
            running: true,
            compatible: true,
            root: fs.realpathSync(f.root),
            version: "0.0.1",
            coreVersion: "v1.2.3",
            serviceInstance: "new-boot",
            generation: 0,
            core: { running: false },
          };
        }
        return value;
      };
      if (operation === "uninstall") await uninstallService(f.ctx, f.deps);
      else if (operation === "update") await updateServiceCore(f.ctx, {}, f.deps);
      else await installService(f.ctx, {}, f.deps);
      const start = f.events.findIndex((event) => event.startsWith("start-service --root"));
      assert.equal(start >= 0, operation !== "uninstall");
      if (operation !== "uninstall") assert.ok(start < f.events.indexOf("maintenance"));
      assert.ok(f.events.indexOf("maintenance") < f.events.indexOf("proxy"));
    } finally {
      f.cleanup();
    }
  }
});

test("idle host repair fails closed on unavailable or active Core and never bypasses failed shutdown", async () => {
  for (const mode of ["query", "active", "missing", "root", "protocol", "shutdown"] as const) {
    const f = fixture();
    try {
      f.deps.queryState = () => "unavailable";
      f.deps.evaluateDaemon = async () =>
        f.events.includes("maintenance")
          ? { kind: "stopped", running: false, healthy: false }
          : { kind: "healthy", running: true, healthy: true, pid: 424242, port: 49152 };
      const run = f.deps.runHelper;
      assert.ok(run);
      f.deps.runHelper = async (helper, args, timeout) => {
        const value = await run(helper, args, timeout);
        if (args[0] === "status") return { ...(value as object), running: false };
        if (args[0] === "start-service") {
          if (mode === "query") throw new Error("SCM cannot be validated");
          return {
            protocol: mode === "protocol" ? 2 : 1,
            supported: true,
            installed: true,
            running: true,
            compatible: true,
            root: mode === "root" ? "other" : fs.realpathSync(f.root),
            version: "0.0.1",
            coreVersion: "v1",
            serviceInstance: "new-boot",
            generation: 0,
            ...(mode === "missing"
              ? {}
              : {
                  core:
                    mode === "active"
                      ? {
                          running: true,
                          pid: 1234,
                          startedAt: new Date().toISOString(),
                          healthy: true,
                        }
                      : { running: false },
                }),
          };
        }
        return value;
      };
      f.deps.maintenance = async () => {
        f.events.push("maintenance");
        throw new Error("shutdown failed");
      };
      await assert.rejects(installService(f.ctx, {}, f.deps));
      assert.equal(f.events.includes("maintenance"), mode === "shutdown");
      assert.ok(!f.events.includes("proxy"));
      assert.ok(!f.events.some((event) => event.startsWith("install --root")));
      assert.deepEqual(fs.readdirSync(f.programFiles), []);
    } finally {
      f.cleanup();
    }
  }
});

test("stopped daemon retains administrative unavailable-host repair without IPC preflight", async () => {
  const f = fixture();
  try {
    f.deps.queryState = () => "unavailable";
    const run = f.deps.runHelper;
    assert.ok(run);
    f.deps.runHelper = async (helper, args, timeout) => {
      assert.notEqual(args[0], "start-service", "no live daemon needs boot acknowledgement");
      const value = await run(helper, args, timeout);
      return args[0] === "status" ? { ...(value as object), running: false } : value;
    };
    await installService(f.ctx, {}, f.deps);
    assert.ok(f.events.includes("maintenance"));
    assert.ok(f.events.includes("proxy"));
    assert.ok(f.events.some((event) => event.startsWith("install --root")));
  } finally {
    f.cleanup();
  }
});
