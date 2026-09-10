import { commandOutput } from "../cli-output.js";
import { diagnoseSash } from "../doctor.js";

/** Human names for the machine-readable check ids that stay in `doctor --json`. */
const CHECK_LABELS: Record<string, string> = {
  installation: "Installation",
  node: "Node",
  dashboard: "Dashboard",
  manifest: "Settings",
  core: "Core",
  runtime: "Runtime",
  "runtime-manifest": "Runtime settings",
  proxy: "System proxy",
  autostart: "Start at login",
  "daemon-port": "Sash API port",
  "controller-port": "Core controller port",
  "mixed-port": "Proxy port",
  "proxy-connections": "Windows connections",
};

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
        process.stdout.write(
          `[${check.status}] ${CHECK_LABELS[check.id] ?? check.id} — ${check.message}\n`,
        );
        if (check.advice) process.stdout.write(`  ${check.advice}\n`);
      }
    },
  );
}
