import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { WebBootstrapInfo } from "./contracts.js";
import { WEB_BOOTSTRAP_TTL_MS } from "./daemon/web-auth.js";
import { atomicWriteFileSync } from "./fs-atomic.js";
import type { SashLayout } from "./paths.js";
import { runSanitizedCommand, windowsSystemExecutable } from "./process.js";

const BOOTSTRAP_DIRECTORY = /^web-bootstrap-(\d{13})-[a-f0-9]{16}$/;

/** Expired handoffs can be removed without racing a browser still opening one. */
export function removeStaleBootstrapFiles(root: string, now = Date.now()): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = BOOTSTRAP_DIRECTORY.exec(entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink() && match && Number(match[1]) <= now) {
      removeBootstrapFile(path.join(root, entry.name, "index.html"));
    }
  }
}

function createPrivateDirectory(directory: string): void {
  if (process.platform !== "win32") {
    fs.mkdirSync(directory, { mode: 0o700 });
    return;
  }
  // Create the directory with its DACL already in place. No credential is
  // written under inherited Windows permissions, including custom SASH_HOME.
  const executable = windowsSystemExecutable("WindowsPowerShell/v1.0/powershell.exe");
  if (!path.isAbsolute(executable)) throw new Error("Windows PowerShell is unavailable");
  const encoded = Buffer.from(directory, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$directory = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
    "if (Test-Path -LiteralPath $directory) { throw 'Bootstrap directory already exists' }",
    "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl = [Security.AccessControl.DirectorySecurity]::new()",
    "$acl.SetOwner($sid)",
    "$acl.SetAccessRuleProtection($true, $false)",
    "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))",
    "[IO.Directory]::CreateDirectory($directory, $acl) | Out-Null",
    "$actual = [IO.Directory]::GetAccessControl($directory)",
    "if (!$actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Bootstrap directory is not private' }",
  ].join("; ");
  runSanitizedCommand(executable, ["-NoProfile", "-NonInteractive", "-Command", script]);
}

/**
 * Write a one-time handoff in a new owner-only directory. Only the file URL
 * reaches the launcher; the credential enters the URL fragment inside the
 * browser, never process arguments or CLI output. Keep the file until expiry
 * so a cold browser or a concurrent `sash web` invocation can still load it.
 */
export function writeBootstrapFile(
  layout: SashLayout,
  opts: WebBootstrapInfo & { dashboardUrl: string },
): { filePath: string; fileUrl: string } {
  const now = Date.now();
  const expiresAt = Date.parse(opts.expiresAt);
  if (
    !/^[a-f0-9]{64}$/.test(opts.token) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + WEB_BOOTSTRAP_TTL_MS
  ) {
    throw new Error("Invalid or expired browser authorization; run 'sash web' again.");
  }
  const target = new URL(opts.dashboardUrl);
  if (
    target.protocol !== "http:" ||
    target.hostname !== "127.0.0.1" ||
    target.username ||
    target.password
  ) {
    throw new Error("The dashboard must use the local Sash address");
  }
  fs.mkdirSync(layout.tempDir, { recursive: true });
  removeStaleBootstrapFiles(layout.tempDir, now);
  const name = `web-bootstrap-${expiresAt}-${crypto.randomBytes(8).toString("hex")}`;
  const directory = path.join(layout.tempDir, name);
  const filePath = path.join(directory, "index.html");
  createPrivateDirectory(directory);
  const handoff = JSON.stringify({ url: opts.dashboardUrl, token: opts.token }).replaceAll(
    "<",
    "\\u003c",
  );
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Sash</title>
  </head>
  <body>
    <p>Opening the Sash dashboard...</p>
    <script>
      (() => {
        const handoff = ${handoff};
        window.location.replace(handoff.url + "#boot=" + handoff.token);
      })();
    </script>
  </body>
</html>
`;
  try {
    atomicWriteFileSync(filePath, html, 0o600);
  } catch (error) {
    removeBootstrapFile(filePath);
    throw error;
  }
  return { filePath, fileUrl: pathToFileURL(filePath).href };
}

/** Delete only the known document and its empty directory, never recursively. */
export function removeBootstrapFile(filePath: string): void {
  const directory = path.dirname(filePath);
  if (
    path.basename(filePath) !== "index.html" ||
    !BOOTSTRAP_DIRECTORY.test(path.basename(directory))
  )
    return;
  try {
    const entry = fs.lstatSync(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return;
    fs.rmSync(filePath, { force: true });
    fs.rmdirSync(directory);
  } catch {
    // Retry on the next invocation if a browser still holds the file open.
  }
}
