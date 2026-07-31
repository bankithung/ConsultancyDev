'use client';

import { useMemo, useState } from 'react';
import { Check, Search, Users } from 'lucide-react';
import { Input } from '@/components/ui/input';
import type { User } from '@/lib/types';

interface ManagerMultiSelectProps {
  /** Every BRANCH_MANAGER the admin may choose from. */
  options: User[];
  selected: number[];
  onChange: (next: number[]) => void;
  disabled?: boolean;
}

/**
 * Picks which BRANCH_MANAGERs a HEAD_MANAGER oversees.
 *
 * A plain scrollable checkbox list rather than a popover — it has to work on a
 * 375px screen inside an already-scrolling modal, where a nested popover is
 * awkward to dismiss.
 */
export function ManagerMultiSelect({ options, selected, onChange, disabled = false }: ManagerMultiSelectProps) {
  const [filter, setFilter] = useState('');

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => {
      const haystack = `${option.full_name} ${option.username} ${option.email} ${option.branch_name ?? ''}`;
      return haystack.toLowerCase().includes(needle);
    });
  }, [options, filter]);

  const toggle = (id: number) => {
    onChange(selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]);
  };

  if (options.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center">
        <Users className="mx-auto h-5 w-5 text-slate-400" />
        <p className="mt-2 text-sm text-slate-600">No branch managers exist yet</p>
        <p className="mt-0.5 text-xs text-slate-500">Create branch managers first, then assign them here.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200">
      <div className="border-b border-slate-100 p-2">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter branch managers…"
            aria-label="Filter branch managers"
            className="h-9 pl-8 text-sm"
            disabled={disabled}
          />
        </div>
      </div>

      <ul className="max-h-52 overflow-y-auto p-1">
        {visible.length === 0 && (
          <li className="px-3 py-4 text-center text-sm text-slate-500">No managers match “{filter}”</li>
        )}
        {visible.map((option) => {
          const isSelected = selected.includes(option.id);
          return (
            <li key={option.id}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => toggle(option.id)}
                aria-pressed={isSelected}
                className={`flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors disabled:opacity-50 ${
                  isSelected ? 'bg-teal-50' : 'hover:bg-slate-50'
                }`}
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                    isSelected ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-300 bg-white'
                  }`}
                  aria-hidden
                >
                  {isSelected && <Check size={11} strokeWidth={3} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-900">{option.full_name}</span>
                  <span className="block truncate text-xs text-slate-500">
                    {option.branch_name ? option.branch_name : 'No branch'} · {option.email}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-3 py-2">
        <span className="text-xs text-slate-600">
          {selected.length} of {options.length} selected
        </span>
        {selected.length > 0 && !disabled && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-xs font-semibold text-teal-700 hover:underline"
          >
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}
