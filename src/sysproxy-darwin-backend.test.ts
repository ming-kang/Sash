import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyDarwinSnapshot, captureDarwinSnapshot } from "./sysproxy/darwin.js";
import type { DarwinProxySetting, DarwinSystemProxySnapshot } from "./sysproxy/types.js";

interface RecordedCommand {
  command: string;
  args: string[];
}

function proxyOutput(server: string, port: number, enabled = true): string {
  return [
    `Enabled: ${enabled ? "Yes" : "No"}`,
    `Server: ${server}`,
    `Port: ${port}`,
    "Authenticated Proxy Enabled: 0",
  ].join("\n");
}

function automaticProxyOutput(url: string, enabled: boolean): string {
  return [`URL: ${url || "(null)"}`, `Enabled: ${enabled ? "Yes" : "No"}`].join("\n");
}

function setting(enabled: boolean, server: string, port: number): DarwinProxySetting {
  return { enabled, server, port, authenticated: false };
}

function darwinSnapshot(): DarwinSystemProxySnapshot {
  return {
    version: 1,
    platform: "darwin",
    services: [
      {
        service: "Wi-Fi",
        web: setting(true, "web.proxy", 8080),
        secureWeb: setting(false, "secure.proxy", 8443),
        socks: setting(true, "socks.proxy", 1080),
        auto: { enabled: false, url: "http://proxy.example/config.pac" },
      },
    ],
  };
}

function operationNames(calls: RecordedCommand[]): string[] {
  return calls.map((call) => call.args[0] ?? "");
}

describe("macOS system proxy backend", () => {
  it("captures sorted services and each protocol strictly in sequence", async () => {
    const calls: RecordedCommand[] = [];
    let commandActive = false;
    const snapshot = await captureDarwinSnapshot(async (command, args) => {
      assert.equal(commandActive, false, "networksetup commands must remain sequential");
      commandActive = true;
      calls.push({ command, args: [...args] });
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        switch (args[0]) {
          case "-listallnetworkservices":
            return "Wi-Fi\nEthernet\n";
          case "-getwebproxy":
            return proxyOutput("web.proxy", 8080);
          case "-getsecurewebproxy":
            return proxyOutput("secure.proxy", 8443, false);
          case "-getsocksfirewallproxy":
            return proxyOutput("socks.proxy", 1080);
          case "-getautoproxyurl":
            return automaticProxyOutput("http://proxy.example/config.pac", false);
          default:
            throw new Error(`Unexpected networksetup operation: ${String(args[0])}`);
        }
      } finally {
        commandActive = false;
      }
    });

    assert.deepEqual(
      snapshot.services.map((service) => service.service),
      ["Ethernet", "Wi-Fi"],
    );
    assert.deepEqual(
      calls.map((call) => call.args.join(" ")),
      [
        "-listallnetworkservices",
        "-getwebproxy Ethernet",
        "-getsecurewebproxy Ethernet",
        "-getsocksfirewallproxy Ethernet",
        "-getautoproxyurl Ethernet",
        "-getwebproxy Wi-Fi",
        "-getsecurewebproxy Wi-Fi",
        "-getsocksfirewallproxy Wi-Fi",
        "-getautoproxyurl Wi-Fi",
      ],
    );
  });

  it("writes proxy data before states and turns modes off before enabling others", async () => {
    const calls: RecordedCommand[] = [];
    let commandActive = false;
    await applyDarwinSnapshot(darwinSnapshot(), async (command, args) => {
      assert.equal(commandActive, false, "networksetup commands must remain sequential");
      commandActive = true;
      calls.push({ command, args: [...args] });
      await new Promise<void>((resolve) => setImmediate(resolve));
      commandActive = false;
      return args[0] === "-listallnetworkservices" ? "Wi-Fi\n" : "";
    });

    assert.deepEqual(operationNames(calls), [
      "-listallnetworkservices",
      "-setwebproxy",
      "-setsecurewebproxy",
      "-setsocksfirewallproxy",
      "-setautoproxyurl",
      "-setsecurewebproxystate",
      "-setautoproxystate",
      "-setwebproxystate",
      "-setsocksfirewallproxystate",
    ]);
    assert.deepEqual(
      calls.slice(5).map((call) => call.args.at(-1)),
      ["off", "off", "on", "on"],
    );
  });

  it("aggregates setter failures after attempting every safe operation", async () => {
    const calls: RecordedCommand[] = [];

    await assert.rejects(
      applyDarwinSnapshot(darwinSnapshot(), async (command, args) => {
        calls.push({ command, args: [...args] });
        if (args[0] === "-listallnetworkservices") return "Wi-Fi\n";
        if (args[0] === "-setwebproxy") throw new Error("web setter failed");
        if (args[0] === "-setautoproxystate") throw "automatic state failed";
        return "";
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /web setter failed/);
        assert.match(error.message, /automatic state failed/);
        return true;
      },
    );

    assert.deepEqual(operationNames(calls), [
      "-listallnetworkservices",
      "-setwebproxy",
      "-setsecurewebproxy",
      "-setsocksfirewallproxy",
      "-setautoproxyurl",
      "-setsecurewebproxystate",
      "-setautoproxystate",
      "-setwebproxystate",
      "-setsocksfirewallproxystate",
    ]);
  });

  it("performs no writes when the network service collection changed", async () => {
    const calls: RecordedCommand[] = [];

    await assert.rejects(
      applyDarwinSnapshot(darwinSnapshot(), async (command, args) => {
        calls.push({ command, args: [...args] });
        return "Ethernet\n";
      }),
      /network service collection changed/,
    );

    assert.deepEqual(operationNames(calls), ["-listallnetworkservices"]);
  });
});
