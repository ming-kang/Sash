#!/usr/bin/env node
import "./node-version-guard.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { withCliErrors } from "./cli-errors.js";
import { runConfigSet, runConfigShow } from "./commands/config-cmd.js";
import { runRestart, runStart, runStop } from "./commands/lifecycle.js";
import { runLogs } from "./commands/logs.js";
import { runStatus } from "./commands/status.js";
import { runSubSet, runSubShow, runSubUnset, runSubUpdate } from "./commands/sub.js";
import { runUi } from "./commands/ui.js";
import { runUpdate } from "./commands/update.js";
import { runUpgrade } from "./commands/upgrade.js";

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
    "Lightweight wrapper for the Mihomo (Clash.Meta) core with an integrated MetaCubeXD dashboard",
  )
  .version(packageVersion(), "-v, --version", "print the Sash version")
  .enablePositionalOptions()
  .exitOverride()
  .addHelpText(
    "after",
    `
Examples:
  $ sash start                 install the core if needed and launch it
  $ sash sub set <url>         import a Clash/mihomo subscription URL
  $ sash ui                    open the MetaCubeXD dashboard
  $ sash status                show runtime state and endpoints
  $ sash update                upgrade the mihomo core
  $ sash upgrade               upgrade Sash itself via npm

Data directory: %LOCALAPPDATA%\\Sash (Windows), ~/Library/Application Support/Sash (macOS),
$XDG_DATA_HOME/sash (Linux). Override with the SASH_HOME environment variable.`,
  );

program
  .command("start")
  .description("install the core/dashboard if needed and start mihomo in the background")
  .option("--no-ui", "skip MetaCubeXD dashboard installation")
  .action(withCliErrors((opts: { ui: boolean }) => runStart({ noUi: !opts.ui })));

program
  .command("stop")
  .description("stop the running mihomo core")
  .action(withCliErrors(() => runStop()));

program
  .command("restart")
  .description("restart the mihomo core")
  .option("--no-ui", "skip MetaCubeXD dashboard installation")
  .action(withCliErrors((opts: { ui: boolean }) => runRestart({ noUi: !opts.ui })));

program
  .command("status")
  .description("show runtime state, versions, and endpoints")
  .option("--json", "output machine-readable JSON")
  .action(withCliErrors((opts: { json?: boolean }) => runStatus(opts)));

program
  .command("logs")
  .description("print core logs")
  .option("-n, --lines <n>", "number of lines to print", (v: string) => Number.parseInt(v, 10))
  .option("-f, --follow", "follow the log output")
  .option("--errors", "read the stderr log instead of stdout")
  .action(
    withCliErrors((opts: { lines?: number; follow?: boolean; errors?: boolean }) =>
      runLogs({ lines: opts.lines ?? 50, follow: opts.follow, errors: opts.errors }),
    ),
  );

program
  .command("update")
  .description("upgrade the mihomo core binary")
  .option("--version <tag>", "install a specific core version, e.g. v1.19.30")
  .option("--force", "reinstall even if already on the target version")
  .action(withCliErrors((opts: { version?: string; force?: boolean }) => runUpdate(opts)));

program
  .command("upgrade")
  .description("upgrade Sash itself via npm")
  .option("--version <version>", "install a specific Sash version")
  .action(withCliErrors((opts: { version?: string }) => runUpgrade(opts)));

program
  .command("ui")
  .description("open the MetaCubeXD dashboard (installs/starts components as needed)")
  .option("--no-open", "print the URL without opening a browser")
  .action(withCliErrors((opts: { open: boolean }) => runUi({ noOpen: !opts.open })));

const sub = program.command("sub").description("manage the Clash/mihomo subscription");
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
  .description(
    `set a managed key (${["tun", "allow-lan", "mixed-port", "controller", "secret"].join(", ")})`,
  )
  .action(withCliErrors((key: string, value?: string) => runConfigSet(key, value)));

program
  .command("version")
  .description("print the Sash version")
  .action(() => {
    console.log(packageVersion());
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // commander already printed help/usage; normalise the exit code.
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
