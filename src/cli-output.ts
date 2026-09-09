import { errorMessage } from "./error-utils.js";

/** Keep machine output as a single JSON result, including command failures. */
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
    process.exitCode = 1;
  }
}
