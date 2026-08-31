/* Tiny console logger with consistent prefixes. No colors to stay pipe-safe. */

export const log = {
  info(msg: string): void {
    console.log(`[sash] ${msg}`);
  },
  ok(msg: string): void {
    console.log(`[sash] ✓ ${msg}`);
  },
  warn(msg: string): void {
    console.warn(`[sash] ! ${msg}`);
  },
  error(msg: string): void {
    console.error(`[sash] ✗ ${msg}`);
  },
  /** Key-value line used by status-like commands. */
  kv(key: string, value: string): void {
    console.log(`  ${key.padEnd(16)}${value}`);
  },
};
