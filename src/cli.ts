#!/usr/bin/env node
import "./node-version-guard.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Argument, Command, CommanderError, InvalidArgumentError } from "commander";
import { withCliErrors } from "./cli-errors.js";
import { cliOutputSignal, handleCliOutputError } from "./cli-output.js";
import type { AutoMode } from "./commands/auto.js";
import type { RoutingMode } from "./commands/mode.js";
import type { ProxyAction } from "./commands/proxy.js";
import { errorMessage } from "./error-utils.js";
import { parseLogLineCount } from "./log-follow.js";

// Command modules load lazily inside each action so `sash version` / `--help`
// never pay for the network, YAML and archive modules they do not use.
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
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (!handleCliOutputError(error)) throw error;
});

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
  $ sash upgrade               upgrade Sash through npm and restart sashd
  $ sash profile list          list saved profiles
  $ sash proxy on              enable the system proxy for a running Core

Data directory: %LOCALAPPDATA%\\Sash (Windows), ~/Library/Application Support/Sash (macOS),
$XDG_DATA_HOME/sash (Linux). Override with the SASH_HOME environment variable.

Bare sash prints status. Exit codes: 0 success, 1 command failure, 2 incomplete observation.
Set SASH_DEBUG=1 to print CLI error stacks to stderr.`,
  );

program
  .command("start")
  .description("install components if needed and start sash in the background")
  .action(withCliErrors(async () => (await import("./commands/lifecycle.js")).runStart()));

program
  .command("stop")
  .description("stop sash (shuts down core and disables system proxy)")
  .option("--core", "stop Core and keep management available")
  .action(
    withCliErrors(async (opts: { core?: boolean }) =>
      (await import("./commands/lifecycle.js")).runStop(opts),
    ),
  );

program
  .command("restart")
  .description("apply saved configuration and restart the core")
  .action(withCliErrors(async () => (await import("./commands/lifecycle.js")).runRestart()));

program
  .command("auto")
  .description("inspect or set automatic startup at login for the current user")
  .addArgument(
    new Argument("[mode]", "set autostart or inspect its state").choices(["on", "off", "status"]),
  )
  .option("--json", "output machine-readable JSON")
  .action(
    withCliErrors(async (mode: AutoMode | undefined, opts: { json?: boolean }) =>
      (await import("./commands/auto.js")).runAuto(mode, undefined, opts),
    ),
  );

program
  .command("status")
  .description("show runtime state, versions, endpoints, and system proxy status")
  .option("--watch", "watch status changes until interrupted; --json emits one snapshot per line")
  .option("--delay <name>", "test an exact node or group name; --watch samples every 30 seconds")
  .option("--json", "output machine-readable JSON")
  .action(
    withCliErrors(async (opts: { json?: boolean; watch?: boolean; delay?: string }) =>
      (await import("./commands/status.js")).runStatus(opts),
    ),
  );

program
  .command("doctor")
  .description("check installation, state, Core integrity, ports and desktop integration")
  .option("--json", "output machine-readable JSON")
  .action(
    withCliErrors(async (opts: { json?: boolean }) =>
      (await import("./commands/doctor.js")).runDoctor(opts),
    ),
  );

const profile = program
  .command("profile")
  .description("manage saved profiles; sash restart applies changes")
  .action(withCliErrors(async () => (await import("./commands/profile.js")).runProfileList()));
profile
  .command("list")
  .description("list saved profiles and the saved selection")
  .option("--json", "output machine-readable JSON")
  .action(
    withCliErrors(async (opts: { json?: boolean }) =>
      (await import("./commands/profile.js")).runProfileList(opts),
    ),
  );
profile
  .command("use [profile]")
  .description("select a saved profile by ID or exact name")
  .option("--default", "select the built-in configuration")
  .option("--json", "output machine-readable JSON")
  .action(
    withCliErrors(
      async (reference: string | undefined, opts: { default?: boolean; json?: boolean }) =>
        (await import("./commands/profile.js")).runProfileUse(reference, opts),
    ),
  );
profile
  .command("add <url>")
  .description("download and save a remote profile")
  .option("--name <name>", "saved display name")
  .option("--use", "select the saved profile for the next Apply")
  .option("--json", "output machine-readable JSON")
  .action(
    withCliErrors(async (url: string, opts: { name?: string; use?: boolean; json?: boolean }) =>
      (await import("./commands/profile.js")).runProfileAdd(url, opts),
    ),
  );
profile
  .command("update [profile]")
  .description("update a profile by ID/name, or the saved selection if omitted")
  .option("--all", "update every remote profile")
  .option("--json", "output machine-readable JSON")
  .action(
    withCliErrors(async (reference: string | undefined, opts: { all?: boolean; json?: boolean }) =>
      (await import("./commands/profile.js")).runProfileUpdate(reference, opts),
    ),
  );
profile
  .command("rename <profile> <name>")
  .description("rename a saved profile by ID or exact name")
  .option("--json", "output machine-readable JSON")
  .action(
    withCliErrors(async (reference: string, name: string, opts: { json?: boolean }) =>
      (await import("./commands/profile.js")).runProfileRename(reference, name, opts),
    ),
  );
profile
  .command("remove <profile>")
  .description("remove a saved profile by ID or exact name")
  .option("--json", "output machine-readable JSON")
  .action(
    withCliErrors(async (reference: string, opts: { json?: boolean }) =>
      (await import("./commands/profile.js")).runProfileRemove(reference, opts),
    ),
  );

program
  .command("proxy")
  .description("inspect or set the system proxy")
  .addArgument(
    new Argument("[action]", "set proxy intent or inspect its state").choices([
      "on",
      "off",
      "status",
    ]),
  )
  .option("--json", "output machine-readable JSON")
  .action(
    withCliErrors(async (action: ProxyAction | undefined, opts: { json?: boolean }) =>
      (await import("./commands/proxy.js")).runProxy(action, opts),
    ),
  );
program
  .command("mode")
  .description("change the running Core routing mode")
  .addArgument(new Argument("<mode>", "runtime routing mode").choices(["rule", "global", "direct"]))
  .option("--json", "output machine-readable JSON")
  .action(
    withCliErrors(async (mode: RoutingMode, opts: { json?: boolean }) =>
      (await import("./commands/mode.js")).runMode(mode, opts),
    ),
  );

program
  .command("logs")
  .description("print runtime logs")
  .option("-n, --lines <n>", "number of lines to print", parseLines)
  .option("-f, --follow", "follow the log output")
  .option("--errors", "read the stderr log instead of stdout")
  .option("--daemon", "read sashd daemon logs instead of core logs")
  .option("--startup", "read login startup diagnostics")
  .action(
    withCliErrors(
      async (opts: {
        lines?: number;
        follow?: boolean;
        errors?: boolean;
        daemon?: boolean;
        startup?: boolean;
      }) =>
        (await import("./commands/logs.js")).runLogs({
          lines: opts.lines ?? 50,
          follow: opts.follow,
          errors: opts.errors,
          daemon: opts.daemon,
          startup: opts.startup,
        }),
    ),
  );

program
  .command("update [tag]")
  .description("upgrade the core binary")
  .option("--check", "check the Core release without installing or starting management")
  .option("--json", "output machine-readable JSON")
  .action(
    withCliErrors(async (tag: string | undefined, opts: { check?: boolean; json?: boolean }) =>
      (await import("./commands/update.js")).runUpdate({ ...opts, version: tag }),
    ),
  );

program
  .command("upgrade [version]")
  .description("upgrade Sash through npm and restart the management daemon")
  .option("--check", "check Sash version and compatibility without changing anything")
  .option("--json", "output machine-readable JSON")
  .action(
    withCliErrors(async (version: string | undefined, opts: { check?: boolean; json?: boolean }) =>
      (await import("./commands/upgrade.js")).runUpgrade(version, opts),
    ),
  );

program
  .command("web")
  .description("open the web dashboard without starting the core")
  .option("--no-open", "print the URL without opening a browser")
  .action(
    withCliErrors(async (opts: { open: boolean }) =>
      (await import("./commands/web.js")).runWeb({ noOpen: !opts.open }),
    ),
  );

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
    throw new InvalidArgumentError(errorMessage(err));
  }
}

async function main(): Promise<void> {
  try {
    // Bare `sash` is `sash status`.
    if (process.argv.length <= 2) {
      await withCliErrors(async () => (await import("./commands/status.js")).runStatus())();
      return;
    }
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
if (cliOutputSignal.aborted) process.exitCode = 0;
