import { writeCliDebug } from "./cli-errors.js";
import { type CoreUpdateProgressPrinter, coreUpdateProgressText } from "./core-update.js";
import { errorMessage } from "./error-utils.js";

const outputClosed = new AbortController();
export const cliOutputSignal = outputClosed.signal;

export function handleCliOutputError(error: NodeJS.ErrnoException): boolean {
  if (error.code !== "EPIPE" && !outputClosed.signal.aborted) return false;
  outputClosed.abort(error);
  process.exitCode = 0;
  return true;
}

export async function commandOutput<T>(
  json: boolean | undefined,
  action: () => T | Promise<T>,
  render: (result: T) => void,
): Promise<void> {
  try {
    const result = await action();
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else render(result);
  } catch (error) {
    if (!json) throw error;
    process.stdout.write(`${JSON.stringify({ error: errorMessage(error) })}\n`);
    writeCliDebug(error);
    process.exitCode = 1;
  }
}

export function coreUpdateProgressPrinter(): CoreUpdateProgressPrinter {
  const interactive = process.stderr.isTTY === true;
  let previous = "";
  let pending = false;
  return {
    onProgress(progress) {
      const text = coreUpdateProgressText(progress);
      if (text === previous) return;
      previous = text;
      pending = true;
      process.stderr.write(interactive ? `\r\x1b[K[sash] ${text}` : `[sash] ${text}\n`);
    },
    settle() {
      if (!pending) return;
      pending = false;
      if (interactive) process.stderr.write("\n");
    },
  };
}
