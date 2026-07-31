'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
// jspdf is imported dynamically inside `downloadPdf` — see the note there.
import {
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  Filter,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';

import { apiClient } from '@/lib/apiClient';
import type { Payment, PaymentStatus, Refund, RefundStatus } from '@/lib/types';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { useDebounce } from '@/hooks/useDebounce';
import { PaginationBar } from '@/components/common/PaginationBar';
import { EmptyState, ErrorState, InlineSpinner, LoadingState } from '@/components/common/states';
import { PaymentModal } from '@/components/common/PaymentModal';
import { PaymentDetailsModal } from '@/components/common/PaymentDetailsModal';
import { RefundDrawer } from '@/components/common/RefundDrawer';
import { Modal } from '@/components/common/Modal';
import { REFUND_STATUSES } from '@/components/common/payments';
import {
  FilterDrawer,
  selectionCount,
  type FilterGroup,
  type FilterSelection,
} from '@/components/common/FilterDrawer';
import { useCurrentRole } from '@/components/rbac/useCurrentRole';
import { DataTable } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn, getAvatarColor, getInitials } from '@/lib/utils';
import { toast } from '@/store/toastStore';

/**
 * Payments and refunds — one screen, two tabs.
 *
 * Three rules shape this page:
 *
 * 1. Every money figure is a server aggregate. `payments/stats/` sums in SQL
 *    across the caller's whole scope, and the refund totals walk every page.
 *    A payout reduced from one 25-row page of 200 is a wrong number that looks
 *    right, which is worse than no number.
 * 2. Every filter offered here exists in the backend's FilterSet
 *    (`PaymentFilter`, `RefundFilter` in core/filters.py) and every search box
 *    over an endpoint that declares `search_fields`. DRF discards a parameter
 *    it does not recognise and answers 200 with the UNFILTERED list, so a
 *    control with no backing filter looks like it worked and shows wrong data.
 * 3. Refunds are a MANAGER capability (`CAN.manageRefunds`). Everything about
 *    them — the tab, the row action, the totals, and the requests that fetch
 *    them — is behind that one check. See `canManageRefunds` below.
 *
 * The modals and the refund drawer own their own mutations; this page only
 * opens them and invalidates the caches they touch.
 */

/**
 * Column shape accepted by `DataTable`.
 *
 * Declared locally because `components/ui/data-table` exports the component but
 * not the interface.
 */
interface Column<T> {
  header: string;
  accessorKey?: keyof T;
  cell?: (item: T) => React.ReactNode;
  className?: string;
}

/**
 * Rows per page.
 *
 * Matches `DataTable`'s own internal page size, so its client-side pager stays
 * dormant and `PaginationBar` below is the single source of paging. Two pagers
 * over the same rows would let a user sit on "page 2 of 3" inside page 1.
 */
const PAGE_SIZE = 10;

/** Wire values from `Payment.Status`. TypeScript cannot police these — both sides are strings. */
const PAYMENT_STATUSES: readonly PaymentStatus[] = ['Success', 'Pending', 'Failed', 'Refunded'];

/** `Payment.type` is free text server-side; these are the values the app produces. */
const PAYMENT_TYPES = ['Enquiry', 'Registration', 'Enrollment'] as const;

const PAYMENT_METHODS = ['Cash', 'Card', 'UPI', 'Bank Transfer', 'Cheque', 'Other'] as const;

const PAYMENT_STATUS_STYLES: Record<PaymentStatus, string> = {
  Success: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  Pending: 'bg-amber-50 text-amber-700 border-amber-100',
  Failed: 'bg-rose-50 text-rose-700 border-rose-100',
  Refunded: 'bg-purple-50 text-purple-700 border-purple-100',
};

/**
 * Refund statuses are a DIFFERENT vocabulary from payment statuses — there is
 * no `Success` refund and no `Processed` payment.
 */
const REFUND_STATUS_STYLES: Record<RefundStatus, string> = {
  Processed: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  Approved: 'bg-blue-50 text-blue-700 border-blue-100',
  Pending: 'bg-amber-50 text-amber-700 border-amber-100',
  Rejected: 'bg-rose-50 text-rose-700 border-rose-100',
};

const NEUTRAL_BADGE = 'bg-slate-50 text-slate-600 border-slate-200';

type TabId = 'transactions' | 'refunds';

function toOptions(values: readonly string[]) {
  return values.map((value) => ({ value, label: value }));
}

/** Backed by `PaymentFilter`; each param is a `MultiValueFilter` on the server. */
const PAYMENT_FILTER_GROUPS: FilterGroup[] = [
  {
    param: 'status',
    label: 'Status',
    options: toOptions(PAYMENT_STATUSES),
    hint: 'Where the transaction ended up.',
  },
  {
    param: 'type',
    label: 'Type',
    options: toOptions(PAYMENT_TYPES),
    hint: 'What the money was for.',
  },
  {
    param: 'method',
    label: 'Method',
    options: toOptions(PAYMENT_METHODS),
    hint: 'How the money arrived.',
  },
];

/** Backed by `RefundFilter`. Status is the only column a refund is picked by. */
const REFUND_FILTER_GROUPS: FilterGroup[] = [
  {
    param: 'status',
    label: 'Status',
    options: toOptions(REFUND_STATUSES),
    hint: 'Pending and Approved are requests; only Processed has moved money.',
  },
];

/** One chip per category — four selected statuses should not be four chips. */
function toChips(groups: FilterGroup[], selection: FilterSelection) {
  return groups
    .filter((group) => (selection[group.param] ?? []).length > 0)
    .map((group) => {
      const values = selection[group.param] ?? [];
      const only = group.options.find((option) => option.value === values[0]);
      return {
        param: group.param,
        label: group.label,
        detail: values.length === 1 ? (only?.label ?? values[0]) : `${values.length} selected`,
      };
    });
}

function rupees(value: number): string {
  return `₹${Math.round(value).toLocaleString('en-IN')}`;
}

/**
 * Money for the PDF, where the ₹ sign cannot be used.
 *
 * jsPDF's built-in fonts are WinAnsiEncoded and WinAnsi has no U+20B9: the
 * rupee sign goes into the content stream as bytes 0x20 0xB9, so "₹1,200"
 * prints as " ¹1,200". Verified against jspdf 4.2.1. Fixing the glyph properly
 * means embedding a Unicode font — a few hundred KB in the bundle for one
 * character — so the PDF spells the currency instead. Screen and CSV output
 * (UTF-8 with a BOM) keep the ₹ sign.
 */
function rupeesAscii(value: number): string {
  return `INR ${Math.round(value).toLocaleString('en-IN')}`;
}

function formatDay(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : format(date, 'dd MMM yyyy');
}

/* -------------------------------------------------------------------------- */
/* Server aggregates                                                          */
/* -------------------------------------------------------------------------- */

function readNumber(source: unknown, key: string): number {
  if (typeof source !== 'object' || source === null) return 0;
  const value = (source as Record<string, unknown>)[key];
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0;
}

interface PaymentTotals {
  totalRevenue: number;
  thisMonthRevenue: number;
  pendingAmount: number;
  transactionCount: number;
}

/**
 * `payments/stats/` is a scoped SQL aggregate, but the client types its body as
 * `unknown`, so each field is read defensively rather than asserted.
 */
function toPaymentTotals(value: unknown): PaymentTotals {
  return {
    totalRevenue: readNumber(value, 'totalRevenue'),
    thisMonthRevenue: readNumber(value, 'thisMonthRevenue'),
    pendingAmount: readNumber(value, 'pendingAmount'),
    transactionCount: readNumber(value, 'transactionCount'),
  };
}

const SCAN_PAGE_SIZE = 100;
const SCAN_MAX_PAGES = 20;

interface RefundTotals {
  /** Money that has actually left the business. */
  processedAmount: number;
  processedCount: number;
  /** Approved but not yet paid out — a committed liability, not a payout. */
  approvedCount: number;
  truncated: boolean;
}

/**
 * Refund totals.
 *
 * The two counts come off the envelope with no rows transferred, so they are
 * exact totals rather than "how many landed on page one".
 *
 * The payout sum still has to walk the rows, because `refunds/` exposes no
 * aggregate action — but `RefundFilter` now narrows that walk to the refunds
 * that actually moved money instead of every refund ever raised. The scan is
 * bounded by SCAN_MAX_PAGES and `truncated` is surfaced rather than swallowed.
 */
async function fetchRefundTotals(): Promise<RefundTotals> {
  const [processedHead, approvedHead] = await Promise.all([
    apiClient.refunds.list({ page_size: 1, filters: { status: 'Processed' } }),
    apiClient.refunds.list({ page_size: 1, filters: { status: 'Approved' } }),
  ]);

  let processedAmount = 0;
  let scanned = 0;
  let page = 1;
  let pages = 1;

  do {
    const envelope = await apiClient.refunds.list({
      page,
      page_size: SCAN_PAGE_SIZE,
      filters: { status: 'Processed' },
    });
    for (const refund of envelope.results) {
      processedAmount += Number(refund.amount) || 0;
    }
    scanned += envelope.results.length;
    pages = envelope.pages;
    page += 1;
  } while (page <= pages && page <= SCAN_MAX_PAGES);

  return {
    processedAmount,
    processedCount: processedHead.count,
    approvedCount: approvedHead.count,
    truncated: scanned < processedHead.count,
  };
}

/* -------------------------------------------------------------------------- */
/* Export                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Neutralises spreadsheet formula injection.
 *
 * `student_name` and `reference` are user-supplied; a cell opening with =, +,
 * - or @ is executed on open by Excel and Sheets.
 */
function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

function downloadCsv(headers: string[], rows: string[][], filename: string): void {
  const csv = [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n');
  // BOM so Excel reads the rupee sign and non-ASCII names as UTF-8.
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

interface ExportData {
  title: string;
  headers: string[];
  /** Amounts left unformatted so a spreadsheet can sum the column. */
  csvRows: string[][];
  /** Amounts pre-formatted, since a PDF cell is read rather than computed on. */
  pdfRows: string[][];
}

/** Teal 700, matching the app's header colour. */
const PDF_HEAD_FILL: [number, number, number] = [15, 118, 110];

/**
 * One-click PDF download via jspdf + jspdf-autotable.
 *
 * Both are loaded on demand rather than imported at module scope: together
 * they are ~416 KB of minified JS for something reached through a dropdown, and
 * this page has to be usable on a phone. The download itself is unchanged —
 * the chunk is fetched while the rows are being collected.
 *
 * Note the NAMED `jsPDF` binding. jspdf 4.x serves one ESM build for both the
 * `browser` and `default` export conditions, and in it `default` is a namespace
 * OBJECT while `jsPDF` is the constructor — yet `types/index.d.ts` still
 * declares `export default jsPDF`. A default import therefore typechecks and
 * then throws "jsPDF is not a constructor" the first time anyone exports.
 */
async function downloadPdf(
  title: string,
  headers: string[],
  rows: string[][],
  filename: string
): Promise<void> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);

  const doc = new jsPDF();

  doc.setFontSize(18);
  doc.text(title, 14, 22);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Generated ${format(new Date(), 'PPpp')} · ${rows.length} records`, 14, 30);
  doc.setTextColor(0);

  // jspdf-autotable v5 is a function taking the document, not a `doc.autoTable`
  // plugin method — the older call style is gone in this major version.
  autoTable(doc, {
    head: [headers],
    body: rows,
    startY: 38,
    styles: { fontSize: 9, cellPadding: 2.5 },
    headStyles: { fillColor: PDF_HEAD_FILL, halign: 'left' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    didDrawPage: () => {
      const { pageSize } = doc.internal;
      doc.setFontSize(8);
      doc.setTextColor(140);
      doc.text(
        `Page ${doc.getNumberOfPages()}`,
        pageSize.getWidth() - 14,
        pageSize.getHeight() - 8,
        { align: 'right' }
      );
      doc.setTextColor(0);
    },
  });

  doc.save(filename);
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

function PaymentsScreen() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useCurrentRole();

  /**
   * RBAC.
   *
   * The standalone /app/refunds route was wrapped in
   * `<RoleRoute allow={CAN.manageRefunds}>`; this page is reachable by
   * everyone, and its Refunds tab had NO gate at all — so an employee already
   * saw refund rows here before the merge. Folding the route in without this
   * check would have made that the only way to reach refunds and left the hole
   * permanent.
   *
   * Presentation only: the backend scopes every refund row to the caller
   * regardless. This keeps controls that would 403 off the screen and, more
   * importantly, stops the page issuing refund requests at all for a role that
   * has no business reading them.
   */
  const canManageRefunds = can('manageRefunds');

  /**
   * The tab lives in the URL so a link, a bookmark or the back button lands on
   * the same place — and so the old /app/refunds route can redirect into it.
   *
   * An employee who follows a `?tab=refunds` link falls back to Transactions
   * rather than reaching a tab that does not exist for them.
   */
  const requested = searchParams.get('tab');
  const activeTab: TabId = requested === 'refunds' && canManageRefunds ? 'refunds' : 'transactions';

  const setActiveTab = (next: TabId) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`/app/payments?${params.toString()}`, { scroll: false });
  };

  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [detailsPaymentId, setDetailsPaymentId] = useState<string | null>(null);
  const [refundPaymentId, setRefundPaymentId] = useState<string | null>(null);
  const [isCreateRefundOpen, setIsCreateRefundOpen] = useState(false);
  const [refundDetail, setRefundDetail] = useState<Refund | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [activeParam, setActiveParam] = useState('status');
  const [isExporting, setIsExporting] = useState(false);

  /**
   * Search and filters are kept PER TAB.
   *
   * The two endpoints share only `status`, and even that is a different
   * vocabulary — a refund is never `Success`. One shared bag would send
   * `method=UPI` to `refunds/`, where it matches no filter and is dropped, and
   * the tab would show an unfiltered list under a chip claiming otherwise.
   */
  const [paymentSelection, setPaymentSelection] = useState<FilterSelection>({});
  const [refundSelection, setRefundSelection] = useState<FilterSelection>({});
  const [paymentSearch, setPaymentSearch] = useState('');
  const [refundSearch, setRefundSearch] = useState('');
  const debouncedPaymentSearch = useDebounce(paymentSearch, 300);
  const debouncedRefundSearch = useDebounce(refundSearch, 300);

  const onTransactions = activeTab === 'transactions';

  const groups = onTransactions ? PAYMENT_FILTER_GROUPS : REFUND_FILTER_GROUPS;
  const selection = onTransactions ? paymentSelection : refundSelection;
  const setSelection = onTransactions ? setPaymentSelection : setRefundSelection;
  const searchValue = onTransactions ? paymentSearch : refundSearch;
  const setSearchValue = onTransactions ? setPaymentSearch : setRefundSearch;

  const activeFilterCount = selectionCount(selection);
  const chips = toChips(groups, selection);
  const hasQuery = activeFilterCount > 0 || searchValue !== '';

  const payments = usePaginatedQuery<Payment>(['payments'], apiClient.payments.list, {
    pageSize: PAGE_SIZE,
    ordering: '-date',
    search: debouncedPaymentSearch || undefined,
    filters: paymentSelection,
  });

  // `refunds/` now declares `RefundFilter` and `search_fields`
  // (`student__student_name`, `reason`), so both controls on this tab reach the
  // server. The request is not issued at all for a role that may not see them.
  const refunds = usePaginatedQuery<Refund>(['refunds'], apiClient.refunds.list, {
    pageSize: PAGE_SIZE,
    ordering: '-created_at',
    search: debouncedRefundSearch || undefined,
    filters: refundSelection,
    enabled: canManageRefunds,
  });

  const totals = useQuery({
    queryKey: ['payments', 'stats'],
    queryFn: async () => toPaymentTotals(await apiClient.dashboard.getPaymentStats()),
  });

  const refundTotals = useQuery({
    queryKey: ['refunds', 'totals'],
    queryFn: fetchRefundTotals,
    enabled: canManageRefunds,
  });

  // Counts come off the envelope with no rows transferred, so they are true
  // totals rather than "how many landed on page one".
  const successCount = useQuery({
    queryKey: ['payments', 'count', 'Success'],
    queryFn: async () =>
      (await apiClient.payments.list({ page_size: 1, filters: { status: 'Success' } })).count,
  });

  const pendingCount = useQuery({
    queryKey: ['payments', 'count', 'Pending'],
    queryFn: async () =>
      (await apiClient.payments.list({ page_size: 1, filters: { status: 'Pending' } })).count,
  });

  const revenue = totals.data?.totalRevenue ?? 0;
  const refunded = refundTotals.data?.processedAmount ?? 0;

  const invalidatePayments = () => {
    void queryClient.invalidateQueries({ queryKey: ['payments'] });
    void queryClient.invalidateQueries({ queryKey: ['refunds'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard-pending-payments'] });
  };

  const openFilters = (param?: string) => {
    setActiveParam(param ?? groups[0]?.param ?? 'status');
    setIsFilterOpen(true);
  };

  const clearGroup = (param: string) => {
    const next = { ...selection };
    delete next[param];
    setSelection(next);
  };

  const clearAll = () => {
    setSelection({});
    setSearchValue('');
  };

  /**
   * Exports every row matching the current filters, not the visible page.
   *
   * The table shows 10 rows; a file named "payments_export" that contains 10 of
   * 200 is indistinguishable from a complete one once it leaves the app.
   */
  const collectRows = async (): Promise<ExportData> => {
    const csvRows: string[][] = [];
    const pdfRows: string[][] = [];
    let page = 1;
    let pages = 1;

    if (onTransactions) {
      do {
        const envelope = await apiClient.payments.list({
          page,
          page_size: SCAN_PAGE_SIZE,
          ordering: '-date',
          search: debouncedPaymentSearch || undefined,
          filters: paymentSelection,
        });
        for (const p of envelope.results) {
          const amount = Number(p.amount) || 0;
          const shared = [p.studentName ?? '', p.reference ?? '', formatDay(p.date)];
          const tail = [p.method ?? '', p.status ?? '', p.type ?? ''];
          csvRows.push([...shared, String(amount), ...tail]);
          pdfRows.push([...shared, rupeesAscii(amount), ...tail]);
        }
        pages = envelope.pages;
        page += 1;
      } while (page <= pages && page <= SCAN_MAX_PAGES);

      return {
        title: 'Payments Report',
        headers: ['Student', 'Reference', 'Date', 'Amount', 'Method', 'Status', 'Type'],
        csvRows,
        pdfRows,
      };
    }

    do {
      const envelope = await apiClient.refunds.list({
        page,
        page_size: SCAN_PAGE_SIZE,
        ordering: '-created_at',
        search: debouncedRefundSearch || undefined,
        filters: refundSelection,
      });
      for (const r of envelope.results) {
        const amount = Number(r.amount) || 0;
        const head = [r.student_name ?? ''];
        const tail = [
          r.reason ?? '',
          formatDay(r.created_at),
          formatDay(r.processed_at),
          r.status ?? '',
        ];
        csvRows.push([...head, String(amount), ...tail]);
        pdfRows.push([...head, rupeesAscii(amount), ...tail]);
      }
      pages = envelope.pages;
      page += 1;
    } while (page <= pages && page <= SCAN_MAX_PAGES);

    return {
      title: 'Refunds Report',
      headers: ['Student', 'Amount', 'Reason', 'Requested', 'Processed', 'Status'],
      csvRows,
      pdfRows,
    };
  };

  const runExport = async (kind: 'csv' | 'pdf') => {
    setIsExporting(true);
    try {
      const data = await collectRows();
      if (data.csvRows.length === 0) {
        toast.warning('Nothing to export', 'No records match the current filters.');
        return;
      }

      const stamp = format(new Date(), 'yyyyMMdd_HHmmss');
      const slug = onTransactions ? 'payments' : 'refunds';

      if (kind === 'csv') {
        downloadCsv(data.headers, data.csvRows, `${slug}_export_${stamp}.csv`);
      } else {
        await downloadPdf(data.title, data.headers, data.pdfRows, `${slug}_report_${stamp}.pdf`);
      }

      toast.success('Export ready', `${data.csvRows.length} records downloaded.`);
    } catch {
      toast.error('Export failed', 'Could not read the full record set. Please try again.');
    } finally {
      setIsExporting(false);
    }
  };

  const transactionColumns: Column<Payment>[] = [
    {
      header: 'Student',
      accessorKey: 'studentName',
      cell: (item) => {
        const avatar = getAvatarColor(item.studentName ?? '');
        return (
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
                avatar.bg,
                avatar.text
              )}
            >
              {getInitials(item.studentName ?? '')}
            </div>
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-semibold text-slate-900">{item.studentName || '—'}</span>
              <span className="text-[10px] uppercase text-slate-500">{item.type}</span>
            </div>
          </div>
        );
      },
    },
    {
      header: 'Reference',
      cell: (item) => <span className="text-xs text-slate-500">{item.reference || '—'}</span>,
      className: 'hidden md:table-cell',
    },
    {
      header: 'Date',
      cell: (item) => <span className="text-xs font-medium text-slate-500">{formatDay(item.date)}</span>,
      className: 'hidden sm:table-cell',
    },
    {
      header: 'Amount',
      accessorKey: 'amount',
      cell: (item) => <span className="font-bold text-slate-900">{rupees(Number(item.amount) || 0)}</span>,
    },
    {
      header: 'Method',
      cell: (item) => <span className="text-xs font-medium text-slate-600">{item.method || '—'}</span>,
      className: 'hidden lg:table-cell',
    },
    {
      header: 'Status',
      cell: (item) => (
        <span
          className={cn(
            'inline-block w-fit rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
            PAYMENT_STATUS_STYLES[item.status] ?? NEUTRAL_BADGE
          )}
        >
          {item.status}
        </span>
      ),
    },
    {
      header: '',
      cell: (item) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-7 w-7 rounded-full p-0 hover:bg-slate-100">
              <MoreHorizontal className="h-4 w-4 text-slate-500" />
              <span className="sr-only">Actions for {item.studentName}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[170px]">
            <DropdownMenuItem
              onClick={() => setDetailsPaymentId(item.id)}
              className="text-xs font-medium"
            >
              <Eye className="mr-2 h-3.5 w-3.5 text-slate-400" />
              View details
            </DropdownMenuItem>
            {/* Only a settled payment can be refunded, and only by a role that
                may manage refunds at all. A payment already marked Refunded is
                excluded, so the action is never offered where the server would
                reject it. */}
            {canManageRefunds && item.status === 'Success' && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => setRefundPaymentId(item.id)}
                  className="text-xs font-medium text-orange-600 focus:text-orange-700"
                >
                  <RotateCcw className="mr-2 h-3.5 w-3.5" />
                  Request refund
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  const refundColumns: Column<Refund>[] = [
    {
      header: 'Student',
      accessorKey: 'student_name',
      cell: (item) => {
        const avatar = getAvatarColor(item.student_name ?? '');
        return (
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
                avatar.bg,
                avatar.text
              )}
            >
              {getInitials(item.student_name ?? '')}
            </div>
            <span className="truncate font-semibold text-slate-900">{item.student_name || '—'}</span>
          </div>
        );
      },
    },
    {
      header: 'Refund',
      accessorKey: 'amount',
      cell: (item) => (
        <span className="font-bold text-orange-600">{rupees(Number(item.amount) || 0)}</span>
      ),
    },
    {
      header: 'Payment',
      cell: (item) => (
        <span className="text-xs text-slate-500">{item.payment ? `#${item.payment}` : '—'}</span>
      ),
      className: 'hidden lg:table-cell',
    },
    {
      header: 'Requested',
      cell: (item) => (
        <span className="text-xs font-medium text-slate-500">{formatDay(item.created_at)}</span>
      ),
      className: 'hidden sm:table-cell',
    },
    {
      header: 'Reason',
      cell: (item) => (
        <span className="block max-w-[220px] truncate text-xs text-slate-500">{item.reason || '—'}</span>
      ),
      className: 'hidden md:table-cell',
    },
    {
      header: 'Status',
      cell: (item) => (
        <span
          className={cn(
            'inline-block w-fit rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
            REFUND_STATUS_STYLES[item.status] ?? NEUTRAL_BADGE
          )}
        >
          {item.status}
        </span>
      ),
    },
    {
      header: '',
      cell: (item) => (
        <Button
          variant="ghost"
          className="h-7 w-7 rounded-full p-0 hover:bg-slate-100"
          onClick={() => setRefundDetail(item)}
          aria-label={`View refund for ${item.student_name}`}
        >
          <Eye className="h-4 w-4 text-slate-500" />
        </Button>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-[1400px] space-y-3 px-3 py-2 sm:px-6 lg:px-8">
      {/* Stats — every figure is a server aggregate over the caller's full
          scope. The two refund-derived tiles are replaced rather than blanked
          for a role that may not read refunds: a "Refunded ₹0" tile would be a
          claim, not a redaction. */}
      <div
        className={cn(
          'grid grid-cols-2 gap-2 sm:gap-4',
          canManageRefunds ? 'md:grid-cols-4' : 'md:grid-cols-3'
        )}
      >
        <StatCard
          accent="bg-emerald-500"
          label="Total Revenue"
          value={rupees(revenue)}
          note={
            successCount.data !== undefined
              ? `${successCount.data.toLocaleString('en-IN')} settled`
              : 'Settled payments'
          }
          noteClass="text-emerald-600 bg-emerald-50"
          loading={totals.isLoading}
        />
        {canManageRefunds ? (
          <StatCard
            accent="bg-blue-500"
            label="Net Income"
            value={rupees(revenue - refunded)}
            note="After processed refunds"
            noteClass="text-blue-600 bg-blue-50"
            loading={totals.isLoading || refundTotals.isLoading}
          />
        ) : (
          <StatCard
            accent="bg-blue-500"
            label="This Month"
            value={rupees(totals.data?.thisMonthRevenue ?? 0)}
            note="Settled this month"
            noteClass="text-blue-600 bg-blue-50"
            loading={totals.isLoading}
          />
        )}
        <StatCard
          accent="bg-amber-500"
          label="Outstanding"
          value={rupees(totals.data?.pendingAmount ?? 0)}
          note={
            pendingCount.data !== undefined
              ? `${pendingCount.data.toLocaleString('en-IN')} pending`
              : 'Pending payments'
          }
          noteClass="text-amber-600 bg-amber-50"
          loading={totals.isLoading}
        />
        {canManageRefunds && (
          <StatCard
            accent="bg-rose-500"
            label="Refunded"
            value={rupees(refunded)}
            note={
              refundTotals.data
                ? `${refundTotals.data.processedCount} processed${
                    refundTotals.data.approvedCount > 0
                      ? ` · ${refundTotals.data.approvedCount} approved`
                      : ''
                  }`
                : 'Processed refunds'
            }
            noteClass="text-rose-600 bg-rose-50"
            loading={refundTotals.isLoading}
          />
        )}
      </div>

      {totals.isError && (
        <ErrorState
          error={totals.error}
          onRetry={() => void totals.refetch()}
          title="Could not load payment totals"
        />
      )}
      {refundTotals.data?.truncated && (
        <p className="text-[11px] text-slate-400">
          The refunded total covers the {SCAN_PAGE_SIZE * SCAN_MAX_PAGES} most recent processed
          refunds of {refundTotals.data.processedCount.toLocaleString('en-IN')}.
        </p>
      )}

      <Tabs
        value={activeTab}
        className="w-full"
        onValueChange={(value) => {
          if (value === 'transactions' || (value === 'refunds' && canManageRefunds)) {
            setActiveTab(value as TabId);
          }
        }}
      >
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <TabsList className="shrink-0 rounded-lg border border-slate-200 bg-slate-100 p-1">
              <TabsTrigger
                value="transactions"
                className="rounded-md px-3 py-1.5 text-xs font-medium transition-all data-[state=active]:bg-white data-[state=active]:text-teal-700 data-[state=active]:shadow-sm sm:px-4"
              >
                Transactions
              </TabsTrigger>
              {/* Not merely disabled: an employee has no business knowing the
                  refunds ledger exists on this screen. */}
              {canManageRefunds && (
                <TabsTrigger
                  value="refunds"
                  className="rounded-md px-3 py-1.5 text-xs font-medium transition-all data-[state=active]:bg-white data-[state=active]:text-teal-700 data-[state=active]:shadow-sm sm:px-4"
                >
                  Refunds
                </TabsTrigger>
              )}
            </TabsList>

            <div className="relative min-w-[160px] max-w-[350px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                placeholder={
                  onTransactions ? 'Search name or reference…' : 'Search student or reason…'
                }
                aria-label={onTransactions ? 'Search payments' : 'Search refunds'}
                value={searchValue}
                onChange={(e) => setSearchValue(e.target.value)}
                className="h-9 w-full border-slate-200 bg-white pl-9 text-xs focus:border-teal-500 focus:ring-teal-500/20"
              />
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => openFilters()}
              className={cn(
                'h-9 shrink-0 border-slate-200 bg-white px-3 text-slate-600 hover:text-slate-900',
                activeFilterCount > 0 && 'border-teal-500 bg-teal-50 text-teal-700'
              )}
            >
              <Filter className="mr-2 h-4 w-4" />
              Filter
              {activeFilterCount > 0 && (
                <Badge
                  variant="secondary"
                  className="ml-2 flex h-5 w-5 items-center justify-center rounded-full bg-teal-100 p-0 text-[10px] text-teal-700"
                >
                  {activeFilterCount}
                </Badge>
              )}
            </Button>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isExporting}
                  className="h-9 border-slate-200 bg-white text-xs font-medium hover:bg-slate-50"
                >
                  {isExporting ? (
                    <InlineSpinner className="mr-2" />
                  ) : (
                    <Download className="mr-2 h-3.5 w-3.5 text-slate-500" />
                  )}
                  <span className="hidden sm:inline">Export</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[190px] border border-slate-200 bg-white shadow-lg">
                <DropdownMenuLabel className="text-xs font-bold text-slate-500">
                  Export all matching
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => void runExport('csv')}
                  className="cursor-pointer text-xs font-medium"
                >
                  <FileSpreadsheet className="mr-2 h-4 w-4 text-green-600" /> Download CSV
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => void runExport('pdf')}
                  className="cursor-pointer text-xs font-medium"
                >
                  <FileText className="mr-2 h-4 w-4 text-red-600" /> Download PDF
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* The primary action follows the tab, so the toolbar never carries
                two of them competing for the same corner. */}
            {onTransactions ? (
              <Button
                onClick={() => setIsPaymentModalOpen(true)}
                size="sm"
                className="h-9 bg-teal-600 text-xs font-semibold text-white shadow-sm hover:bg-teal-700"
              >
                <Plus className="h-3.5 w-3.5 sm:mr-2" />
                <span className="hidden sm:inline">Record payment</span>
              </Button>
            ) : (
              <Button
                onClick={() => setIsCreateRefundOpen(true)}
                size="sm"
                className="h-9 bg-teal-600 text-xs font-semibold text-white shadow-sm hover:bg-teal-700"
              >
                <RotateCcw className="h-3.5 w-3.5 sm:mr-2" />
                <span className="hidden sm:inline">Create refund</span>
              </Button>
            )}
          </div>
        </div>

        {/* Applied filters. Pressing a chip reopens the drawer at that group;
            the × drops the whole category. */}
        {chips.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {chips.map((chip) => (
              <span
                key={chip.param}
                className="inline-flex items-center overflow-hidden rounded-full border border-teal-200 bg-white text-xs text-teal-800"
              >
                <button
                  type="button"
                  onClick={() => openFilters(chip.param)}
                  className="py-1 pl-2.5 pr-1.5 transition-colors hover:bg-teal-50"
                >
                  <span className="text-slate-500">{chip.label}:</span> {chip.detail}
                </button>
                <button
                  type="button"
                  onClick={() => clearGroup(chip.param)}
                  aria-label={`Remove ${chip.label} filter`}
                  className="py-1 pl-1 pr-2 text-teal-500 transition-colors hover:bg-teal-50 hover:text-teal-800"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearAll}
              className="h-6 px-2 text-[11px] text-slate-500 hover:text-slate-900"
            >
              Clear all
            </Button>
          </div>
        )}

        <TabsContent value="transactions" className="mt-0">
          <ListPanel
            isLoading={payments.isLoading}
            isError={payments.isError}
            error={payments.error}
            onRetry={payments.refetch}
            isEmpty={payments.isEmpty}
            emptyTitle={hasQuery ? 'No payments match your filters' : 'No payments recorded yet'}
            emptyDescription={
              hasQuery
                ? 'Try a different search term, or clear the filters.'
                : 'Record a payment to see it here.'
            }
            emptyAction={
              hasQuery ? (
                <Button variant="outline" onClick={clearAll}>
                  Clear filters
                </Button>
              ) : (
                <Button
                  className="bg-teal-600 hover:bg-teal-700"
                  onClick={() => setIsPaymentModalOpen(true)}
                >
                  <Plus className="mr-2 h-4 w-4" /> Record payment
                </Button>
              )
            }
          >
            <DataTable columns={transactionColumns} data={payments.rows} />
            <PaginationBar
              page={payments.page}
              pages={payments.pages}
              count={payments.count}
              pageSize={payments.pageSize}
              onPageChange={payments.setPage}
              isLoading={payments.isFetching}
            />
          </ListPanel>
        </TabsContent>

        {canManageRefunds && (
          <TabsContent value="refunds" className="mt-0">
            <ListPanel
              isLoading={refunds.isLoading}
              isError={refunds.isError}
              error={refunds.error}
              onRetry={refunds.refetch}
              isEmpty={refunds.isEmpty}
              emptyTitle={hasQuery ? 'No refunds match your filters' : 'No refunds yet'}
              emptyDescription={
                hasQuery
                  ? 'Try a different search term or status.'
                  : 'Refund requests you raise will be listed here.'
              }
              emptyAction={
                hasQuery ? (
                  <Button variant="outline" onClick={clearAll}>
                    Clear filters
                  </Button>
                ) : (
                  <Button
                    className="bg-teal-600 hover:bg-teal-700"
                    onClick={() => setIsCreateRefundOpen(true)}
                  >
                    <RotateCcw className="mr-2 h-4 w-4" /> Create refund
                  </Button>
                )
              }
            >
              <DataTable columns={refundColumns} data={refunds.rows} />
              <PaginationBar
                page={refunds.page}
                pages={refunds.pages}
                count={refunds.count}
                pageSize={refunds.pageSize}
                onPageChange={refunds.setPage}
                isLoading={refunds.isFetching}
              />
            </ListPanel>
          </TabsContent>
        )}
      </Tabs>

      <FilterDrawer
        open={isFilterOpen}
        onOpenChange={setIsFilterOpen}
        groups={groups}
        selection={selection}
        onChange={setSelection}
        activeParam={activeParam}
        onActiveParamChange={setActiveParam}
        noun={onTransactions ? 'payment' : 'refund'}
      />

      {/* The modals and the refund drawer own their mutations; this page
          supplies an id and refreshes the caches they invalidate. */}
      <PaymentModal
        open={isPaymentModalOpen}
        onClose={() => setIsPaymentModalOpen(false)}
        onCreated={invalidatePayments}
      />

      {detailsPaymentId !== null && (
        <PaymentDetailsModal
          open
          onClose={() => setDetailsPaymentId(null)}
          paymentId={detailsPaymentId}
        />
      )}

      {canManageRefunds && refundPaymentId !== null && (
        <RefundDrawer
          open
          onClose={() => setRefundPaymentId(null)}
          paymentId={refundPaymentId}
          onCreated={invalidatePayments}
        />
      )}

      {/* Raised against a student rather than one transaction — the flow the
          standalone /app/refunds screen owned before the merge. */}
      {canManageRefunds && (
        <RefundDrawer
          open={isCreateRefundOpen}
          onClose={() => setIsCreateRefundOpen(false)}
          onCreated={invalidatePayments}
        />
      )}

      <Modal
        open={refundDetail !== null}
        onClose={() => setRefundDetail(null)}
        title="Refund details"
        footer={
          <div className="flex justify-end">
            <Button variant="outline" className="w-full sm:w-32" onClick={() => setRefundDetail(null)}>
              Close
            </Button>
          </div>
        }
      >
        {refundDetail && (
          <dl className="space-y-4">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Student</dt>
              <dd className="mt-0.5 break-words text-sm font-semibold text-slate-900">
                {refundDetail.student_name}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Amount</dt>
              <dd className="mt-0.5 text-lg font-bold text-orange-600">
                -{rupees(Number(refundDetail.amount) || 0)}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Status</dt>
              <dd className="mt-1">
                <span
                  className={cn(
                    'inline-block w-fit rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                    REFUND_STATUS_STYLES[refundDetail.status] ?? NEUTRAL_BADGE
                  )}
                >
                  {refundDetail.status}
                </span>
              </dd>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Requested
                </dt>
                <dd className="mt-0.5 text-sm text-slate-900">{formatDay(refundDetail.created_at)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Processed
                </dt>
                <dd className="mt-0.5 text-sm text-slate-900">
                  {formatDay(refundDetail.processed_at)}
                </dd>
              </div>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Against payment
              </dt>
              <dd className="mt-0.5 text-sm text-slate-900">
                {refundDetail.payment ? `#${refundDetail.payment}` : 'Not linked to a payment'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Reason</dt>
              <dd className="mt-0.5 whitespace-pre-wrap break-words rounded-md bg-slate-50 p-3 text-sm text-slate-700">
                {refundDetail.reason || '—'}
              </dd>
            </div>
          </dl>
        )}
      </Modal>
    </div>
  );
}

export default function PaymentsPage() {
  // useSearchParams needs a Suspense boundary to keep this route static.
  return (
    <Suspense fallback={null}>
      <PaymentsScreen />
    </Suspense>
  );
}

/* -------------------------------------------------------------------------- */
/* Presentational                                                             */
/* -------------------------------------------------------------------------- */

function StatCard({
  accent,
  label,
  value,
  note,
  noteClass,
  loading,
}: {
  accent: string;
  label: string;
  value: string;
  note: string;
  noteClass: string;
  loading: boolean;
}) {
  return (
    <Card className="group overflow-hidden border-slate-200 bg-white shadow-sm transition-all duration-200 hover:shadow-md">
      <div className={cn('h-1 w-full', accent)} />
      <CardContent className="p-3 sm:p-4">
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
        <h4 className="mt-1 text-lg font-bold text-slate-900 sm:text-2xl">
          {loading ? <span className="text-slate-300">—</span> : value}
        </h4>
        <div className={cn('mt-3 w-fit rounded-full px-2 py-0.5 text-[10px] font-medium', noteClass)}>
          {note}
        </div>
      </CardContent>
    </Card>
  );
}

function ListPanel({
  isLoading,
  isError,
  error,
  onRetry,
  isEmpty,
  emptyTitle,
  emptyDescription,
  emptyAction,
  children,
}: {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  isEmpty: boolean;
  emptyTitle: string;
  emptyDescription: string;
  emptyAction?: React.ReactNode;
  children: React.ReactNode;
}) {
  if (isLoading) {
    return (
      <Card className="border-slate-200 bg-white p-4 shadow-sm">
        <LoadingState rows={5} label="Loading records…" />
      </Card>
    );
  }

  if (isError) {
    return <ErrorState error={error} onRetry={onRetry} title="Could not load these records" />;
  }

  if (isEmpty) {
    return (
      <EmptyState
        title={emptyTitle}
        description={emptyDescription}
        icon={FileText}
        action={emptyAction}
      />
    );
  }

  return <Card className="overflow-hidden border-slate-200 bg-white shadow-sm">{children}</Card>;
}
