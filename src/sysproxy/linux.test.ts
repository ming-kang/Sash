import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import {
  detectLinuxDesktop,
  linuxSystemProxyBackend,
  linuxSystemProxySnapshotCodec,
} from "./linux.js";
import { SystemProxyManager } from "./manager.js";
import type { PosixSystemProxySnapshot } from "./types.js";

const codec = linuxSystemProxySnapshotCodec();

function gnomeSnapshot(mode: string): PosixSystemProxySnapshot {
  return {
    version: 1,
    platform: "linux",
    values: {
      mode: mode,
      "http.host": "127.0.0.1",
      "http.port": 17890,
      "ignore-hosts": ["localhost"],
    },
  };
}

describe("linux desktop detection", () => {
  it("maps desktop names to gsettings or kwriteconfig backends", () => {
    assert.equal(detectLinuxDesktop({ XDG_CURRENT_DESKTOP: "GNOME" }), "gnome");
    assert.equal(detectLinuxDesktop({ XDG_CURRENT_DESKTOP: "ubuntu:GNOME" }), "gnome");
    assert.equal(detectLinuxDesktop({ XDG_CURRENT_DESKTOP: "KDE" }), "kde");
    assert.equal(detectLinuxDesktop({ DESKTOP_SESSION: "plasma" }), "kde");
    assert.equal(detectLinuxDesktop({ XDG_CURRENT_DESKTOP: "sway" }), null);
    assert.equal(detectLinuxDesktop({}), null);
  });
});

describe("linux snapshot codec", () => {
  it("parses a persisted linux snapshot", () => {
    const parsed = codec.parse(gnomeSnapshot("manual"));
    assert.equal(parsed.platform, "linux");
    assert.equal((parsed as PosixSystemProxySnapshot).values.mode, "manual");
  });

  it("rejects foreign snapshots", () => {
    assert.throws(() => codec.parse({ version: 1, platform: "darwin", values: {} }));
    assert.throws(() => codec.parse({ version: 2, platform: "linux", values: {} }));
    assert.throws(() => codec.parse(null));
  });

  it("computes equivalence on managed keys only", () => {
    const left = gnomeSnapshot("manual");
    const right = { ...gnomeSnapshot("manual"), values: { ...gnomeSnapshot("manual").values } };
    assert.equal(codec.equivalent(left, right), true);
    const other = gnomeSnapshot("none");
    assert.equal(codec.equivalent(left, other), false);
  });

  it("derives enabled state from GNOME and KDE values", () => {
    assert.deepEqual(codec.state(gnomeSnapshot("manual")), {
      supported: true,
      enabled: true,
      server: "127.0.0.1:17890",
      details: undefined,
    });
    assert.equal(codec.state(gnomeSnapshot("none")).enabled, false);
    assert.equal(codec.state(gnomeSnapshot("auto")).enabled, true);
    const kde: PosixSystemProxySnapshot = {
      version: 1,
      platform: "linux",
      values: { "Proxy Settings/ProxyType": 1, "Proxy Settings/httpProxy": "http://x 8080" },
    };
    assert.equal(codec.state(kde).enabled, true);
    assert.equal(codec.state(kde).server, "http://x 8080");
  });

  it("produces a GNOME manual target", () => {
    const target = codec.target(
      { host: "127.0.0.1", port: 7890, bypass: ["a"] },
      gnomeSnapshot("none"),
    );
    assert.equal((target as PosixSystemProxySnapshot).values.mode, "manual");
    assert.equal((target as PosixSystemProxySnapshot).values["http.port"], 7890);
  });
});

describe("linux backend", () => {
  it("reports unsupported in a headless session and rejects restore consistently", async () => {
    const backend = linuxSystemProxyBackend({ env: {} });
    assert.equal(backend.supported, false);
    await assert.rejects(
      backend.restore(gnomeSnapshot("none"), gnomeSnapshot("none")),
      /not supported/,
    );
  });

  it("aborts the GNOME snapshot when a key read fails", async () => {
    const run = async (_cmd: string, args: string[]) => {
      if (args[2] === "ignore-hosts") throw new Error("schema missing");
      return "''";
    };
    const backend = linuxSystemProxyBackend({
      env: { XDG_CURRENT_DESKTOP: "GNOME", PATH: "/usr/bin" },
      run,
    });
    if (!backend.supported) return;
    await assert.rejects(backend.capture(), /Could not read GNOME proxy setting ignore-hosts/);
  });

  it("captures and applies GNOME gsettings values", async () => {
    const calls: string[] = [];
    const values: Record<string, string> = {
      "org.gnome.system.proxy mode": "'none'",
      "org.gnome.system.proxy.http host": "''",
      "org.gnome.system.proxy.http port": "0",
      "org.gnome.system.proxy ignore-hosts": "['localhost']",
    };
    const run = async (_cmd: string, args: string[]) => {
      const joined = args.join(" ");
      calls.push(joined);
      const key = `${args[1]} ${args[2]}`;
      return values[key] ?? "''";
    };
    const backend = linuxSystemProxyBackend({
      env: { XDG_CURRENT_DESKTOP: "GNOME", PATH: "/usr/bin" },
      run,
    });
    // gsettings may be missing on PATH — then unsupported is legitimate.
    if (!backend.supported) return;
    const snap = await backend.capture();
    assert.equal(snap.platform, "linux");
    await backend.apply(codec.target({ host: "127.0.0.1", port: 7890, bypass: [] }, snap));
    assert.ok(calls.some((c) => c.includes("set org.gnome.system.proxy mode 'manual'")));
  });
});

describe("linux precise restore", () => {
  it("restores the typed-empty GNOME ignore-hosts verbatim", async () => {
    const calls: string[] = [];
    const store: Record<string, string> = {
      "org.gnome.system.proxy mode": "'none'",
      "org.gnome.system.proxy ignore-hosts": "@as []",
      "org.gnome.system.proxy.http host": "''",
      "org.gnome.system.proxy.http port": "0",
      "org.gnome.system.proxy.http use-authentication": "false",
      "org.gnome.system.proxy.http authentication-user": "'alice'",
      "org.gnome.system.proxy.http authentication-password": "'s3cret'",
    };
    const run = async (_cmd: string, args: string[]) => {
      calls.push(args.join(" "));
      const key = `${args[1]} ${args[2]}`;
      if (args[0] === "set") {
        store[key] = args[3] as string;
        return "";
      }
      return store[key] ?? "''";
    };
    const backend = linuxSystemProxyBackend({
      env: { XDG_CURRENT_DESKTOP: "GNOME", PATH: "/usr/bin" },
      run,
    });
    if (!backend.supported) return;
    const original = await backend.capture();
    const target = codec.target({ host: "127.0.0.1", port: 7890, bypass: ["x"] }, original);
    calls.length = 0;
    await backend.apply(target);
    // An unchanged credential key is never rewritten.
    assert.ok(
      !calls.some((c) => c.includes("set org.gnome.system.proxy.http authentication-")),
      calls.join("\n"),
    );
    assert.ok(calls.includes("set org.gnome.system.proxy ignore-hosts ['x']"));
    calls.length = 0;
    await backend.apply(original);
    assert.ok(calls.includes("set org.gnome.system.proxy ignore-hosts @as []"));
  });

  it("distinguishes absent/empty/default KDE keys and deletes absent ones", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-kde-"));
    t.onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    // Present-empty httpProxy; absent socksProxy; present-default ProxyType.
    fs.writeFileSync(
      path.join(dir, "config", "kioslaverc"),
      "[Proxy Settings]\nhttpProxy=\nProxyType=0\n",
    );
    const calls: string[] = [];
    const store: Record<string, string> = { httpProxy: "", ProxyType: "0" };
    const rc = path.join(dir, "config", "kioslaverc");
    const syncFile = () => {
      const lines = Object.entries(store).map(([k, v]) => `${k}=${v}`);
      fs.writeFileSync(rc, `[Proxy Settings]\n${lines.join("\n")}\n`);
    };
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args].join(" "));
      const keyIdx = args.indexOf("--key");
      const key = keyIdx >= 0 ? (args[keyIdx + 1] as string) : "";
      if (cmd.includes("kreadconfig")) return store[key] ?? "";
      if (cmd.includes("kwriteconfig")) {
        if (args.includes("--delete")) delete store[key];
        else store[key] = args[args.length - 1] as string;
        syncFile();
      }
      if (cmd === "dbus-send" && args[1]?.includes("kded5")) {
        throw new Error("no such daemon");
      }
      return "";
    };
    const backend = linuxSystemProxyBackend({
      env: {
        XDG_CURRENT_DESKTOP: "KDE",
        PATH: "/usr/bin",
        XDG_CONFIG_HOME: path.join(dir, "config"),
      },
      run,
    });
    if (!backend.supported) return;
    const original = await backend.capture();
    const values = (original as PosixSystemProxySnapshot).values;
    // Present-empty reads back as "", absent as null+absent marker.
    assert.equal(values["Proxy Settings/httpProxy"], "");
    assert.equal(values["Proxy Settings/socksProxy"], null);
    assert.equal(values["Proxy Settings/ProxyType"], 0);
    // Apply the target so socksProxy exists, then restore — the
    // restored-absent key must be deleted, never emptied.
    await backend.apply(codec.target({ host: "127.0.0.1", port: 7890, bypass: [] }, original));
    assert.ok("socksProxy" in store);
    calls.length = 0;
    await backend.apply(original);
    assert.ok(
      calls.some((c) => c.includes("--key socksProxy --delete")),
      calls.join("\n"),
    );
    assert.ok(!("socksProxy" in store));
    // The notify targets the running generation — kded6 (kded5 is tried
    // only when kded6 is unreachable).
    assert.ok(calls.some((c) => c.includes("org.kde.kded6")));
  });
});

describe("linux SystemProxyManager — GNOME on/off", () => {
  it("applies and releases cleanly through the real manager", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-sysproxy-gnome-"));
    try {
      const gsettings: Record<string, string> = {
        "org.gnome.system.proxy mode": "'none'",
        "org.gnome.system.proxy ignore-hosts": "@as []",
        "org.gnome.system.proxy.http host": "''",
        "org.gnome.system.proxy.http port": "0",
        "org.gnome.system.proxy.https host": "''",
        "org.gnome.system.proxy.https port": "0",
        "org.gnome.system.proxy.socks host": "''",
        "org.gnome.system.proxy.socks port": "0",
        "org.gnome.system.proxy.http enabled": "false",
        "org.gnome.system.proxy.http use-authentication": "false",
        "org.gnome.system.proxy.http authentication-user": "''",
        "org.gnome.system.proxy.http authentication-password": "''",
      };
      const run = async (cmd: string, args: string[]) => {
        const key = `${args[1]} ${args[2]}`;
        if (cmd === "gsettings" && args[0] === "set") gsettings[key] = args[3] as string;
        return gsettings[key] ?? "''";
      };
      const backend = linuxSystemProxyBackend({
        env: { XDG_CURRENT_DESKTOP: "GNOME", PATH: "/usr/bin" },
        run,
      });
      if (!backend.supported) return;
      const layout = {
        systemProxyStateFile: path.join(tmpDir, "state", "system-proxy.json"),
        systemProxyLockFile: path.join(tmpDir, "proxy.lock"),
      };
      const manager = new SystemProxyManager({ layout, backend });

      // apply: capture and target share the same presence metadata, so
      // target verification must pass.
      await manager.apply({ port: 17890, bypass: ["localhost"] });
      assert.equal(gsettings["org.gnome.system.proxy mode"], "'manual'");
      assert.equal(gsettings["org.gnome.system.proxy.http port"], "17890");
      assert.equal((await manager.inspect()).applied, true);

      // release: every changed key is written back to its captured raw.
      await manager.release();
      assert.equal(gsettings["org.gnome.system.proxy mode"], "'none'");
      assert.equal(gsettings["org.gnome.system.proxy.http port"], "0");
      assert.equal((await manager.inspect()).applied, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("linux precise restore — GNOME conservative model", () => {
  it("writes back only keys Sash changed, never resets or invents values", async () => {
    const calls: string[] = [];
    const gsettings: Record<string, string> = {
      "org.gnome.system.proxy mode": "'none'",
      "org.gnome.system.proxy ignore-hosts": "@as []",
    };
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args].join(" "));
      const key = `${args[1]} ${args[2]}`;
      if (cmd === "gsettings" && args[0] === "set") gsettings[key] = args[3] as string;
      return gsettings[key] ?? "''";
    };
    const backend = linuxSystemProxyBackend({
      env: { XDG_CURRENT_DESKTOP: "GNOME", PATH: "/usr/bin" },
      run,
    });
    if (!backend.supported) return;
    const original = await backend.capture();
    await backend.apply(codec.target({ host: "127.0.0.1", port: 7890, bypass: ["x"] }, original));
    assert.ok(gsettings["org.gnome.system.proxy mode"] === "'manual'");
    calls.length = 0;
    await backend.apply(original);
    // Restore sets the captured raw for keys that changed — never reset,
    // never writes a key it did not change.
    assert.ok(calls.includes("gsettings set org.gnome.system.proxy mode 'none'"));
    assert.ok(
      calls.includes("gsettings set org.gnome.system.proxy ignore-hosts @as []"),
      calls.join("\n"),
    );
    assert.ok(!calls.some((c) => c.startsWith("gsettings reset")));
  });
});

describe("linux backend restore", () => {
  const GNOME_BASELINE: Record<string, string> = {
    "org.gnome.system.proxy mode": "'none'",
    "org.gnome.system.proxy autoconfig-url": "''",
    "org.gnome.system.proxy ignore-hosts": "@as []",
    "org.gnome.system.proxy.http enabled": "false",
    "org.gnome.system.proxy.http host": "''",
    "org.gnome.system.proxy.http port": "0",
    "org.gnome.system.proxy.http use-authentication": "false",
    "org.gnome.system.proxy.http authentication-user": "''",
    "org.gnome.system.proxy.http authentication-password": "''",
    "org.gnome.system.proxy.https host": "''",
    "org.gnome.system.proxy.https port": "0",
    "org.gnome.system.proxy.socks host": "''",
    "org.gnome.system.proxy.socks port": "0",
    "org.gnome.system.proxy.ftp host": "''",
    "org.gnome.system.proxy.ftp port": "0",
  };

  function gnomeBackend(initial: Record<string, string>) {
    const calls: string[] = [];
    const store = { ...initial };
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args].join(" "));
      const key = `${args[1]} ${args[2]}`;
      if (cmd === "gsettings" && args[0] === "set") {
        store[key] = args[3] as string;
        return "";
      }
      return store[key] ?? "''";
    };
    return {
      calls,
      store,
      backend: linuxSystemProxyBackend({
        env: { XDG_CURRENT_DESKTOP: "GNOME", PATH: "/usr/bin" },
        run,
      }),
    };
  }

  it("writes back captured raw values for keys still holding the target", async () => {
    const { store, backend } = gnomeBackend(GNOME_BASELINE);
    if (!backend.supported) return;
    const original = await backend.capture();
    const target = codec.target({ host: "127.0.0.1", port: 7890, bypass: ["x"] }, original);
    await backend.apply(target);

    const result = await backend.restore(original, target);

    assert.deepEqual(result.skipped, []);
    assert.equal(store["org.gnome.system.proxy mode"], "'none'");
    assert.equal(store["org.gnome.system.proxy.http port"], "0");
    assert.equal(store["org.gnome.system.proxy ignore-hosts"], "@as []");
  });

  it("skips an externally modified key while restoring the rest", async () => {
    const { store, backend } = gnomeBackend(GNOME_BASELINE);
    if (!backend.supported) return;
    const original = await backend.capture();
    const target = codec.target({ host: "127.0.0.1", port: 7890, bypass: ["x"] }, original);
    await backend.apply(target);
    store["org.gnome.system.proxy.http port"] = "3128";

    const result = await backend.restore(original, target);

    assert.deepEqual(result.skipped, [
      {
        key: "http.port",
        service: "org.gnome.system.proxy.http port",
        reason: "modified",
      },
    ]);
    assert.equal(store["org.gnome.system.proxy.http port"], "3128", "foreign value untouched");
    assert.equal(store["org.gnome.system.proxy mode"], "'none'", "other keys restored");
    assert.equal(store["org.gnome.system.proxy.https port"], "0");
  });

  it("recovers a partial state holding only original and target values", async () => {
    const { store, backend } = gnomeBackend(GNOME_BASELINE);
    if (!backend.supported) return;
    const original = await backend.capture();
    const target = codec.target({ host: "127.0.0.1", port: 7890, bypass: ["x"] }, original);
    await backend.apply(target);
    // A crash mid-restore leaves some keys back at the original already.
    store["org.gnome.system.proxy mode"] = "'none'";
    store["org.gnome.system.proxy ignore-hosts"] = "@as []";

    const result = await backend.restore(original, target);

    assert.deepEqual(result.skipped, []);
    assert.equal(store["org.gnome.system.proxy.http port"], "0");
    assert.equal(store["org.gnome.system.proxy.socks host"], "''");
  });

  it("writes nothing when every key already holds the original", async () => {
    const { calls, backend } = gnomeBackend(GNOME_BASELINE);
    if (!backend.supported) return;
    const original = await backend.capture();
    const target = codec.target({ host: "127.0.0.1", port: 7890, bypass: ["x"] }, original);
    calls.length = 0;

    const result = await backend.restore(original, target);

    assert.deepEqual(result.skipped, []);
    assert.equal(
      calls.some((line) => line.startsWith("gsettings set")),
      false,
      calls.join("\n"),
    );
  });

  it("skips a KDE key modified outside Sash while deleting restored-absent keys", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-kde-restore-"));
    t.onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
    const configHome = path.join(dir, "config");
    fs.mkdirSync(configHome, { recursive: true });
    const rc = path.join(configHome, "kioslaverc");
    fs.writeFileSync(rc, "[Proxy Settings]\nhttpProxy=\nProxyType=0\n");
    const store: Record<string, string> = { httpProxy: "", ProxyType: "0" };
    const syncFile = () => {
      const lines = Object.entries(store).map(([k, v]) => `${k}=${v}`);
      fs.writeFileSync(rc, `[Proxy Settings]\n${lines.join("\n")}\n`);
    };
    const run = async (cmd: string, args: string[]) => {
      const keyIdx = args.indexOf("--key");
      const key = keyIdx >= 0 ? (args[keyIdx + 1] as string) : "";
      if (cmd.includes("kreadconfig")) return store[key] ?? "";
      if (cmd.includes("kwriteconfig")) {
        if (args.includes("--delete")) delete store[key];
        else store[key] = args[args.length - 1] as string;
        syncFile();
      }
      return "";
    };
    const backend = linuxSystemProxyBackend({
      env: { XDG_CURRENT_DESKTOP: "KDE", PATH: "/usr/bin", XDG_CONFIG_HOME: configHome },
      run,
    });
    if (!backend.supported) return;
    const original = await backend.capture();
    const target = codec.target({ host: "127.0.0.1", port: 7890, bypass: [] }, original);
    await backend.apply(target);
    // A foreign proxy on a managed key: skipped and never overwritten —
    // while keys Sash added (absent in the original) are deleted back.
    store.httpsProxy = "http://foreign.example 3128";
    syncFile();

    const result = await backend.restore(original, target);

    assert.deepEqual(result.skipped, [
      {
        key: "Proxy Settings/httpsProxy",
        service: "Proxy Settings/httpsProxy",
        reason: "modified",
      },
    ]);
    assert.equal(store.httpsProxy, "http://foreign.example 3128");
    assert.equal(store.socksProxy, undefined);
    assert.equal(store.ProxyType, "0");
    assert.equal(store.httpProxy, "");
  });
});

describe("KDE real client", () => {
  it("round-trips KDE values verbatim through the real kreadconfig/kwriteconfig", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-kde-real-"));
    t.onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
    const configHome = path.join(dir, "config");
    fs.mkdirSync(configHome, { recursive: true });
    const rc = path.join(configHome, "kioslaverc");
    fs.writeFileSync(rc, "[Proxy Settings]\nhttpProxy= custom value \nProxyType=0\n");
    const { execFile } = await import("node:child_process");
    const run = (cmd: string, args: string[]) =>
      new Promise<string>((resolve, reject) =>
        execFile(
          cmd,
          args,
          { env: { PATH: "/usr/bin:/bin", HOME: dir, XDG_CONFIG_HOME: configHome }, timeout: 5000 },
          (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
        ),
      );
    const backend = linuxSystemProxyBackend({
      env: { XDG_CURRENT_DESKTOP: "KDE", PATH: "/usr/bin", XDG_CONFIG_HOME: configHome, HOME: dir },
      run,
    });
    if (!backend.supported) return; // no real kreadconfig on this host
    const original = await backend.capture();
    const values = (original as PosixSystemProxySnapshot).values;
    const reported = values["Proxy Settings/httpProxy"];
    assert.equal((values.$absent as Record<string, boolean>)["Proxy Settings/socksProxy"], true);
    await backend.apply(codec.target({ host: "127.0.0.1", port: 7890, bypass: [] }, original));
    await backend.apply(original);
    const text = fs.readFileSync(rc, "utf8");
    assert.ok(!text.includes("socksProxy"), text);
    const after = await run("kreadconfig5", [
      "--file",
      "kioslaverc",
      "--group",
      "Proxy Settings",
      "--key",
      "httpProxy",
    ]);
    assert.equal(after.replace(/\r?\n$/, ""), reported);
  });
});
