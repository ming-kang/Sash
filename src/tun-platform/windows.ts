import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { errorMessage } from "../error-utils.js";
import {
  downloadReleaseAsset,
  listReleaseAssets,
  parseSha256Digest,
  type ReleaseAsset,
  selectReleaseAsset,
} from "../github.js";
import { currentPackageRoot, readSashPackageInfo } from "../package-info.js";
import type { SashLayout } from "../paths.js";
import { runSanitizedCommandAsync, windowsSystemExecutable } from "../process.js";
import type { HostedCore, TunPlatform, TunPrivilege } from "../tun-service.js";
import { readHelperDigests } from "./helper-digests.js";
import { refuseElevationInTests } from "./shared.js";

/**
 * The Windows TUN helper is the Go service under helper/. It is not part of
 * the npm package: installation takes it from this Sash version's GitHub
 * Release (or a local `npm run build:helper` output in a source checkout).
 */
export const HELPER_REPO = "ming-kang/Sash";
export const HELPER_SERVICE = "SashTun";
export const HELPER_PIPE = "\\\\.\\pipe\\sash-tun";
/** Bumped together with protocolVersion in helper/server.go. */
export const HELPER_PROTOCOL = 1;
/** The 0.7.0 helper service, replaced on install and removed on uninstall. */
const LEGACY_SERVICE = "SashTunHelper";

export function helperAssetName(arch: string = process.arch): string {
  return `sash-tun-helper-win32-${arch}.exe`;
}

const helperReplySchema = z.object({
  ok: z.boolean(),
  protocol: z.number().int(),
  home: z.string(),
  running: z.boolean(),
  pid: z.number().int().positive().optional(),
  error: z.string().optional(),
});
export type HelperReply = z.output<typeof helperReplySchema>;
export type HelperOp = "status" | "start" | "stop";
export type HelperRequest = (op: HelperOp, timeoutMs: number) => Promise<HelperReply>;

/** One request line per connection, answered by one reply line. */
export function requestHelper(
  op: HelperOp,
  timeoutMs: number,
  pipe: string = HELPER_PIPE,
): Promise<HelperReply> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: pipe });
    let buffer = "";
    const timer = setTimeout(
      () => socket.destroy(new Error(`TUN helper did not answer ${op} within ${timeoutMs}ms`)),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ op })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        if (buffer.length > 64 * 1024) socket.destroy(new Error("TUN helper reply is too large"));
        return;
      }
      clearTimeout(timer);
      socket.end();
      try {
        resolve(helperReplySchema.parse(JSON.parse(buffer.slice(0, newline))));
      } catch {
        reject(new Error("TUN helper sent an invalid reply"));
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      reject(new Error("TUN helper closed the connection without replying"));
    });
  });
}

function samePath(left: string, right: string): boolean {
  return path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
}

export function privilegeFromReply(reply: HelperReply, layout: SashLayout): TunPrivilege {
  if (reply.protocol !== HELPER_PROTOCOL)
    return {
      state: "stale",
      detail: `the TUN service speaks protocol ${reply.protocol}; this Sash needs ${HELPER_PROTOCOL}`,
    };
  if (!samePath(reply.home, layout.root))
    return { state: "stale", detail: `the TUN service serves another data folder (${reply.home})` };
  return { state: "ready" };
}

/** CommandLineToArgvW quoting; arguments without spaces or quotes stay bare. */
export function quoteWindowsArgument(value: string): string {
  if (value && !/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)("|$)/g, (_match, slashes: string, quote: string) =>
    quote ? `${slashes}${slashes}\\"` : `${slashes}${slashes}`,
  )}"`;
}

/** Everything the service may ever run is fixed here, at installation. */
export function serviceArguments(layout: SashLayout, sid: string): string {
  return [
    "service",
    "--user",
    sid,
    "--core",
    layout.coreExe,
    "--home",
    layout.root,
    "--config",
    layout.configFile,
    "--stdout",
    layout.coreLogFile,
    "--stderr",
    layout.coreErrLogFile,
  ]
    .map(quoteWindowsArgument)
    .join(" ");
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The helper lives in an Administrators-owned directory under ProgramData:
 * ProgramData lets any user create folders, so an existing `Sash` folder is
 * taken over and re-protected rather than trusted.
 */
const SCRIPT_PRELUDE = `
$sashDir = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Sash'
$helperDir = Join-Path $sashDir 'TUN'
$helperExe = Join-Path $helperDir 'sash-tun-helper.exe'
$legacyDir = Join-Path $sashDir 'core'
function Remove-SashService([string]$name) {
  $service = Get-Service -Name $name -ErrorAction SilentlyContinue
  if (-not $service) { return }
  if ($service.Status -ne 'Stopped') {
    Stop-Service -Name $name -Force
    $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
  }
  $service.Close()
  & sc.exe delete $name | Out-Null
  for ($i = 0; $i -lt 50 -and (Get-Service -Name $name -ErrorAction SilentlyContinue); $i++) {
    Start-Sleep -Milliseconds 200
  }
  if (Get-Service -Name $name -ErrorAction SilentlyContinue) { throw "Windows did not remove the $name service" }
}
function Protect-Directory([string]$dir) {
  if (Test-Path -LiteralPath $dir) {
    $item = Get-Item -LiteralPath $dir -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "$dir is not a plain directory"
    }
  } else {
    New-Item -ItemType Directory -Path $dir | Out-Null
  }
  & icacls.exe $dir /setowner '*S-1-5-32-544' /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls could not take ownership of $dir" }
  & icacls.exe $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls could not protect $dir" }
}
Remove-SashService '${HELPER_SERVICE}'
Remove-SashService '${LEGACY_SERVICE}'
if (Test-Path -LiteralPath $legacyDir) { Remove-Item -LiteralPath $legacyDir -Recurse -Force }
`;

export function installScript(input: {
  source: string;
  sha256: string;
  arguments: string;
}): string {
  return `${SCRIPT_PRELUDE}
foreach ($dir in @($sashDir, $helperDir)) { Protect-Directory $dir }
Copy-Item -LiteralPath ${psQuote(input.source)} -Destination $helperExe -Force
$actual = (Get-FileHash -LiteralPath $helperExe -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne ${psQuote(input.sha256)}) {
  Remove-Item -LiteralPath $helperExe -Force
  throw "TUN helper digest mismatch: got $actual"
}
New-Service -Name '${HELPER_SERVICE}' -BinaryPathName ('"' + $helperExe + '" ' + ${psQuote(input.arguments)}) -DisplayName 'Sash TUN Helper' -Description 'Starts and stops the Sash Core with the privileges TUN Mode needs.' -StartupType Automatic | Out-Null
& sc.exe failure '${HELPER_SERVICE}' reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
Start-Service -Name '${HELPER_SERVICE}'
`;
}

export function uninstallScript(): string {
  return `${SCRIPT_PRELUDE}
if (Test-Path -LiteralPath $helperDir) { Remove-Item -LiteralPath $helperDir -Recurse -Force }
if ((Test-Path -LiteralPath $sashDir) -and -not (Get-ChildItem -LiteralPath $sashDir -Force)) {
  Remove-Item -LiteralPath $sashDir -Force
}
`;
}

function powershellExe(): string {
  return windowsSystemExecutable(path.join("WindowsPowerShell", "v1.0", "powershell.exe"));
}

async function runElevated(script: string, action: string): Promise<void> {
  refuseElevationInTests(action);
  const resultFile = path.join(
    os.tmpdir(),
    `sash-tun-${process.pid}-${randomBytes(6).toString("hex")}.txt`,
  );
  const elevated = `$ErrorActionPreference = 'Stop'
try {
${script}
} catch {
  Set-Content -LiteralPath ${psQuote(resultFile)} -Value $_.Exception.Message -Encoding UTF8
  exit 1
}`;
  const encoded = Buffer.from(elevated, "utf16le").toString("base64");
  const launcher =
    "$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden " +
    `-ArgumentList ${psQuote(`-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`)}; ` +
    "exit $p.ExitCode";
  try {
    await runSanitizedCommandAsync(
      powershellExe(),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", launcher],
      { timeoutMs: 300_000 },
    );
  } catch (error) {
    const reason = (await fs.readFile(resultFile, "utf8").catch(() => "")).trim();
    if (reason) throw new Error(`Could not ${action}: ${reason}`);
    if (/cancel/i.test(errorMessage(error)))
      throw new Error("Windows administrator approval was cancelled");
    throw new Error(`Could not ${action}: ${errorMessage(error)}`);
  } finally {
    await fs.rm(resultFile, { force: true });
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

interface HelperSource {
  file: string;
  sha256: string;
  cleanup(): Promise<void>;
}

export interface HelperSourceOptions {
  proxyUri?: string;
  /** Test seam for the source-checkout precedence; production uses the real package. */
  packageRoot?: string;
}

async function downloadHelper(
  layout: SashLayout,
  tag: string,
  asset: ReleaseAsset,
  proxyUri?: string,
): Promise<HelperSource> {
  await fs.mkdir(layout.tempDir, { recursive: true });
  const file = path.join(layout.tempDir, asset.name);
  await downloadReleaseAsset({
    repo: HELPER_REPO,
    tag,
    asset,
    dest: file,
    ...(proxyUri !== undefined ? { proxyUri } : {}),
  });
  return {
    file,
    sha256: parseSha256Digest(asset.digest),
    cleanup: () => fs.rm(file, { force: true }),
  };
}

/**
 * The release API is only a digest oracle: both paths download the same
 * direct URL and verify the bytes after download. When the API cannot be
 * read — rate limit, offline — the digests embedded in this package at build
 * time take over as the oracle; they never skip or weaken verification.
 */
async function fallbackHelperSource(
  layout: SashLayout,
  tag: string,
  name: string,
  version: string,
  cause: unknown,
  proxyUri?: string,
): Promise<HelperSource> {
  const embedded = readHelperDigests()?.find((asset) => asset.name === name);
  if (!embedded) {
    throw new Error(
      `Could not read the Sash ${version} GitHub Release: ${errorMessage(cause)}; ` +
        `this package carries no embedded digest for ${name}, so the verified direct download is unavailable`,
    );
  }
  return downloadHelper(
    layout,
    tag,
    { name: embedded.name, size: embedded.size, digest: `sha256:${embedded.sha256}` },
    proxyUri,
  );
}

export async function resolveHelperSource(
  layout: SashLayout,
  options: HelperSourceOptions = {},
): Promise<HelperSource> {
  const name = helperAssetName();
  const local = path.join(options.packageRoot ?? currentPackageRoot(), "helper", "bin", name);
  if ((await fs.stat(local).catch(() => undefined))?.isFile())
    return { file: local, sha256: await sha256File(local), cleanup: async () => {} };

  const { version } = readSashPackageInfo();
  const tag = `v${version}`;
  let assets: Awaited<ReturnType<typeof listReleaseAssets>>;
  try {
    assets = await listReleaseAssets(HELPER_REPO, tag, undefined, undefined, options.proxyUri);
  } catch (error) {
    return fallbackHelperSource(layout, tag, name, version, error, options.proxyUri);
  }
  const asset = selectReleaseAsset(assets, [name]);
  if (!asset) throw new Error(`The Sash ${version} GitHub Release has no ${name}`);
  return downloadHelper(layout, tag, asset, options.proxyUri);
}

async function currentUserSid(): Promise<string> {
  const output = await runSanitizedCommandAsync(windowsSystemExecutable("whoami.exe"), [
    "/user",
    "/fo",
    "csv",
    "/nh",
  ]);
  const sid = output.match(/"[^"]*","(S-1-[\d-]+)"/)?.[1];
  if (!sid) throw new Error("Could not read the current Windows account SID");
  return sid;
}

async function serviceRegistered(name: string): Promise<boolean> {
  try {
    await runSanitizedCommandAsync(windowsSystemExecutable("sc.exe"), ["query", name]);
    return true;
  } catch (error) {
    // ERROR_SERVICE_DOES_NOT_EXIST
    if ((error as { code?: unknown }).code === 1060) return false;
    throw error;
  }
}

export interface WindowsTunPlatformDeps {
  request?: HelperRequest;
  serviceRegistered?: (name: string) => Promise<boolean>;
}

export function windowsTunPlatform(deps: WindowsTunPlatformDeps = {}): TunPlatform {
  const request = deps.request ?? ((op, timeoutMs) => requestHelper(op, timeoutMs));
  const registered = deps.serviceRegistered ?? serviceRegistered;

  async function inspect(layout: SashLayout): Promise<TunPrivilege> {
    let reply: HelperReply;
    try {
      reply = await request("status", 5_000);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM")
        return { state: "stale", detail: "the TUN service belongs to another Windows account" };
      if (await registered(HELPER_SERVICE))
        return { state: "stale", detail: "the TUN service is installed but not running" };
      if (await registered(LEGACY_SERVICE))
        return { state: "stale", detail: "the TUN helper from Sash 0.7.0 must be replaced" };
      return { state: "missing" };
    }
    return privilegeFromReply(reply, layout);
  }

  return {
    mechanism: "service",
    inspect,
    async install(layout, options = {}) {
      const source = await resolveHelperSource(layout, options);
      try {
        const sid = await currentUserSid();
        await runElevated(
          installScript({
            source: source.file,
            sha256: source.sha256,
            arguments: serviceArguments(layout, sid),
          }),
          "install the TUN helper",
        );
      } finally {
        await source.cleanup();
      }
      let privilege: TunPrivilege = { state: "unknown" };
      for (let attempt = 0; attempt < 30; attempt += 1) {
        privilege = await inspect(layout);
        if (privilege.state === "ready") return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error(
        `The TUN service did not come up${privilege.detail ? `: ${privilege.detail}` : ""}`,
      );
    },
    async uninstall() {
      await runElevated(uninstallScript(), "remove the TUN helper");
    },
    host(layout): HostedCore {
      return {
        async start() {
          const privilege = privilegeFromReply(await request("status", 5_000), layout);
          if (privilege.state !== "ready")
            throw new Error(`The TUN service cannot start this Core: ${privilege.detail}`);
          const reply = await request("start", 30_000);
          if (!reply.ok || !reply.pid)
            throw new Error(reply.error ?? "The TUN service did not start the Core");
          return { pid: reply.pid };
        },
        async stop() {
          const reply = await request("stop", 30_000);
          if (!reply.ok) throw new Error(reply.error ?? "The TUN service did not stop the Core");
        },
        async status() {
          const reply = await request("status", 5_000);
          return { running: reply.running, pid: reply.pid ?? null };
        },
      };
    },
  };
}
