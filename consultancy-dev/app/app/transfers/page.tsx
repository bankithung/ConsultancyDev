'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceStrict, formatDistanceToNowStrict } from 'date-fns';
import { ArrowDownLeft, ArrowUpRight, Check, Inbox, Send, SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { BookmarkTabs } from '@/components/common/BookmarkTabs';
import { PaginationBar } from '@/components/common/PaginationBar';
import {
  FilterDrawer, selectionCount,
  type FilterGroup, type FilterSelection,
} from '@/components/common/FilterDrawer';
import { EmptyState, ErrorBanner, ErrorState, LoadingState } from '@/components/common/states';
import { RoleRoute } from '@/components/rbac/RoleGate';
import { ALL_ROLES } from '@/components/rbac/roles';
import { apiClient } from '@/lib/apiClient';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { useAuth } from '@/hooks/useAuth';
import type { RecordTransfer, RecordTransferStatus } from '@/lib/types';

/**
 * Record transfers — the inbox and outbox of ownership hand-overs.
 *
 * SERVER-SIDE FILTERING ONLY. `RecordTransferViewSet` declares
 * `filterset_fields = ('status', 'entity_type', 'from_user', 'to_user')`, and
 * every control here maps to one of those four. Narrowing the fetched page in
 * the browser instead would hide matches on later pages while the count kept
 * reporting the unfiltered total.
 *
 * THERE IS NO SEARCH BOX, deliberately: that viewset declares no
 * `search_fields`. `SearchFilter` is a global filter backend, so `?search=` is
 * accepted and then applied against an empty field list — the request succeeds
 * and returns the FULL list, which reads as "everything matched". A search box
 * here needs backend work first.
 */

const STATUS_STYLE: Record<RecordTransferStatus, string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  ACCEPTED: 'bg-green-100 text-green-700',
  REJECTED: 'bg-red-100 text-red-700',
  CANCELLED: 'bg-slate-200 text-slate-600',
};

const STATUS_LABEL: Record<RecordTransferStatus, string> = {
  PENDING: 'Pending',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};

/** Mirrors `RecordTransfer.ENTITY_CHOICES` on the model. */
const ENTITY_LABELS: Record<string, string> = {
  enquiry: 'Enquiry',
  registration: 'Registration',
  enrollment: 'Enrollment',
  document: 'Document',
  task: 'Task',
  follow_up: 'Follow-up',
  visa_tracking: 'Visa tracking',
};

/**
 * Query-key roots holding rows an accepted transfer re-owns, one per
 * `ENTITY_CHOICES` member. The previous version listed four of the seven, so
 * accepting a task or a follow-up left the list it came from showing the old
 * owner until something else refetched it. `follow_up` appears twice because
 * two screens key the same resource differently.
 */
const OWNED_LIST_KEYS = [
  'enquiries', 'registrations', 'enrollments', 'documents',
  'tasks', 'followUps', 'follow-ups', 'visaTracking',
] as const;

const DIRECTIONS = ['inbox', 'outbox'] as const;
type Direction = (typeof DIRECTIONS)[number];

const DIRECTION_META: Record<Direction, { label: string; icon: typeof Inbox; blurb: string }> = {
  inbox: {
    label: 'Inbox',
    icon: Inbox,
    blurb: 'Records a colleague has handed to you, for you to accept or reject',
  },
  outbox: {
    label: 'Outbox',
    icon: Send,
    blurb: 'Records you have handed to a colleague, and how each one was answered',
  },
};

const STATUS_OPTIONS = (Object.keys(STATUS_LABEL) as RecordTransferStatus[]).map((value) => ({
  value,
  label: STATUS_LABEL[value],
}));

const ENTITY_OPTIONS = Object.entries(ENTITY_LABELS).map(([value, label]) => ({ value, label }));

function entityLabel(entityType: string): string {
  return ENTITY_LABELS[entityType] ?? entityType.replace(/_/g, ' ');
}

/** Past this, "9 days ago" is harder to place than the date itself. */
const RELATIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A gap smaller than this is not a decision anyone made — it is the same
 * request. See `timing()`.
 */
const INSTANT_MS = 60 * 1000;

function parse(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Seconds-precision, for the hover title where precision actually belongs. */
function exactTime(date: Date): string {
  return format(date, 'd MMM yyyy, HH:mm:ss');
}

function relativeTime(date: Date): string {
  if (Date.now() - date.getTime() > RELATIVE_WINDOW_MS) {
    return format(date, date.getFullYear() === new Date().getFullYear() ? 'd MMM' : 'd MMM yyyy');
  }
  return formatDistanceToNowStrict(date, { addSuffix: true });
}

/**
 * ONE time per row, not two.
 *
 * A transfer sent by an admin or a manager is applied inside the same request
 * (`services.create_transfer` calls `apply_transfer` when the actor outranks
 * peer-to-peer), so `created_at` and `resolved_at` are the same second. Printing
 * both was two lines carrying one moment. The gap only means something when a
 * recipient actually took time to decide, and then the interesting figure is
 * how long they took — not two absolute stamps the reader has to subtract.
 */
function timing(transfer: RecordTransfer): { label: string; took: string | null; title: string } | null {
  const sent = parse(transfer.created_at);
  if (!sent) return null;

  const resolved = parse(transfer.resolved_at);
  const gap = resolved ? resolved.getTime() - sent.getTime() : 0;

  return {
    label: relativeTime(sent),
    took: resolved && gap >= INSTANT_MS ? formatDistanceStrict(sent, resolved) : null,
    title: resolved
      ? `Sent ${exactTime(sent)}\nResolved ${exactTime(resolved)}`
      : `Sent ${exactTime(sent)}`,
  };
}

/* ------------------------------------------------------------------- a row */

function TransferRow({
  transfer,
  direction,
  onAccept,
  onReject,
  isBusy,
}: {
  transfer: RecordTransfer;
  direction: Direction;
  onAccept: (transfer: RecordTransfer) => void;
  onReject: (transfer: RecordTransfer) => void;
  isBusy: boolean;
}) {
  const incoming = direction === 'inbox';
  // Only the recipient may respond, and only while it is still pending — the
  // backend enforces both with a 403 and a 400 respectively.
  const canRespond = incoming && transfer.status === 'PENDING';
  const title = transfer.entity_label || `${entityLabel(transfer.entity_type)} #${transfer.entity_id}`;
  const when = timing(transfer);

  /*
    A LOG ENTRY, NOT A CARD. The job on this screen is to scan a lot of these
    and act on the pending ones, so everything that was a stacked line — the
    record type, the counterparty, the two timestamps — is inline. Two lines on
    a phone, one from `sm` up.
  */
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2.5 transition-colors hover:bg-slate-50 sm:flex-row sm:items-center sm:gap-3 sm:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
            incoming ? 'bg-blue-50 text-blue-600' : 'bg-purple-50 text-purple-600'
          }`}
          aria-hidden
        >
          {incoming ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}
        </span>

        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="truncate text-sm font-medium text-slate-900">{title}</span>
          <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
            {entityLabel(transfer.entity_type)}
          </span>
          <span className="truncate text-xs text-slate-500">
            {incoming ? 'from' : 'to'}{' '}
            <span className="text-slate-700">
              {incoming ? transfer.from_user_name : transfer.to_user_name}
            </span>
          </span>
          {/* Context when there is room for it; the full text is on hover. */}
          {transfer.note && (
            <span
              title={transfer.note}
              className="hidden max-w-[16rem] truncate text-xs italic text-slate-400 xl:inline"
            >
              “{transfer.note}”
            </span>
          )}
        </div>
      </div>

      {/* Indented to clear the icon on a phone, where this wraps to line two. */}
      <div className="flex shrink-0 items-center gap-2 pl-[38px] sm:pl-0">
        {when && (
          <time
            dateTime={transfer.created_at}
            title={when.title}
            className="whitespace-nowrap text-xs text-slate-500"
          >
            {when.label}
            {when.took && <span className="text-slate-400"> · answered in {when.took}</span>}
          </time>
        )}

        <Badge className={`border-transparent px-1.5 py-0 text-[11px] ${STATUS_STYLE[transfer.status]}`}>
          {STATUS_LABEL[transfer.status]}
        </Badge>

        {canRespond && (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              className="h-7 bg-teal-600 px-2 text-xs hover:bg-teal-700"
              onClick={() => onAccept(transfer)}
              disabled={isBusy}
              aria-label={`Accept ${title}`}
            >
              <Check size={13} className="sm:mr-1" />
              <span className="hidden sm:inline">Accept</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 border-red-200 px-2 text-xs text-red-700 hover:bg-red-50"
              onClick={() => onReject(transfer)}
              disabled={isBusy}
              aria-label={`Reject ${title}`}
            >
              <X size={13} className="sm:mr-1" />
              <span className="hidden sm:inline">Reject</span>
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ a list */

/**
 * One direction's rows. Mounted only while its tab is open, and keyed by
 * direction by the caller, so each tab owns its own page cursor rather than
 * carrying the other one's over — page 3 of the inbox is not page 3 of the
 * outbox.
 */
function TransferList({
  direction,
  userId,
  filters,
  isFiltered,
  onAccept,
  onReject,
  isBusy,
}: {
  direction: Direction;
  userId: number;
  filters: Record<string, string>;
  isFiltered: boolean;
  onAccept: (transfer: RecordTransfer) => void;
  onReject: (transfer: RecordTransfer) => void;
  isBusy: boolean;
}) {
  const meta = DIRECTION_META[direction];

  const transfers = usePaginatedQuery<RecordTransfer>(
    ['transfers', direction],
    apiClient.transfers.list,
    {
      pageSize: 10,
      ordering: '-created_at',
      // `to_user` / `from_user` are both in `filterset_fields`, so the split is
      // the server's, not a slice of a mixed list.
      filters: { ...filters, [direction === 'inbox' ? 'to_user' : 'from_user']: userId },
    },
  );

  if (transfers.isError) {
    return (
      <div className="p-4">
        <ErrorState error={transfers.error} onRetry={transfers.refetch} />
      </div>
    );
  }

  if (transfers.isLoading) {
    return (
      <div className="p-4">
        <LoadingState rows={3} label={`Loading ${meta.label.toLowerCase()}`} />
      </div>
    );
  }

  if (transfers.rows.length === 0) {
    return (
      <div className="p-4">
        <EmptyState
          icon={meta.icon}
          title={isFiltered ? 'No transfers match these filters' : `Nothing in your ${meta.label.toLowerCase()}`}
          description={
            isFiltered
              ? 'Clear a filter to widen the search.'
              : direction === 'inbox'
                ? 'Records handed to you by a colleague appear here for you to accept or reject.'
                : 'Use the transfer action on an enquiry, registration or document to hand it to a colleague.'
          }
        />
      </div>
    );
  }

  return (
    <>
      <ul className="divide-y divide-slate-100">
        {transfers.rows.map((transfer) => (
          <TransferRow
            key={transfer.id}
            transfer={transfer}
            direction={direction}
            onAccept={onAccept}
            onReject={onReject}
            isBusy={isBusy}
          />
        ))}
      </ul>

      <PaginationBar
        page={transfers.page}
        pages={transfers.pages}
        count={transfers.count}
        pageSize={transfers.pageSize}
        onPageChange={transfers.setPage}
        isLoading={transfers.isFetching}
      />
    </>
  );
}

/* ---------------------------------------------------------------- a screen */

function TransfersScreen() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [direction, setDirection] = useState<Direction>('inbox');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [activeParam, setActiveParam] = useState('status');
  const [acceptTarget, setAcceptTarget] = useState<RecordTransfer | null>(null);
  const [rejectTarget, setRejectTarget] = useState<RecordTransfer | null>(null);

  /**
   * Filters are kept PER TAB. The two directions are answered by the same
   * endpoint but are different questions — a status worth filtering the inbox
   * by is rarely the one you want on the outbox — and a shared bag would make
   * switching tabs silently re-filter the one you arrived at.
   */
  const [selections, setSelections] = useState<Record<Direction, FilterSelection>>({
    inbox: {},
    outbox: {},
  });
  const selection = selections[direction];

  /**
   * ONE VALUE PER GROUP, enforced here rather than in the drawer, which is
   * multi-select for every other screen.
   *
   * `RecordTransferViewSet` filters through `filterset_fields` and has no
   * entry in core/filters.py, so django-filter generates a single-value
   * `ChoiceFilter` for `status` and `entity_type`. Repeated parameters reach
   * Django intact, but the filter's form field reads only the last one — two
   * selected statuses would return rows matching just one of them, under a
   * chip claiming both. Until the backend grows a `RecordTransferFilter` with
   * `MultipleChoiceFilter` (as `EnquiryFilter` already has), the honest
   * control is a radio: keep whichever value was just added.
   */
  const setSelection = (next: FilterSelection) => {
    const single: FilterSelection = {};
    for (const [param, values] of Object.entries(next)) {
      if (values.length === 0) continue;
      const added = values.find((value) => !(selection[param] ?? []).includes(value));
      single[param] = [added ?? values[values.length - 1]];
    }
    setSelections((live) => ({ ...live, [direction]: single }));
  };

  /**
   * Scalars, not arrays: with one value per group there is nothing to repeat,
   * and a bare `?status=PENDING` is exactly what the generated filter reads.
   */
  const serverFilters = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(selection)
          .filter(([, values]) => values.length > 0)
          .map(([param, values]) => [param, values[0]]),
      ),
    [selection],
  );

  /**
   * The badge's number, from the server.
   *
   * `transfers/inbox/` is already scoped to `to_user=me, status=PENDING`, so
   * the envelope's `count` is the real total. The previous version counted
   * PENDING rows in the CURRENT PAGE — with ten rows a page it could never
   * report more than ten however many were waiting, and said so authoritatively.
   * `page_size: 1` because only the count is wanted; the same trick the
   * dashboard already uses for this figure.
   */
  const pending = useQuery({
    queryKey: ['transfers', 'inbox', 'pending-count'],
    queryFn: () => apiClient.transfers.inbox({ page: 1, page_size: 1 }),
    enabled: Boolean(user),
    staleTime: 30_000,
  });

  const respondMutation = useMutation({
    mutationFn: ({ transfer, action }: { transfer: RecordTransfer; action: 'accept' | 'reject' }) =>
      action === 'accept' ? apiClient.transfers.accept(transfer.id) : apiClient.transfers.reject(transfer.id),
    onSuccess: () => {
      // Covers both lists and the pending badge, which all key off `transfers`.
      queryClient.invalidateQueries({ queryKey: ['transfers'] });
      // An accepted record changes owner, so every list that showed it under
      // the old owner is now stale.
      for (const key of OWNED_LIST_KEYS) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
      setAcceptTarget(null);
      setRejectTarget(null);
    },
  });

  /**
   * Both groups map to a filter the SERVER applies. `from_user` and `to_user`
   * are the other two `filterset_fields`, but they are what the tabs already
   * are — offering them here would let someone build an inbox filtered to
   * somebody else's inbox, which returns nothing.
   */
  const groups = useMemo<FilterGroup[]>(
    () => [
      {
        param: 'status',
        label: 'Status',
        options: STATUS_OPTIONS,
        hint: 'Where the hand-over got to. One at a time — the server matches a single status.',
      },
      {
        param: 'entity_type',
        label: 'Record type',
        options: ENTITY_OPTIONS,
        hint: 'What kind of record was handed over. One at a time.',
      },
    ],
    [],
  );

  const filterCount = selectionCount(selection);

  const openFilters = (param?: string) => {
    setActiveParam(param ?? groups[0].param);
    setIsFilterOpen(true);
  };

  const chips = useMemo(
    () =>
      groups
        .filter((group) => (selection[group.param] ?? []).length > 0)
        .map((group) => {
          const value = (selection[group.param] ?? [])[0];
          return {
            param: group.param,
            label: group.label,
            detail: group.options.find((option) => option.value === value)?.label ?? value,
          };
        }),
    [groups, selection],
  );

  const removeChip = (param: string) => {
    const next = { ...selection };
    delete next[param];
    setSelections((live) => ({ ...live, [direction]: next }));
  };

  const clearFilters = () => setSelections((live) => ({ ...live, [direction]: {} }));

  /**
   * A dialog belongs to the tab it was opened from: an accept prompt left open
   * across a switch would be answering about a row no longer on screen. Closed
   * during render rather than in an effect, so the stale prompt never paints.
   */
  const [dialogDirection, setDialogDirection] = useState(direction);
  if (dialogDirection !== direction) {
    setDialogDirection(direction);
    setIsFilterOpen(false);
    setAcceptTarget(null);
    setRejectTarget(null);
  }

  const pendingCount = pending.data?.count;

  const tabs = DIRECTIONS.map((value) => ({
    value,
    label: DIRECTION_META[value].label,
    icon: DIRECTION_META[value].icon,
    // Inbox only, and only when there is something to act on. The outbox has
    // no equivalent "needs you" number, and a decorative total there would
    // imply one.
    count: value === 'inbox' && pendingCount ? pendingCount : undefined,
  }));

  return (
    <div className="pt-1">
      <BookmarkTabs tabs={tabs} value={direction} onChange={setDirection} aria-label="Transfer direction" />

      {/*
        One panel. The tabs sit on its top edge and everything below — toolbar,
        applied filters, rows and pagination — is inside it, so the screen reads
        as a single object rather than a stack of cards.
      */}
      <section
        role="tabpanel"
        id={`panel-${direction}`}
        aria-labelledby={`tab-${direction}`}
        className="overflow-hidden rounded-lg rounded-tl-none border border-slate-200 bg-white shadow-sm"
      >
        {/*
          No search box (see the file header) and no create action: a transfer
          starts from the record being handed over, not from this screen. A
          "New transfer" button here would have nothing to hand over.
        */}
        <div className="flex flex-col gap-2 border-b border-slate-100 p-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="min-w-0 text-sm text-slate-600">{DIRECTION_META[direction].blurb}</p>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => openFilters()}
            aria-haspopup="dialog"
            aria-expanded={isFilterOpen}
            className={
              filterCount > 0
                ? 'h-9 shrink-0 self-start border-teal-200 bg-teal-50 text-xs text-teal-700 hover:bg-teal-100 sm:self-auto'
                : 'h-9 shrink-0 self-start border-slate-200 text-xs sm:self-auto'
            }
          >
            <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" />
            Filter
            {filterCount > 0 && (
              <span className="ml-1.5 rounded-full bg-teal-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                {filterCount}
              </span>
            )}
          </Button>
        </div>

        {/* Applied filters. Pressing a chip reopens the drawer at that group. */}
        {chips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 bg-slate-50/70 px-3 py-2">
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
                  <span className="text-slate-500">{chip.label}:</span>{' '}
                  <span className="font-medium">{chip.detail}</span>
                </button>
                <button
                  type="button"
                  onClick={() => removeChip(chip.param)}
                  aria-label={`Remove ${chip.label} filter`}
                  className="py-1 pl-0.5 pr-2 text-teal-500 transition-colors hover:text-teal-800"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={clearFilters}
              className="ml-1 text-xs text-slate-500 underline-offset-2 hover:text-slate-900 hover:underline"
            >
              Clear filters
            </button>
          </div>
        )}

        {respondMutation.isError && (
          <div className="border-b border-slate-100 p-3">
            <ErrorBanner error={respondMutation.error} onDismiss={() => respondMutation.reset()} />
          </div>
        )}

        {/*
          Only the open tab is mounted, so switching fires one request rather
          than two. `key` so the two tabs never share a page cursor.
        */}
        {user ? (
          <TransferList
            key={direction}
            direction={direction}
            userId={user.id}
            filters={serverFilters}
            isFiltered={filterCount > 0}
            onAccept={setAcceptTarget}
            onReject={setRejectTarget}
            isBusy={respondMutation.isPending}
          />
        ) : (
          <div className="p-4">
            <LoadingState rows={3} label="Loading transfers" />
          </div>
        )}
      </section>

      <FilterDrawer
        open={isFilterOpen}
        onOpenChange={setIsFilterOpen}
        groups={groups}
        selection={selection}
        onChange={setSelection}
        activeParam={activeParam}
        onActiveParamChange={setActiveParam}
        noun="transfer"
      />

      <ConfirmDialog
        open={acceptTarget !== null}
        onClose={() => setAcceptTarget(null)}
        onConfirm={() => acceptTarget && respondMutation.mutate({ transfer: acceptTarget, action: 'accept' })}
        title="Accept this transfer?"
        description={`You will become the owner of ${
          acceptTarget?.entity_label || 'this record'
        } and it will appear in your lists.`}
        confirmText="Accept transfer"
        isLoading={respondMutation.isPending}
      />

      <ConfirmDialog
        open={rejectTarget !== null}
        onClose={() => setRejectTarget(null)}
        onConfirm={() => rejectTarget && respondMutation.mutate({ transfer: rejectTarget, action: 'reject' })}
        title="Reject this transfer?"
        description={`The record stays with ${rejectTarget?.from_user_name}. They will see that you declined.`}
        confirmText="Reject transfer"
        confirmVariant="destructive"
        isLoading={respondMutation.isPending}
      />
    </div>
  );
}

export default function TransfersRoute() {
  // Anyone can be party to a transfer; the API scopes what each role sees.
  return (
    <RoleRoute allow={ALL_ROLES}>
      <TransfersScreen />
    </RoleRoute>
  );
}
