'use client';

import { useCallback, useState } from 'react';
import { keepPreviousData, useQuery, type QueryKey } from '@tanstack/react-query';
import type { PageParams, Paginated } from '@/lib/types';
import { getApiErrorMessage } from '@/lib/api';

export interface UsePaginatedQueryOptions {
  /** Rows per page. Defaults to 25 (the backend default); capped at 200. */
  pageSize?: number;
  /** Server-side search term. Changing it resets to page 1. */
  search?: string;
  /** Server-side ordering, e.g. `-created_at`. Changing it resets to page 1. */
  ordering?: string;
  /**
   * Field filters, e.g. `{status: 'Pending'}` or `{status: ['New', 'Closed']}`
   * for "any of". Changing them resets to page 1. Only fields the endpoint
   * declares work -- see `PageParams.filters`.
   */
  filters?: Record<string, string | number | boolean | readonly string[]>;
  /** Set false to hold the request (e.g. until a dependency is known). */
  enabled?: boolean;
}

export interface UsePaginatedQueryResult<T> {
  /** Rows for the current page. Always an array, never undefined. */
  rows: T[];
  /** Total rows across all pages. */
  count: number;
  /** Total number of pages. */
  pages: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
  hasPrevious: boolean;
  setPage: (page: number) => void;
  nextPage: () => void;
  previousPage: () => void;
  isLoading: boolean;
  /** True while any fetch is in flight, including background page changes. */
  isFetching: boolean;
  isError: boolean;
  /** Displayable message from the API's `{error}` body, or null. */
  error: string | null;
  refetch: () => void;
  /** True when the request succeeded and there is genuinely nothing to show. */
  isEmpty: boolean;
}

/**
 * Drives a paginated list endpoint: owns the page cursor, threads
 * search/ordering through, and flattens the envelope for rendering.
 *
 * `fetcher` is any `apiClient.<resource>.list`.
 *
 * @example
 * const users = usePaginatedQuery(['users'], apiClient.users.list, { search: debounced });
 * users.rows.map(...)          // User[]
 * users.setPage(users.page + 1)
 */
export function usePaginatedQuery<T>(
  key: QueryKey,
  // `params` is optional to match every `apiClient.*.list`, which declares
  // `(params: PageParams = {})`. With a required parameter here, a row-type
  // mismatch surfaced as a confusing "fetcher is not assignable" error instead
  // of pointing at the actual culprit.
  fetcher: (params?: PageParams) => Promise<Paginated<T>>,
  options: UsePaginatedQueryOptions = {}
): UsePaginatedQueryResult<T> {
  const { pageSize = 25, search, ordering, filters, enabled = true } = options;

  const [page, setPage] = useState(1);

  // Serialised so a caller passing an inline object literal does not reset the
  // page on every render.
  const filterKey = JSON.stringify(filters ?? {});
  const queryShape = `${search ?? ''}|${ordering ?? ''}|${pageSize}|${filterKey}`;

  // A new search, sort or filter invalidates the current cursor -- page 7 of
  // the old result set is meaningless (and often out of range) for the new one.
  //
  // Adjusted during render rather than in an effect: React re-runs this
  // component immediately with the corrected page, so no request is ever issued
  // for the stale cursor. Doing it in useEffect would fire one throwaway fetch
  // for the old page first (and trips react-hooks/set-state-in-effect).
  const [prevQueryShape, setPrevQueryShape] = useState(queryShape);
  if (prevQueryShape !== queryShape) {
    setPrevQueryShape(queryShape);
    setPage(1);
  }

  const query = useQuery({
    queryKey: [...key, { page, pageSize, search, ordering, filterKey }],
    queryFn: () => fetcher({ page, page_size: pageSize, search, ordering, filters }),
    enabled,
    // Keeps the previous page on screen while the next one loads, instead of
    // flashing an empty table.
    placeholderData: keepPreviousData,
  });

  const envelope = query.data;

  const goToPage = useCallback((next: number) => {
    setPage(next > 1 ? next : 1);
  }, []);

  const nextPage = useCallback(() => {
    setPage((current) => current + 1);
  }, []);

  const previousPage = useCallback(() => {
    setPage((current) => (current > 1 ? current - 1 : 1));
  }, []);

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);

  return {
    rows: envelope?.results ?? [],
    count: envelope?.count ?? 0,
    pages: envelope?.pages ?? 0,
    page: envelope?.page ?? page,
    pageSize: envelope?.page_size ?? pageSize,
    hasNext: envelope?.next !== null && envelope?.next !== undefined,
    hasPrevious: envelope?.previous !== null && envelope?.previous !== undefined,
    setPage: goToPage,
    nextPage,
    previousPage,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error ? getApiErrorMessage(query.error) : null,
    refetch,
    isEmpty: query.isSuccess && (envelope?.count ?? 0) === 0,
  };
}
