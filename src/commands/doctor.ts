import { formatCliError } from "../cli-errors.js";
import { commandOutput } from "../cli-output.js";
import { diagnoseSash } from "../doctor.js";
import { log } from "../log.js";

/** Human names for the machine-readable check ids that stay in `doctor --json`. */
const CHECK_LABELS: Record<string, string> = {
  installation: "Installation",
  node: "Node",
  dashboard: "WebUI",
  manifest: "Settings",
  core: "Core",
  runtime: "Runtime",
  "runtime-manifest": "Runtime Settings",
  proxy: "System Proxy",
  autostart: "Auto Start",
  "daemon-port": "Local API Port",
  "controller-port": "Core Controller Port",
  "mixed-port": "Proxy Port",
  "proxy-connections": "Windows Connections",
  "sash-version": "Sash Version",
  geodata: "Geodata",
  network: "Network",
  "login-start": "Last Login Start",
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
      const rows = [["Check", "Result", "Details"]];
      const labels = { ok: "OK", info: "Info", warning: "Warning", error: "Error" };
      for (const check of result.checks) {
        const [message, ...details] = formatCliError(check.message).split("\n");
        rows.push([CHECK_LABELS[check.id] ?? check.id, labels[check.status], message ?? ""]);
        for (const detail of details) rows.push(["", "", detail]);
        if (check.advice) rows.push(["", "", check.advice]);
      }
      log.table(rows);
      const errors = result.checks.filter((check) => check.status === "error").length;
      const warnings = result.checks.filter((check) => check.status === "warning").length;
      log.info("");
      log.table([
        [
          "Result",
          `${errors} ${errors === 1 ? "error" : "errors"} · ${warnings} ${warnings === 1 ? "warning" : "warnings"}`,
        ],
      ]);
    },
  );
}
