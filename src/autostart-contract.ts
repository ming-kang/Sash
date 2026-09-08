import { hasExactOwnKeys, isPlainObject } from "./json-shape.js";

export const AUTOSTART_STATES = [
  "on",
  "off",
  "stale",
  "disabled",
  "unknown",
  "unsupported",
] as const;
export type AutostartState = (typeof AUTOSTART_STATES)[number];
export type RegisteredAutostartState = Exclude<AutostartState, "unknown" | "unsupported">;

/** OS registration is the source of truth; it is not a setting in sash.json. */
export interface AutostartStatus {
  state: AutostartState;
  canEnable: boolean;
  reason: string | null;
}

export function parseAutostartStatus(value: unknown): AutostartStatus {
  if (
    !isPlainObject(value) ||
    !hasExactOwnKeys(value, ["state", "canEnable", "reason"]) ||
    !AUTOSTART_STATES.some((state) => state === value.state) ||
    typeof value.canEnable !== "boolean" ||
    (value.reason !== null && typeof value.reason !== "string")
  ) {
    throw new Error("Invalid autostart status");
  }
  return {
    state: value.state as AutostartState,
    canEnable: value.canEnable,
    reason: value.reason,
  };
}

export function parseAutostartEnabled(value: unknown): boolean {
  if (
    !isPlainObject(value) ||
    !hasExactOwnKeys(value, ["enabled"]) ||
    typeof value.enabled !== "boolean"
  ) {
    throw new Error("Expected an object containing only an enabled boolean");
  }
  return value.enabled;
}
