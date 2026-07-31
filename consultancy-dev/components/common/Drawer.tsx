'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';

interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Sub-line under the title. Also the panel's accessible description. */
  description?: React.ReactNode;
  /**
   * Width classes for the panel. The default is full-bleed on a phone; a
   * caller adds its own breakpoint-prefixed width on top.
   */
  panelClassName?: string;
  /**
   * Layout for the scrolling region between header and footer.
   *
   * The body scrolls by default, which is what a drawer holding a form wants.
   * A panel that scrolls its own sub-panes instead must turn it off with
   * `overflow-y-hidden` — NOT `overflow-hidden`, which tailwind-merge files
   * under a different utility group, keeps alongside the default, and leaves
   * the winner to stylesheet order rather than to the caller.
   */
  bodyClassName?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
  /**
   * Vetoes a dismiss. Return false to keep the panel open — this is the hook a
   * drawer with a half-filled form uses to confirm before throwing it away.
   * Covers the scrim, Escape and the close button alike, because all three
   * reach Radix through the same `onOpenChange(false)`.
   */
  onRequestClose?: () => boolean;
}

/**
 * The right-edge panel shared by every drawer in the app.
 *
 * ANIMATION: the slide is plain CSS keyed on Radix's own `data-state`
 * attribute — see the `drawer` banner in app/globals.css. It is NOT done with
 * `animate-in`/`slide-in-from-right`: this project has no Tailwind animation
 * plugin installed, so those classes (still used in components/ui/dialog.tsx)
 * compile to nothing at all and the panel simply appears. Radix's `Presence`
 * waits for `animationend` before unmounting, which is the only reason the
 * EXIT is visible rather than a snap — a hand-rolled mount/unmount would need
 * to reimplement that.
 *
 * The two `data-slot` hooks are the contract with that stylesheet; a drawer
 * that omits them renders correctly and animates not at all.
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  panelClassName,
  bodyClassName,
  footer,
  children,
  onRequestClose,
}: DrawerProps) {
  const handleOpenChange = (next: boolean) => {
    if (next) {
      onOpenChange(true);
      return;
    }
    if (onRequestClose && !onRequestClose()) return;
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-slot="drawer-scrim"
          className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[2px]"
        />
        <Dialog.Content
          data-slot="drawer"
          // `aria-describedby` is deliberately NOT passed. react-dialog 1.1.23
          // derives it from whether a `Dialog.Description` actually mounted
          // (`descriptionPresent ? descriptionId : undefined`) and no longer
          // warns about a missing one, so the old escape hatch has nothing left
          // to suppress. Worse, `Dialog.Content` spreads the caller's props
          // AFTER that computed value, so passing the key at all — even as
          // undefined — wins and strips the link to the description below.
          className={cn(
            'fixed inset-y-0 right-0 z-50 flex w-full max-w-full flex-col bg-white shadow-2xl outline-none',
            panelClassName,
          )}
        >
          <header className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
            <div className="min-w-0">
              <Dialog.Title className="text-base font-semibold text-slate-900">{title}</Dialog.Title>
              {description && (
                <Dialog.Description className="mt-0.5 text-xs text-slate-500">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="-mr-1 shrink-0 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                aria-label={`Close ${title.toLowerCase()}`}
              >
                <X size={18} />
              </button>
            </Dialog.Close>
          </header>

          <div className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto', bodyClassName)}>
            {children}
          </div>

          {footer && (
            <footer className="shrink-0 border-t border-slate-200 bg-slate-50 px-4 py-3">
              {footer}
            </footer>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
