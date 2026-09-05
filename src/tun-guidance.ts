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
    context === "activation-rolled-back"
      ? ' Then enable TUN again with "sash tun on" or in the dashboard.'
      : "";
  const explanation =
    " A Core-only restart in the WebUI cannot elevate the Sash daemon. If Sash was already elevated, inspect the Core error log.";
  if (platform === "win32") {
    return `${diagnosis}Open PowerShell as Administrator and run "sash restart". If SASH_HOME was explicitly customized, set the same value in that shell first.${retry}${explanation} Use the same elevated context for later CLI operations because state files are private.`;
  }
  return `${diagnosis}Restart Sash with root privileges using the same data directory: sudo env SASH_HOME=${quotePosix(options.root)} "$(command -v sash)" restart.${retry}${explanation} Use the same elevated context and SASH_HOME for later CLI operations because state files are private.`;
}
