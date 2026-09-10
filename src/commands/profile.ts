import { commandOutput } from "../cli-output.js";
import { CliProfiles } from "../cli-profiles.js";
import { log } from "../log.js";
import { runtimeContext } from "./shared.js";

const profiles = () => new CliProfiles(runtimeContext());
type OutputOptions = { json?: boolean };

export async function runProfileList(options: OutputOptions = {}): Promise<void> {
  await commandOutput(
    options.json,
    () => profiles().list(),
    (index) => {
      if (!index.profiles.length) log.info("No profiles saved; using the built-in configuration");
      for (const profile of index.profiles)
        process.stdout.write(
          `${profile.id === index.activeId ? "*" : " "}  ${profile.id}  ${JSON.stringify(profile.name)}  ${profile.url ? "subscription" : "local file"}${profile.lastError ? `  last error: ${JSON.stringify(profile.lastError)}` : ""}`,
        );
      if (index.profiles.length) log.info("* selected profile · run sash restart to apply it");
    },
  );
}

export async function runProfileUse(
  reference?: string,
  options: OutputOptions & { default?: boolean } = {},
): Promise<void> {
  await commandOutput(
    options.json,
    () => profiles().use(reference, options.default),
    (result) => {
      log.info(
        `Selected ${result.name === null ? "the built-in configuration" : JSON.stringify(result.name)} · run sash restart to apply it`,
      );
    },
  );
}

export async function runProfileAdd(
  url: string,
  options: OutputOptions & { name?: string; use?: boolean } = {},
): Promise<void> {
  await commandOutput(
    options.json,
    () => profiles().add(url, options),
    (result) => {
      log.info(
        `Saved ${JSON.stringify(result.profile.name)}${result.activated ? " and selected it · run sash restart to apply" : ""}`,
      );
    },
  );
}

export async function runProfileUpdate(
  reference?: string,
  options: OutputOptions & { all?: boolean } = {},
): Promise<void> {
  await commandOutput(
    options.json,
    async () => {
      const result = await profiles().update(reference, options.all);
      if ("failed" in result && result.failed.length) process.exitCode = 1;
      return result;
    },
    (result) => {
      if ("profile" in result)
        log.info(`Saved ${JSON.stringify(result.profile.name)} · run sash restart to apply it`);
      else {
        log.info(
          `Updated ${result.updated} profile(s), ${result.failed.length} failed · run sash restart to apply`,
        );
        for (const failure of result.failed)
          log.warn(`${JSON.stringify(failure.name)}: ${failure.error}`);
      }
    },
  );
}

export async function runProfileRename(
  reference: string,
  name: string,
  options: OutputOptions = {},
): Promise<void> {
  await commandOutput(
    options.json,
    () => profiles().rename(reference, name),
    ({ profile }) => {
      log.info(`Renamed to ${JSON.stringify(profile.name)}`);
    },
  );
}

export async function runProfileRemove(
  reference: string,
  options: OutputOptions = {},
): Promise<void> {
  await commandOutput(
    options.json,
    () => profiles().remove(reference),
    (result) => {
      log.info(
        `Removed ${JSON.stringify(result.name)}${result.wasActive ? " · using the built-in configuration from now on" : ""}`,
      );
    },
  );
}
