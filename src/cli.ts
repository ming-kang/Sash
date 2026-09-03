#!/usr/bin/env node
import "./node-version-guard.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { withCliErrors } from "./cli-errors.js";
import { runRestart, runStart, runStop } from "./commands/lifecycle.js";
import { runLogs } from "./commands/logs.js";
import { runStatus } from "./commands/status.js";
import { runUpdate } from "./commands/update.js";
import { runUpgrade } from "./commands/upgrade.js";
import { runWeb } from "./commands/web.js";
import { parseLogLineCount } from "./log-follow.js";

function packageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const program = new Command();

program
  .name("sash")
  .description(
    "A lightweight command-line companion for a rule-based network core and its web dashboard.",
  )
  .version(packageVersion(), "-v, --version", "print the Sash version")
  .enablePositionalOptions()
  .exitOverride()
  .addHelpText(
    "after",
    `
Examples:
  $ sash start                 install components if needed and launch sash in the background
  $ sash web                   open the web dashboard
  $ sash status                show runtime state, endpoints, and system proxy status
  $ sash update                upgrade the core binary
  $ sash upgrade               upgrade Sash itself via npm

Data directory: %LOCALAPPDATA%\\Sash (Windows), ~/Library/Application Support/Sash (macOS),
$XDG_DATA_HOME/sash (Linux). Override with the SASH_HOME environment variable.`,
  );

program
  .command("start")
  .description("install components if needed and start sash in the background")
  .action(withCliErrors(() => runStart()));

program
  .command("stop")
  .description("stop sash (shuts down core and disables system proxy)")
  .action(withCliErrors(() => runStop()));

program
  .command("restart")
  .description("restart the daemon and core")
  .action(withCliErrors(() => runRestart()));

program
  .command("status")
  .description("show runtime state, versions, endpoints, and system proxy status")
  .option("--json", "output machine-readable JSON")
  .action(withCliErrors((opts: { json?: boolean }) => runStatus(opts)));

program
  .command("logs")
  .description("print runtime logs")
  .option("-n, --lines <n>", "number of lines to print", parseLines)
  .option("-f, --follow", "follow the log output")
  .option("--errors", "read the stderr log instead of stdout")
  .option("--daemon", "read sashd daemon logs instead of core logs")
  .action(
    withCliErrors(
      (opts: { lines?: number; follow?: boolean; errors?: boolean; daemon?: boolean }) =>
        runLogs({
          lines: opts.lines ?? 50,
          follow: opts.follow,
          errors: opts.errors,
          daemon: opts.daemon,
        }),
    ),
  );

program
  .command("update")
  .description("upgrade the core binary")
  .option("--version <tag>", "install a specific core version, e.g. v1.19.30")
  .option("--force", "reinstall the target version and repair inconsistent Core state")
  .action(withCliErrors((opts: { version?: string; force?: boolean }) => runUpdate(opts)));

program
  .command("upgrade")
  .description("upgrade Sash itself via npm")
  .option("--version <version>", "install a specific Sash version")
  .action(withCliErrors((opts: { version?: string }) => runUpgrade(opts)));

program
  .command("web")
  .description("open the web dashboard (installs/starts components as needed)")
  .option("--no-open", "print the URL without opening a browser")
  .action(withCliErrors((opts: { open: boolean }) => runWeb({ noOpen: !opts.open })));

program
  .command("version")
  .description("print the Sash version")
  .action(() => {
    console.log(packageVersion());
  });

function parseLines(value: string): number {
  try {
    return parseLogLineCount(value);
  } catch (err) {
    throw new InvalidArgumentError(err instanceof Error ? err.message : String(err));
  }
}

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      process.exitCode =
        err.exitCode === 0 || err.code === "commander.helpDisplayed" ? 0 : err.exitCode;
      if (err.code === "commander.unknownCommand" || err.code === "commander.unknownOption") {
        process.exitCode = 1;
      }
      return;
    }
    throw err;
  }
}

await main();
