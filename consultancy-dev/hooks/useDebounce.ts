'use client';

import { useEffect, useState } from 'react';

/**
 * Returns `value` after it has stopped changing for `delay` ms.
 *
 * Typical use is a search box feeding a server-side `?search=` query, so that
 * typing does not fire a request per keystroke.
 *
 * @example
 * const [search, setSearch] = useState('');
 * const debouncedSearch = useDebounce(search, 300);
 * const { data } = usePaginatedQuery(['users', debouncedSearch], apiClient.users.list, { search: debouncedSearch });
 */
export function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
