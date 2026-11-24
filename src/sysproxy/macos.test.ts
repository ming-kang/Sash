import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, vi } from "vitest";

const calls: string[][] = [];
let responder: (tool: string, argv: string[]) => string | Error = () => "";

vi.mock("../process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process.js")>()),
  runSanitizedCommandAsync: vi.fn(async (tool: string, argv: string[]) => {
    calls.push([tool, ...argv]);
    const answer = responder(tool, argv);
    if (answer instanceof Error) throw answer;
    return answer;
  }),
}));

import { macosSystemProxyBackend, macosSystemProxySnapshotCodec } from "./macos.js";
import { SystemProxyManager } from "./manager.js";
import type { PosixSystemProxySnapshot } from "./types.js";

type ServiceFields = {
  serviceName?: string;
  webProxy: { server: string; port: number; enabled: boolean };
  secureWebProxy: { server: string; port: number; enabled: boolean };
  socksProxy: { enabled: boolean };
  autoProxyUrl: { enabled: boolean; url: string };
  bypass: string[];
};
const servicesOf = (snapshot: PosixSystemProxySnapshot) =>
  snapshot.values.services as unknown as Record<string, ServiceFields>;
const service = (snapshot: PosixSystemProxySnapshot, name: string): ServiceFields => {
  const found = servicesOf(snapshot)[name];
  assert.ok(found, `service ${name} missing`);
  return found;
};

const sample: PosixSystemProxySnapshot = {
  version: 1,
  platform: "darwin",
  values: {
    services: {
      "Wi-Fi": {
        webProxy: { enabled: false, server: "", port: 0 },
        secureWebProxy: { enabled: false, server: "", port: 0 },
        socksProxy: { enabled: false, server: "", port: 0 },
        autoProxyUrl: { enabled: false, url: "" },
        autoProxyDiscovery: { enabled: false },
        bypass: ["*.local", "169.254/16"],
      },
    },
  },
};

describe("macOS system proxy snapshot codec", () => {
  it("round-trips a captured snapshot", () => {
    const parsed = macosSystemProxySnapshotCodec.parse(sample);
    assert.equal(parsed.platform, "darwin");
    assert.ok(macosSystemProxySnapshotCodec.equivalent(parsed, sample));
  });

  it("rejects a Windows snapshot", () => {
    assert.throws(() => macosSystemProxySnapshotCodec.parse({ version: 1, platform: "win32" }));
  });

  it("targets every service with the requested manual proxy", () => {
    const target = macosSystemProxySnapshotCodec.target(
      { host: "127.0.0.1", port: 7897, bypass: ["localhost"] },
      sample,
    );
    assert.equal(target.platform, "darwin");
    const wifi = service(target as PosixSystemProxySnapshot, "Wi-Fi");
    assert.equal(wifi.webProxy.server, "127.0.0.1");
    assert.equal(wifi.secureWebProxy.port, 7897);
    assert.equal(wifi.socksProxy.enabled, true);
    const state = macosSystemProxySnapshotCodec.state(target);
    assert.equal(state.enabled, true);
    assert.equal(state.server, "127.0.0.1:7897");
  });

  it("reports enabled state for PAC-only configurations", () => {
    const pac = macosSystemProxySnapshotCodec.parse({
      version: 1,
      platform: "darwin",
      values: {
        services: {
          "Wi-Fi": {
            ...((sample.values.services as Record<string, unknown>)["Wi-Fi"] as object),
            autoProxyUrl: { enabled: true, url: "http://127.0.0.1:7897/proxy.pac" },
          },
        },
      },
    });
    const state = macosSystemProxySnapshotCodec.state(pac);
    assert.equal(state.enabled, true);
  });

  it("marks a touched service as incompatible with the original", () => {
    const target = macosSystemProxySnapshotCodec.target({ port: 7897 }, sample);
    const tampered = macosSystemProxySnapshotCodec.parse(target);
    service(tampered as PosixSystemProxySnapshot, "Wi-Fi").webProxy.server = "10.0.0.1";
    assert.equal(macosSystemProxySnapshotCodec.compatible(tampered, sample, target), false);
    assert.equal(macosSystemProxySnapshotCodec.compatible(target, sample, target), true);
  });
});

describe("macOS system proxy disabled-state preservation", () => {
  const pacService: PosixSystemProxySnapshot = {
    version: 1,
    platform: "darwin",
    values: {
      services: {
        "Wi-Fi": {
          webProxy: { enabled: false, server: "", port: 0, authenticated: false },
          secureWebProxy: { enabled: false, server: "", port: 0, authenticated: false },
          socksProxy: { enabled: false, server: "", port: 0, authenticated: false },
          autoProxyUrl: { enabled: true, url: "http://proxy.example/wp.dat" },
          autoProxyDiscovery: { enabled: false },
          bypass: [],
        },
      },
    },
  };

  it("keeps a pre-existing PAC URL in the target so equivalence holds", () => {
    const target = macosSystemProxySnapshotCodec.target({ port: 7897 }, pacService);
    const wifi = service(target as PosixSystemProxySnapshot, "Wi-Fi");
    // PAC is disabled but its stored URL is preserved verbatim — a blanket
    // url:"" target would never match what the machine actually holds.
    assert.equal(wifi.autoProxyUrl.enabled, false);
    assert.equal(wifi.autoProxyUrl.url, "http://proxy.example/wp.dat");
  });

  it("treats different stored values of a DISABLED proxy as different", () => {
    const empty = macosSystemProxySnapshotCodec.parse(pacService);
    const stored = macosSystemProxySnapshotCodec.parse(pacService);
    service(stored as PosixSystemProxySnapshot, "Wi-Fi").webProxy.server = "old.example";
    // Disabled-but-stored values are real state that must be restored; they
    // participate in equivalence, so nothing Sash wrote can hide behind a
    // disabled flag.
    assert.equal(macosSystemProxySnapshotCodec.equivalent(empty, stored), false);
  });

  it("detects an external change to a service we touched", () => {
    const target = macosSystemProxySnapshotCodec.target({ port: 7897 }, pacService);
    const tampered = macosSystemProxySnapshotCodec.parse(target);
    const wifi = service(tampered as PosixSystemProxySnapshot, "Wi-Fi");
    wifi.socksProxy = { ...wifi.socksProxy, enabled: false };
    assert.equal(macosSystemProxySnapshotCodec.compatible(tampered, pacService, target), false);
    assert.equal(macosSystemProxySnapshotCodec.compatible(target, pacService, target), true);
  });

  it("does not let a service rename veto restoring our proxy values", () => {
    const target = macosSystemProxySnapshotCodec.target({ port: 7897 }, pacService);
    const renamed = macosSystemProxySnapshotCodec.parse(target);
    service(renamed as PosixSystemProxySnapshot, "Wi-Fi").serviceName = "Wi-Fi 2";
    assert.equal(macosSystemProxySnapshotCodec.compatible(renamed, pacService, target), true);
  });
});

const plutilFor = (services: Record<string, string>) =>
  JSON.stringify({
    NetworkServices: Object.fromEntries(
      Object.entries(services).map(([uuid, name]) => [uuid, { UserDefinedName: name }]),
    ),
  });

function journalService(extra: Record<string, unknown> = {}) {
  return {
    webProxy: { enabled: false, server: "", port: 0, authenticated: false },
    secureWebProxy: { enabled: false, server: "", port: 0, authenticated: false },
    socksProxy: { enabled: false, server: "", port: 0, authenticated: false },
    autoProxyUrl: { enabled: false, url: "" },
    autoProxyDiscovery: { enabled: false },
    bypass: [],
    ...extra,
  };
}

const journal = (services: Record<string, unknown>): PosixSystemProxySnapshot => ({
  version: 1,
  platform: "darwin",
  values: { services: services as never },
});

describe("macOS system proxy restore by stable service id", () => {
  const apply = (snapshot: PosixSystemProxySnapshot) => macosSystemProxyBackend().apply(snapshot);

  it("follows a service across a rename/uuid switch, not its stale name", async () => {
    calls.length = 0;
    responder = (tool) => {
      if (tool === "/usr/bin/plutil") {
        // The recorded uuid now belongs to a DIFFERENT display name — the
        // same service after the user renamed it / switched networks.
        return plutilFor({ "UUID-1": "Wi-Fi 2" });
      }
      return "";
    };
    await apply(
      journal({
        "UUID-1": journalService({
          serviceName: "Wi-Fi",
          autoProxyUrl: { enabled: true, url: "http://proxy.example/wp.dat" },
        }),
      }),
    );
    const writes = calls.filter((c) => c[0] === "/usr/sbin/networksetup");
    assert.ok(writes.length > 0);
    // Every write targets the resolved CURRENT name, never the stale one.
    assert.ok(writes.every((c) => c[2] === "Wi-Fi 2"));
    assert.ok(writes.some((c) => c[1] === "-setautoproxyurl"));
  });

  it("restores a journal service that is not currently online", async () => {
    calls.length = 0;
    responder = (tool) => {
      // The service exists (uuid resolves) but reports no IP — restore must
      // still write: offline state is not a reason to skip the journal.
      if (tool === "/usr/bin/plutil") return plutilFor({ "UUID-9": "Thunderbolt" });
      return "";
    };
    await apply(
      journal({
        "UUID-9": journalService({
          serviceName: "Thunderbolt",
          webProxy: { enabled: true, server: "192.168.0.2", port: 8888, authenticated: false },
        }),
      }),
    );
    const writes = calls.filter((c) => c[0] === "/usr/sbin/networksetup");
    assert.ok(writes.some((c) => c[1] === "-setwebproxy" && c[2] === "Thunderbolt"));
    assert.ok(writes.some((c) => c[1] === "-setwebproxystate" && c[3] === "on"));
  });

  it("writes stored empty values faithfully (PAC cleared, bypass emptied)", async () => {
    calls.length = 0;
    responder = (tool) => {
      if (tool === "/usr/bin/plutil") return plutilFor({ "UUID-1": "Wi-Fi" });
      return "";
    };
    await apply(journal({ "UUID-1": journalService({ serviceName: "Wi-Fi" }) }));
    const writes = calls.filter((c) => c[0] === "/usr/sbin/networksetup");
    // Empty recorded PAC URL -> only the state flag is written, never a URL.
    assert.equal(
      writes.some((c) => c[1] === "-setautoproxyurl"),
      false,
    );
    assert.ok(writes.some((c) => c[1] === "-setautoproxystate" && c[3] === "off"));
    // Empty bypass list -> the literal "Empty" marker macOS understands.
    assert.ok(writes.some((c) => c[1] === "-setproxybypassdomains" && c[3] === "Empty"));
  });

  it("skips a service the system no longer has", async () => {
    calls.length = 0;
    responder = (tool) => {
      if (tool === "/usr/bin/plutil") return plutilFor({ "UUID-2": "Ethernet" });
      return "";
    };
    // UUID-9 existed at capture time; now it is gone (network removed).
    await apply(journal({ "UUID-9": journalService({ serviceName: "Wi-Fi" }) }));
    assert.equal(calls.filter((c) => c[0] === "/usr/sbin/networksetup").length, 0);
  });
});

type FixtureManual = { enabled: boolean; server: string; port: number; authenticated?: boolean };
type FixtureService = {
  webProxy: FixtureManual;
  secureWebProxy: FixtureManual;
  socksProxy: FixtureManual;
  autoProxyUrl: { enabled: boolean; url: string };
  autoProxyDiscovery: { enabled: boolean };
  bypass: string[];
  ip: string;
};

const fixtureService = (over: Partial<FixtureService> = {}): FixtureService => ({
  webProxy: { enabled: false, server: "", port: 0 },
  secureWebProxy: { enabled: false, server: "", port: 0 },
  socksProxy: { enabled: false, server: "", port: 0 },
  autoProxyUrl: { enabled: false, url: "" },
  autoProxyDiscovery: { enabled: false },
  bypass: [],
  ip: "192.168.1.5",
  ...over,
});

const manualText = (value: FixtureManual) =>
  `Enabled: ${value.enabled ? "Yes" : "No"}\nServer: ${value.server}\nPort: ${value.port}\nAuthenticated Proxy Enabled: ${value.authenticated ? 1 : 0}\n`;

/**
 * Stateful networksetup/plutil fixture: services keyed by display name,
 * uuid->name resolution through the preferences store, and real read/write
 * of every proxy field so the production manager + backend run end to end.
 */
describe("macOS system proxy restore through SystemProxyManager", () => {
  let services: Record<string, FixtureService>;
  let uuids: Record<string, string>;

  function installFixture() {
    responder = (tool, argv) => {
      if (tool === "/usr/bin/plutil") return plutilFor(uuids);
      if (argv[0] === "-listallnetworkservices") return Object.keys(services).join("\n");
      const svc = services[argv[1] ?? ""];
      if (!svc) return "";
      switch (argv[0]) {
        case "-getinfo":
          return svc.ip ? `IP address: ${svc.ip}\n` : "IP address: \n";
        case "-getwebproxy":
          return manualText(svc.webProxy);
        case "-getsecurewebproxy":
          return manualText(svc.secureWebProxy);
        case "-getsocksfirewallproxy":
          return manualText(svc.socksProxy);
        case "-getautoproxyurl":
          return `URL: ${svc.autoProxyUrl.url || "(null)"}\nEnabled: ${svc.autoProxyUrl.enabled ? "Yes" : "No"}\n`;
        case "-getproxyautodiscovery":
          return `Auto Proxy Discovery: ${svc.autoProxyDiscovery.enabled ? "On" : "Off"}\n`;
        case "-getproxybypassdomains":
          return svc.bypass.length
            ? svc.bypass.join("\n")
            : "There aren't any bypass domains setup.";
        case "-setwebproxy":
          svc.webProxy.server = argv[2] ?? "";
          svc.webProxy.port = Number(argv[3]);
          // networksetup(8): -setwebproxy "Turns proxy on."
          svc.webProxy.enabled = true;
          return "";
        case "-setwebproxystate":
          svc.webProxy.enabled = argv[2] === "on";
          return "";
        case "-setsecurewebproxy":
          svc.secureWebProxy.server = argv[2] ?? "";
          svc.secureWebProxy.port = Number(argv[3]);
          svc.secureWebProxy.enabled = true;
          return "";
        case "-setsecurewebproxystate":
          svc.secureWebProxy.enabled = argv[2] === "on";
          return "";
        case "-setsocksfirewallproxy":
          svc.socksProxy.server = argv[2] ?? "";
          svc.socksProxy.port = Number(argv[3]);
          svc.socksProxy.enabled = true;
          return "";
        case "-setsocksfirewallproxystate":
          svc.socksProxy.enabled = argv[2] === "on";
          return "";
        case "-setautoproxyurl":
          svc.autoProxyUrl.url = argv[2] ?? "";
          return "";
        case "-setautoproxystate":
          svc.autoProxyUrl.enabled = argv[2] === "on";
          return "";
        case "-setproxyautodiscovery":
          svc.autoProxyDiscovery.enabled = argv[2] === "on";
          return "";
        case "-setproxybypassdomains":
          svc.bypass = argv.slice(2).filter((v) => v !== "Empty");
          return "";
      }
      return "";
    };
  }

  async function manager(): Promise<{
    manager: SystemProxyManager;
    journalFile: string;
  }> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "sash-sysproxy-"));
    const journalFile = path.join(dir, "sysproxy-state.json");
    return {
      manager: new SystemProxyManager({
        backend: macosSystemProxyBackend(),
        layout: { systemProxyStateFile: journalFile, systemProxyLockFile: path.join(dir, "lock") },
      }),
      journalFile,
    };
  }

  it("restores a service that went offline since apply (network switch)", async () => {
    calls.length = 0;
    uuids = { "UUID-WF": "Wi-Fi", "UUID-EN": "Ethernet" };
    services = { "Wi-Fi": fixtureService(), Ethernet: fixtureService({ ip: "" }) };
    installFixture();
    const { manager: mgr, journalFile } = await manager();
    await mgr.apply({ port: 7897 });
    // Simulate the network switch: Wi-Fi drops its IP, Ethernet comes up.
    (services["Wi-Fi"] as FixtureService).ip = "";
    (services.Ethernet as FixtureService).ip = "10.0.0.2";
    calls.length = 0;
    await mgr.release();
    const writes = calls.filter(
      (c) => c[0] === "/usr/sbin/networksetup" && c[1]?.startsWith("-set"),
    );
    // The journal's uuid-keyed Wi-Fi service is written back even though it
    // is offline; Ethernet, untouched at capture time, is never written.
    assert.ok(writes.length > 0);
    assert.ok(writes.every((c) => c[2] === "Wi-Fi"));
    assert.equal((services["Wi-Fi"] as FixtureService).webProxy.enabled, false);
    assert.equal((services["Wi-Fi"] as FixtureService).webProxy.server, "");
    assert.equal(fs.existsSync(journalFile), false);
  });

  it("does not overwrite an offline service modified outside Sash; keeps the journal", async () => {
    calls.length = 0;
    uuids = { "UUID-WF": "Wi-Fi" };
    services = { "Wi-Fi": fixtureService() };
    installFixture();
    const { manager: mgr, journalFile } = await manager();
    await mgr.apply({ port: 7897 });
    // Wi-Fi went offline AND someone else set a foreign proxy on it.
    (services["Wi-Fi"] as FixtureService).ip = "";
    (services["Wi-Fi"] as FixtureService).webProxy = {
      enabled: true,
      server: "9.9.9.9",
      port: 3128,
    };
    calls.length = 0;
    await assert.rejects(mgr.release(), /modified outside Sash/);
    // No write touched Wi-Fi: the foreign settings survive and evidence stays.
    const writes = calls.filter(
      (c) => c[0] === "/usr/sbin/networksetup" && c[1]?.startsWith("-set"),
    );
    assert.equal(writes.length, 0);
    assert.equal((services["Wi-Fi"] as FixtureService).webProxy.server, "9.9.9.9");
    assert.equal(fs.existsSync(journalFile), true);
  });

  it("never falls back from a vanished uuid to a same-named service", async () => {
    calls.length = 0;
    uuids = { "UUID-WF": "Wi-Fi" };
    services = { "Wi-Fi": fixtureService() };
    installFixture();
    const { manager: mgr, journalFile } = await manager();
    await mgr.apply({ port: 7897 });
    // The recorded service is deleted and a NEW service reuses the name —
    // writing to it would clobber a service Sash never touched.
    uuids = { "UUID-NEW": "Wi-Fi" };
    calls.length = 0;
    await assert.rejects(mgr.release(), /service removed/);
    const writes = calls.filter(
      (c) => c[0] === "/usr/sbin/networksetup" && c[1]?.startsWith("-set"),
    );
    assert.equal(writes.length, 0);
    assert.equal(fs.existsSync(journalFile), true);
  });

  it("restores a renamed service by uuid even while offline", async () => {
    calls.length = 0;
    uuids = { "UUID-WF": "Wi-Fi" };
    services = { "Wi-Fi": fixtureService() };
    installFixture();
    const { manager: mgr, journalFile } = await manager();
    await mgr.apply({ port: 7897 });
    // Rename + go offline: the uuid still resolves, so restore targets the
    // current display name and must not be confused by the stale one.
    uuids = { "UUID-WF": "Wi-Fi 2" };
    services["Wi-Fi 2"] = services["Wi-Fi"] as FixtureService;
    delete services["Wi-Fi"];
    (services["Wi-Fi 2"] as FixtureService).ip = "";
    calls.length = 0;
    await mgr.release();
    const writes = calls.filter(
      (c) => c[0] === "/usr/sbin/networksetup" && c[1]?.startsWith("-set"),
    );
    assert.ok(writes.length > 0);
    assert.ok(writes.every((c) => c[2] === "Wi-Fi 2"));
    assert.equal(fs.existsSync(journalFile), false);
  });

  it("rolls back its own partial apply and restores cleanly once the fault clears", async () => {
    calls.length = 0;
    uuids = { "UUID-WF": "Wi-Fi" };
    services = { "Wi-Fi": fixtureService() };
    installFixture();
    // One-shot fault: the first -setsecurewebproxy fails after -setwebproxy
    // already wrote, leaving the service mid-write (webProxy == target,
    // secureWebProxy == original).
    let failSecure = true;
    const base = responder;
    responder = (tool, argv) => {
      if (failSecure && tool === "/usr/sbin/networksetup" && argv[0] === "-setsecurewebproxy") {
        return new Error("networksetup failed");
      }
      return base(tool, argv);
    };
    const { manager: mgr, journalFile } = await manager();
    await assert.rejects(mgr.apply({ port: 7897 }));
    // The per-field check treats the mid-write values as Sash's own, so the
    // rollback writes webProxy back to the original — then hits the same
    // fault on -setsecurewebproxy and keeps the journal as evidence.
    assert.equal((services["Wi-Fi"] as FixtureService).webProxy.enabled, false);
    assert.equal((services["Wi-Fi"] as FixtureService).webProxy.server, "");
    assert.equal(fs.existsSync(journalFile), true);
    failSecure = false;
    // Once the fault clears, retrying the restore finishes cleanly.
    await mgr.release();
    const wifi = services["Wi-Fi"] as FixtureService;
    assert.equal(wifi.webProxy.enabled, false);
    assert.equal(wifi.secureWebProxy.enabled, false);
    assert.equal(fs.existsSync(journalFile), false);
  });

  it("restores a service left enabled by -setwebproxy's implicit side effect", async () => {
    calls.length = 0;
    uuids = { "UUID-WF": "Wi-Fi" };
    // Baseline: a disabled proxy with a valid host/port configured.
    services = {
      "Wi-Fi": fixtureService({
        webProxy: { enabled: false, server: "10.0.0.9", port: 8888 },
      }),
    };
    installFixture();
    // Fault: the first -setwebproxystate off fails right after -setwebproxy
    // restored host/port — and implicitly re-enabled the proxy. The service
    // is left holding enabled==target + server/port==original.
    let failState = true;
    const base = responder;
    responder = (tool, argv) => {
      if (
        failState &&
        tool === "/usr/sbin/networksetup" &&
        argv[0] === "-setwebproxystate" &&
        argv[2] === "off"
      ) {
        return new Error("networksetup failed");
      }
      return base(tool, argv);
    };
    const { manager: mgr, journalFile } = await manager();
    await mgr.apply({ port: 7897 });
    await assert.rejects(mgr.release());
    const wifi = services["Wi-Fi"] as FixtureService;
    assert.equal(wifi.webProxy.enabled, true); // implicit enable survived
    assert.equal(wifi.webProxy.server, "10.0.0.9");
    assert.equal(fs.existsSync(journalFile), true);
    failState = false;
    // The intermediate leaves are all in {original, target} — Sash's own —
    // so the retry finishes the restore instead of skipping as "modified".
    await mgr.release();
    assert.equal(wifi.webProxy.enabled, false);
    assert.equal(wifi.webProxy.server, "10.0.0.9");
    assert.equal(wifi.webProxy.port, 8888);
    assert.equal(fs.existsSync(journalFile), false);
  });
});
