'use client';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface ConfirmationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  onConfirm: () => void;
  isLoading?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'destructive';
}

/**
 * Yes/no confirmation for an action that is about to happen.
 *
 * `components/ui/ConfirmDialog` covers the same ground with a headless-ui
 * panel; this one is the radix `AlertDialog` variant, which traps focus on the
 * cancel button and is what the destructive flows in this app already expect.
 */
export function ConfirmationModal({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  isLoading = false,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
}: ConfirmationModalProps) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !isLoading && onOpenChange(next)}>
      <AlertDialogContent className="w-[calc(100vw-1.5rem)] max-w-[calc(100vw-1.5rem)] rounded-xl bg-white sm:max-w-[425px]">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-base font-bold text-slate-900 sm:text-lg">
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-sm text-slate-600">
            {description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <AlertDialogCancel disabled={isLoading} className="mt-0 h-9 w-full text-xs sm:w-auto">
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              // The dialog closes itself on action; the caller decides when to
              // dismiss, so a pending mutation is not torn down mid-flight.
              event.preventDefault();
              onConfirm();
            }}
            disabled={isLoading}
            className={`h-9 w-full text-xs sm:w-auto ${
              variant === 'destructive'
                ? 'bg-rose-600 hover:bg-rose-700'
                : 'bg-emerald-600 hover:bg-emerald-700'
            }`}
          >
            {isLoading ? 'Processing…' : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
