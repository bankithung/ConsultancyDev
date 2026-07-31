/**
 * The engagements URL contract.
 *
 * It lives in its own module because two trees depend on it: the page renders
 * from it, and the sidebar highlights from it. A second copy in the sidebar
 * would rot the first time an alias was added.
 *
 * `?tab=` is the ONLY thing the URL carries, so a link, a bookmark or the back
 * button lands exactly where it did before the two screens were merged.
 */

export const ENGAGEMENTS_PATH = '/app/engagements';

export const TABS = ['follow-ups', 'appointments'] as const;
export type TabValue = (typeof TABS)[number];

export const DEFAULT_TAB: TabValue = 'follow-ups';

/**
 * Spellings that must keep resolving.
 *
 * Falling back to the default for these would be silent and wrong: someone
 * following a `?tab=appointment` link would land on follow-ups and have no way
 * to tell that the app had ignored them.
 */
export const TAB_ALIASES: Record<string, TabValue> = {
  followups: 'follow-ups',
  follow_ups: 'follow-ups',
  followup: 'follow-ups',
  'follow-up': 'follow-ups',
  appointment: 'appointments',
  appointments: 'appointments',
  calendar: 'appointments',
};

export function resolveTab(raw: string | null): TabValue {
  if (raw === null) return DEFAULT_TAB;
  if ((TABS as readonly string[]).includes(raw)) return raw as TabValue;
  return TAB_ALIASES[raw.toLowerCase()] ?? DEFAULT_TAB;
}

export const TAB_LABELS: Record<TabValue, string> = {
  'follow-ups': 'Follow-ups',
  appointments: 'Appointments',
};
