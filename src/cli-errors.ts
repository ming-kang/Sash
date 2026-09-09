/** Uniform CLI error presentation for command actions. */
export function withCliErrors<Args extends unknown[]>(
  fn: (...args: Args) => Promise<void> | void,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(`[sash] ✗ ${err instanceof Error ? err.message : String(err)}`);
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
