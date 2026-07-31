'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * Tracks a CSS media query.
 *
 * Uses `useSyncExternalStore` so the match is read during render instead of
 * being copied into state by an effect. The previous version listed `matches`
 * in its own effect's dependencies, so every change tore down and re-attached
 * the listener. The third argument is the server snapshot: `false`, matching
 * the pre-hydration render.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    [query]
  );

  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
