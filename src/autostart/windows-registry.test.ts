import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { findExecutableOnPath } from "../process.js";
import { requireCommandSuccess, runAutostartCommand } from "./command.js";
import { testAutostartContext } from "./test-context.test.js";
import { windowsAutostart } from "./windows.js";

const shell = process.platform === "win32" ? findExecutableOnPath("pwsh.exe") : undefined;

it("executes the Windows registry scripts in a disposable, non-startup registry namespace", {
  skip: !shell,
}, async (t) => {
  assert.ok(shell);
  const key = `Software\\SashAutostartTest-${crypto.randomUUID()}`;
  assert.match(key, /^Software\\SashAutostartTest-[a-f0-9-]{36}$/);
  const runScript = async (source: string, env: NodeJS.ProcessEnv = {}) => {
    const result = await runAutostartCommand(
      shell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(source, "utf16le").toString("base64"),
      ],
      { ...process.env, ...env, SystemRoot: process.env.SystemRoot },
    );
    requireCommandSuccess(result);
    return result.stdout;
  };
  t.after(async () => {
    // The generated key is never a real Run/StartupApproved path.
    assert.match(key, /^Software\\SashAutostartTest-[a-f0-9-]{36}$/);
    await runScript(`[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('${key}', $false)`);
  });
  const { ctx } = testAutostartContext(t, "win32", async (_command, args, env) => {
    assert.equal(args[2], "-EncodedCommand");
    const encoded = args[3];
    assert.ok(encoded);
    let source = Buffer.from(encoded, "base64").toString("utf16le");
    const realRun = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const realApproval =
      "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
    assert.ok(source.includes(realRun) && source.includes(realApproval));
    source = source.replaceAll(realRun, `${key}\\Run`).replaceAll(realApproval, `${key}\\Approval`);
    assert.equal(source.includes("Software\\Microsoft\\"), false);
    return { code: 0, stdout: await runScript(source, env), stderr: "" };
  });
  await runScript(
    "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('" +
      key +
      "\\Run'); " +
      "$key.SetValue('Unrelated', 'keep this'); $key.Dispose()",
  );
  const backend = windowsAutostart(ctx);
  assert.equal(await backend.inspect(), "off");
  await backend.set(true);
  assert.equal(await backend.inspect(), "on");
  await runScript(
    "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('" +
      key +
      "\\Approval'); " +
      "$key.SetValue('Sash', [byte[]](3,0,0,0,0,0,0,0,0,0,0,0), [Microsoft.Win32.RegistryValueKind]::Binary); $key.Dispose()",
  );
  assert.equal(await backend.inspect(), "disabled");
  await backend.set(true);
  assert.equal(await backend.inspect(), "on");
  fs.unlinkSync(ctx.entryPath);
  assert.equal(await backend.inspect(), "stale");
  await backend.set(false);
  assert.equal(await backend.inspect(), "off");
  assert.equal(fs.existsSync(path.join(ctx.controlDir, "start.vbs")), false);
  const unrelated = await runScript(
    "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('" +
      key +
      "\\Run'); " +
      "[Console]::Out.Write($key.GetValue('Unrelated')); $key.Dispose()",
  );
  assert.equal(unrelated, "keep this");
});
