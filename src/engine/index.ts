import type { SashState } from "../app-state.js";
import type { RoutingMode } from "../contracts.js";
import type { CoreDelayResult } from "../core-delay.js";
import type { GeneratedConfig, GeoxMirrorSet } from "../mihomo-config.js";
import type { SashLayout } from "../paths.js";

/**
 * The daemon's view of a proxy core. Everything engine-specific — how the
 * binary is launched, how the merged configuration is rendered and checked,
 * and how the external controller is spoken to — crosses this boundary so a
 * second engine can be added without touching orchestration code.
 */
export interface CoreEngine {
  readonly id: string;
  /** Arguments the supervisor passes to the Core executable. */
  spawnArguments(layout: SashLayout): string[];
  /** Render the merged generated configuration for a state snapshot. */
  renderActiveConfig(state: SashState, layout: SashLayout): Promise<GeneratedConfig>;
  /** Validate a generated config with the installed Core binary. */
  validateConfig(
    executable: string,
    yaml: string,
    layout: SashLayout,
    options: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<void>;
  /** External-controller client for probes, reloads, modes and delay tests. */
  api(controller: string, secret: string): CoreControllerApi;
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
