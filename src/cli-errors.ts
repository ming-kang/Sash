import { errorMessage, errorPresentation } from "./error-utils.js";
import { log } from "./log.js";

export function formatCliError(error: unknown): string {
  const presentation = errorPresentation(error);
  const message = presentation?.message ?? errorMessage(error);
  return presentation?.advice ? `${message}\n${presentation.advice}` : message;
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
