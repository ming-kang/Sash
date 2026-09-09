import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildSanitizedEnv, findExecutableOnPath } from "./process.js";

const shell = findExecutableOnPath(process.platform === "win32" ? "pwsh.exe" : "pwsh");

it("completes commands, enums and contextual options in PowerShell without executing Sash", {
  skip: shell ? false : "PowerShell 7 is not installed",
}, async () => {
  assert.ok(shell);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-completion-"));
  const marker = path.join(root, "must-not-execute");
  const cases = [
    { input: "sash st", expected: ["start", "stop", "status"] },
    { input: "sash up", expected: ["update", "upgrade"] },
    { input: "sash status --d", expected: ["--delay"] },
    { input: "sash.ps1 status --w", expected: ["--watch"] },
    { input: "sash.cmd upgrade --c", expected: ["--check"] },
    { input: "sash auto o", expected: ["on", "off"] },
    { input: "sash proxy st", expected: ["status"] },
    { input: "sash mode --json d", expected: ["direct"] },
    { input: "sash profile re", expected: ["rename", "remove"] },
    { input: "sash profile use --d", expected: ["--default"] },
    { input: "sash profile update --a", expected: ["--all"] },
    { input: "sash stop --c", expected: ["--core"] },
    { input: "sash doctor --j", expected: ["--json"] },
    { input: "sash web --n", expected: ["--no-open"] },
    { input: "sash logs -n 20 --f", expected: ["--follow"] },
    { input: "sash logs --lines=20 --d", expected: ["--daemon"] },
    { input: "sash logs -f --f", expected: [] },
    { input: "sash profile use 'Work Name' --d", expected: [] },
    { input: "sash status --delay DIRECT --d", expected: [] },
    { input: "sash status --delay --j", expected: [] },
    { input: "sash status -- --j", expected: [] },
    {
      input: "sash profile add 'https://example.test/a?secret=x' --name 'Work 名称' --u",
      expected: ["--use"],
    },
    {
      input:
        "sash profile add $(Set-Content -LiteralPath $env:SASH_COMPLETION_MARKER -Value bad) --n",
      expected: ["--name"],
    },
    { input: "sash help pro", expected: ["profile", "proxy"] },
    { input: "sash profile help re", expected: ["rename", "remove"] },
    { input: "sash status --d --json", cursor: "sash status --d".length, expected: ["--delay"] },
  ];
  try {
    fs.writeFileSync(
      path.join(root, "sash.cmd"),
      '@echo off\r\necho unexpected> "%SASH_COMPLETION_MARKER%"\r\n',
    );
    fs.writeFileSync(
      path.join(root, "sash.ps1"),
      "Set-Content -LiteralPath $env:SASH_COMPLETION_MARKER -Value unexpected\n",
    );
    fs.writeFileSync(
      path.join(root, "sash"),
      '#!/bin/sh\nprintf unexpected > "$SASH_COMPLETION_MARKER"\n',
      { mode: 0o700 },
    );
    const env = buildSanitizedEnv();
    const searchPath = env.PATH ?? env.Path ?? "";
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
    const output = execFileSync(
      shell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. $env:SASH_COMPLETION_SCRIPT
$cases = ConvertFrom-Json -InputObject $env:SASH_COMPLETION_CASES
$results = foreach ($case in $cases) {
    $cursor = if ($null -ne $case.PSObject.Properties['cursor']) { $case.cursor } else { $case.input.Length }
    [pscustomobject]@{
        input = $case.input
        matches = @((TabExpansion2 $case.input $cursor).CompletionMatches | ForEach-Object CompletionText)
    }
}
ConvertTo-Json -InputObject @($results) -Depth 4 -Compress
`,
      ],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
        env: {
          ...env,
          PATH: `${root}${path.delimiter}${searchPath}`,
          SASH_HOME: path.join(root, "data"),
          LOCALAPPDATA: path.join(root, "local"),
          XDG_STATE_HOME: path.join(root, "state"),
          SASH_COMPLETION_SCRIPT: fileURLToPath(
            new URL("../docs/completions/sash.ps1", import.meta.url),
          ),
          SASH_COMPLETION_CASES: JSON.stringify(cases),
          SASH_COMPLETION_MARKER: marker,
        },
      },
    );
    const results = JSON.parse(output) as Array<{ input: string; matches: string[] }>;
    assert.equal(results.length, cases.length);
    for (const [index, result] of results.entries())
      assert.deepEqual(result.matches, cases[index]?.expected, result.input);
    assert.equal(fs.existsSync(marker), false, "completion must not execute expressions or Sash");
    assert.equal(fs.existsSync(path.join(root, "data")), false);
  } finally {
    assert.equal(
      path.dirname(await fs.promises.realpath(root)).toLowerCase(),
      (await fs.promises.realpath(os.tmpdir())).toLowerCase(),
    );
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
