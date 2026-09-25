import { hasExactOwnKeys, isPlainObject } from "../json-shape.js";

export type AutostartState = "on" | "off" | "stale" | "disabled" | "unknown" | "unsupported";
export type RegisteredAutostartState = Exclude<AutostartState, "unknown" | "unsupported">;

export interface AutostartStatus {
  state: AutostartState;
  canEnable: boolean;
  reason: string | null;
}

export const PENDING_AUTOSTART_STATUS: AutostartStatus = {
  state: "unknown",
  canEnable: false,
  reason: "Autostart observation is pending",
};

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
