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
  const prepare =
    context === "activation-rolled-back"
      ? 'Run "sash stop" and "sash config set tun on", then '
      : 'Run "sash stop", then ';
  if (platform === "win32") {
    return `${prepare}open PowerShell as Administrator and run "sash start". If SASH_HOME was explicitly customized, set the same value in that shell first. "sash restart" alone does not elevate sashd. If Sash was already elevated, inspect the Core error log.`;
  }
  return `${prepare}start Sash with root privileges using the same data directory: sudo env SASH_HOME=${quotePosix(options.root)} "$(command -v sash)" start. "sash restart" alone does not elevate sashd. If Sash was already elevated, inspect the Core error log.`;
}
