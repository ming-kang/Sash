/** Uniform CLI error presentation for command actions. */
export function withCliErrors<Args extends unknown[]>(
  fn: (...args: Args) => Promise<void> | void,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(`[sash] ✗ ${err instanceof Error ? err.message : String(err)}`);
      if (process.env.DEBUG === "1" || process.env.DEBUG === "true") {
        if (err instanceof Error && err.stack) console.error(err.stack);
      }
      process.exitCode = 1;
    }
  };
}
