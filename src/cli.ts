#!/usr/bin/env node
import "./node-version-guard.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { withCliErrors } from "./cli-errors.js";
import { runConfigSet, runConfigShow } from "./commands/config-cmd.js";
import { runRestart, runStart, runStop } from "./commands/lifecycle.js";
import { runLogs } from "./commands/logs.js";
import { runProxyOff, runProxyOn, runProxyStatus } from "./commands/proxy.js";
import { runStatus } from "./commands/status.js";
import { runSubSet, runSubShow, runSubUnset, runSubUpdate } from "./commands/sub.js";
import { runUpdate } from "./commands/update.js";
import { runUpgrade } from "./commands/upgrade.js";
import { runWeb } from "./commands/web.js";
import { SETTABLE_KEYS } from "./settings.js";

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
  $ sash proxy on              enable system proxy (routes OS traffic through sash)
  $ sash sub set <url>         import a subscription URL
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
  .description("restart the core process")
  .action(withCliErrors(() => runRestart()));

program
  .command("status")
  .description("show runtime state, versions, endpoints, and system proxy status")
  .option("--json", "output machine-readable JSON")
  .action(withCliErrors((opts: { json?: boolean }) => runStatus(opts)));

const proxy = program.command("proxy").description("manage the OS system proxy");
proxy
  .command("on")
  .description("route OS-level traffic through Sash's mixed port")
  .action(withCliErrors(() => runProxyOn()));
proxy
  .command("off")
  .description("disable the OS-level system proxy")
  .action(withCliErrors(() => runProxyOff()));
proxy
  .command("status", { isDefault: true })
  .description("show the current OS and desired system proxy state")
  .action(withCliErrors(() => runProxyStatus()));

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
  .option("--force", "reinstall even if already on the target version")
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

const sub = program.command("sub").description("manage the subscription");
sub
  .command("set <url>")
  .description("set the subscription URL and regenerate the config")
  .action(withCliErrors((url: string) => runSubSet(url)));
sub
  .command("update")
  .description("refetch the subscription and reload the running core")
  .action(withCliErrors(() => runSubUpdate()));
sub
  .command("show")
  .description("show the current subscription")
  .action(withCliErrors(() => runSubShow()));
sub
  .command("unset")
  .description("remove the subscription and revert to the default config")
  .action(withCliErrors(() => runSubUnset()));

const config = program.command("config").description("inspect and adjust Sash settings");
config
  .command("show", { isDefault: true })
  .description("show paths and current settings")
  .action(withCliErrors(() => runConfigShow()));
config
  .command("set <key> [value]")
  .description(`set a managed key (${SETTABLE_KEYS.join(", ")})`)
  .action(withCliErrors((key: string, value?: string) => runConfigSet(key, value)));

program
  .command("version")
  .description("print the Sash version")
  .action(() => {
    console.log(packageVersion());
  });

function parseLines(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return n;
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
