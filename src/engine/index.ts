import type { Dispatcher } from "undici";
import type { RoutingMode } from "../contracts.js";
import type { CoreDelayResult } from "../core-delay.js";
import type { GeoxMirrorSet } from "../mihomo-config.js";
import type { SashLayout } from "../paths.js";

/** Process, configuration-check and controller operations provided by the managed Core. */
export interface CoreEngine {
  readonly id: string;
  spawnArguments(layout: SashLayout): string[];
  validateConfig(
    executable: string,
    yaml: string,
    layout: SashLayout,
    options: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<void>;
  api(controller: string, secret: string, dispatcher?: Dispatcher): CoreControllerApi;
  readonly geodata: CoreGeodata;
}

export interface CoreControllerApi {
  isReachable(): Promise<boolean>;
  version(options?: { deadlineMs?: number; attempts?: number }): Promise<string>;
  setMode(mode: RoutingMode): Promise<void>;
  reloadConfig(path: string, signal?: AbortSignal): Promise<void>;
  delay(name: string, signal?: AbortSignal): Promise<CoreDelayResult>;
}

export interface CoreGeodata {
  readonly mirrorSets: readonly GeoxMirrorSet[];
  isDownloadFailure(error: unknown): boolean;
  fileForFailure(error: unknown): string | undefined;
  readonly testTimeoutMs: number;
}

export { mihomoEngine } from "./mihomo.js";
