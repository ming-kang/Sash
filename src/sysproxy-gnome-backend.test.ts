import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyLinuxSnapshot, captureLinuxSnapshot } from "./sysproxy/gnome.js";
import type { LinuxSystemProxySnapshot } from "./sysproxy/types.js";

interface RecordedCommand {
  command: string;
  args: string[];
}

function linuxSnapshot(): LinuxSystemProxySnapshot {
  return {
    version: 1,
    platform: "linux",
    mode: "manual",
    autoConfigUrl: "http://proxy.example/config.pac",
    httpUseAuthentication: true,
    http: { host: "http.proxy", port: 8080 },
    https: { host: "https.proxy", port: 8443 },
    socks: { host: "socks.proxy", port: 1080 },
  };
}

function settingKeys(calls: RecordedCommand[]): string[] {
  return calls.map((call) => call.args.slice(1, 3).join(" "));
}

describe("GNOME system proxy backend", () => {
  it("captures all nine settings strictly in sequence", async () => {
    const calls: RecordedCommand[] = [];
    let commandActive = false;
    let availabilityChecks = 0;
    const snapshot = await captureLinuxSnapshot(
      async (command, args) => {
        assert.equal(commandActive, false, "gsettings commands must remain sequential");
        commandActive = true;
        calls.push({ command, args: [...args] });
        await new Promise<void>((resolve) => setImmediate(resolve));
        try {
          const schema = args[1];
          const key = args[2];
          if (schema === "org.gnome.system.proxy" && key === "mode") return "'manual'";
          if (schema === "org.gnome.system.proxy" && key === "autoconfig-url") {
            return "'http://proxy.example/config.pac'";
          }
          if (key === "use-authentication") return "false";
          if (key === "host") return `'${schema?.split(".").at(-1)}.proxy'`;
          if (key === "port") return "uint16 7890";
          throw new Error(`Unexpected gsettings read: ${args.join(" ")}`);
        } finally {
          commandActive = false;
        }
      },
      () => {
        availabilityChecks++;
      },
    );

    assert.equal(availabilityChecks, 1);
    assert.deepEqual(settingKeys(calls), [
      "org.gnome.system.proxy mode",
      "org.gnome.system.proxy autoconfig-url",
      "org.gnome.system.proxy.http use-authentication",
      "org.gnome.system.proxy.http host",
      "org.gnome.system.proxy.http port",
      "org.gnome.system.proxy.https host",
      "org.gnome.system.proxy.https port",
      "org.gnome.system.proxy.socks host",
      "org.gnome.system.proxy.socks port",
    ]);
    assert.deepEqual(snapshot, {
      version: 1,
      platform: "linux",
      mode: "manual",
      autoConfigUrl: "http://proxy.example/config.pac",
      httpUseAuthentication: false,
      http: { host: "http.proxy", port: 7890 },
      https: { host: "https.proxy", port: 7890 },
      socks: { host: "socks.proxy", port: 7890 },
    });
  });

  it("writes all endpoint fields before setting mode last", async () => {
    const calls: RecordedCommand[] = [];
    let commandActive = false;
    let availabilityChecks = 0;
    await applyLinuxSnapshot(
      linuxSnapshot(),
      async (command, args) => {
        assert.equal(commandActive, false, "gsettings commands must remain sequential");
        commandActive = true;
        calls.push({ command, args: [...args] });
        await new Promise<void>((resolve) => setImmediate(resolve));
        commandActive = false;
        return "";
      },
      () => {
        availabilityChecks++;
      },
    );

    assert.equal(availabilityChecks, 1);
    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ["set", "org.gnome.system.proxy", "autoconfig-url", "'http://proxy.example/config.pac'"],
        ["set", "org.gnome.system.proxy.http", "use-authentication", "true"],
        ["set", "org.gnome.system.proxy.http", "host", "'http.proxy'"],
        ["set", "org.gnome.system.proxy.http", "port", "8080"],
        ["set", "org.gnome.system.proxy.https", "host", "'https.proxy'"],
        ["set", "org.gnome.system.proxy.https", "port", "8443"],
        ["set", "org.gnome.system.proxy.socks", "host", "'socks.proxy'"],
        ["set", "org.gnome.system.proxy.socks", "port", "1080"],
        ["set", "org.gnome.system.proxy", "mode", "'manual'"],
      ],
    );
  });

  it("does not enable mode after an endpoint write fails", async () => {
    const calls: RecordedCommand[] = [];
    const endpointFailure = new Error("HTTPS host write failed");

    await assert.rejects(
      applyLinuxSnapshot(
        linuxSnapshot(),
        async (command, args) => {
          calls.push({ command, args: [...args] });
          if (args[1] === "org.gnome.system.proxy.https" && args[2] === "host") {
            throw endpointFailure;
          }
          return "";
        },
        () => {},
      ),
      (error: unknown) => error === endpointFailure,
    );

    assert.deepEqual(settingKeys(calls), [
      "org.gnome.system.proxy autoconfig-url",
      "org.gnome.system.proxy.http use-authentication",
      "org.gnome.system.proxy.http host",
      "org.gnome.system.proxy.http port",
      "org.gnome.system.proxy.https host",
    ]);
    assert.equal(
      calls.some((call) => call.args[2] === "mode"),
      false,
    );
  });

  it("runs the availability check before issuing any command", async () => {
    let commandCalls = 0;
    const availabilityFailure = new Error("gsettings unavailable");

    await assert.rejects(
      captureLinuxSnapshot(
        async () => {
          commandCalls++;
          return "";
        },
        () => {
          throw availabilityFailure;
        },
      ),
      (error: unknown) => error === availabilityFailure,
    );

    assert.equal(commandCalls, 0);
  });
});
