import { isCanonicalIsoTimestamp, isPlainObject } from "./json-shape.js";

const CORE_UPDATE_STAGES = [
  "checking",
  "resolving",
  "downloading",
  "extracting",
  "verifying",
  "validating",
  "waiting",
  "installing",
] as const;
export type CoreUpdateStage = (typeof CORE_UPDATE_STAGES)[number];
export interface CoreUpdateProgress {
  stage: CoreUpdateStage;
  startedAt: string;
  target: string | null;
  downloading: boolean;
  downloaded: number;
  total: number | null;
}

/** Shared with the browser; progress carries no installation or credential material. */
export function parseCoreUpdateProgress(value: unknown): CoreUpdateProgress | null {
  if (value === null) return null;
  if (
    !isPlainObject(value) ||
    !CORE_UPDATE_STAGES.some((stage) => stage === value.stage) ||
    !isCanonicalIsoTimestamp(value.startedAt) ||
    (value.target !== null &&
      (typeof value.target !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.target))) ||
    typeof value.downloading !== "boolean" ||
    value.downloading !== (value.stage === "downloading") ||
    typeof value.downloaded !== "number" ||
    !Number.isSafeInteger(value.downloaded) ||
    value.downloaded < 0 ||
    (value.total !== null &&
      (typeof value.total !== "number" || !Number.isSafeInteger(value.total) || value.total <= 0))
  )
    throw new TypeError("Invalid Core update progress");
  return {
    stage: value.stage as CoreUpdateStage,
    startedAt: value.startedAt,
    target: value.target,
    downloading: value.downloading,
    downloaded: value.downloaded,
    total: value.total,
  };
}
