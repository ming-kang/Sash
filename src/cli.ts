#!/usr/bin/env node
import "./node-version-guard.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Argument, Command, CommanderError, InvalidArgumentError } from "commander";
import { withCliErrors } from "./cli-errors.js";
import { cliOutputSignal, handleCliOutputError } from "./cli-output.js";
import type { AutoMode } from "./commands/auto.js";
import type { ProxyAction } from "./commands/proxy.js";
import type { RoutingMode } from "./contracts.js";
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
  .description("A network toolbox for developers, learning and research.")
  .version(packageVersion(), "-v, --version", "Show the Sash version")
  .enablePositionalOptions()
  .exitOverride()
  .configureOutput({ outputError: (text, write) => write(text.replace(/^error:/, "Error:")) })
  .configureHelp({
    subcommandDescription: (command) => command.summary() || command.description(),
    subcommandTerm: (command) =>
      [
        command.name(),
        ...command.registeredArguments.map((argument) =>
          argument.required ? `<${argument.name()}>` : `[${argument.name()}]`,
        ),
      ].join(" "),
  })
  .addHelpText(
    "after",
    `
Examples:
  sash                 Show status
  sash start           Start Sash and Core
  sash web             Open an authorized WebUI session
  sash logs -f         Follow Core logs

Run sash <command> --help for details.`,
  );

program
  .command("start")
  .description("Start Sash and Core. Install Core if needed.")
  .action(withCliErrors(async () => (await import("./commands/lifecycle.js")).runStart()));

program
  .command("stop")
  .description("Restore the previous system proxy settings, then stop Sash and Core.")
  .option("--core", "Stop Core only; keep Sash and WebUI running")
  .action(
    withCliErrors(async (opts: { core?: boolean }) =>
      (await import("./commands/lifecycle.js")).runStop(opts),
    ),
  );

program
  .command("restart")
  .description("Apply the saved configuration to Core.")
  .action(withCliErrors(async () => (await import("./commands/lifecycle.js")).runRestart()));

program
  .command("auto")
  .description("Show or change whether Sash starts at login.")
  .addArgument(
    new Argument("[mode]", "Start at login (default: status)").choices(["on", "off", "status"]),
  )
  .option("--json", "Output JSON")
  .action(
    withCliErrors(async (mode: AutoMode | undefined, opts: { json?: boolean }) =>
      (await import("./commands/auto.js")).runAuto(mode, undefined, opts),
    ),
  );

program
  .command("status")
  .option("--verbose", "Show profile, versions, download transport and paths")
  .description("Show Sash, Core and system proxy status.")
  .option("--watch", "Watch status changes")
  .option("--delay <name>", "Test latency for a node or group")
  .option("--json", "Output JSON")
  .action(
    withCliErrors(
      async (opts: { json?: boolean; watch?: boolean; delay?: string; verbose?: boolean }) =>
        (await import("./commands/status.js")).runStatus(opts),
    ),
  );

program
  .command("doctor")
  .description("Diagnose installation, runtime, ports and Windows integration.")
  .option("--json", "Output JSON")
  .action(
    withCliErrors(async (opts: { json?: boolean }) =>
      (await import("./commands/doctor.js")).runDoctor(opts),
    ),
  );

const profile = program
  .command("profile")
  .description("Manage saved profiles. With no command, list profiles.")
  .action(withCliErrors(async () => (await import("./commands/profile.js")).runProfileList()));
profile
  .command("list")
  .description("List saved profiles and the selected profile.")
  .option("--json", "Output JSON")
  .action(
    withCliErrors(async (opts: { json?: boolean }) =>
      (await import("./commands/profile.js")).runProfileList(opts),
    ),
  );
profile
  .command("use [profile]")
  .description("Select a saved profile by ID or exact name.")
  .option("--default", "Select the built-in configuration")
  .option("--json", "Output JSON")
  .action(
    withCliErrors(
      async (reference: string | undefined, opts: { default?: boolean; json?: boolean }) =>
        (await import("./commands/profile.js")).runProfileUse(reference, opts),
    ),
  );
profile
  .command("add <url>")
  .description("Download and save a remote profile.")
  .option("--name <name>", "Set the profile name")
  .option("--use", "Select the profile after saving")
  .option("--json", "Output JSON")
  .action(
    withCliErrors(async (url: string, opts: { name?: string; use?: boolean; json?: boolean }) =>
      (await import("./commands/profile.js")).runProfileAdd(url, opts),
    ),
  );
profile
  .command("update [profile]")
  .description(
    "Refresh a remote profile by ID or exact name. With no profile, refresh the selected profile.",
  )
  .option("--all", "Refresh all remote profiles")
  .option("--json", "Output JSON")
  .action(
    withCliErrors(async (reference: string | undefined, opts: { all?: boolean; json?: boolean }) =>
      (await import("./commands/profile.js")).runProfileUpdate(reference, opts),
    ),
  );
profile
  .command("rename <profile> <name>")
  .description("Rename a saved profile by ID or exact name.")
  .option("--json", "Output JSON")
  .action(
    withCliErrors(async (reference: string, name: string, opts: { json?: boolean }) =>
      (await import("./commands/profile.js")).runProfileRename(reference, name, opts),
    ),
  );
profile
  .command("remove <profile>")
  .description("Remove a saved profile by ID or exact name.")
  .option("--json", "Output JSON")
  .action(
    withCliErrors(async (reference: string, opts: { json?: boolean }) =>
      (await import("./commands/profile.js")).runProfileRemove(reference, opts),
    ),
  );

program
  .command("proxy")
  .description("Show or change the system proxy setting.")
  .addArgument(
    new Argument("[action]", "System proxy action (default: status)").choices([
      "on",
      "off",
      "status",
    ]),
  )
  .option("--json", "Output JSON")
  .action(
    withCliErrors(async (action: ProxyAction | undefined, opts: { json?: boolean }) =>
      (await import("./commands/proxy.js")).runProxy(action, opts),
    ),
  );
program
  .command("mode")
  .description("Set the running Core routing mode.")
  .addArgument(new Argument("<mode>", "Routing mode").choices(["rule", "global", "direct"]))
  .option("--json", "Output JSON")
  .action(
    withCliErrors(async (mode: RoutingMode, opts: { json?: boolean }) =>
      (await import("./commands/mode.js")).runMode(mode, opts),
    ),
  );

program
  .command("logs")
  .description("Show Core logs by default.")
  .option("-n, --lines <n>", "Number of lines to show (default: 50)", parseLines)
  .option("-f, --follow", "Follow new log entries")
  .option("--errors", "Show error logs")
  .option("--daemon", "Show Sash logs")
  .option("--startup", "Show login startup logs")
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
  .description("Update Core to the latest release or a specified tag.")
  .option("--check", "Check for an update without installing or starting Sash")
  .option("--cancel", "Cancel the Core download in progress")
  .option("--json", "Output JSON")
  .action(
    withCliErrors(
      async (
        tag: string | undefined,
        opts: { check?: boolean; cancel?: boolean; json?: boolean },
      ) => (await import("./commands/update.js")).runUpdate({ ...opts, version: tag }),
    ),
  );

program
  .command("upgrade [version]")
  .description("Upgrade Sash through npm to the latest or a specified version.")
  .option("--check", "Check version and compatibility without installing")
  .option("--no-restart", "Install without restarting Sash")
  .option("--json", "Output JSON")
  .action(
    withCliErrors(
      async (
        version: string | undefined,
        opts: { check?: boolean; json?: boolean; restart?: boolean },
      ) => (await import("./commands/upgrade.js")).runUpgrade(version, opts),
    ),
  );

program
  .command("web")
  .description("Open an authorized WebUI session.")
  .option("--no-open", "Print the URL without opening or authorizing a browser")
  .action(
    withCliErrors(async (opts: { open: boolean }) =>
      (await import("./commands/web.js")).runWeb({ noOpen: !opts.open }),
    ),
  );

program
  .command("version")
  .description("Show the Sash version")
  .action(() => {
    console.log(packageVersion());
  });

const summaries: Record<string, string> = {
  start: "Start Sash and Core",
  stop: "Stop Sash and Core",
  restart: "Apply the saved configuration to Core",
  status: "Show status",
  web: "Open WebUI",
  profile: "Manage saved profiles",
  proxy: "Manage the system proxy",
  mode: "Set the Core routing mode",
  auto: "Manage start at login",
  update: "Update Core",
  upgrade: "Upgrade Sash through npm",
  logs: "Show logs",
  doctor: "Diagnose setup and runtime issues",
  version: "Show the Sash version",
};
const helpDetails: Record<string, string> = {
  start: "If Sash and Core are already running, leave them running.",
  restart:
    "Reload Core when possible. Restart it if the proxy port or LAN setting changed.\nStart Core if it is stopped.",
  status:
    "Bare sash shows the same summary.\nNode and group names must match exactly.\nWith --watch --delay, latency is tested every 30 seconds.\nWith --watch --json, output one JSON snapshot per line.\n\nExit codes: 0 observation complete, 1 command failed, 2 observation incomplete.",
  doctor:
    "Includes network checks for Core download sources.\nDoes not install Core or start Sash.\n\nExit codes: 0 checks complete, 1 checks failed, 2 observation incomplete.",
  profile:
    "Use a profile ID or exact name. Quote names containing spaces.\nChanges to the selected profile are applied to a healthy running Core when\nno listener changes are pending. Otherwise, they remain saved.",
  proxy:
    "Enabling requires a healthy running Core.\nTurning it off restores the previous Windows proxy settings.",
  mode: "The mode applies to the current Core session.\nApplying the saved configuration may reset it.",
  auto: "Available on Windows with a supported global npm installation.\nSash may start to save a change. Core is not started by this command.",
  logs: "Examples:\n  sash logs -f\n  sash logs --errors\n  sash logs --daemon --errors\n  sash logs --startup\n\n--startup cannot be combined with --daemon or --errors.\nSet SASH_DEBUG=1 to include stack traces for CLI errors.",
  update:
    "Examples:\n  sash update\n  sash update --check\n  sash update v1.19.31\n  sash update --cancel\n\nReplacing a running Core briefly interrupts proxy connections.\nCtrl+C requests download cancellation. An interrupted command exits 130.",
  upgrade:
    "Examples:\n  sash upgrade\n  sash upgrade --check\n  sash upgrade 0.3.4\n\nA running Sash is restarted after installation unless --no-restart is set.\nThe previous Core running state is restored after the restart.",
  web: "Start Sash if needed. Leave Core unchanged.",
};
program.addHelpCommand("help [command]", "Show help for a command");
profile.addHelpCommand("help [command]", "Show help for a command");
for (const command of [program, ...program.commands, ...profile.commands]) {
  command.helpOption("-h, --help", "Show help");
  if (command.parent === program) {
    command.summary(summaries[command.name()] ?? command.description());
    const details = helpDetails[command.name()];
    if (details) command.addHelpText("after", `\n${details}`);
  }
}
const profileDetails: Record<string, string> = {
  use: 'Specify a profile or --default.\n\nExamples:\n  sash profile use MyProxies\n  sash profile use "Work Profile"\n  sash profile use --default',
  add: "If no profile is selected, the saved profile is selected automatically.",
  update:
    "Specify a profile or --all, not both.\nLocal profiles have no subscription URL to refresh.",
  remove: "Removing the selected profile selects the built-in configuration.",
};
const profileSummaries: Record<string, string> = {
  list: "List saved profiles",
  use: "Select a profile",
  add: "Download and save a profile",
  update: "Refresh a remote profile",
  rename: "Rename a profile",
  remove: "Remove a profile",
};
for (const command of profile.commands) {
  command.summary(profileSummaries[command.name()] ?? command.description());
  const details = profileDetails[command.name()];
  if (details) command.addHelpText("after", `\n${details}`);
}

function parseLines(value: string): number {
  try {
    return parseLogLineCount(value);
  } catch (err) {
    throw new InvalidArgumentError(errorMessage(err));
  }
}

async function main(): Promise<void> {
  try {
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
