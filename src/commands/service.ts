import { sashLayout } from "../paths.js";
import { installService, serviceStatus, uninstallService } from "../service-management.js";
import { runtimeContext } from "./shared.js";

export interface ServiceCommandDeps {
  platform?: NodeJS.Platform;
  installService?: typeof installService;
  serviceStatus?: typeof serviceStatus;
  uninstallService?: typeof uninstallService;
}

export async function runServiceInstall(
  opts: { coreVersion?: string; helper?: string } = {},
  deps: ServiceCommandDeps = {},
): Promise<void> {
  await (deps.installService ?? installService)(serviceRuntimeContext(deps), {
    ...(opts.coreVersion !== undefined ? { coreVersion: opts.coreVersion } : {}),
    ...(opts.helper !== undefined ? { helperPath: opts.helper } : {}),
  });
  console.log(
    'Service installed. In an ordinary PowerShell with the same SASH_HOME, run "sash start", then enable TUN in the dashboard. The user daemon does not need Administrator privileges.',
  );
}

export async function runServiceStatus(
  opts: { json?: boolean } = {},
  deps: ServiceCommandDeps = {},
): Promise<void> {
  const status = await (deps.serviceStatus ?? serviceStatus)(sashLayout());
  if (opts.json) console.log(JSON.stringify(status, null, 2));
  else {
    console.log(
      status.supported ? `Service: ${status.state}` : "Service: unsupported on this platform",
    );
    if (status.version) console.log(`Service version: ${status.version}`);
    if (status.coreVersion) console.log(`Core version: ${status.coreVersion}`);
    if (status.message) console.log(status.message);
  }
}

export async function runServiceUninstall(deps: ServiceCommandDeps = {}): Promise<void> {
  await (deps.uninstallService ?? uninstallService)(serviceRuntimeContext(deps));
}

function serviceRuntimeContext(deps: ServiceCommandDeps) {
  if ((deps.platform ?? process.platform) !== "win32") {
    throw new Error("Sash Service management is supported only on Windows.");
  }
  return runtimeContext({ existingRootOnly: true });
}
