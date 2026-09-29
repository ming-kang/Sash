import { errorMessage } from "./error-utils.js";
import { log } from "./log.js";

/** Display-only translations. Error messages carried by JSON remain unchanged. */
export function formatCliError(error: unknown): string {
  const message = errorMessage(error);
  if (message === "on" || message === "off") return message === "on" ? "On" : "Off";
  const proxyStillOn = /^off — Windows is still set( to .+)?; run sash proxy off$/.exec(message);
  if (proxyStillOn)
    return `Windows system proxy is On${proxyStillOn[1] ?? ""}; Sash is configured Off.\nRun sash proxy status for details.`;
  const missing = /^Profile (.+) was not found — run sash profile list$/.exec(message);
  if (missing)
    return `Profile ${missing[1]} was not found.\nRun sash profile list to see saved profiles.`;
  const ambiguous = /^Profile name (.+) is ambiguous — use its ID from sash profile list$/.exec(
    message,
  );
  if (ambiguous)
    return `More than one profile is named ${ambiguous[1]}.\nUse an ID from sash profile list.`;
  const rejectedConfig =
    /^Core rejected (?:generated configuration|the configuration reload): ([\s\S]+)$/.exec(message);
  if (rejectedConfig)
    return `Core rejected the configuration: ${rejectedConfig[1]}\nFix the profile in WebUI and apply it again.`;
  const messages: Record<string, string> = {
    "on — not applied to Windows yet; run sash proxy on":
      "Windows system proxy is Off; Sash is configured On.\nRun sash proxy on to apply it.",
    "No profile is selected — name one from sash profile list or pass --all":
      "No profile is selected.\nSpecify a profile or use --all.",
    "Specify one profile ID/name or --default":
      "Specify a profile or --default.\nRun sash profile use --help for examples.",
    "Use a profile ID/name or --all, not both":
      "Specify a profile or --all, not both.\nRun sash profile update --help for examples.",
    "--cancel checks nothing; drop --check to cancel a download":
      "--check and --cancel cannot be used together.\nUse sash update --check or sash update --cancel.",
    "Local profile has no URL to update from":
      "Local profiles have no subscription URL to update from.\nEdit the profile in WebUI or add a remote subscription.",
    "Profile changed since the editor opened; reload before saving":
      "The profile changed while you were editing it.\nReload the profile and try again.",
    "Saved configuration changed during preparation; retry Apply":
      "The saved configuration changed during preparation.\nRun sash restart to apply the current configuration.",
    "Cannot enable system proxy: Core is not healthy":
      "Core is not healthy. System proxy was not enabled.\nRun sash doctor for details.",
    "Cannot verify the running Sash — run sash doctor to diagnose":
      "Sash is not responding or its ownership could not be verified.\nRun sash logs --daemon --errors, then sash doctor.",
    "--startup cannot be combined with --daemon or --errors":
      "--startup cannot be combined with --daemon or --errors.\nUse sash logs --startup to read login startup logs.",
  };
  return messages[message] ?? message.replace(/ — run (sash[^\n]*)$/, ".\nRun $1");
}

export function withCliErrors<Args extends unknown[]>(
  fn: (...args: Args) => Promise<void> | void,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    try {
      await fn(...args);
    } catch (err) {
      log.error(formatCliError(err));
      writeCliDebug(err);
      process.exitCode = 1;
    }
  };
}

export function writeCliDebug(error: unknown): void {
  if (
    (process.env.SASH_DEBUG === "1" || process.env.SASH_DEBUG === "true") &&
    error instanceof Error &&
    error.stack
  )
    console.error(error.stack);
}
