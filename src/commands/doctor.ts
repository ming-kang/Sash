import { commandOutput } from "../cli-output.js";
import { diagnoseSash } from "../doctor.js";

export async function runDoctor(options: { json?: boolean } = {}): Promise<void> {
  await commandOutput(
    options.json,
    async () => {
      const result = await diagnoseSash();
      process.exitCode = result.checks.some((check) => check.status === "error")
        ? 1
        : result.complete
          ? 0
          : 2;
      return result;
    },
    (result) => {
      for (const check of result.checks) {
        process.stdout.write(`[${check.status}] ${check.id}: ${check.message}\n`);
        if (check.advice) process.stdout.write(`  ${check.advice}\n`);
      }
    },
  );
}
