'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

const SIZE_CLASS: Record<ModalSize, string> = {
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
  xl: 'sm:max-w-4xl',
};

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: ModalSize;
  children: React.ReactNode;
  /** Sticky action row pinned to the bottom of the panel. */
  footer?: React.ReactNode;
}

/**
 * Responsive dialog. On phones it fills the viewport width with a small inset
 * and caps its height so long forms scroll inside the panel instead of pushing
 * the page sideways; from `sm` up it becomes a centred card.
 */
export function Modal({ open, onClose, title, description, size = 'md', children, footer }: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content
          className={`fixed left-1/2 top-1/2 z-50 flex w-[calc(100vw-1.5rem)] max-w-[calc(100vw-1.5rem)] max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl focus:outline-none sm:w-full ${SIZE_CLASS[size]}`}
        >
          <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-6">
            <div className="min-w-0">
              <Dialog.Title className="text-base font-bold text-slate-900 sm:text-lg">{title}</Dialog.Title>
              {description && (
                <Dialog.Description className="mt-1 text-sm text-slate-600">{description}</Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close dialog"
                className="-mr-1 -mt-1 shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <X size={18} />
              </button>
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 sm:px-6">{children}</div>

          {footer && (
            <div className="border-t border-slate-100 bg-slate-50 px-4 py-3 sm:px-6">{footer}</div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
