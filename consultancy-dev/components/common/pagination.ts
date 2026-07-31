/**
 * Pagination helpers shared by list views.
 *
 * Most list endpoints return a `Paginated<T>` envelope, but a few actions are
 * plain APIViews that return a bare array (`users/counselors/`, the analytics
 * endpoints). `toArray` normalises both so a caller can map over the result
 * without first knowing which shape it received — the mismatch that produced
 * "x.map is not a function" when the API moved from bare arrays to envelopes.
 */

import type { Paginated } from '@/lib/types';

export type MaybePaginated<T> = Paginated<T> | T[] | null | undefined;

function isEnvelope<T>(value: NonNullable<MaybePaginated<T>>): value is Paginated<T> {
  return !Array.isArray(value) && Array.isArray((value as Paginated<T>).results);
}

/** Rows from either shape. Never throws; returns [] for null/undefined. */
export function toArray<T>(value: MaybePaginated<T>): T[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  return isEnvelope(value) ? value.results : [];
}

/** Total row count, falling back to the length of a bare array. */
export function toCount<T>(value: MaybePaginated<T>): number {
  if (value == null) return 0;
  if (Array.isArray(value)) return value.length;
  return isEnvelope(value) ? value.count : 0;
}

/** True when there are no rows — for choosing an empty state. */
export function isEmpty<T>(value: MaybePaginated<T>): boolean {
  return toArray(value).length === 0;
}

/** Page numbers to render, with `null` marking an elided gap. */
export function pageWindow(page: number, pages: number, span = 2): (number | null)[] {
  if (pages <= 1) return pages === 1 ? [1] : [];

  const shown = new Set<number>([1, pages]);
  for (let p = page - span; p <= page + span; p += 1) {
    if (p >= 1 && p <= pages) shown.add(p);
  }

  const ordered = [...shown].sort((a, b) => a - b);
  const out: (number | null)[] = [];
  let previous = 0;
  for (const p of ordered) {
    if (previous && p - previous > 1) out.push(null);
    out.push(p);
    previous = p;
  }
  return out;
}

export { PaginationBar } from './PaginationBar';
