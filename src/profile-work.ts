import fs from "node:fs";
import { Worker } from "node:worker_threads";
import type { GeneratedConfig } from "./mihomo-config.js";
import { buildSanitizedEnv } from "./process.js";
import type { SashSettings } from "./settings.js";

export interface ProfileWork {
  id: number;
  text: string;
  settings?: SashSettings;
}

let worker: Worker | undefined;
let sequence = 0;
let idle: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

function work(text: string, settings?: SashSettings): Promise<unknown> {
  clearTimeout(idle);
  if (!worker) {
    const compiled = new URL("./profile-worker.js", import.meta.url);
    const instance = new Worker(
      fs.existsSync(compiled) ? compiled : new URL("./profile-worker.ts", import.meta.url),
      {
        env: buildSanitizedEnv(),
      },
    );
    worker = instance;
    instance.on("message", (result: { id: number; value?: unknown; error?: string }) => {
      const request = pending.get(result.id);
      pending.delete(result.id);
      if (result.error) request?.reject(new Error(result.error));
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
    instance.postMessage({ id, text, settings } satisfies ProfileWork);
  });
}

export async function parseProfileOffThread(text: string): Promise<Record<string, unknown>> {
  return (await work(text)) as Record<string, unknown>;
}

export async function renderProfileOffThread(
  text: string,
  settings: SashSettings,
): Promise<GeneratedConfig> {
  return (await work(text, settings)) as GeneratedConfig;
}
