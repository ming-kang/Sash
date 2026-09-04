import type { ApiErrorCode } from "../contracts.js";
import { HttpError } from "../daemon-http.js";
import {
  ProfileConflictError,
  ProfileInputError,
  ProfileNotFoundError,
} from "../profile-service.js";
import { CoreUnhealthyError, SettingsInputError } from "../settings-service.js";

/** Rejects state mutations once the daemon shutdown gate has closed. */
export class ShuttingDownError extends Error {
  constructor(message = "sashd is shutting down") {
    super(message);
    this.name = "ShuttingDownError";
  }
}

export interface HttpErrorMapping {
  status: number;
  code: ApiErrorCode;
  message: string;
}

function defaultCodeForStatus(status: number): ApiErrorCode {
  if (status === 400 || status === 413) return "invalid_input";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 503) return "shutting_down";
  if (status >= 500) return "internal";
  return "http";
}

/** Map any thrown domain error to the shared HTTP error envelope. */
export function errorToHttp(err: unknown): HttpErrorMapping {
  if (err instanceof HttpError) {
    return {
      status: err.statusCode,
      code: err.code ?? defaultCodeForStatus(err.statusCode),
      message: err.message,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof ProfileNotFoundError) return { status: 404, code: "not_found", message };
  if (err instanceof ProfileInputError) return { status: 400, code: "invalid_input", message };
  if (err instanceof SettingsInputError) return { status: 400, code: "invalid_input", message };
  if (err instanceof ProfileConflictError) return { status: 409, code: "conflict", message };
  if (err instanceof CoreUnhealthyError) return { status: 409, code: "core_unhealthy", message };
  if (err instanceof ShuttingDownError) return { status: 503, code: "shutting_down", message };
  return { status: 500, code: "internal", message };
}
