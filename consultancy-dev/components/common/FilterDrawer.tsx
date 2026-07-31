'use client';

import { useMemo, useState } from 'react';
import { Check, ChevronRight, Search } from 'lucide-react';

import { Drawer } from '@/components/common/Drawer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterGroup {
  /** Query parameter this group writes to, and its key in the selection. */
  param: string;
  label: string;
  options: FilterOption[];
  /** Adds a search box to the option pane. Long vocabularies need one. */
  searchable?: boolean;
  /** Say what the filter actually matches when the label cannot carry it. */
  hint?: string;
}

/** `{status: ['New', 'Contacted']}` — an absent or empty key means no filter. */
export type FilterSelection = Record<string, string[]>;

export function selectionCount(selection: FilterSelection): number {
  return Object.values(selection).reduce((total, values) => total + values.length, 0);
}

interface FilterDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: FilterGroup[];
  selection: FilterSelection;
  onChange: (next: FilterSelection) => void;
  /** Which group to land on. Used when a chip on the page opens the drawer. */
  activeParam: string;
  onActiveParamChange: (param: string) => void;
  /** What the rows are called, for the header line. e.g. "enquiry". */
  noun?: string;
}

/**
 * The filter panel: categories on the left, the selected category's options on
 * the right.
 *
 * Every filter is multi-select and every one is applied by the SERVER (see
 * core/filters.py) — a filter applied in the browser could only narrow the rows
 * already fetched, so it would hide matches on later pages while the row count
 * kept reporting the unfiltered total.
 *
 * Selections take effect as they are made rather than on an "Apply" press. The
 * panel is narrower than the page for exactly that reason: the table keeps
 * updating beside it, so the drawer previews its own effect.
 *
 * The panel shell — slide animation, scrim, header, footer — lives in
 * `Drawer`; this file is only the two-pane picker inside it.
 */
export function FilterDrawer({
  open,
  onOpenChange,
  groups,
  selection,
  onChange,
  activeParam,
  onActiveParamChange,
  noun = 'record',
}: FilterDrawerProps) {
  const [optionSearch, setOptionSearch] = useState('');

  const active = groups.find((group) => group.param === activeParam) ?? groups[0];
  const activeValues = active ? (selection[active.param] ?? []) : [];

  const visibleOptions = useMemo(() => {
    if (!active) return [];
    const term = optionSearch.trim().toLowerCase();
    if (!term || !active.searchable) return active.options;
    return active.options.filter((option) => option.label.toLowerCase().includes(term));
  }, [active, optionSearch]);

  const total = selectionCount(selection);

  const setGroupValues = (param: string, values: string[]) => {
    const next = { ...selection };
    if (values.length === 0) delete next[param];
    else next[param] = values;
    onChange(next);
  };

  const toggleOption = (param: string, value: string) => {
    const current = selection[param] ?? [];
    setGroupValues(
      param,
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    );
  };

  const selectGroup = (param: string) => {
    onActiveParamChange(param);
    setOptionSearch('');
  };

  // "Select all" acts on what is ON SCREEN. With a search term applied, a
  // button that silently also took the 30 hidden options would be a trap.
  const allVisibleSelected =
    visibleOptions.length > 0 && visibleOptions.every((option) => activeValues.includes(option.value));

  const toggleAllVisible = () => {
    if (!active) return;
    const visibleValues = visibleOptions.map((option) => option.value);
    setGroupValues(
      active.param,
      allVisibleSelected
        ? activeValues.filter((value) => !visibleValues.includes(value))
        : Array.from(new Set([...activeValues, ...visibleValues])),
    );
  };

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="Filters"
      description={
        total === 0
          ? `Showing every ${noun} you can see`
          : `${total} filter${total === 1 ? '' : 's'} applied`
      }
      panelClassName="sm:max-w-xl lg:max-w-3xl"
      // The category rail and the option list scroll individually, so the shell
      // must not. `overflow-y-hidden` rather than `overflow-hidden` so it
      // cancels the Drawer's default cleanly — see the note on `bodyClassName`.
      bodyClassName="overflow-y-hidden"
      footer={
        <div className="flex items-center justify-between gap-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9 text-xs text-slate-600 hover:text-slate-900"
            onClick={() => onChange({})}
            disabled={total === 0}
          >
            Clear all
          </Button>
          <Button
            size="sm"
            className="h-9 bg-teal-600 px-5 text-xs hover:bg-teal-700"
            onClick={() => onOpenChange(false)}
          >
            Show results
          </Button>
        </div>
      }
    >
      {/*
        Two panes from `sm` up. On a phone the category rail turns into a
        horizontal strip of chips instead of a 120px column squeezed beside
        the options — the same idiom the enquiry detail modal already uses.
      */}
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav
          aria-label="Filter categories"
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50 p-2 sm:w-56 sm:flex-col sm:overflow-x-visible sm:overflow-y-auto sm:border-b-0 sm:border-r"
        >
          {groups.map((group) => {
            const count = (selection[group.param] ?? []).length;
            const isActive = active?.param === group.param;
            return (
              <button
                key={group.param}
                type="button"
                onClick={() => selectGroup(group.param)}
                aria-current={isActive ? 'true' : undefined}
                className={cn(
                  'flex shrink-0 items-center justify-between gap-2 whitespace-nowrap rounded-md px-3 py-2 text-left text-sm transition-colors',
                  isActive
                    ? 'bg-white font-medium text-teal-700 shadow-sm ring-1 ring-teal-200'
                    : 'text-slate-600 hover:bg-white/70 hover:text-slate-900',
                )}
              >
                <span className="truncate">{group.label}</span>
                {count > 0 ? (
                  <span className="shrink-0 rounded-full bg-teal-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                    {count}
                  </span>
                ) : (
                  <ChevronRight size={14} className="hidden shrink-0 text-slate-300 sm:block" />
                )}
              </button>
            );
          })}
        </nav>

        <section
          className="flex min-h-0 flex-1 flex-col"
          aria-label={active ? `${active.label} options` : 'Options'}
        >
          {active && (
            <>
              <div className="border-b border-slate-100 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-slate-900">{active.label}</h3>
                    <p className="text-xs text-slate-500">
                      {active.hint ?? 'Pick as many as you need — matches any of them.'}
                    </p>
                  </div>
                  {visibleOptions.length > 0 && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-8 shrink-0 px-2 text-xs text-teal-700 hover:bg-teal-50"
                      onClick={toggleAllVisible}
                    >
                      {allVisibleSelected ? 'Clear these' : `Select all ${visibleOptions.length}`}
                    </Button>
                  )}
                </div>

                {active.searchable && (
                  <div className="relative mt-3">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <Input
                      value={optionSearch}
                      onChange={(event) => setOptionSearch(event.target.value)}
                      placeholder={`Search ${active.label.toLowerCase()}…`}
                      aria-label={`Search ${active.label}`}
                      className="h-9 border-slate-200 pl-9 text-sm focus:border-teal-500 focus:ring-teal-500"
                    />
                  </div>
                )}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {visibleOptions.length === 0 ? (
                  <p className="px-2 py-8 text-center text-sm text-slate-500">
                    {active.options.length === 0
                      ? 'Nothing to filter on yet.'
                      : `No ${active.label.toLowerCase()} matches “${optionSearch}”.`}
                  </p>
                ) : (
                  <ul className="space-y-0.5">
                    {visibleOptions.map((option) => {
                      const checked = activeValues.includes(option.value);
                      return (
                        <li key={option.value}>
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={checked}
                            onClick={() => toggleOption(active.param, option.value)}
                            className={cn(
                              'flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm transition-colors',
                              checked ? 'bg-teal-50 text-teal-900' : 'text-slate-700 hover:bg-slate-50',
                            )}
                          >
                            <span
                              className={cn(
                                'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                                checked ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-300 bg-white',
                              )}
                            >
                              {checked && <Check size={12} strokeWidth={3} />}
                            </span>
                            <span className="min-w-0 flex-1 break-words">{option.label}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </Drawer>
  );
}
