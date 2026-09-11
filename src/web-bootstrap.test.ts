import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { sashLayout } from "./paths.js";
import { runSanitizedCommand, windowsSystemExecutable } from "./process.js";
import {
  removeBootstrapFile,
  removeStaleBootstrapFiles,
  writeBootstrapFile,
} from "./web-bootstrap.js";

let root: string;
const token = "b".repeat(64);
const dashboardUrl = "http://127.0.0.1:29193/ui/";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-web-bootstrap-test-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

it("hands off through a private document while keeping the launch URL credential-free", () => {
  const file = writeBootstrapFile(sashLayout(root), {
    dashboardUrl,
    token,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(fileURLToPath(file.fileUrl), file.filePath);
  assert.equal(file.fileUrl.includes(token), false);
  const html = fs.readFileSync(file.filePath, "utf8");
  assert.match(html, /name="referrer" content="no-referrer"/);
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script);
  let handoff = "";
  vm.runInNewContext(script, {
    window: {
      location: {
        replace: (url: string) => {
          handoff = url;
        },
      },
    },
  });
  assert.equal(handoff, `${dashboardUrl}#boot=${token}`);

  if (process.platform === "win32") {
    const encoded = Buffer.from(file.filePath, "utf8").toString("base64");
    const result = runSanitizedCommand(
      windowsSystemExecutable("WindowsPowerShell/v1.0/powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $identity=[Security.Principal.WindowsIdentity]::GetCurrent(); $acl=[IO.File]::GetAccessControl($p); $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); @{owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; tokenOwner=$identity.Owner.Value; sid=$identity.User.Value; readers=@($rules | Where-Object AccessControlType -eq Allow | ForEach-Object {$_.IdentityReference.Value})} | ConvertTo-Json -Compress`,
      ],
      // CI runners cold-start powershell.exe well beyond the 5s default.
      { timeoutMs: 30_000 },
    );
    const acl = JSON.parse(result) as {
      owner: string;
      tokenOwner: string;
      sid: string;
      readers: string[];
    };
    // An elevated token may assign Administrators as the file owner; the
    // protected directory still grants read access only to this user's SID.
    assert.equal(acl.owner, acl.tokenOwner);
    assert.deepEqual(acl.readers, [acl.sid]);
  } else {
    assert.equal(fs.statSync(file.filePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file.filePath)).mode & 0o777, 0o700);
  }
});

it("keeps concurrent live handoffs and removes only expired bootstrap documents", () => {
  const layout = sashLayout(root);
  const firstExpiry = Date.now() + 30_000;
  const first = writeBootstrapFile(layout, {
    dashboardUrl,
    token,
    expiresAt: new Date(firstExpiry).toISOString(),
  });
  const second = writeBootstrapFile(layout, {
    dashboardUrl,
    token,
    expiresAt: new Date(firstExpiry + 30_000).toISOString(),
  });
  const unrelated = path.join(layout.tempDir, "keep.html");
  fs.writeFileSync(unrelated, "keep");
  removeStaleBootstrapFiles(layout.tempDir, firstExpiry - 1);
  assert.equal(fs.existsSync(first.filePath), true);
  removeStaleBootstrapFiles(layout.tempDir, firstExpiry);
  assert.equal(fs.existsSync(path.dirname(first.filePath)), false);
  assert.equal(fs.existsSync(second.filePath), true);
  assert.equal(fs.readFileSync(unrelated, "utf8"), "keep");
  removeBootstrapFile(second.filePath);
  assert.equal(fs.existsSync(path.dirname(second.filePath)), false);
});

it("does not follow bootstrap directory links or recursively remove extra files", () => {
  const layout = sashLayout(root);
  fs.mkdirSync(layout.tempDir);
  const target = path.join(root, "keep");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "index.html"), "keep");
  const link = path.join(layout.tempDir, "web-bootstrap-1000000000000-0000000000000000");
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  removeStaleBootstrapFiles(layout.tempDir);
  assert.equal(fs.readFileSync(path.join(target, "index.html"), "utf8"), "keep");

  const file = writeBootstrapFile(layout, {
    dashboardUrl,
    token,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  });
  const extra = path.join(path.dirname(file.filePath), "keep.txt");
  fs.writeFileSync(extra, "keep");
  removeBootstrapFile(file.filePath);
  assert.equal(fs.readFileSync(extra, "utf8"), "keep");
});

it("rejects invalid credentials and remote handoffs before writing anything", () => {
  for (const patch of [
    { token: "invalid" },
    { expiresAt: new Date(Date.now() - 1).toISOString() },
    { expiresAt: new Date(Date.now() + 120_000).toISOString() },
    { dashboardUrl: "https://example.com/ui/" },
    { dashboardUrl: "http://user@127.0.0.1:29193/ui/" },
  ]) {
    assert.throws(() =>
      writeBootstrapFile(sashLayout(root), {
        dashboardUrl,
        token,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ...patch,
      }),
    );
    assert.deepEqual(fs.readdirSync(root), []);
  }
});
