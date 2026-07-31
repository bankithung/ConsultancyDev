'use client';

import * as React from 'react';
import { DayPicker } from 'react-day-picker';

import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';

/**
 * Ported from the kikonsDev build, which targeted react-day-picker v8.
 *
 * v9 renamed every classNames key (`caption` -> `month_caption`, `nav_button`
 * -> `button_previous`/`button_next`, `head_row` -> `weekdays`, `row` -> `week`,
 * `cell` -> `day`, `day` -> `day_button`) and moved selection states from
 * `day_selected`/`day_today` to `selected`/`today`. This project is on v10, so
 * the map below uses the current names; the visual result is unchanged.
 */
export type CalendarProps = React.ComponentProps<typeof DayPicker>;

function Calendar({ className, classNames, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('p-3', className)}
      classNames={{
        months: 'flex flex-col sm:flex-row gap-4',
        month: 'flex flex-col gap-4',
        month_caption: 'flex justify-center pt-1 relative items-center h-7',
        caption_label: 'text-sm font-medium',
        nav: 'flex items-center gap-1 absolute inset-x-0 top-1 justify-between px-1',
        button_previous: cn(
          buttonVariants({ variant: 'outline' }),
          'h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100',
        ),
        button_next: cn(
          buttonVariants({ variant: 'outline' }),
          'h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100',
        ),
        month_grid: 'w-full border-collapse',
        weekdays: 'flex',
        weekday: 'text-slate-500 rounded-md w-9 font-normal text-[0.8rem]',
        week: 'flex w-full mt-2',
        day: 'h-9 w-9 text-center text-sm p-0 relative focus-within:relative focus-within:z-20',
        day_button: cn(
          buttonVariants({ variant: 'ghost' }),
          'h-9 w-9 p-0 font-normal aria-selected:opacity-100',
        ),
        selected: 'bg-teal-600 text-white hover:bg-teal-600 hover:text-white focus:bg-teal-600',
        today: 'bg-slate-100 text-slate-900',
        outside: 'text-slate-400 opacity-50',
        disabled: 'text-slate-400 opacity-50',
        range_start: 'rounded-l-md',
        range_middle: 'aria-selected:bg-teal-50 aria-selected:text-teal-900 rounded-none',
        range_end: 'rounded-r-md',
        hidden: 'invisible',
        ...classNames,
      }}
      {...props}
    />
  );
}
Calendar.displayName = 'Calendar';

export { Calendar };
