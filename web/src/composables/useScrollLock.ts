let lockCount = 0;
let previousBodyOverflow: string | null = null;
let previousRootOverflow: string | null = null;

/**
 * Reference-counted scroll lock on body + documentElement so nested dialogs
 * (e.g. ConfirmDialog over CodeEditorModal) do not unlock prematurely.
 */
export function acquireScrollLock(): void {
  if (typeof document === "undefined") return;
  if (lockCount === 0) {
    previousBodyOverflow = document.body.style.overflow;
    previousRootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
  }
  lockCount += 1;
}

export function releaseScrollLock(): void {
  if (typeof document === "undefined") return;
  if (lockCount === 0) return;
  lockCount -= 1;
  if (lockCount > 0) return;
  document.body.style.overflow = previousBodyOverflow ?? "";
  document.documentElement.style.overflow = previousRootOverflow ?? "";
  previousBodyOverflow = null;
  previousRootOverflow = null;
}
