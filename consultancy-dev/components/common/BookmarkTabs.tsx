'use client';

import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * File-divider tabs.
 *
 * The visual is a physical filing tab rather than a generic pill row, because
 * that is literally what these screens are: the consultancy holds each
 * student's papers in a file, and this is the drawer. The active tab loses its
 * bottom border and sits one pixel over the panel edge so the two surfaces read
 * as one continuous card — which is also the point structurally, since
 * everything below belongs to the selected tab.
 *
 * Inactive tabs are recessed and slightly shorter, so the active one reads as
 * pulled forward without needing a colour change to say so.
 *
 * THE ONE-PIXEL SEAM, because it is easy to break by adding a class here:
 * the rail scrolls, so it clips at its own padding box. The active tab's
 * overhang is `-mb-px` and the rail's `pb-px` is what leaves room for it
 * INSIDE that box; the rail's own `-mb-px` then pulls the panel up into the
 * same band. Remove either and the overhang is either clipped or lands on a
 * border it no longer covers. For the same reason the rail must not gain
 * `mask-image`, `filter`, `opacity` or a transform: each creates a stacking
 * context, which would trap the active tab's `z-10` inside the rail and let
 * the panel — later in the DOM — paint its border straight back over the seam.
 */
export interface BookmarkTab<T extends string> {
  value: T;
  label: string;
  /** Optional total, shown only when it is known. */
  count?: number;
  /** Optional leading glyph; carried at 14px to match the label's cap height. */
  icon?: LucideIcon;
}

interface BookmarkTabsProps<T extends string> {
  tabs: ReadonlyArray<BookmarkTab<T>>;
  value: T;
  onChange: (value: T) => void;
  'aria-label': string;
}

export function BookmarkTabs<T extends string>({
  tabs,
  value,
  onChange,
  'aria-label': ariaLabel,
}: BookmarkTabsProps<T>) {
  const railRef = useRef<HTMLDivElement>(null);

  /**
   * A deep link can select a tab that is scrolled off-screen on a phone, which
   * looks like the wrong tab is open. `nearest` on both axes so bringing it
   * into view never scrolls the page itself.
   */
  useEffect(() => {
    railRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [value]);

  /**
   * Arrow keys move between tabs, which is what the tablist role promises and
   * what a roving tabindex is for — only the selected tab is in the tab order,
   * so Tab steps past the whole rail into the panel rather than through five
   * buttons. Selection follows focus, the right pattern when switching is
   * cheap and reversible.
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = tabs.findIndex((tab) => tab.value === value);
    if (current === -1) return;

    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = (current - 1 + tabs.length) % tabs.length;
        break;
      case 'ArrowRight':
        next = (current + 1) % tabs.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = tabs.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    onChange(tabs[next].value);
    // Focus has to be moved by hand: the newly selected button is the only one
    // in the tab order, and nothing else would put the caret on it.
    railRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <div
      ref={railRef}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      onKeyDown={handleKeyDown}
      // `scrollbar-none`: a scrollbar here would be drawn across the seam that
      // joins the active tab to its panel. The clipped tab at the edge is the
      // affordance instead.
      className="scrollbar-none -mb-px flex items-end gap-1 overflow-x-auto px-2 pb-px sm:px-3"
    >
      {tabs.map((tab) => {
        const isActive = tab.value === value;
        const Icon = tab.icon;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            id={`tab-${tab.value}`}
            aria-selected={isActive}
            aria-controls={`panel-${tab.value}`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(tab.value)}
            className={cn(
              'group relative -mb-px flex shrink-0 items-center gap-2 rounded-t-lg border border-b-0 px-3 pt-2 text-sm font-medium transition-all sm:px-4',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-1',
              isActive
                ? // Merges with the panel: same surface, and it covers the seam.
                  'z-10 border-slate-200 bg-white pb-[9px] text-slate-900 shadow-[0_-1px_2px_rgba(15,23,42,0.04)]'
                : 'border-transparent bg-slate-100/80 pb-2 text-slate-500 hover:bg-slate-200/70 hover:text-slate-700',
            )}
          >
            {Icon && (
              <Icon
                size={14}
                className={cn('shrink-0', isActive ? 'text-teal-600' : 'text-slate-400')}
              />
            )}
            <span className="whitespace-nowrap">{tab.label}</span>
            {tab.count !== undefined && (
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums',
                  isActive ? 'bg-teal-50 text-teal-700' : 'bg-white/70 text-slate-500',
                )}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
