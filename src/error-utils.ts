import { isPlainObject } from "./json-shape.js";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorDetail(error: unknown, maxLength = 300): string {
  return errorMessage(error)
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

export interface ErrorPresentation {
  message: string;
  advice?: string;
}

export function withErrorPresentation<T extends Error>(
  error: T,
  presentation: ErrorPresentation,
): T {
  Object.defineProperty(error, "presentation", {
    value: presentation,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return error;
}

export function errorPresentation(error: unknown): ErrorPresentation | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return parseErrorPresentation((error as { presentation?: unknown }).presentation);
}

export function parseErrorPresentation(value: unknown): ErrorPresentation | undefined {
  if (!isPlainObject(value) || typeof value.message !== "string") return undefined;
  if (value.advice === undefined) return { message: value.message };
  if (typeof value.advice !== "string") return undefined;
  return { message: value.message, advice: value.advice };
}
