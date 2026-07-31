import type { PageParams, Paginated } from '@/lib/types';

/**
 * Walks every page of a list endpoint and returns the rows.
 *
 * The profile's money panels (paid / refunded totals) are wrong unless they see
 * every row for the student, and no list endpoint accepts a `student_name`
 * filter — see `PageParams.filters` for the fields each endpoint actually
 * honours. So we narrow with `search` server-side, pull the result set, and do
 * the exact-name match on the client.
 *
 * Bounded by `maxPages` so a mis-typed search cannot spin off hundreds of
 * requests; one student's history is never near the ceiling.
 */
export async function loadAllPages<T>(
  fetchPageOf: (params: PageParams) => Promise<Paginated<T>>,
  params: Omit<PageParams, 'page' | 'page_size'> = {},
  pageSize = 100,
  maxPages = 20,
): Promise<T[]> {
  const rows: T[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const envelope = await fetchPageOf({ ...params, page, page_size: pageSize });
    rows.push(...envelope.results);
    totalPages = envelope.pages;
    page += 1;
  } while (page <= totalPages && page <= maxPages);

  return rows;
}
