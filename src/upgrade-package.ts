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
  const probeText = await runUpgradeCommand(
    nodePath,
    [path.join(packageRoot, "dist", "upgrade-probe-entry.js")],
    { ...options, purpose: "Check prepared Sash runtime and dashboard" },
  );
  const probe: unknown = JSON.parse(probeText);
  if (
    !isPlainObject(probe) ||
    probe.version !== expectedVersion ||
    probe.upgradeProtocol !== UPGRADE_PROTOCOL ||
    probe.ui !== true ||
    typeof probe.node !== "string" ||
    !supportsNode(info, probe.node)
  )
    throw new Error("Prepared Sash package failed its startup checks");
}
