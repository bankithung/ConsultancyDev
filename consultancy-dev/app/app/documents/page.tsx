'use client';

import { Suspense, useCallback } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ArrowRightLeft, ExternalLink, FileText, FolderOpen, Send } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { BookmarkTabs } from '@/components/common/BookmarkTabs';
import { LoadingState } from '@/components/common/states';
import { DocumentList } from './components/DocumentList';
import { DocumentTransfer } from './components/DocumentTransfer';
import { DocumentTracking } from './components/DocumentTracking';
import { PhysicalDocumentList } from './components/PhysicalDocumentList';
import { PhysicalDocumentTransfer } from './components/PhysicalDocumentTransfer';
import { resolveTab, sectionForTab, type DocumentSection, type TabValue } from './tabs';

/**
 * Documents hub.
 *
 * Three sections — digital, physical, tracking — chosen from the sidebar, with
 * two sub-tabs inside each of the first two. The URL still carries only
 * `?tab=`, and the section is derived from it (see ./tabs), so a link, a
 * bookmark or the back button lands exactly where it always did. The older
 * routes that survive (/app/document-transfer, /app/documents/expiry) still
 * cross-link into the right place; /app/document-tracking now redirects here.
 *
 * The panel below the rail is the ONLY card on this screen. Each of the five
 * children used to bring its own heading and its own `Card`, which stacked
 * three surfaces deep once they moved inside the panel; they now render bare
 * sections and the title, the blurb and the cross-link live here.
 */

interface SectionTab {
  value: TabValue;
  label: string;
  icon: LucideIcon;
}

/**
 * Two tabs per section at most, so the labels can be bare nouns: the sidebar
 * has already said "Digital" or "Physical", and repeating it here would put
 * the same word on both tabs.
 */
const SECTION_TABS: Record<DocumentSection, ReadonlyArray<SectionTab>> = {
  digital: [
    { value: 'digital', label: 'Documents', icon: FileText },
    { value: 'digital-transfer', label: 'Transfer', icon: Send },
  ],
  physical: [
    { value: 'physical', label: 'Documents', icon: FolderOpen },
    { value: 'physical-transfer', label: 'Transfer', icon: ArrowRightLeft },
  ],
  // Tracking is a single view. A rail holding one tab is decoration.
  tracking: [],
};

const SECTION_TITLE: Record<DocumentSection, string> = {
  digital: 'Digital documents',
  physical: 'Physical documents',
  tracking: 'Document tracking',
};

const TAB_DESCRIPTION: Record<TabValue, string> = {
  digital: 'Uploaded copies, and whether each one is still in the office’s custody',
  'digital-transfer':
    'Hand custody of documents to a colleague. They accept or reject from their transfers inbox.',
  physical: 'Originals the office is holding, and who has each one right now',
  'physical-transfer': 'Move originals between colleagues, or hand them back to the student',
  tracking: 'Recent uploads and custody changes across your documents',
};

/**
 * Standalone route that mirrors a tab, for the cross-link.
 *
 * No `tracking` entry: /app/document-tracking redirects here now, so the link
 * would have been a loop back to the page it was rendered on.
 */
const STANDALONE_ROUTE: Partial<Record<TabValue, { href: string; label: string }>> = {
  digital: { href: '/app/documents/expiry', label: 'Expiry tracking' },
  'digital-transfer': { href: '/app/document-transfer', label: 'Full transfer page' },
};

function DocumentsTabs() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeTab = resolveTab(searchParams.get('tab'));
  const section = sectionForTab(activeTab);
  const tabs = SECTION_TABS[section];
  const hasTabs = tabs.length > 0;

  const handleTabChange = useCallback(
    (value: TabValue) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('tab', value);
      // `replace` keeps tab switching out of the history stack's way while
      // still making the current tab linkable.
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const standalone = STANDALONE_ROUTE[activeTab];

  return (
    <div className="pt-1">
      {hasTabs && (
        <BookmarkTabs
          tabs={tabs}
          value={activeTab}
          onChange={handleTabChange}
          aria-label={`${SECTION_TITLE[section]} view`}
        />
      )}

      {/*
        One panel: the tabs sit on its top edge and the whole of the selected
        view is inside it, so the screen reads as a single object.

        The tab semantics and the squared corner are BOTH conditional on there
        being a rail. A `tabpanel` with no tablist above it is a lie to a
        screen reader — `aria-labelledby` would point at an id that was never
        rendered — and the square top-left corner exists only to receive the
        first tab, so on tracking it would be a notch cut for a tab that is
        never coming.
      */}
      <section
        {...(hasTabs
          ? {
              role: 'tabpanel',
              id: `panel-${activeTab}`,
              'aria-labelledby': `tab-${activeTab}`,
            }
          : {})}
        className={cn(
          'overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm',
          hasTabs && 'rounded-tl-none',
        )}
      >
        <div className="flex flex-col gap-2 border-b border-slate-100 p-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-900">{SECTION_TITLE[section]}</h2>
            <p className="mt-0.5 text-sm text-slate-600">{TAB_DESCRIPTION[activeTab]}</p>
          </div>

          {/*
            The cross-link belongs here rather than on the tab row: the rail
            scrolls horizontally, and anything parked beside it either gets
            dragged out of reach or forces the rail to shrink. In the header it
            also sits next to the blurb describing what it is a fuller view of.
          */}
          {standalone && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0 self-start text-xs text-slate-600"
              asChild
            >
              <Link href={standalone.href}>
                {standalone.label}
                <ExternalLink size={13} className="ml-1.5" />
              </Link>
            </Button>
          )}
        </div>

        {/*
          Only the open tab is mounted. Keeping all five alive would fire every
          document, transfer and custody query on a screen showing one of them.
        */}
        {activeTab === 'digital' && <DocumentList />}
        {activeTab === 'digital-transfer' && <DocumentTransfer />}
        {activeTab === 'physical' && <PhysicalDocumentList />}
        {activeTab === 'physical-transfer' && <PhysicalDocumentTransfer />}
        {activeTab === 'tracking' && <DocumentTracking />}
      </section>
    </div>
  );
}

export default function DocumentsPage() {
  // `useSearchParams` needs a Suspense boundary to avoid opting the whole route
  // out of static rendering.
  return (
    <Suspense fallback={<LoadingState rows={4} label="Loading documents…" />}>
      <DocumentsTabs />
    </Suspense>
  );
}
