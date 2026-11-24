import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { GeneratedConfig, GeoxMirrorSet } from "./mihomo-config.js";
import { buildSanitizedEnv } from "./process.js";
import type { SashSettings } from "./settings.js";

export type ProfileSummary = Pick<GeneratedConfig, "proxyCount">;

type ProfileTask =
  | { kind: "inspect"; text: string }
  | {
      kind: "render";
      text: string;
      settings: SashSettings;
    }
  | { kind: "mirrors"; generated: GeneratedConfig; mirrors: GeoxMirrorSet };

export type ProfileWork = ProfileTask & { id: number };
type ProfileWorkResult = ProfileSummary | GeneratedConfig;
export type ProfileWorkReply =
  | { id: number; value: ProfileWorkResult }
  | { id: number; error: string };

let worker: Worker | undefined;
let sequence = 0;
let idle: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<
  number,
  { resolve(value: ProfileWorkResult): void; reject(error: Error): void }
>();

function work(task: ProfileTask): Promise<ProfileWorkResult> {
  clearTimeout(idle);
  if (!worker) {
    const compiled = new URL("./profile-worker.js", import.meta.url);
    const source = !fs.existsSync(compiled);
    const instance = new Worker(
      source ? new URL("./profile-worker.ts", import.meta.url) : compiled,
      {
        env: buildSanitizedEnv(),
        // Source checkouts run the TypeScript worker through tsx: `.js`
        // specifiers inside it must resolve to neighboring `.ts` files, which
        // plain `node` cannot do.
        ...(source
          ? {
              // Resolve tsx to an absolute URL: the daemon's cwd is SASH_HOME,
              // where bare "tsx" has no node_modules to resolve against.
              execArgv: [
                "--import",
                pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
              ],
            }
          : {}),
      },
    );
    worker = instance;
    instance.on("message", (result: ProfileWorkReply) => {
      const request = pending.get(result.id);
      pending.delete(result.id);
      if ("error" in result) request?.reject(new Error(result.error));
      else request?.resolve(result.value);
      if (pending.size === 0) {
        instance.unref();
        idle = setTimeout(() => {
          if (worker === instance) {
            worker = undefined;
            void instance.terminate();
          }
        }, 30_000);
        idle.unref();
      }
    });
    const failed = (error: Error): void => {
      if (worker !== instance) return;
      worker = undefined;
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    instance.once("error", failed);
    instance.once("exit", () =>
      failed(new Error("Profile processing stopped; retry the operation")),
    );
  }
  const id = ++sequence;
  worker.ref();
  const instance = worker;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    instance.postMessage({ id, ...task } satisfies ProfileWork);
  });
}

export async function inspectProfileOffThread(text: string): Promise<ProfileSummary> {
  return (await work({ kind: "inspect", text })) as ProfileSummary;
}

export async function renderProfileOffThread(
  text: string,
  settings: SashSettings,
): Promise<GeneratedConfig> {
  return (await work({ kind: "render", text, settings })) as GeneratedConfig;
}

export async function renderGeodataMirrorsOffThread(
  generated: GeneratedConfig,
  mirrors: GeoxMirrorSet,
): Promise<GeneratedConfig> {
  return (await work({ kind: "mirrors", generated, mirrors })) as GeneratedConfig;
}
