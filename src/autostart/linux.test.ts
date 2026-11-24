import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import { testAutostartContext } from "../testing/autostart-context.js";
import { linuxAutostart, linuxAutostartFile, linuxDesktopEntry } from "./linux.js";

describe("linux autostart (XDG)", () => {
  it("writes a desktop entry under XDG_CONFIG_HOME/autostart", async (t) => {
    const { ctx } = testAutostartContext(t, "linux");
    const file = linuxAutostartFile(ctx);
    assert.equal(file, path.join(ctx.env.XDG_CONFIG_HOME as string, "autostart", "sash.desktop"));
    const backend = linuxAutostart(ctx);
    assert.equal(await backend.inspect(), "off");
    await backend.set(true);
    const text = fs.readFileSync(file, "utf8");
    assert.ok(text.includes("[Desktop Entry]"));
    assert.ok(text.includes(`SASH_HOME=${ctx.dataDir}`));
    assert.ok(text.includes(`${ctx.nodePath} ${ctx.entryPath}`));
    assert.equal(await backend.inspect(), "on");
  });

  it("quotes launcher paths containing spaces", (t) => {
    const { ctx } = testAutostartContext(t, "linux");
    const text = linuxDesktopEntry(ctx);
    const execLine = text.split("\n").find((line) => line.startsWith("Exec="));
    // The data dir itself contains a space in the fixture.
    assert.ok(execLine?.includes(`"${ctx.entryPath}"`) || execLine?.includes(ctx.entryPath));
  });

  it("reports stale when the Exec line no longer matches", async (t) => {
    const { ctx } = testAutostartContext(t, "linux");
    const backend = linuxAutostart(ctx);
    await backend.set(true);
    const file = linuxAutostartFile(ctx);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Exec=", "Exec=/old/sash #"));
    assert.equal(await backend.inspect(), "stale");
  });

  it("reports disabled when Hidden=true is present", async (t) => {
    const { ctx } = testAutostartContext(t, "linux");
    const backend = linuxAutostart(ctx);
    await backend.set(true);
    const file = linuxAutostartFile(ctx);
    fs.writeFileSync(file, `${fs.readFileSync(file, "utf8")}Hidden=true\n`);
    assert.equal(await backend.inspect(), "disabled");
  });

  it("removes the entry on disable", async (t) => {
    const { ctx } = testAutostartContext(t, "linux");
    const backend = linuxAutostart(ctx);
    await backend.set(true);
    await backend.set(false);
    assert.equal(fs.existsSync(linuxAutostartFile(ctx)), false);
    assert.equal(await backend.inspect(), "off");
  });
});
