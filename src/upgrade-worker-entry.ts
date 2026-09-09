import "./node-version-guard.js";
import http from "node:http";
import semver from "semver";
import { errorMessage } from "./error-utils.js";
import { fetchWithRetry } from "./http.js";
import { canonicalPath, inspectInstallation, npmPackageRoot } from "./installation.js";
import { isPlainObject } from "./json-shape.js";
import {
  exactSashVersion,
  readSashPackageInfo,
  supportsNode,
  UPGRADE_PROTOCOL,
} from "./package-info.js";
import { createSashUpgradeJournal } from "./self-upgrade.js";
import { withStateLock } from "./state-lock.js";
import { cleanCompletedUpgradeArtifacts } from "./upgrade-garbage.js";
import { readUpgradeJournal } from "./upgrade-journal.js";
import { resolveSashNpmTarget } from "./upgrade-npm.js";
import { upgradePaths } from "./upgrade-paths.js";
import { SashUpgradeTransaction, type UpgradeResult } from "./upgrade-transaction.js";

function renderResult(result: UpgradeResult, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else if (result.outcome === "upgraded")
    process.stdout.write(
      `Sash upgraded from ${result.from} to ${result.version}; restored ${result.instances} instance(s).\n`,
    );
  else if (result.outcome === "recovered")
    process.stdout.write(
      `Recovered the interrupted upgrade. Sash ${result.version} is installed; ${result.instances} instance(s) settled.\n`,
    );
  else
    process.stderr.write(
      `Sash upgrade failed: ${result.error ?? "unknown error"}${result.recoveryRequired ? "\nRun sash upgrade to retry recovery; installation and runtime handoffs were preserved." : `\nSash ${result.version} and its runtime state were preserved.`}\n`,
    );
  process.exitCode = result.outcome === "failed" ? 1 : 0;
}

async function selfTest(): Promise<void> {
  const server = http.createServer((_req, res) => res.end("independent"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object")
    throw new Error("Worker self-test did not bind loopback");
  try {
    const response = await fetchWithRetry(`http://127.0.0.1:${address.port}`, {
      direct: true,
      manualRedirect: true,
      attempts: 1,
    });
    if ((await response.text(128)) !== "independent")
      throw new Error("Worker transport self-test failed");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  process.stdout.write(`${JSON.stringify({ upgradeProtocol: UPGRADE_PROTOCOL })}\n`);
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const stages: Record<string, string> = {
  preparing: "Preparing recovery files",
  downloading: "Downloading Sash",
  dependencies: "Installing dependencies",
  "dependency-check": "Checking installed dependencies",
  "candidate-check": "Checking the new CLI and dashboard",
  prepared: "New version is ready",
  reserving: "Waiting for running operations to finish",
  stopping: "Stopping running instances",
  activating: "Installing Sash",
  restoring: "Restoring running instances",
  committed: "Upgrade verified",
  "rolling-back": "Restoring the previous version",
  "rolled-back": "Previous version restored",
  cancelled: "Upgrade cancelled",
  "commit-cleanup": "Cleaning recovery files",
  "rollback-cleanup": "Cleaning recovery files",
  "cancel-cleanup": "Cleaning preparation files",
};
let currentStage = "";
let lastOutput = 0;
const progressTimer = setInterval(() => {
  if (!json && currentStage && Date.now() - lastOutput >= 15_000) {
    process.stderr.write(`[sash upgrade] ${currentStage}…\n`);
    lastOutput = Date.now();
  }
}, 15_000).unref();
const cancellation = new AbortController();
const cancel = (): void => cancellation.abort(new Error("Sash upgrade cancelled"));
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
process.on("message", (value: unknown) => {
  if (isPlainObject(value) && value.type === "cancel") cancel();
});
try {
  if (args[0] === "--self-test") await selfTest();
  else {
    if (!["--begin", "--recover", "--check"].includes(args[0] ?? "") || !args[1])
      throw new Error("Invalid Sash upgrade worker invocation");
    const prefix = canonicalPath(args[1]);
    if (args[0] === "--check") {
      const journal = readUpgradeJournal(prefix);
      if (json)
        process.stdout.write(
          `${JSON.stringify({ pending: journal ? { from: journal.sourceVersion, target: journal.targetVersion, phase: journal.phase } : null })}\n`,
        );
      else
        process.stdout.write(
          journal
            ? `Sash upgrade ${journal.sourceVersion} → ${journal.targetVersion} is pending (${journal.phase}). Run sash upgrade to recover.\n`
            : "No Sash upgrade is pending.\n",
        );
    } else {
      await withStateLock(
        upgradePaths(prefix).lock,
        { purpose: "upgrade Sash installation", timeoutMs: 0 },
        async () => {
          const pending = readUpgradeJournal(prefix);
          const options = {
            signal: cancellation.signal,
            onStage: (stage: string) => {
              currentStage = stages[stage] ?? stage;
              lastOutput = Date.now();
              if (!json) process.stderr.write(`[sash upgrade] ${currentStage}\n`);
            },
            onDownload: (downloaded: number, total?: number) => {
              if (json || (Date.now() - lastOutput < 1000 && downloaded !== total)) return;
              lastOutput = Date.now();
              process.stderr.write(
                `[sash upgrade] Downloaded ${(downloaded / 1048576).toFixed(1)}${total ? ` / ${(total / 1048576).toFixed(1)}` : ""} MB\n`,
              );
            },
          };
          if (pending) {
            renderResult(await new SashUpgradeTransaction(pending, options).recover(), json);
            return;
          }
          const installation = inspectInstallation({ packageRoot: npmPackageRoot(prefix) });
          if (installation.kind !== "npm-global") throw new Error(installation.reason);
          const current = readSashPackageInfo(installation.packageRoot);
          const cleaned = await cleanCompletedUpgradeArtifacts(installation);
          if (args[0] === "--recover") {
            if (!cleaned) throw new Error("No Sash upgrade transaction is available to recover");
            renderResult(
              {
                outcome: "recovered",
                from: current.version,
                target: current.version,
                version: current.version,
                instances: 0,
                recoveryRequired: false,
              },
              json,
            );
            return;
          }
          const targetIndex = args.indexOf("--target");
          const explicit = targetIndex >= 0 ? exactSashVersion(args[targetIndex + 1]) : undefined;
          const target = await resolveSashNpmTarget(explicit, cancellation.signal);
          if (
            target.version === current.version ||
            (explicit === undefined && semver.lte(target.version, current.version))
          ) {
            if (json)
              process.stdout.write(
                `${JSON.stringify({ outcome: "current", version: current.version, target: target.version })}\n`,
              );
            else process.stdout.write(`Sash ${current.version} is already current.\n`);
            return;
          }
          if (!supportsNode(current) || !supportsNode(target))
            throw new Error(
              `Current Node ${process.version} must support both Sash ${current.version} (${current.nodeRange}) and ${target.version} (${target.nodeRange})`,
            );
          if (
            current.upgradeProtocol !== UPGRADE_PROTOCOL ||
            target.upgradeProtocol !== UPGRADE_PROTOCOL
          )
            throw new Error(
              "Sash source and target must support the same recoverable upgrade protocol",
            );
          const journal = createSashUpgradeJournal(installation, target.version);
          renderResult(await new SashUpgradeTransaction(journal, options).run(target), json);
        },
      );
    }
  }
} catch (error) {
  if (json)
    process.stdout.write(`${JSON.stringify({ outcome: "failed", error: errorMessage(error) })}\n`);
  else process.stderr.write(`Sash upgrade: ${errorMessage(error)}\n`);
  process.exitCode = 1;
} finally {
  clearInterval(progressTimer);
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
  if (process.connected) process.disconnect();
}
