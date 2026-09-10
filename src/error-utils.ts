export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Single-line error detail for logs, status payloads and persisted failure records. */
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
