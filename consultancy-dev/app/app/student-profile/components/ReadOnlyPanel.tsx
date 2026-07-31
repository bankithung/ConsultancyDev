'use client';

import { Lock } from 'lucide-react';

interface ReadOnlyFieldProps {
  label: string;
  value: string | number | null | undefined;
  /** Rendered immediately before the value, e.g. a currency symbol. */
  prefix?: string;
  suffix?: string;
}

/** One label/value pair. Renders '—' rather than disappearing, so gaps are visible. */
export function ReadOnlyField({ label, value, prefix = '', suffix = '' }: ReadOnlyFieldProps) {
  const isBlank = value === null || value === undefined || value === '';
  return (
    <div className="min-w-0">
      <dt className="truncate text-[10px] font-bold uppercase tracking-widest text-slate-400">{label}</dt>
      <dd className="truncate text-sm font-medium text-slate-800">
        {isBlank ? <span className="text-xs italic text-slate-300">Not recorded</span> : `${prefix}${value}${suffix}`}
      </dd>
    </div>
  );
}

interface ReadOnlyPanelProps {
  title: string;
  children: React.ReactNode;
}

/**
 * Values the API returns but will not accept back.
 *
 * Several enquiry and registration fields survived the backend rebuild on the
 * read serializer but were dropped from the write payload. Rendering them as
 * disabled inputs would imply they are editable; rendering them as plain text
 * with this framing does not.
 */
export function ReadOnlyPanel({ title, children }: ReadOnlyPanelProps) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
      <p className="mb-2.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500">
        <Lock size={10} className="shrink-0" />
        {title}
        <span className="font-normal normal-case tracking-normal text-slate-400">· read-only</span>
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">{children}</dl>
    </div>
  );
}
