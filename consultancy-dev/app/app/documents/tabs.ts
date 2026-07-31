/**
 * The documents URL contract.
 *
 * It lives in its own module because two trees depend on it: the page renders
 * from it, and the sidebar highlights from it. A second copy in the sidebar
 * would rot the first time an alias was added.
 *
 * `?tab=` is the ONLY thing the URL carries. The SECTION — which sidebar child
 * is lit, and which sub-tabs the page offers — is derived from the tab, so
 * every historic link keeps resolving and there is no second parameter that
 * can disagree with the first.
 */

export const DOCUMENTS_PATH = '/app/documents';

export const TABS = ['digital', 'digital-transfer', 'physical', 'physical-transfer', 'tracking'] as const;
export type TabValue = (typeof TABS)[number];

export const DEFAULT_TAB: TabValue = 'digital';

/** Historic `?tab=` values that must keep working. */
export const TAB_ALIASES: Record<string, TabValue> = {
  documents: 'digital',
  transfer: 'digital-transfer',
  transfers: 'digital-transfer',
  'document-transfer': 'digital-transfer',
  expiry: 'digital',
  'documents-expiry': 'digital',
  physicaldocs: 'physical',
  'physical-docs': 'physical',
  'physical-transfer': 'physical-transfer',
  'document-tracking': 'tracking',
  track: 'tracking',
};

export function resolveTab(raw: string | null): TabValue {
  if (raw === null) return DEFAULT_TAB;
  if ((TABS as readonly string[]).includes(raw)) return raw as TabValue;
  return TAB_ALIASES[raw] ?? DEFAULT_TAB;
}

/** The three things the sidebar offers. Digital and physical each hold two tabs. */
export type DocumentSection = 'digital' | 'physical' | 'tracking';

const TAB_SECTION: Record<TabValue, DocumentSection> = {
  digital: 'digital',
  'digital-transfer': 'digital',
  physical: 'physical',
  'physical-transfer': 'physical',
  tracking: 'tracking',
};

export function sectionForTab(tab: TabValue): DocumentSection {
  return TAB_SECTION[tab];
}
