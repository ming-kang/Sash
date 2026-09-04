import { reactive } from "vue";
import { t } from "../i18n/index.js";

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
  confirmText: t("common.confirm"),
  cancelText: t("common.cancel"),
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
  confirmState.confirmText = opts.confirmText ?? t("common.confirm");
  confirmState.cancelText = opts.cancelText ?? t("common.cancel");
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
