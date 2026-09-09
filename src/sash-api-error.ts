/** HTTP failure from the daemon API, carrying the error-envelope fields. */
export class SashApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "SashApiError";
  }
}
