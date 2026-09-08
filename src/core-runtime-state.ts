import { isPlainObject } from "./json-shape.js";

export type CoreMode = "rule" | "global" | "direct";
export interface CoreRuntimeState {
  mode: CoreMode;
  selections: Record<string, string>;
}

export function parseCoreMode(value: unknown): CoreMode {
  if (value !== "rule" && value !== "global" && value !== "direct")
    throw new Error("Core returned an invalid routing mode");
  return value;
}

export function parseCoreRuntimeState(value: unknown): CoreRuntimeState {
  if (!isPlainObject(value) || !isPlainObject(value.selections))
    throw new Error("Invalid Core runtime state");
  const selections = Object.entries(value.selections);
  if (
    selections.length > 10_000 ||
    selections.some(
      ([name, selected]) =>
        !name ||
        name.length > 4096 ||
        typeof selected !== "string" ||
        !selected ||
        selected.length > 4096,
    )
  )
    throw new Error("Invalid Core selector state");
  return {
    mode: parseCoreMode(value.mode),
    selections: Object.fromEntries(selections) as Record<string, string>,
  };
}

/** Only manual Selector groups have a restorable choice; automatic groups keep their policy. */
export function captureCoreRuntimeState(config: unknown, response: unknown): CoreRuntimeState {
  if (!isPlainObject(config) || !isPlainObject(response) || !isPlainObject(response.proxies))
    throw new Error("Core returned an invalid runtime snapshot");
  const selections: Array<[string, unknown]> = [];
  for (const [name, proxy] of Object.entries(response.proxies)) {
    if (!isPlainObject(proxy)) throw new Error("Core returned an invalid proxy entry");
    if (proxy.type === "Selector") selections.push([name, proxy.now]);
  }
  return parseCoreRuntimeState({ mode: config.mode, selections: Object.fromEntries(selections) });
}
