export type TunPrivilegeContext = "activation-rolled-back" | "runtime-inactive";

export interface TunPrivilegeGuidanceOptions {
  platform?: NodeJS.Platform;
  root: string;
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function tunPrivilegeGuidance(
  context: TunPrivilegeContext,
  options: TunPrivilegeGuidanceOptions,
): string {
  const platform = options.platform ?? process.platform;
  // An elevated `sash restart` replaces sashd with an elevated instance, so
  // the stop/start choreography is no longer needed.
  const prepare =
    context === "activation-rolled-back" ? 'Run "sash config set tun on" first. ' : "";
  if (platform === "win32") {
    return `${prepare}Open PowerShell as Administrator and run "sash restart". If SASH_HOME was explicitly customized, set the same value in that shell first. If Sash was already elevated, inspect the Core error log.`;
  }
  return `${prepare}Restart Sash with root privileges using the same data directory: sudo env SASH_HOME=${quotePosix(options.root)} "$(command -v sash)" restart. If Sash was already elevated, inspect the Core error log.`;
}
