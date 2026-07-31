/**
 * Shared vocabulary for the student-profile / students / my-students screens.
 *
 * The old build read these from `lib/utils`, which in this build only exports
 * `cn`. They live here rather than in `lib/` because nothing outside this
 * feature consumes them.
 */

import type { Enquiry } from '@/lib/types';

/** The three record kinds a student profile can be opened for. */
export const PROFILE_TYPES = ['enquiry', 'registration', 'enrollment'] as const;

export type ProfileType = (typeof PROFILE_TYPES)[number];

export function isProfileType(value: string): value is ProfileType {
  return (PROFILE_TYPES as readonly string[]).includes(value);
}

/** Courses the consultancy places students into. Free text on the wire. */
export const COURSES = [
  'MBBS',
  'BDS',
  'BAMS',
  'BHMS',
  'Engineering',
  'Pharmacy',
  'Nursing',
  'Physiotherapy',
  'Paramedical',
  'Other',
] as const;

/** Education hubs offered as tick-boxes on an enquiry. */
export const PREFERRED_LOCATIONS = [
  'Bangalore',
  'Chennai',
  'Delhi',
  'Hyderabad',
  'Mumbai',
  'Pune',
  'Kota',
  'Overseas',
] as const;

export const CLASS_12_STREAMS: readonly Enquiry['stream'][] = ['Science', 'Commerce', 'Arts'];

export const ENQUIRY_STATUSES: readonly Enquiry['status'][] = ['New', 'Contacted', 'Converted', 'Closed'];

/*
 * `paymentMethod` and `paymentStatus` are free CharFields server-side — the
 * unions in `lib/types` widen to `string`. These lists are the values the app
 * produces, so the pickers stay consistent without pretending the API validates
 * them.
 */
export const PAYMENT_METHODS = ['Cash', 'Card', 'UPI', 'Bank Transfer', 'Cheque', 'Other'] as const;

export const PAYMENT_STATUSES = ['Paid', 'Pending', 'Partial'] as const;

/* -------------------------------------------------------------------------- */
/* Numeric form fields                                                         */
/* -------------------------------------------------------------------------- */

/*
 * Number inputs are held as strings in every form here.
 *
 * `z.coerce.number()` makes a schema whose input type differs from its output
 * type, which is what forced the `@ts-ignore` above `zodResolver(...)` in the
 * older forms in this repo. Keeping the field a string means input === output,
 * the resolver's generics line up, and the conversion happens once — here —
 * where an empty box can be told apart from a zero.
 */

/** A numeric string, or empty. Anything else is rejected by the schema. */
export const NUMERIC_FIELD = /^$|^-?\d+(\.\d+)?$/;

/** `''` -> undefined, so an untouched box is omitted rather than sent as 0. */
export function toOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Same as `toOptionalNumber` but falls back to `fallback` for empty input. */
export function toNumber(value: string | undefined, fallback = 0): number {
  return toOptionalNumber(value) ?? fallback;
}

/** Renders a number back into a form field without turning 0 into ''. */
export function fromNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

/** `₹1,20,000` — Indian digit grouping, no decimals. */
export function formatCurrency(value: number | null | undefined): string {
  return `₹${Number(value ?? 0).toLocaleString('en-IN')}`;
}

/**
 * A record id as the number a foreign key holds, or null when it is not numeric.
 *
 * Ids are typed as strings across this app. Comparing `fk === Number(id)` on a
 * non-numeric id yields `NaN`, which never equals anything — so every row would
 * be filtered out and a student's payments would silently render as empty.
 * Returning null lets the caller fall back to matching by name instead.
 */
export function toForeignKey(id: string | null | undefined): number | null {
  if (id === null || id === undefined || id.trim() === '') return null;
  const parsed = Number(id);
  return Number.isInteger(parsed) ? parsed : null;
}

/** Trimmed, case-insensitive name comparison used to link records by student. */
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** `2024-05-01` for a date input, from an ISO timestamp or date. */
export function toDateInput(value: string | null | undefined): string {
  if (!value) return '';
  return value.split('T')[0] ?? '';
}
