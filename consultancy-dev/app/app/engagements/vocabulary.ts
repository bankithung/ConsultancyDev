import { format, parseISO } from 'date-fns';

import type { AdmissionLikelihood, Appointment, FollowUpOutcome } from '@/lib/types';
import type { FilterSelection } from '@/components/common/FilterDrawer';

/*
 * WIRE VOCABULARY for both engagement resources.
 *
 * Follow-up `type`, `status` and `priority` are free CharFields with no
 * `choices`, so these are conventions rather than an enum the server enforces.
 * Appointment `type` and `status` ARE `choices`, but both sides of the wire are
 * plain `string`, so TypeScript cannot police a typo either way.
 *
 * They live in one module because the filter drawer (rendered by the page) and
 * the badges, tones and forms (rendered by the views) must send and read the
 * SAME spellings — any drift between the two silently matches nothing.
 */

export const FOLLOW_UP_TYPES = ['Call', 'Email', 'WhatsApp', 'SMS'] as const;
export const FOLLOW_UP_STATUSES = ['Pending', 'Completed', 'Missed'] as const;
export const FOLLOW_UP_PRIORITIES = ['High', 'Medium', 'Low'] as const;

export const FOLLOW_UP_PENDING = 'Pending';
export const FOLLOW_UP_COMPLETED = 'Completed';

export const OUTCOMES = [
  'Not reached', 'Interested', 'Thinking', 'Not interested', 'Converted',
] as const;
export const LIKELIHOODS = ['High', 'Medium', 'Low', 'Unknown'] as const;

export const APPOINTMENT_TYPES = ['In-Person', 'Video Call', 'Phone Call'] as const;
export const APPOINTMENT_STATUSES = ['Scheduled', 'Completed', 'Cancelled'] as const;

export const APPOINTMENT_DEFAULT_TYPE = 'In-Person';
export const APPOINTMENT_SCHEDULED = 'Scheduled';

export const DURATIONS = [
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '45', label: '45 minutes' },
  { value: '60', label: '1 hour' },
  { value: '90', label: '1.5 hours' },
];

/* ------------------------------------------------------------------ tones */

export const FOLLOW_UP_STATUS_TONES: Record<string, string> = {
  Pending: 'bg-amber-100 text-amber-700 border-amber-200',
  Completed: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  Missed: 'bg-rose-100 text-rose-700 border-rose-200',
};

export const PRIORITY_TONES: Record<string, string> = {
  High: 'bg-rose-100 text-rose-700',
  Medium: 'bg-amber-100 text-amber-700',
  Low: 'bg-slate-100 text-slate-600',
};

export const OUTCOME_TONES: Record<FollowUpOutcome, string> = {
  Converted: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  Interested: 'bg-blue-50 text-blue-700 border-blue-200',
  Thinking: 'bg-amber-50 text-amber-700 border-amber-200',
  'Not reached': 'bg-slate-50 text-slate-600 border-slate-200',
  'Not interested': 'bg-rose-50 text-rose-700 border-rose-200',
};

/**
 * `admission_possibility` is a four-value choice, NOT a 0-100 scale. The old
 * build rendered it as a percentage bar; there is no numeric column behind it,
 * so a bar would be inventing precision the data does not have.
 */
export const LIKELIHOOD_TONES: Record<AdmissionLikelihood, string> = {
  High: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  Medium: 'bg-amber-50 text-amber-700 border-amber-200',
  Low: 'bg-rose-50 text-rose-700 border-rose-200',
  Unknown: 'bg-slate-50 text-slate-600 border-slate-200',
};

export const APPOINTMENT_STATUS_TONES: Record<string, string> = {
  Scheduled: 'bg-blue-50 text-blue-700 border-blue-200',
  Completed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  Cancelled: 'bg-rose-50 text-rose-700 border-rose-200',
};

/** The dot and rail colour a status gets in the calendar and day panel. */
export function appointmentAccent(status: string): string {
  if (status === 'Cancelled') return 'bg-rose-300';
  if (status === 'Completed') return 'bg-emerald-400';
  return 'bg-teal-500';
}

/* ------------------------------------------------------------- KPI filters */

/**
 * The KPI tiles that ARE a filter, and the filter each one applies.
 *
 * Making them clickable is what keeps the numbers honest: the tiles count the
 * whole workload, never the filtered page, so a tile reading 5 beside a table
 * showing 2 would look like a bug. As controls, they instead read as "you are
 * looking at these 5" once the tile lights up.
 */
export const FOLLOW_UP_KPI_FILTERS = {
  total: {},
  pending: { status: [FOLLOW_UP_PENDING] },
  urgent: { status: [FOLLOW_UP_PENDING], priority: ['High'] },
} satisfies Record<string, FilterSelection>;

export const APPOINTMENT_KPI_FILTERS = {
  total: {},
  scheduled: { status: ['Scheduled'] },
  completed: { status: ['Completed'] },
  cancelled: { status: ['Cancelled'] },
} satisfies Record<string, FilterSelection>;

/* ----------------------------------------------------------------- dates */

/** Local date + time inputs to the ISO datetime the wire expects. */
export function toIsoDateTime(date: string, time: string): string | null {
  const parsed = new Date(`${date}T${time}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Never throws on a malformed datetime; the wire value is not validated here. */
export function formatWhen(value: string, pattern: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : format(parsed, pattern);
}

/** `Appointment.date` is a DateTimeField; never let a bad value throw in render. */
export function safeDate(value: string): Date | null {
  const parsed = parseISO(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** `Appointment.time` is a nullable TimeField — fall back to the time part of `date`. */
export function displayTime(appointment: Appointment): string {
  if (appointment.time) return appointment.time.slice(0, 5);
  const parsed = safeDate(appointment.date);
  return parsed ? format(parsed, 'HH:mm') : '—';
}
