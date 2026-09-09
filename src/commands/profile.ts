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
      if (!index.profiles.length)
        log.info("No saved profiles; the built-in configuration is selected");
      for (const profile of index.profiles)
        process.stdout.write(
          `${profile.id === index.activeId ? "*" : " "} ${profile.id}  r${profile.revision}  ${JSON.stringify(profile.name)}  ${profile.url ? "remote" : "local"}${profile.lastError ? `  error: ${JSON.stringify(profile.lastError)}` : ""}\n`,
        );
      if (index.profiles.length)
        log.info("* saved selection; sash restart applies saved configuration");
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
        `Saved selection: ${result.name === null ? "built-in configuration" : JSON.stringify(result.name)}; run sash restart to apply`,
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
        `Saved profile ${result.profile.id} ${JSON.stringify(result.profile.name)}${result.activated ? "; selected for the next Apply" : ""}`,
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
        log.info(
          `Saved profile ${result.profile.id} revision ${result.profile.revision}; run sash restart to apply`,
        );
      else {
        log.info(
          `Updated ${result.updated} profile(s); ${result.failed.length} failed. Saved changes require Apply`,
        );
        for (const failure of result.failed)
          log.warn(
            `${failure.id} ${JSON.stringify(failure.name)}: ${JSON.stringify(failure.error)}`,
          );
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
      log.info(`Renamed profile ${profile.id} to ${JSON.stringify(profile.name)}`);
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
        `Removed profile ${result.id} ${JSON.stringify(result.name)}${result.wasActive ? "; built-in configuration selected for the next Apply" : ""}`,
      );
    },
  );
}
