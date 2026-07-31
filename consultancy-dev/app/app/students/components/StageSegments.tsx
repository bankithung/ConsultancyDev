'use client';

import { cn } from '@/lib/utils';

/**
 * Pipeline stage selector, with each stage's size on the segment itself.
 *
 * This replaces a row of KPI cards that were also the stage switcher — a
 * control doing two jobs, where neither read as clickable. Putting the number
 * on the segment keeps the information (how many students are at this stage)
 * while making the interaction obvious, and removes a whole band from the page.
 *
 * `—` while loading rather than 0: a zero is an answer, and showing one before
 * the count arrives states something false.
 */
export interface StageSegment<T extends string> {
  value: T;
  label: string;
  /** Short label for narrow screens. */
  shortLabel: string;
  count: number;
  isLoading: boolean;
  /** Tailwind text colour for the count when this segment is selected. */
  accent: string;
}

interface StageSegmentsProps<T extends string> {
  segments: ReadonlyArray<StageSegment<T>>;
  value: T;
  onChange: (value: T) => void;
}

export function StageSegments<T extends string>({ segments, value, onChange }: StageSegmentsProps<T>) {
  return (
    <div
      role="group"
      aria-label="Pipeline stage"
      className="flex w-full shrink-0 items-center gap-0.5 rounded-lg bg-slate-100 p-0.5 sm:w-auto"
    >
      {segments.map((segment) => {
        const isActive = segment.value === value;
        return (
          <button
            key={segment.value}
            type="button"
            aria-pressed={isActive}
            onClick={() => onChange(segment.value)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors sm:flex-none sm:px-3',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500',
              isActive
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-700',
            )}
          >
            <span className="hidden sm:inline">{segment.label}</span>
            <span className="sm:hidden">{segment.shortLabel}</span>
            <span
              className={cn(
                'text-[11px] font-semibold tabular-nums',
                isActive ? segment.accent : 'text-slate-400',
              )}
            >
              {segment.isLoading ? '—' : segment.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
