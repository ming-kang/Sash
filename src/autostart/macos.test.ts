import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { type AutostartContext, autostartContext, type CommandResult } from "./context.js";
import { MACOS_AUTOSTART_LABEL, macosAutostart, macosPlistContents } from "./macos.js";

async function tempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "sash-autostart-"));
}

function testContext(home: string, commands: Record<string, string>): AutostartContext {
  fs.mkdirSync(path.join(home, "pkg", "dist"), { recursive: true });
  fs.writeFileSync(path.join(home, "pkg", "dist", "autostart-entry.js"), "// entry\n");
  fs.writeFileSync(path.join(home, "node"), "// node\n");
  fs.chmodSync(path.join(home, "node"), 0o755);
  return autostartContext({
    platform: "darwin",
    homedir: home,
    packageRoot: path.join(home, "pkg"),
    nodePath: path.join(home, "node"),
    runCommand: async (_command, args): Promise<CommandResult> => {
      const key = args.join(" ");
      if (key.includes("print-disabled")) {
        return {
          code: 0,
          stdout: commands.disabled ?? `"${MACOS_AUTOSTART_LABEL}" = enabled`,
          stderr: "",
        };
      }
      if (key.includes("print") && key.includes(MACOS_AUTOSTART_LABEL)) {
        return commands.loaded === "yes"
          ? { code: 0, stdout: "state = running", stderr: "" }
          : { code: 113, stdout: "", stderr: "Could not find service" };
      }
      if (key.includes("bootstrap") || key.includes("bootout")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
}

describe("macOS LaunchAgent autostart", () => {
  it("renders a plist with the daemon entry and SASH_HOME", async () => {
    const home = await tempDir();
    const ctx = testContext(home, {});
    const plist = macosPlistContents(ctx);
    assert.ok(plist.includes(`<key>Label</key>\n<string>${MACOS_AUTOSTART_LABEL}</string>`));
    assert.ok(plist.includes(`${ctx.nodePath}`));
    assert.ok(plist.includes(`${ctx.entryPath}`));
    assert.ok(plist.includes("<key>SASH_HOME</key>"));
  });

  it("reports off when no plist exists", async () => {
    const home = await tempDir();
    const backend = macosAutostart(testContext(home, {}));
    assert.equal(await backend.inspect(), "off");
  });

  it("reports on once the plist matches and is not disabled", async () => {
    const home = await tempDir();
    const ctx = testContext(home, { loaded: "yes" });
    const backend = macosAutostart(ctx);
    await backend.set(true);
    const plist = path.join(home, "Library", "LaunchAgents", `${MACOS_AUTOSTART_LABEL}.plist`);
    assert.ok(fs.existsSync(plist));
    assert.equal(fs.readFileSync(plist, "utf8"), macosPlistContents(ctx));
    assert.equal(await backend.inspect(), "on");
  });

  it("reports stale when the plist contents drift", async () => {
    const home = await tempDir();
    const ctx = testContext(home, { loaded: "yes" });
    const backend = macosAutostart(ctx);
    await backend.set(true);
    const plist = path.join(home, "Library", "LaunchAgents", `${MACOS_AUTOSTART_LABEL}.plist`);
    fs.appendFileSync(plist, "<!-- drift -->\n");
    assert.equal(await backend.inspect(), "stale");
  });

  it("reports disabled when launchctl marks the service disabled", async () => {
    const home = await tempDir();
    const ctx = testContext(home, {
      loaded: "yes",
      disabled: `"${MACOS_AUTOSTART_LABEL}" = disabled`,
    });
    const backend = macosAutostart(ctx);
    await backend.set(true);
    assert.equal(await backend.inspect(), "disabled");
  });

  it("removes the plist on disable", async () => {
    const home = await tempDir();
    const ctx = testContext(home, { loaded: "yes" });
    const backend = macosAutostart(ctx);
    await backend.set(true);
    await backend.set(false);
    const plist = path.join(home, "Library", "LaunchAgents", `${MACOS_AUTOSTART_LABEL}.plist`);
    assert.equal(fs.existsSync(plist), false);
    assert.equal(await backend.inspect(), "off");
  });
});

describe("macOS LaunchAgent registration edge cases", () => {
  function recordingContext(home: string, handlers: Record<string, CommandResult>) {
    const calls: string[] = [];
    fs.mkdirSync(path.join(home, "pkg", "dist"), { recursive: true });
    fs.writeFileSync(path.join(home, "pkg", "dist", "autostart-entry.js"), "// entry\n");
    fs.writeFileSync(path.join(home, "node"), "// node\n");
    fs.chmodSync(path.join(home, "node"), 0o755);
    const ctx = autostartContext({
      platform: "darwin",
      homedir: home,
      packageRoot: path.join(home, "pkg"),
      nodePath: path.join(home, "node"),
      runCommand: async (_command, args): Promise<CommandResult> => {
        const key = args.join(" ");
        calls.push(key);
        for (const [match, result] of Object.entries(handlers)) {
          if (key.includes(match)) return result;
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    return { ctx, calls };
  }

  it("clears a disabled override before bootstrapping", async () => {
    const home = await tempDir();
    const { ctx, calls } = recordingContext(home, {
      [`print ${process.getuid!()}`]: { code: 0, stdout: "state = running", stderr: "" },
      [`print gui`]: { code: 0, stdout: "state = running", stderr: "" },
      "print-disabled": { code: 0, stdout: "", stderr: "" },
    });
    await macosAutostart(ctx).set(true);
    const enableAt = calls.findIndex((key) => key.startsWith(`enable gui/`));
    const bootstrapAt = calls.findIndex((key) => key.startsWith("bootstrap "));
    assert.ok(enableAt >= 0, "launchctl enable was not invoked");
    assert.ok(bootstrapAt >= 0, "launchctl bootstrap was not invoked");
    assert.ok(enableAt < bootstrapAt, "enable must precede bootstrap");
  });

  it("removes the plist when bootstrap fails", async () => {
    const home = await tempDir();
    const { ctx } = recordingContext(home, {
      "bootstrap ": { code: 1, stdout: "", stderr: "Bootstrap failed" },
      "print-disabled": { code: 0, stdout: "", stderr: "" },
    });
    await assert.rejects(macosAutostart(ctx).set(true));
    const plist = path.join(home, "Library", "LaunchAgents", `${MACOS_AUTOSTART_LABEL}.plist`);
    assert.equal(fs.existsSync(plist), false);
  });

  it("reports stale, not on, when print-disabled fails", async () => {
    const home = await tempDir();
    const { ctx } = recordingContext(home, {
      "print-disabled": { code: 1, stdout: "", stderr: "disabled query failed" },
      [`print gui/`]: { code: 0, stdout: "state = running", stderr: "" },
    });
    const backend = macosAutostart(ctx);
    // The undeterminable state must abort before any change.
    await assert.rejects(backend.set(true), /disabled state/);
    assert.equal(await backend.inspect(), "off");
  });

  it("fails disable when bootout errors but the service is still loaded", async () => {
    const home = await tempDir();
    const handlers: Record<string, CommandResult> = {
      [`print gui/`]: { code: 0, stdout: "state = running", stderr: "" },
      "print-disabled": { code: 0, stdout: "", stderr: "" },
    };
    const { ctx } = recordingContext(home, handlers);
    const backend = macosAutostart(ctx);
    await backend.set(true);
    handlers["bootout "] = { code: 1, stdout: "", stderr: "bootout failed" };
    await assert.rejects(backend.set(false));
    const plist = path.join(home, "Library", "LaunchAgents", `${MACOS_AUTOSTART_LABEL}.plist`);
    assert.equal(fs.existsSync(plist), true);
  });

  it("still removes the plist when bootout fails on an absent service", async () => {
    const home = await tempDir();
    const { ctx } = recordingContext(home, {
      "bootout ": { code: 1, stdout: "", stderr: "Could not find service" },
      [`print gui/`]: { code: 113, stdout: "", stderr: "Could not find service" },
      "print-disabled": { code: 0, stdout: "", stderr: "" },
    });
    const backend = macosAutostart(ctx);
    await backend.set(false);
    const plist = path.join(home, "Library", "LaunchAgents", `${MACOS_AUTOSTART_LABEL}.plist`);
    assert.equal(fs.existsSync(plist), false);
  });

  it("treats a GUI-domain error as an error, never as 'not registered'", async () => {
    const home = await tempDir();
    const { ctx } = recordingContext(home, {
      [`print gui/`]: {
        code: 5,
        stdout: "",
        stderr: "Bootstrap failed: 5: Input/output error",
      },
      "print-disabled": { code: 0, stdout: "", stderr: "" },
    });
    const backend = macosAutostart(ctx);
    // set(false) must surface the domain error instead of treating the
    // service as absent and deleting the plist.
    await assert.rejects(backend.set(false), /launchctl print failed/);
  });

  it("restores the previous plist and disabled state when a refresh fails", async () => {
    const home = await tempDir();
    const plist = path.join(home, "Library", "LaunchAgents", `${MACOS_AUTOSTART_LABEL}.plist`);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    const OLD_PLIST = "<plist><dict><key>Label</key><string>old</string></dict></plist>\n";
    fs.writeFileSync(plist, OLD_PLIST);
    const calls: string[] = [];
    const ctx = autostartContext({
      platform: "darwin",
      homedir: home,
      packageRoot: path.join(home, "pkg"),
      nodePath: path.join(home, "node"),
      runCommand: async (_command, args): Promise<CommandResult> => {
        const key = args.join(" ");
        calls.push(key);
        if (key.includes("print-disabled")) {
          // The agent was registered AND disabled before the failed refresh.
          return { code: 0, stdout: `"${MACOS_AUTOSTART_LABEL}" = disabled`, stderr: "" };
        }
        if (key.startsWith("bootstrap ")) {
          return { code: 1, stdout: "", stderr: "Bootstrap failed" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    fs.mkdirSync(path.join(home, "pkg", "dist"), { recursive: true });
    fs.writeFileSync(path.join(home, "pkg", "dist", "autostart-entry.js"), "// entry\n");
    fs.writeFileSync(path.join(home, "node"), "// node\n");
    fs.chmodSync(path.join(home, "node"), 0o755);
    await assert.rejects(macosAutostart(ctx).set(true));
    // Old plist bytes restored and re-registered...
    assert.equal(fs.readFileSync(plist, "utf8"), OLD_PLIST);
    const bootstraps = calls.filter((key) => key.startsWith("bootstrap "));
    assert.ok(bootstraps.length >= 2, "previous plist was not re-bootstrapped");
    // ...and the disabled override re-applied.
    assert.ok(calls.some((key) => key.startsWith("disable gui/")));
  });
});

describe("macOS LaunchAgent rollback coverage", () => {
  function fixture(home: string, handlers: Record<string, CommandResult>) {
    fs.mkdirSync(path.join(home, "pkg", "dist"), { recursive: true });
    fs.writeFileSync(path.join(home, "pkg", "dist", "autostart-entry.js"), "// entry\n");
    fs.writeFileSync(path.join(home, "node"), "// node\n");
    fs.chmodSync(path.join(home, "node"), 0o755);
    const calls: string[] = [];
    const ctx = autostartContext({
      platform: "darwin",
      homedir: home,
      packageRoot: path.join(home, "pkg"),
      nodePath: path.join(home, "node"),
      runCommand: async (_command, args): Promise<CommandResult> => {
        const key = args.join(" ");
        calls.push(key);
        for (const [match, result] of Object.entries(handlers)) {
          if (key.includes(match)) return result;
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    return { ctx, calls };
  }

  it("does not load an old plist that was never loaded when refresh fails", async () => {
    const home = await tempDir();
    const plist = path.join(home, "Library", "LaunchAgents", `${MACOS_AUTOSTART_LABEL}.plist`);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    const OLD_PLIST = "<plist><dict><key>Label</key><string>old</string></dict></plist>\n";
    fs.writeFileSync(plist, OLD_PLIST);
    const { ctx, calls } = fixture(home, {
      // Old plist exists but the service was never loaded in this gui session.
      "print gui": { code: 113, stdout: "", stderr: "Could not find service" },
      "print-disabled": { code: 0, stdout: "", stderr: "" },
      "bootstrap ": { code: 1, stdout: "", stderr: "Bootstrap failed" },
    });
    await assert.rejects(macosAutostart(ctx).set(true));
    // Old file restored, but no second bootstrap ran: the agent must stay
    // unloaded exactly as before, not get loaded by the rollback.
    assert.equal(fs.readFileSync(plist, "utf8"), OLD_PLIST);
    assert.equal(calls.filter((key) => key.startsWith("bootstrap ")).length, 1);
    assert.equal(calls.filter((key) => key.startsWith("disable gui/")).length, 0);
  });

  it("changes nothing when the disabled state cannot be determined", async () => {
    const home = await tempDir();
    const plist = path.join(home, "Library", "LaunchAgents", `${MACOS_AUTOSTART_LABEL}.plist`);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    const OLD_PLIST = "<plist><dict><key>Label</key><string>old</string></dict></plist>\n";
    fs.writeFileSync(plist, OLD_PLIST);
    const { ctx, calls } = fixture(home, {
      "print gui": { code: 0, stdout: "state = running", stderr: "" },
      "print-disabled": { code: 1, stdout: "", stderr: "disabled query failed" },
    });
    await assert.rejects(macosAutostart(ctx).set(true), /disabled state/);
    // No state was touched: file intact, no enable/bootstrap/disable calls.
    assert.equal(fs.readFileSync(plist, "utf8"), OLD_PLIST);
    assert.equal(calls.filter((key) => key.startsWith("bootstrap ")).length, 0);
    assert.equal(calls.filter((key) => key.startsWith("enable gui/")).length, 0);
  });

  it("reports rollback command failures alongside the original error", async () => {
    const home = await tempDir();
    const plist = path.join(home, "Library", "LaunchAgents", `${MACOS_AUTOSTART_LABEL}.plist`);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    const OLD_PLIST = "<plist><dict><key>Label</key><string>old</string></dict></plist>\n";
    fs.writeFileSync(plist, OLD_PLIST);
    const { ctx } = fixture(home, {
      "print gui": { code: 0, stdout: "state = running", stderr: "" },
      "print-disabled": { code: 0, stdout: "", stderr: "" },
      "bootstrap ": { code: 1, stdout: "", stderr: "Bootstrap failed" },
      "bootout ": { code: 1, stdout: "", stderr: "bootout broken" },
      "disable ": { code: 0, stdout: "", stderr: "" },
    });
    // Both the original failure and the failed rollback commands surface.
    await assert.rejects(macosAutostart(ctx).set(true), /rollback errors:.*bootout/);
    assert.equal(fs.readFileSync(plist, "utf8"), OLD_PLIST);
  });

  it("restores a persistent disabled override that exists without a plist", async () => {
    const home = await tempDir();
    const { ctx, calls } = fixture(home, {
      // No plist on disk, but the service carries a persistent disabled
      // override in the gui domain (survives plist removal and reboots).
      "print gui": { code: 113, stdout: "", stderr: "Could not find service" },
      "print-disabled": {
        code: 0,
        stdout: '"dev.astralyn.sash" => disabled',
        stderr: "",
      },
      "bootstrap ": { code: 1, stdout: "", stderr: "Bootstrap failed" },
    });
    await assert.rejects(macosAutostart(ctx).set(true));
    // The override the enable call removed is put back by the rollback even
    // though there was no previous plist.
    assert.equal(calls.filter((key) => key.startsWith("disable gui/")).length, 1);
    assert.equal(
      fs.existsSync(path.join(home, "Library", "LaunchAgents", `${MACOS_AUTOSTART_LABEL}.plist`)),
      false,
    );
  });
});
