import { isCanonicalIsoTimestamp, isPlainObject } from "./json-shape.js";

export const CORE_DELAY_URL = "https://www.gstatic.com/generate_204";
export const CORE_DELAY_TIMEOUT_MS = 5000;
export const CORE_DELAY_REQUEST_MS = CORE_DELAY_TIMEOUT_MS + 2000;

export type CoreDelayOutcome =
  | { state: "ok"; delayMs: number; error: null }
  | { state: "timeout" | "failed" | "not_found"; delayMs: null; error: string };

export type CoreDelayResult = CoreDelayOutcome & {
  name: string;
  url: string;
  timeoutMs: number;
  testedAt: string;
};

/** Core reports a missing target, a probe timeout and any other failure with distinct HTTP statuses. */
export function delayFailureState(statusCode: number): "not_found" | "timeout" | "failed" {
  if (statusCode === 404) return "not_found";
  if (statusCode === 408 || statusCode === 504) return "timeout";
  return "failed";
}

export function validateDelayTarget(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 512 ||
    /[\ud800-\udfff]/u.test(value) ||
    /\p{Cc}/u.test(value) ||
    value === "." ||
    value === ".."
  )
    throw new TypeError("Delay target must be an exact node or group name (1–512 characters)");
  return value;
}

export function parseCoreDelayResult(value: unknown, name: string): CoreDelayResult {
  if (
    !isPlainObject(value) ||
    value.name !== name ||
    value.url !== CORE_DELAY_URL ||
    value.timeoutMs !== CORE_DELAY_TIMEOUT_MS ||
    !isCanonicalIsoTimestamp(value.testedAt)
  )
    throw new TypeError("Invalid Core delay observation");
  const base = { name, url: value.url, timeoutMs: value.timeoutMs, testedAt: value.testedAt };
  if (
    value.state === "ok" &&
    typeof value.delayMs === "number" &&
    Number.isSafeInteger(value.delayMs) &&
    value.delayMs > 0 &&
    value.error === null
  )
    return { ...base, state: "ok", delayMs: value.delayMs, error: null };
  if (
    (value.state === "timeout" || value.state === "failed" || value.state === "not_found") &&
    value.delayMs === null &&
    typeof value.error === "string" &&
    value.error.trim()
  )
    return { ...base, state: value.state, delayMs: null, error: value.error };
  throw new TypeError("Invalid Core delay result");
}
