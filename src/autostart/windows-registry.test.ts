import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { findExecutableOnPath, windowsSystemExecutable } from "../process.js";
import { testAutostartContext } from "../testing/autostart-context.js";
import { requireCommandSuccess, runAutostartCommand } from "./context.js";
import { windowsAutostart } from "./windows.js";
import { parseWindowsRegistryValue, readWindowsRegistration } from "./windows-registry.js";

const shell = process.platform === "win32" ? findExecutableOnPath("pwsh.exe") : undefined;

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_HEADER = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const APPROVAL_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
const APPROVAL_HEADER =
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";

it("parses REG_SZ and REG_BINARY values, preserving data exactly", () => {
  const cases: Array<[string, string, unknown]> = [
    [
      `\r\n${RUN_HEADER}\r\n    Sash    REG_SZ    "C:\\Sash\\wscript.exe" //B //Nologo "C:\\Sash 数据\\start.vbs" 备注\r\n\r\n`,
      RUN_KEY,
      {
        type: "REG_SZ",
        data: '"C:\\Sash\\wscript.exe" //B //Nologo "C:\\Sash 数据\\start.vbs" 备注',
      },
    ],
    [
      `\r\n${RUN_HEADER}\r\n    Sash    REG_SZ    alpha    beta     gamma\r\n`,
      RUN_KEY,
      { type: "REG_SZ", data: "alpha    beta     gamma" },
    ],
    [`${RUN_KEY}\r\n    Sash    REG_SZ    \r\n\r\n`, RUN_KEY, { type: "REG_SZ", data: "" }],
    [
      `\r\n${APPROVAL_HEADER}\r\n    Sash    REG_BINARY    060000000000000000000000\r\n\r\n`,
      APPROVAL_KEY,
      { type: "REG_BINARY", data: Buffer.from([6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
    ],
    // Unexpected types survive parsing so callers can reject them.
    [
      `\r\n${RUN_HEADER}\r\n    Sash    REG_DWORD    0x1\r\n\r\n`,
      RUN_KEY,
      { type: "REG_DWORD", data: "0x1" },
    ],
  ];
  for (const [output, key, expected] of cases)
    assert.deepEqual(parseWindowsRegistryValue(output, key, "Sash"), expected);
});

it("rejects malformed registry query output", () => {
  const cases: Record<string, string> = {
    "empty output": "",
    "wrong header": `\r\nHKEY_CURRENT_USER\\Software\\Other\r\n    Sash    REG_SZ    x\r\n`,
    "truncated after the header": `\r\n${RUN_HEADER}\r\n`,
    "truncated value line": `\r\n${RUN_HEADER}\r\n    Sash    RE\r\n`,
    "value name mismatch": `\r\n${RUN_HEADER}\r\n    SashOld    REG_SZ    x\r\n`,
    "flush-left extra line": `\r\n${RUN_HEADER}\r\n    Sash    REG_SZ    x\r\ngarbage\r\n`,
    "duplicate value": `\r\n${RUN_HEADER}\r\n    Sash    REG_SZ    x\r\n    Sash    REG_SZ    y\r\n`,
    "lowercase REG_BINARY data": `\r\n${RUN_HEADER}\r\n    Sash    REG_BINARY    0600ab\r\n`,
    "odd-length REG_BINARY data": `\r\n${RUN_HEADER}\r\n    Sash    REG_BINARY    060\r\n`,
    "spaced REG_BINARY data": `\r\n${RUN_HEADER}\r\n    Sash    REG_BINARY    06 00\r\n`,
  };
  for (const [name, output] of Object.entries(cases)) {
    assert.throws(
      () => parseWindowsRegistryValue(output, RUN_KEY, "Sash"),
      /Invalid Windows registry output/,
      name,
    );
  }
});

it("falls back to the PowerShell inspection when reg.exe output is lossy", async (t) => {
  // reg.exe cannot represent every Unicode code point; both replacement characters
  // and question marks mark output that must not be trusted.
  const cases = [
    [
      "replacement characters",
      "C:\\Users\\\uFFFD\uFFFD\uFFFD\\start.vbs",
      "C:\\Users\\张三\\start.vbs",
    ],
    ["question marks", "C:\\Users\\??\\start.vbs", null],
  ] as const;
  for (const [label, lossy, decoded] of cases) {
    let encodedCommands = 0;
    const { ctx } = testAutostartContext(t, "win32", async (_command, args) => {
      if (args[0] === "query") {
        const header = (args[1] ?? "").replace(/^HKCU/, "HKEY_CURRENT_USER");
        if (args[1] === RUN_KEY) {
          return {
            code: 0,
            stdout: `\r\n${header}\r\n    Sash    REG_SZ    ${lossy}\r\n\r\n`,
            stderr: "",
          };
        }
        return { code: 1, stdout: "", stderr: "not found" };
      }
      encodedCommands++;
      assert.equal(args[2], "-EncodedCommand");
      return {
        code: 0,
        stdout: JSON.stringify({
          run: decoded === null ? null : Buffer.from(decoded).toString("base64"),
          approval: null,
        }),
        stderr: "",
      };
    });
    assert.deepEqual(
      await readWindowsRegistration(ctx),
      { command: decoded, disabled: false },
      label,
    );
    assert.equal(encodedCommands, 1, label);
  }
});

it("reads reg.exe output directly when it decodes losslessly", async (t) => {
  let encodedCommands = 0;
  const { ctx } = testAutostartContext(t, "win32", async (_command, args) => {
    if (args[0] === "query") {
      const header = (args[1] ?? "").replace(/^HKCU/, "HKEY_CURRENT_USER");
      if (args[1] === RUN_KEY)
        return {
          code: 0,
          stdout: `\r\n${header}\r\n    Sash    REG_SZ    wscript.exe start.vbs\r\n\r\n`,
          stderr: "",
        };
      return {
        code: 0,
        stdout: `\r\n${header}\r\n    Sash    REG_BINARY    060000000000000000000000\r\n\r\n`,
        stderr: "",
      };
    }
    encodedCommands++;
    throw new Error("unexpected PowerShell fallback");
  });
  assert.deepEqual(await readWindowsRegistration(ctx), {
    command: "wscript.exe start.vbs",
    disabled: false,
  });
  assert.equal(encodedCommands, 0);
});

it("executes the Windows registry scripts in a disposable, non-startup registry namespace", {
  skip: !shell,
}, async (t) => {
  assert.ok(shell);
  const key = `Software\\SashAutostartTest-${crypto.randomUUID()}`;
  assert.match(key, /^Software\\SashAutostartTest-[a-f0-9-]{36}$/);
  const realEnv = (env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    ...env,
    SystemRoot: process.env.SystemRoot,
  });
  const runScript = async (source: string, env: NodeJS.ProcessEnv = {}) => {
    const result = await runAutostartCommand(
      shell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(source, "utf16le").toString("base64"),
      ],
      realEnv(env),
    );
    requireCommandSuccess(result);
    return result.stdout;
  };
  t.after(async () => {
    // The generated key is never a real Run/StartupApproved path.
    assert.match(key, /^Software\\SashAutostartTest-[a-f0-9-]{36}$/);
    await runScript(`[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('${key}', $false)`);
  });
  const realRun = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
  const realApproval =
    "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
  const { ctx } = testAutostartContext(t, "win32", async (_command, args, env) => {
    if (args[0] === "//B")
      return runAutostartCommand(windowsSystemExecutable("cscript.exe"), args, realEnv(env));
    if (args[0] === "query") {
      const queried = args[1];
      assert.ok(queried, "Missing registry query key");
      const mapped =
        queried === `HKCU\\${realRun}`
          ? `${key}\\Run`
          : queried === `HKCU\\${realApproval}`
            ? `${key}\\Approval`
            : undefined;
      assert.ok(mapped, `Unexpected registry query target: ${queried}`);
      const result = await runAutostartCommand(
        windowsSystemExecutable("reg.exe"),
        ["query", `HKCU\\${mapped}`, ...args.slice(2)],
        realEnv(env),
      );
      // reg.exe echoes the queried key as its header; restore the original target
      // so the strict header check still validates the response.
      return {
        ...result,
        stdout: result.stdout.replaceAll(`HKEY_CURRENT_USER\\${mapped}`, queried),
      };
    }
    assert.equal(args[2], "-EncodedCommand");
    const encoded = args[3];
    assert.ok(encoded);
    let source = Buffer.from(encoded, "base64").toString("utf16le");
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
  const unicodeCommand =
    '"C:\\Windows\\System32\\wscript.exe" //B //Nologo "C:\\Users\\张三\\start.vbs"';
  await runScript(
    "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('" +
      key +
      "\\Run'); " +
      "$key.SetValue('Sash', $env:SASH_TEST_COMMAND, [Microsoft.Win32.RegistryValueKind]::String); $key.Dispose()",
    { SASH_TEST_COMMAND: unicodeCommand },
  );
  assert.equal((await readWindowsRegistration(ctx)).command, unicodeCommand);
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
