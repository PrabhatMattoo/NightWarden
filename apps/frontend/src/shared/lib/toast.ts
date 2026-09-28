import { toast as sonnerToast } from "sonner";

type ToastVariant = "info" | "success" | "error";

type ShowProps = {
  title?: string;
  message: string;
  variant?: ToastVariant;
};

export const toast = {
  show({ variant = "info", title, message }: ShowProps): void {
    const emit =
      variant === "success"
        ? sonnerToast.success
        : variant === "error"
          ? sonnerToast.error
          : sonnerToast.info;
    emit(title ?? message, title ? { description: message } : undefined);
  },

  // The message is the title: the icon already says which kind of toast it is.
  success(message: string): void {
    sonnerToast.success(message);
  },

  error(message: string): void {
    sonnerToast.error(message);
  },

  clean(): void {
    sonnerToast.dismiss();
  },
} as const;
