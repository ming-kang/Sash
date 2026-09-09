import path from "node:path";
import { isPlainObject } from "./json-shape.js";
import { readSashPackageInfo, supportsNode, UPGRADE_PROTOCOL } from "./package-info.js";
import { runUpgradeCommand, upgradeChildEnv } from "./upgrade-command.js";

export async function verifyUpgradePackage(
  packageRoot: string,
  expectedVersion: string,
  nodePath: string,
  dataDir: string,
  signal?: AbortSignal,
): Promise<void> {
  const info = readSashPackageInfo(packageRoot);
  if (info.version !== expectedVersion || info.upgradeProtocol !== UPGRADE_PROTOCOL)
    throw new Error(
      "Prepared Sash package identity or upgrade protocol differs from the requested version",
    );
  const options = {
    cwd: packageRoot,
    env: { ...upgradeChildEnv(), SASH_HOME: dataDir },
    signal,
    timeoutMs: 30_000,
  };
  const checks = await Promise.allSettled([
    runUpgradeCommand(nodePath, [path.join(packageRoot, "dist", "cli.js"), "--version"], {
      ...options,
      purpose: "Verify Sash CLI version",
    }),
    runUpgradeCommand(nodePath, [path.join(packageRoot, "dist", "cli.js"), "--help"], {
      ...options,
      purpose: "Verify Sash CLI startup",
    }),
    runUpgradeCommand(nodePath, [path.join(packageRoot, "dist", "upgrade-probe-entry.js")], {
      ...options,
      purpose: "Verify Sash runtime and dashboard",
    }),
    runUpgradeCommand(
      nodePath,
      [path.join(packageRoot, "dist", "upgrade-worker.mjs"), "--self-test"],
      {
        ...options,
        purpose: "Verify the new Sash recovery worker",
      },
    ),
  ]);
  // A failed probe must not leave siblings using a package that cleanup is about to remove.
  const checked = (result: PromiseSettledResult<string>): string => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  };
  const version = checked(checks[0]);
  const help = checked(checks[1]);
  const probeText = checked(checks[2]);
  const workerText = checked(checks[3]);
  const probe: unknown = JSON.parse(probeText);
  const worker: unknown = JSON.parse(workerText);
  if (
    version.trim() !== expectedVersion ||
    !/Usage:\s+sash/.test(help) ||
    !isPlainObject(probe) ||
    probe.version !== expectedVersion ||
    probe.upgradeProtocol !== UPGRADE_PROTOCOL ||
    probe.ui !== true ||
    typeof probe.node !== "string" ||
    !supportsNode(info, probe.node) ||
    !isPlainObject(worker) ||
    worker.upgradeProtocol !== UPGRADE_PROTOCOL
  )
    throw new Error("Prepared Sash package failed its startup checks");
}
