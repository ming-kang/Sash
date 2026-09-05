export type TunPrivilegeContext = "activation-rolled-back" | "runtime-inactive";

export interface TunPrivilegeGuidanceOptions {
  platform?: NodeJS.Platform;
  root: string;
  observation?: "inactive" | "unverified";
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function tunPrivilegeGuidance(
  context: TunPrivilegeContext,
  options: TunPrivilegeGuidanceOptions,
): string {
  const platform = options.platform ?? process.platform;
  const diagnosis =
    options.observation === "unverified"
      ? "An unknown observation does not establish a privilege failure; inspect the Core error log and controller connectivity. "
      : "";
  const retry =
    context === "activation-rolled-back" ? " Then enable TUN again in the dashboard." : "";
  const explanation =
    " A Core-only restart in the WebUI cannot elevate the Sash daemon. If Sash was already elevated, inspect the Core error log.";
  if (platform === "win32") {
    return `${diagnosis}Open PowerShell as Administrator and run "sash service install". If SASH_HOME was explicitly customized, set the same value in that shell first. Then run "sash start" in an ordinary PowerShell with the same SASH_HOME.${retry} The service owns privileged Core children; keep the user daemon unprivileged. If the service is installed, inspect "sash service status" and the Core error log; do not fall back to an elevated Sash daemon.`;
  }
  return `${diagnosis}Restart Sash with root privileges using the same data directory: sudo env SASH_HOME=${quotePosix(options.root)} "$(command -v sash)" restart.${retry}${explanation} Use the same elevated context and SASH_HOME for later CLI operations because state files are private.`;
}
