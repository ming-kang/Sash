import { reactive } from "vue";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  danger?: boolean;
}

interface ConfirmState extends ConfirmOptions {
  visible: boolean;
  resolve: ((ok: boolean) => void) | null;
}

export const confirmState = reactive<ConfirmState>({
  visible: false,
  title: "",
  message: "",
  confirmText: "OK",
  cancelText: "Cancel",
  danger: false,
  resolve: null,
});

export function confirmDialog(
  opts: Omit<ConfirmOptions, "confirmText" | "cancelText"> &
    Partial<Pick<ConfirmOptions, "confirmText" | "cancelText">>,
): Promise<boolean> {
  if (confirmState.resolve) settleConfirm(false);
  confirmState.title = opts.title;
  confirmState.message = opts.message;
  confirmState.confirmText = opts.confirmText ?? "OK";
  confirmState.cancelText = opts.cancelText ?? "Cancel";
  confirmState.danger = opts.danger ?? false;
  confirmState.visible = true;
  return new Promise<boolean>((resolve) => {
    confirmState.resolve = resolve;
  });
}

export function settleConfirm(ok: boolean): void {
  confirmState.visible = false;
  confirmState.resolve?.(ok);
  confirmState.resolve = null;
}
