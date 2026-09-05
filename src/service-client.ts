import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ControllerEndpoint } from "./core-runtime.js";
import { pathEntryExists } from "./fs-atomic.js";
import { fetchWithRetry } from "./http.js";
import { isPlainObject } from "./json-shape.js";
import type { SashLayout } from "./paths.js";
import { buildSanitizedEnv } from "./process.js";
import { SashApiError } from "./sash-client.js";
import type { CoreState } from "./supervisor.js";

/** Native ownership observations are always definite; null is public HTTP status only. */
export type ServiceCoreState = CoreState & { running: boolean };

export interface ServiceStatus {
  protocol?: number;
  supported: boolean;
  installed?: boolean;
  running?: boolean;
  compatible?: boolean;
  version?: string;
  root?: string;
  serviceInstance?: string;
  coreVersion?: string;
  generation?: number;
  core?: ServiceCoreState;
}
export interface ActiveServiceStatus extends ServiceStatus {
  protocol: 1;
  supported: true;
  installed: true;
  running: true;
  compatible: true;
  root: string;
  serviceInstance: string;
  generation: number;
  core: ServiceCoreState;
}
export function parseServiceError(value: unknown, status = 503): SashApiError | undefined {
  if (!isPlainObject(value) || !isPlainObject(value.error)) return undefined;
  if (typeof value.error.code !== "string" || typeof value.error.message !== "string")
    return undefined;
  return new SashApiError(status, value.error.code, value.error.message);
}
export function parseServiceStatus(value: unknown): ServiceStatus {
  const error = parseServiceError(value);
  if (error) throw error;
  if (!isPlainObject(value) || typeof value.supported !== "boolean")
    throw new Error("Invalid service status");
  const s: ServiceStatus = { supported: value.supported };
  for (const key of ["installed", "running", "compatible"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "boolean") throw new Error(`Invalid service ${key}`);
      s[key] = value[key];
    }
  }
  for (const key of ["version", "root", "serviceInstance", "coreVersion"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "string") throw new Error(`Invalid service ${key}`);
      s[key] = value[key];
    }
  }
  for (const key of ["protocol", "generation"] as const) {
    const n = value[key];
    if (n !== undefined) {
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
        throw new Error(`Invalid service ${key}`);
      s[key] = n;
    }
  }
  if (
    (s.supported && s.installed === undefined) ||
    (s.installed && s.running === undefined) ||
    (!s.installed && s.running)
  )
    throw new Error("Invalid service status flags");
  if (value.core !== undefined) {
    const c = value.core;
    if (!isPlainObject(c) || typeof c.running !== "boolean") throw new Error("Invalid Core status");
    const core: ServiceCoreState = { running: c.running };
    if (c.pid !== undefined) {
      if (typeof c.pid !== "number" || !Number.isSafeInteger(c.pid) || c.pid < 1)
        throw new Error("Invalid Core PID");
      core.pid = c.pid;
    }
    for (const key of ["healthy", "tunActive"] as const) {
      if (c[key] !== undefined) {
        if (typeof c[key] !== "boolean") throw new Error(`Invalid Core ${key}`);
        core[key] = c[key];
      }
    }
    if (c.version !== undefined) {
      if (typeof c.version !== "string") throw new Error("Invalid Core version");
      core.version = c.version;
    }
    if (c.startedAt !== undefined) {
      if (
        typeof c.startedAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(c.startedAt) ||
        !Number.isFinite(Date.parse(c.startedAt))
      )
        throw new Error("Invalid Core start time");
      core.startedAt = c.startedAt;
    }
    if (
      core.running &&
      (core.pid === undefined || core.startedAt === undefined || core.healthy === undefined)
    )
      throw new Error("Incomplete running Core status");
    if (
      !core.running &&
      (core.pid !== undefined ||
        core.startedAt !== undefined ||
        core.healthy !== undefined ||
        core.tunActive !== undefined)
    )
      throw new Error("Stopped Core has running metadata");
    s.core = core;
  }
  return s;
}
export function requireActiveService(value: unknown, layout: SashLayout): ActiveServiceStatus {
  const s = parseServiceStatus(value);
  if (
    s.protocol !== 1 ||
    s.supported !== true ||
    s.installed !== true ||
    s.running !== true ||
    s.compatible !== true
  )
    throw new Error("Sash Service is unavailable or incompatible; direct fallback is forbidden");
  if (
    typeof s.root !== "string" ||
    !path.isAbsolute(s.root) ||
    s.root.toLowerCase() !== fs.realpathSync(layout.root).toLowerCase()
  )
    throw new Error("Sash Service root conflicts with SASH_HOME");
  if (!s.version || !s.coreVersion || !s.serviceInstance || s.generation === undefined || !s.core)
    throw new Error("Invalid service ownership status");
  return {
    ...s,
    protocol: 1,
    supported: true,
    installed: true,
    running: true,
    compatible: true,
    root: s.root,
    serviceInstance: s.serviceInstance,
    generation: s.generation,
    core: s.core,
  };
}
export const parseActive = requireActiveService;

/** Resolve through the kernel's SystemRoot link, never inherited environment or
 * PATH. GLOBALROOT bypasses per-user DOS device aliases. */
export function trustedWindowsSystemExecutable(relative: string): string {
  if (
    process.platform !== "win32" ||
    !relative ||
    path.win32.isAbsolute(relative) ||
    relative.split(/[\\/]/).some((part) => part === ".." || part === "." || part.includes(":"))
  )
    throw new Error("Invalid Windows system executable");
  const candidate = path.win32.join("\\\\?\\GLOBALROOT\\SystemRoot\\System32", relative);
  if (!fs.statSync(candidate).isFile())
    throw new Error("Trusted Windows system executable unavailable");
  return fs.realpathSync.native(candidate);
}
function knownProgramFiles(): string {
  // Environment.GetFolderPath uses the native known-folder API, not ProgramFiles.
  const result = spawnSync(
    trustedWindowsSystemExecutable("WindowsPowerShell\\v1.0\\powershell.exe"),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::Write([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles))",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: buildSanitizedEnv(),
      timeout: 5000,
      maxBuffer: 16384,
    },
  );
  if (result.error || result.status !== 0 || !path.win32.isAbsolute(result.stdout.trim()))
    throw new Error("Cannot resolve Windows Program Files known folder");
  return result.stdout.trim();
}
export interface ServiceDiscoveryDeps {
  platform?: NodeJS.Platform;
  findHelper?: () => string | undefined;
  runHelper?: typeof runServiceHelper;
  queryState?: () => "absent" | "running" | "unavailable";
}
export function queryServiceState(): "absent" | "running" | "unavailable" {
  // sc.exe's labels are localized. Query structured presence and the numeric
  // ServiceControllerStatus instead; command errors are never treated as absence.
  const script =
    "$ErrorActionPreference='Stop'; $s=@(Get-CimInstance Win32_Service -Filter \"Name='SashService'\"); if($s.Count -eq 0){@{present=$false}|ConvertTo-Json -Compress} elseif($s.Count -eq 1){@{present=$true;state=[int](Get-Service -Name SashService -ErrorAction Stop).Status}|ConvertTo-Json -Compress} else {throw 'Ambiguous service registration'}";
  const query = spawnSync(
    trustedWindowsSystemExecutable("WindowsPowerShell\\v1.0\\powershell.exe"),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: buildSanitizedEnv(),
      timeout: 10000,
      maxBuffer: 16384,
    },
  );
  if (query.error || query.status !== 0)
    throw new Error("Cannot establish Sash Service registration status");
  const value: unknown = JSON.parse(query.stdout);
  if (isPlainObject(value) && value.present === false && value.state === undefined) return "absent";
  if (
    isPlainObject(value) &&
    value.present === true &&
    typeof value.state === "number" &&
    Number.isInteger(value.state)
  ) {
    if (value.state === 4) return "running";
    if ([1, 2, 3, 5, 6, 7].includes(value.state)) return "unavailable";
  }
  throw new Error("Unrecognized SCM service state");
}
/** SCM is queried before considering a missing helper to mean an absent service. */
export function findServiceHelper(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const registration = queryServiceState();
  const protectedRoot = path.join(knownProgramFiles(), "SashService");
  const installed = path.join(protectedRoot, "sash-service.exe");
  if (pathEntryExists(installed) && fs.lstatSync(installed).isFile()) return installed;
  if (registration !== "absent")
    throw new Error(
      "Sash Service is registered but its protected helper is missing; administrative repair required",
    );
  if (pathEntryExists(protectedRoot))
    throw new SashApiError(
      503,
      "RECOVERY_REQUIRED",
      "Protected installation exists without its SCM registration",
    );
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  const source = fileURLToPath(
    new URL(`../.native/windows-${arch}/sash-service.exe`, import.meta.url),
  );
  return pathEntryExists(source) && fs.lstatSync(source).isFile() ? source : undefined;
}
export function runServiceHelper(
  helper: string,
  args: string[],
  timeoutMs = 15000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      helper,
      args,
      {
        encoding: "utf8",
        windowsHide: true,
        env: buildSanitizedEnv(),
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        let value: unknown;
        try {
          value = JSON.parse(stdout);
        } catch {
          reject(
            new Error(
              error
                ? `Sash Service helper failed: ${error.message}`
                : "Invalid JSON from Sash Service helper",
            ),
          );
          return;
        }
        const wire = parseServiceError(value);
        if (wire) {
          reject(wire);
          return;
        }
        if (error) {
          reject(new Error(`Sash Service helper failed: ${error.message}`));
          return;
        }
        resolve(value);
      },
    );
  });
}
export async function inspectService(
  layout: SashLayout,
  deps: ServiceDiscoveryDeps = {},
): Promise<ServiceStatus> {
  if ((deps.platform ?? process.platform) !== "win32") return { supported: false };
  const helper = (deps.findHelper ?? findServiceHelper)();
  if (!helper) return { supported: true, installed: false, running: false };
  let status: ServiceStatus;
  try {
    status = parseServiceStatus(
      await (deps.runHelper ?? runServiceHelper)(helper, [
        "status",
        "--root",
        fs.realpathSync(layout.root),
      ]),
    );
  } catch (error) {
    if (
      error instanceof SashApiError &&
      error.code === "SERVICE_UNAVAILABLE" &&
      (deps.queryState ?? queryServiceState)() === "unavailable"
    )
      return { supported: true, installed: true, running: false };
    throw error;
  }
  if (status.installed && status.running) requireActiveService(status, layout);
  return status;
}
export async function serviceRequest(
  endpoint: ControllerEndpoint,
  operation: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetchWithRetry(`http://${endpoint.controller}/sash-service/${operation}`, {
    direct: true,
    manualRedirect: true,
    attempts: 1,
    deadlineMs: 60000,
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${endpoint.secret}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text(1024 * 1024);
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error("Invalid service response JSON");
  }
  const error = parseServiceError(value, response.statusCode);
  if (error) throw error;
  if (response.statusCode < 200 || response.statusCode >= 300)
    throw new SashApiError(
      response.statusCode,
      undefined,
      `Sash Service HTTP ${response.statusCode}`,
    );
  return value;
}
