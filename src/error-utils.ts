export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
