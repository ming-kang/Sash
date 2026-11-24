import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { promisify } from "node:util";
import { type Entry, openPromise } from "yauzl";
import { currentCoreVersion } from "../core.js";
import { coreSha256 } from "../launcher/index.js";
import { createIpcHelperClient, setIpcTransportFactory } from "../launcher/ipc.js";
import type { HelperClient } from "../launcher/protocol.js";
import { currentPackageRoot } from "../package-info.js";
import type { TunPlatform } from "../tun-service.js";
import {
  HELPER_EXE_NAME,
  HELPER_SERVICE_NAME,
  helperBinDir,
  helperManifestPath,
  helperManifestSchema,
  helperPipePath,
  helperProtectedDir,
  resolveHelperDistExe,
  WINTUN_SHA256,
  WINTUN_URL,
} from "./windows-shared.js";

const execFileAsync = promisify(execFile);

function helperExePath(): string {
  return resolveHelperDistExe(currentPackageRoot());
}

function pairedCoreExePath(): string {
  return path.join(path.dirname(helperExePath()), `sash-tun-core-win32-${process.arch}.exe`);
}

function protectedHelperExePath(): string {
  return path.join(helperBinDir(), HELPER_EXE_NAME);
}

async function pairedCoreDigest(): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(path.dirname(helperExePath()), "bootstrap-manifest.json"),
        "utf8",
      ),
    ) as { helpers?: { cores?: { name?: string; sha256?: string }[] } };
    return manifest.helpers?.cores?.find(
      (asset) => asset.name === path.basename(pairedCoreExePath()),
    )?.sha256;
  } catch {
    return undefined;
  }
}

async function helperDistDigest(helperExe: string): Promise<string> {
  const manifestFile = path.join(path.dirname(helperExe), "bootstrap-manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8")) as {
    helpers?: { assets?: { name?: string; sha256?: string }[] };
  };
  const expected = manifest.helpers?.assets?.find(
    (asset) => asset.name === path.basename(helperExe),
  )?.sha256;
  if (!expected) {
    throw new Error(
      `Packaged helper manifest has no digest for ${path.basename(helperExe)}; rebuild the release package`,
    );
  }
  const digest = await coreSha256(helperExe);
  if (expected !== digest) {
    throw new Error(`Helper executable ${helperExe} does not match the packaged digest`);
  }
  return expected;
}

async function run(command: string, args: string[], timeoutMs = 15_000): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

async function powershell(script: string, timeoutMs = 15_000): Promise<string> {
  return run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    timeoutMs,
  );
}

async function currentUserSid(): Promise<string> {
  const out = await run("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
  const sid = out.match(/"[^"]+","(S-1-[^"]+)"/)?.[1];
  if (!sid) throw new Error("Could not resolve the current user's SID for the helper ACL");
  return sid;
}

async function isElevated(): Promise<boolean> {
  const out = await run("whoami.exe", ["/groups", "/fo", "csv", "/nh"]);
  return out.includes("S-1-16-12288");
}

export async function fetchWintun(destination: string): Promise<string> {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const dllName = `wintun/bin/${arch === "arm64" ? "arm64" : "amd64"}/wintun.dll`;
  const expectedSha = WINTUN_SHA256[arch];
  try {
    const digest = await coreSha256(destination);
    if (digest === expectedSha) return destination;
  } catch {
    // not downloaded yet
  }
  const response = await fetch(WINTUN_URL, { redirect: "follow" });
  if (!response.ok) throw new Error(`wintun download failed: HTTP ${response.status}`);
  const payload = await (async () => {
    const temp = `${destination}.download`;
    await fs.mkdir(path.dirname(destination), { recursive: true });
    try {
      await fs.writeFile(temp, Buffer.from(await response.arrayBuffer()));
      const zip = await openPromise(temp, { lazyEntries: true });
      const data = await new Promise<Buffer>((resolve, reject) => {
        let payload: Buffer | undefined;
        zip.on("entry", (entry: Entry) => {
          if (entry.fileName.toLowerCase() !== dllName) {
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (error, stream) => {
            if (error) return zip.close();
            const chunks: Buffer[] = [];
            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("end", () => {
              payload = Buffer.concat(chunks);
              zip.close();
            });
            stream.on("error", () => zip.close());
          });
        });
        zip.on("end", () => zip.close());
        zip.on("error", reject);
        zip.once("close", () =>
          payload
            ? resolve(payload)
            : reject(new Error(`${dllName} missing from the pinned wintun archive`)),
        );
        zip.readEntry();
      });
      return data;
    } finally {
      await fs.rm(temp, { force: true });
    }
  })();
  const digest = crypto.createHash("sha256").update(payload).digest("hex");
  if (digest !== expectedSha) {
    throw new Error(`wintun digest mismatch: got ${digest}, expected ${expectedSha}`);
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, payload, { mode: 0o755 });
  return destination;
}

interface ElevatedResult {
  ok: boolean;
  error?: string;
}

/**
 * Windows command-line quoting (CommandLineToArgvW rules): wrap in double
 * quotes; escape backslashes that precede a quote or the closing quote.
 */
function quoteWinArg(arg: string): string {
  return `"${arg.replace(
    /(\\*)("|$)/g,
    (_m, bs: string, tail: string) => bs + bs + (tail === '"' ? '\\"' : ""),
  )}"`;
}

// Check the digest again after copying into the elevated staging directory.
async function runElevatedStaged(
  helperExe: string,
  helperDigest: string,
  args: string[],
): Promise<void> {
  const resultFile = path.join(
    os.tmpdir(),
    `sash-helper-${process.pid}-${crypto.randomBytes(6).toString("hex")}.json`,
  );
  const argv = [...args, "--result", resultFile];
  // A single literal-quoted command line: Start-Process -ArgumentList would
  // otherwise space-join an array and strip the quoting, breaking args with
  // spaces (paths, result file).
  const argLine = argv.map(quoteWinArg).join(" ");
  // PowerShell single-quoted literal ('' escapes a single quote); JSON
  // escaping does NOT work inside PS strings — \" would end the string.
  const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const script = `
$ErrorActionPreference = 'Stop'
$root = [Environment]::GetFolderPath('CommonApplicationData')
if ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
  throw 'ProgramData is a reparse point'
}
$sashRoot = Join-Path $root 'Sash'
if (Test-Path -LiteralPath $sashRoot) {
  $parent = Get-Item -LiteralPath $sashRoot -Force
  if ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Sash root is a reparse point'
  }
  if (-not $parent.PSIsContainer) { throw 'Sash root is not a directory' }
  # Before staging executable content under it, prove the existing parent is
  # owned by SYSTEM or Administrators and grants no write rights to ordinary
  # users — otherwise a lower-privileged actor could swap the staged helper.
  $acl = Get-Acl -LiteralPath $sashRoot
  $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($ownerSid -ne 'S-1-5-18' -and $ownerSid -ne 'S-1-5-32-544') {
    throw "Sash root owner is not SYSTEM/Administrators: $ownerSid"
  }
  foreach ($ace in $acl.Access) {
    if ($ace.AccessControlType -ne 'Allow') { continue }
    try {
      $sid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
      $sid = ''
    }
    if ($sid -eq 'S-1-5-18' -or $sid -eq 'S-1-5-32-544' -or $sid -eq 'S-1-3-4') { continue }
    if ($ace.FileSystemRights.ToString() -match 'FullControl|Modify|Write') {
      throw "Untrusted identity $($ace.IdentityReference.Value) has write rights on Sash root"
    }
  }
}
$stage = Join-Path $sashRoot ('stage-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
  icacls $stage /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)(F)' '*S-1-5-32-544:(OI)(CI)(F)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls failed with exit code $LASTEXITCODE" }
  $staged = Join-Path $stage 'sash-helper.exe'
  Copy-Item -LiteralPath ${ps(helperExe)} -Destination $staged -Force
  $actual = (Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne ${ps(helperDigest)}) {
    throw "Staged helper digest mismatch: $actual"
  }
  $p = Start-Process -FilePath $staged -ArgumentList ${ps(argLine)} -Wait -PassThru
  if ($p.ExitCode -ne 0) { exit $p.ExitCode }
} finally {
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  let spawnError: unknown;
  try {
    if (await isElevated()) {
      await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encoded,
      ]);
    } else {
      await powershell(
        `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -ArgumentList ` +
          `${quoteWinArg(`-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`)}`,
        240_000,
      );
    }
  } catch (error) {
    spawnError = error;
  }
  const result = await fs
    .readFile(resultFile, "utf8")
    .then((text) => JSON.parse(text) as ElevatedResult)
    .catch(() => null);
  await fs.rm(resultFile, { force: true });
  if (result?.error) throw new Error(result.error);
  if (spawnError) throw spawnError;
  if (!result?.ok) throw new Error("Elevated helper operation produced no result");
}

async function runElevatedProtected(
  helperExe: string,
  helperDigest: string,
  args: string[],
): Promise<void> {
  const protectedExe = protectedHelperExePath();
  const manifest = await fs
    .readFile(helperManifestPath(helperProtectedDir()), "utf8")
    .then((text) => helperManifestSchema.parse(JSON.parse(text)))
    .catch(() => undefined);
  if (manifest) {
    const installed = await coreSha256(protectedExe).catch(() => null);
    if (installed === manifest.helperSha256) {
      await runElevatedStaged(protectedExe, installed, args);
      return;
    }
  }
  await runElevatedStaged(helperExe, helperDigest, args);
}

async function serviceInstalled(): Promise<boolean> {
  const config = await run("sc.exe", ["qc", HELPER_SERVICE_NAME]);
  return config.toLowerCase().includes(helperProtectedDir().toLowerCase());
}

/**
 * Socket over the helper's `pipe-client` shim: Node/libuv cannot open the
 * front pipe with the DACL's limited client mask, so the daemon spawns the
 * protected helper as an unprivileged stdio bridge. Its process token is
 * what the server authenticates — it runs as the calling user.
 */
function openHelperSocket(): Duplex {
  const child = spawn(protectedHelperExePath(), ["pipe-client", "--pipe", helperPipePath()], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const duplex = new Duplex({
    allowHalfOpen: false,
    write(chunk, _enc, cb) {
      if (child.stdin.destroyed) {
        cb(new Error("Helper pipe shim closed"));
        return;
      }
      child.stdin.write(chunk, cb);
    },
    read() {},
    final(cb) {
      child.stdin.end(cb);
    },
    destroy(error, cb) {
      child.kill();
      cb(error);
    },
  });
  child.stdout.on("data", (chunk: Buffer) => duplex.push(chunk));
  child.stdout.on("end", () => duplex.push(null));
  child.stdin.on("error", (error) => duplex.destroy(error));
  child.on("error", (error) =>
    duplex.destroy(error instanceof Error ? error : new Error(String(error))),
  );
  child.stderr.on("data", () => {}); // drain so a noisy shim can never block on a full pipe
  child.on("close", (code) => {
    if (code) duplex.destroy(new Error(`Helper pipe shim exited ${code}`));
  });
  // The supervisor's HTTP agent waits for 'connect' like a net.Socket; the
  // shim connects to the pipe at startup, so from the caller's perspective
  // the transport is usable once the child is spawned.
  queueMicrotask(() => duplex.emit("connect"));
  return duplex;
}

export function windowsTunPlatform(): TunPlatform {
  return {
    supported: true,
    async inspect() {
      try {
        if (!(await serviceInstalled())) return { installed: false };
      } catch {
        return { installed: false };
      }
      try {
        const manifest = await fs
          .readFile(helperManifestPath(helperProtectedDir()), "utf8")
          .then((text) => helperManifestSchema.parse(JSON.parse(text)))
          .catch(() => undefined);
        const [expected, installedCoreDigest, installedHelperDigest] = await Promise.all([
          pairedCoreDigest(),
          coreSha256(path.join(helperBinDir(), "mihomo.exe")).catch(() => null),
          coreSha256(protectedHelperExePath()).catch(() => null),
        ]);
        const needsReconsent =
          expected === undefined ||
          manifest === undefined ||
          installedCoreDigest === null ||
          installedHelperDigest === null ||
          installedCoreDigest !== expected ||
          installedHelperDigest !== manifest.helperSha256;
        return {
          installed: true,
          helperVersion: manifest?.helperVersion ?? null,
          needsReconsent,
        };
      } catch {
        // An inspection that cannot verify pairing must not claim a healthy
        // install — flag reconsent so the user is asked to reinstall.
        return { installed: true, needsReconsent: true };
      }
    },
    async install(layout) {
      const helperExe = helperExePath();
      await fs.access(helperExe).catch(() => {
        throw new Error(
          `Missing helper executable ${helperExe}; build it with scripts/build-helper`,
        );
      });
      const packagedCore = pairedCoreExePath();
      await fs.access(packagedCore).catch(() => {
        throw new Error(
          `Missing paired Core executable ${packagedCore}; rebuild the release package`,
        );
      });
      const wintun = await fetchWintun(path.join(layout.tempDir, "wintun.dll"));
      const sid = await currentUserSid();
      const helperDigest = await helperDistDigest(helperExe);
      await runElevatedStaged(helperExe, helperDigest, [
        "install",
        "--installer-sid",
        sid,
        "--core",
        packagedCore,
        "--core-version",
        currentCoreVersion(layout) || "unknown",
        "--helper-exe",
        helperExe,
        "--helper-sha256",
        helperDigest,
        "--wintun",
        wintun,
      ]);
    },
    async uninstall() {
      await runElevatedProtected(helperExePath(), await helperDistDigest(helperExePath()), [
        "uninstall",
      ]);
    },
    connect(): HelperClient {
      // `start` pays for path audits (PowerShell) and the Core spawn; the
      // default 10s IPC timeout is too tight on a cold service.
      setIpcTransportFactory(() => openHelperSocket());
      return createIpcHelperClient(helperPipePath(), 60_000);
    },
  };
}
