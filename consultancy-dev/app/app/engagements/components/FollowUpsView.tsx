'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow, isPast, format } from 'date-fns';
import {
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Clock,
  Clock3,
  Mail,
  MessageCircle,
  MessageSquare,
  Phone,
  Plus,
  Send,
  User as UserIcon,
  X,
} from 'lucide-react';

import { apiClient } from '@/lib/apiClient';
import type { FollowUp, FollowUpComment, FollowUpInput } from '@/lib/types';
import { getAvatarColor, getInitials } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Modal } from '@/components/common/Modal';
import { Drawer } from '@/components/common/Drawer';
import { PaginationBar, toArray } from '@/components/common/pagination';
import { EmptyState, ErrorBanner, ErrorState, LoadingState } from '@/components/common/states';
import { CompleteFollowUpModal, type FollowUpCompletion } from '@/components/common/CompleteFollowUpModal';
import { FOLLOW_UP_OUTCOME_LABELS } from '@/components/common/followUps';
import { toast } from '@/store/toastStore';

import type { EngagementTabState } from '../state';
import {
  FOLLOW_UP_COMPLETED,
  FOLLOW_UP_KPI_FILTERS,
  FOLLOW_UP_PENDING,
  FOLLOW_UP_PRIORITIES,
  FOLLOW_UP_STATUS_TONES,
  FOLLOW_UP_TYPES,
  LIKELIHOOD_TONES,
  OUTCOME_TONES,
  PRIORITY_TONES,
  formatWhen,
  toIsoDateTime,
} from '../vocabulary';

/**
 * The follow-up board.
 *
 * Search, filters, page and the selected row all live on the engagements page
 * so they survive a tab switch; everything below is this view's own — its
 * workload tiles, its list/detail split, and the three dialogs that act on a
 * follow-up.
 */

const PAGE_SIZE = 8;

/** Sentinel for "unassigned" in the create form. Radix Select rejects ''. */
const ANY = 'any';

const TYPE_ICONS: Record<string, React.ReactNode> = {
  Call: <Phone size={14} className="text-slate-400" />,
  Email: <Mail size={14} className="text-slate-400" />,
  WhatsApp: <MessageCircle size={14} className="text-slate-400" />,
  SMS: <MessageSquare size={14} className="text-slate-400" />,
};

const emptyForm = () => ({
  enquiryId: '',
  assignedToId: '',
  type: 'Call' as string,
  priority: 'Medium' as string,
  date: format(new Date(), 'yyyy-MM-dd'),
  time: format(new Date(), 'HH:mm'),
  notes: '',
});

interface FollowUpsViewProps {
  state: EngagementTabState;
  onChange: (patch: Partial<EngagementTabState>) => void;
  /** Driven by the panel's primary action; the dialog itself is owned here. */
  formOpen: boolean;
  onFormOpenChange: (open: boolean) => void;
}

export function FollowUpsView({ state, onChange, formOpen, onFormOpenChange }: FollowUpsViewProps) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [showComplete, setShowComplete] = useState(false);
  const [showReschedule, setShowReschedule] = useState(false);
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [rescheduleTime, setRescheduleTime] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  /** What the form held when it opened — the baseline for the dirty check. */
  const [pristineForm, setPristineForm] = useState(form);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [newComment, setNewComment] = useState('');

  // Reset during render rather than in an effect: an effect runs after paint,
  // so the previous draft would flash before being cleared.
  const [wasFormOpen, setWasFormOpen] = useState(formOpen);
  if (formOpen !== wasFormOpen) {
    setWasFormOpen(formOpen);
    if (formOpen) {
      const fresh = emptyForm();
      setForm(fresh);
      setPristineForm(fresh);
      setFormError(null);
      setConfirmDiscard(false);
    }
  }

  const { committed, selection, page, selectedId } = state;

  const listQuery = useQuery({
    queryKey: ['followUps', 'list', page, committed, selection],
    // A thunk, not a bare reference: react-query calls queryFn with a context
    // object, which `list` would read as its `params`.
    queryFn: () =>
      apiClient.followUps.list({
        page,
        page_size: PAGE_SIZE,
        search: committed || undefined,
        ordering: '-scheduled_for',
        filters: selection,
      }),
    placeholderData: keepPreviousData,
  });

  /**
   * Totals come from the envelope's `count`, which is the whole filtered
   * collection. Counting the eight rows of the current page would report "3
   * pending" to a branch with 300.
   */
  const statsQuery = useQuery({
    queryKey: ['followUps', 'stats'],
    queryFn: async () => {
      const [all, pending, completed, urgent] = await Promise.all([
        apiClient.followUps.list({ page_size: 1 }),
        apiClient.followUps.list({ page_size: 1, filters: { status: FOLLOW_UP_PENDING } }),
        apiClient.followUps.list({ page_size: 1, filters: { status: FOLLOW_UP_COMPLETED } }),
        apiClient.followUps.list({
          page_size: 1,
          filters: { status: FOLLOW_UP_PENDING, priority: 'High' },
        }),
      ]);
      return {
        total: all.count,
        pending: pending.count,
        completed: completed.count,
        urgent: urgent.count,
      };
    },
  });

  const staffQuery = useQuery({
    queryKey: ['users', 'assignable'],
    queryFn: () =>
      apiClient.users.list({
        page_size: 200,
        ordering: 'username',
        filters: { is_active_employee: true },
      }),
  });

  const enquiriesQuery = useQuery({
    queryKey: ['enquiries', 'pickable'],
    queryFn: () => apiClient.enquiries.list({ page_size: 200, ordering: '-created_at' }),
    enabled: formOpen,
  });

  const detailQuery = useQuery({
    queryKey: ['followUp', selectedId],
    queryFn: () => apiClient.followUps.get(selectedId as number),
    enabled: selectedId !== null,
  });

  const commentsQuery = useQuery({
    queryKey: ['followUpComments', selectedId],
    queryFn: () =>
      apiClient.followUpComments.list(selectedId as number, {
        page_size: 100,
        ordering: 'created_at',
      }),
    enabled: selectedId !== null,
  });

  const rows = toArray(listQuery.data);
  const staff = toArray(staffQuery.data);
  const enquiries = toArray(enquiriesQuery.data);
  const comments = toArray(commentsQuery.data);
  const selected = detailQuery.data ?? null;

  const invalidateLists = () => {
    queryClient.invalidateQueries({ queryKey: ['followUps'] });
  };

  const createMutation = useMutation({
    mutationFn: (input: FollowUpInput) => apiClient.followUps.create(input),
    onSuccess: (created) => {
      invalidateLists();
      onFormOpenChange(false);
      setForm(emptyForm());
      setFormError(null);
      onChange({ selectedId: created.id });
      toast.success('Follow-up scheduled');
    },
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Partial<FollowUpInput> }) =>
      apiClient.followUps.update(id, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(['followUp', updated.id], updated);
      invalidateLists();
    },
  });

  /**
   * Append-only thread. The API returns 403 on both PATCH and DELETE by design,
   * so there is deliberately no edit or delete affordance — a correction is a
   * new comment. `author` is stamped server-side and is not sent.
   */
  const commentMutation = useMutation({
    mutationFn: (comment: string) =>
      apiClient.followUpComments.create({ follow_up: selectedId as number, comment }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['followUpComments', selectedId] });
      setNewComment('');
    },
  });

  /**
   * Vetoes the scrim, Escape and the close button while the form holds typed
   * input, and asks instead.
   *
   * This matters more than it did as a centred modal: a drawer's scrim covers
   * most of the screen and is far easier to clip by accident, and what would be
   * thrown away here is a picked student plus whatever was typed into the notes.
   */
  const requestCloseForm = (): boolean => {
    // Mid-submit the follow-up may already be on its way; closing would leave
    // the user unsure whether it was created.
    if (createMutation.isPending) return false;
    if (JSON.stringify(form) === JSON.stringify(pristineForm) || confirmDiscard) return true;
    setConfirmDiscard(true);
    return false;
  };

  const handleCreate = (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.enquiryId) {
      setFormError('Pick the student this follow-up is for.');
      return;
    }
    const scheduledFor = toIsoDateTime(form.date, form.time);
    if (!scheduledFor) {
      setFormError('Pick a valid date and time.');
      return;
    }
    setFormError(null);
    createMutation.mutate({
      // `enquiry` is the enquiry FK. `Enquiry.id` is a string on the client and
      // an integer on the wire.
      enquiry: Number(form.enquiryId),
      assigned_to: form.assignedToId ? Number(form.assignedToId) : null,
      scheduled_for: scheduledFor,
      type: form.type,
      priority: form.priority,
      status: FOLLOW_UP_PENDING,
      notes: form.notes,
    });
  };

  const handleReschedule = (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    const scheduledFor = toIsoDateTime(rescheduleDate, rescheduleTime);
    if (!scheduledFor) {
      setFormError('Pick a valid date and time.');
      return;
    }
    setFormError(null);
    patchMutation.mutate(
      { id: selected.id, patch: { scheduled_for: scheduledFor, status: FOLLOW_UP_PENDING } },
      {
        onSuccess: () => {
          setShowReschedule(false);
          toast.success('Follow-up rescheduled');
        },
      },
    );
  };

  const handleComplete = (patch: FollowUpCompletion) => {
    if (!selected) return;
    patchMutation.mutate(
      { id: selected.id, patch },
      {
        onSuccess: () => {
          setShowComplete(false);
          toast.success('Follow-up completed');
        },
      },
    );
  };

  const handleAddComment = () => {
    if (!newComment.trim() || selectedId === null) return;
    commentMutation.mutate(newComment.trim());
  };

  const openReschedule = () => {
    if (!selected) return;
    const base = new Date(selected.scheduled_for);
    const safe = Number.isNaN(base.getTime()) ? new Date() : base;
    setRescheduleDate(format(safe, 'yyyy-MM-dd'));
    setRescheduleTime(format(safe, 'HH:mm'));
    setFormError(null);
    setShowReschedule(true);
  };

  const stats = statsQuery.data;
  const completionRate =
    stats && stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0;

  const staffOptions = staff.map((member) => ({
    value: member.id.toString(),
    label: member.full_name || member.username,
  }));

  const enquiryOptions = enquiries.map((enquiry) => ({
    value: enquiry.id.toString(),
    label: `${enquiry.candidateName} — ${enquiry.status}`,
  }));

  const enquiriesTruncated =
    enquiriesQuery.data !== undefined && enquiriesQuery.data.count > enquiries.length;

  const hasQuery = Object.keys(selection).length > 0 || state.search !== '';

  /** Clears the box and the drawer at once, without waiting on the debounce. */
  const clearQuery = () => onChange({ search: '', committed: '', selection: {} });

  const activeKpi = (Object.keys(FOLLOW_UP_KPI_FILTERS) as Array<keyof typeof FOLLOW_UP_KPI_FILTERS>)
    .find((key) => JSON.stringify(FOLLOW_UP_KPI_FILTERS[key]) === JSON.stringify(selection));

  const kpis = [
    { key: 'total' as const, label: 'Total', value: stats?.total, tone: 'text-slate-900' },
    { key: 'pending' as const, label: 'Pending', value: stats?.pending, tone: 'text-blue-700' },
    {
      key: 'urgent' as const,
      label: 'Urgent',
      hint: 'pending · high',
      value: stats?.urgent,
      tone: 'text-rose-700',
    },
  ];

  /**
   * Pinned to the bottom of the drawer, so the actions stay reachable while a
   * long form scrolls. When a dismiss has been vetoed it becomes the choice
   * that vetoed it, rather than a separate dialog stacked over the panel.
   */
  const createFooter = confirmDiscard ? (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm font-medium text-slate-700">
        Discard this follow-up? What you have entered will be lost.
      </p>
      <div className="flex shrink-0 gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => setConfirmDiscard(false)}
          className="flex-1 sm:flex-none"
        >
          Keep editing
        </Button>
        <Button
          type="button"
          onClick={() => onFormOpenChange(false)}
          className="flex-1 bg-rose-600 text-white hover:bg-rose-700 sm:flex-none"
        >
          Discard
        </Button>
      </div>
    </div>
  ) : (
    <div className="mx-auto flex w-full max-w-2xl flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          if (requestCloseForm()) onFormOpenChange(false);
        }}
        disabled={createMutation.isPending}
        className="w-full sm:w-auto"
      >
        Cancel
      </Button>
      <Button
        type="submit"
        form="follow-up-form"
        disabled={createMutation.isPending}
        className="w-full bg-teal-600 text-white hover:bg-teal-700 sm:w-auto"
      >
        {createMutation.isPending ? 'Saving…' : 'Create follow-up'}
      </Button>
    </div>
  );

  return (
    <>
      {/*
        The workload, counted by the SERVER over the whole collection rather
        than the eight rows in hand — a branch with 300 follow-ups must not be
        told it has 8. The first three are controls: pressing one applies
        exactly the filter it counts, which is what keeps a tile reading 5 from
        looking wrong beside a table showing 2.
      */}
      <div className="grid grid-cols-2 divide-slate-100 border-b border-slate-100 sm:grid-cols-4 sm:divide-x">
        {kpis.map((kpi) => {
          const isActive = activeKpi === kpi.key;
          return (
            <button
              key={kpi.key}
              type="button"
              aria-pressed={isActive}
              onClick={() => onChange({ selection: FOLLOW_UP_KPI_FILTERS[kpi.key] })}
              className={`flex items-baseline justify-between gap-2 border-b border-slate-100 px-3 py-2.5 text-left transition-colors sm:border-b-0 ${
                isActive ? 'bg-teal-50/70' : 'hover:bg-slate-50'
              }`}
            >
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                {kpi.label}
                {kpi.hint && (
                  <span className="ml-1 font-normal normal-case text-slate-400">{kpi.hint}</span>
                )}
              </span>
              <span className={`text-lg font-bold tabular-nums ${kpi.tone}`}>
                {statsQuery.isError ? '—' : (kpi.value ?? '·')}
              </span>
            </button>
          );
        })}

        {/* Not a control: a ratio is not a subset you can filter to. */}
        <div className="px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Completion
            </span>
            <span className="text-lg font-bold tabular-nums text-emerald-700">
              {statsQuery.isError ? '—' : stats ? `${completionRate}%` : '·'}
            </span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all"
              style={{ width: `${stats ? completionRate : 0}%` }}
            />
          </div>
        </div>
      </div>

      {patchMutation.isError && (
        <div className="px-3 pt-3">
          <ErrorBanner error={patchMutation.error} onDismiss={() => patchMutation.reset()} />
        </div>
      )}
      {commentMutation.isError && (
        <div className="px-3 pt-3">
          <ErrorBanner error={commentMutation.error} onDismiss={() => commentMutation.reset()} />
        </div>
      )}

      {/* `items-start` so the detail panel can stick while the list scrolls. */}
      <div className="flex items-start gap-3 p-3">
        {/* On a phone the detail panel takes over the screen instead of squeezing
            beside a list that would then be ~180px wide. */}
        <div
          className={`flex min-w-0 flex-col gap-2 ${
            selectedId === null ? 'w-full' : 'hidden w-full md:flex lg:w-7/12 xl:w-2/3'
          }`}
        >
          {listQuery.isPending ? (
            <LoadingState rows={5} label="Loading follow-ups…" />
          ) : listQuery.isError ? (
            <ErrorState error={listQuery.error} onRetry={() => listQuery.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No follow-ups here"
              description={
                hasQuery
                  ? 'Nothing matches this search. Try widening it or clearing a filter.'
                  : 'Schedule the first follow-up to start tracking a lead.'
              }
              icon={CalendarDays}
              action={
                hasQuery ? (
                  <Button variant="outline" onClick={clearQuery}>
                    Clear search and filters
                  </Button>
                ) : (
                  <Button
                    onClick={() => onFormOpenChange(true)}
                    className="bg-teal-600 text-white hover:bg-teal-700"
                  >
                    <Plus className="mr-1.5 h-4 w-4" /> Add follow-up
                  </Button>
                )
              }
            />
          ) : (
            <div className="space-y-2">
              {rows.map((followUp) => (
                <FollowUpRow
                  key={followUp.id}
                  followUp={followUp}
                  isSelected={selectedId === followUp.id}
                  onSelect={() => onChange({ selectedId: followUp.id })}
                />
              ))}
            </div>
          )}
        </div>

        {selectedId === null ? (
          <div className="hidden min-h-[22rem] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-slate-200 bg-slate-50/50 text-slate-400 lg:flex lg:w-5/12 xl:w-1/3">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-slate-100">
              <UserIcon size={30} className="text-slate-300" />
            </div>
            <p className="text-sm font-medium">Select a follow-up to view details</p>
          </div>
        ) : (
          /* Bounded and sticky only from `lg`: on a phone the panel should grow
             and let the page scroll, not trap the thread in a 200px box. */
          <div className="flex w-full min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm lg:sticky lg:top-2 lg:max-h-[calc(100vh-7rem)] lg:w-5/12 xl:w-1/3">
            {detailQuery.isPending ? (
              <div className="p-4">
                <LoadingState rows={3} label="Loading follow-up…" />
              </div>
            ) : detailQuery.isError ? (
              <div className="p-4">
                <ErrorState error={detailQuery.error} onRetry={() => detailQuery.refetch()} />
              </div>
            ) : !selected ? (
              <div className="p-4">
                <EmptyState title="Follow-up not found" description="It may have been deleted." />
              </div>
            ) : (
              <>
                <DetailHeader
                  followUp={selected}
                  onClose={() => onChange({ selectedId: null })}
                  onOpenFull={() => router.push(`/app/follow-ups/${selected.id}`)}
                />

                <div className="shrink-0 border-b border-slate-100 bg-slate-50/40 px-4 py-3">
                  <p className="mb-3 whitespace-pre-wrap break-words rounded-md border border-slate-100 bg-white px-3 py-2 text-xs leading-relaxed text-slate-600">
                    {selected.notes.trim() || (
                      <span className="italic text-slate-400">No notes added</span>
                    )}
                  </p>

                  <div className="flex flex-col gap-2 sm:flex-row">
                    {selected.status !== FOLLOW_UP_COMPLETED && (
                      <Button
                        size="sm"
                        className="h-8 flex-1 bg-emerald-600 text-xs font-medium text-white hover:bg-emerald-700"
                        onClick={() => setShowComplete(true)}
                        disabled={patchMutation.isPending}
                      >
                        <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> Complete
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 flex-1 border-slate-200 bg-white text-xs font-medium text-slate-600"
                      onClick={openReschedule}
                      disabled={patchMutation.isPending}
                    >
                      <Clock className="mr-1.5 h-3.5 w-3.5" /> Reschedule
                    </Button>
                  </div>
                </div>

                <CommentThread
                  comments={comments}
                  isPending={commentsQuery.isPending}
                  isError={commentsQuery.isError}
                  error={commentsQuery.error}
                  onRetry={() => commentsQuery.refetch()}
                  value={newComment}
                  onChange={setNewComment}
                  onSubmit={handleAddComment}
                  isSending={commentMutation.isPending}
                />
              </>
            )}
          </div>
        )}
      </div>

      {/* Pagination belongs to the panel, not to the list column: it moves the
          whole board, and nesting it beside a sticky detail pane made it scroll
          away from the rows it controls. */}
      {listQuery.data && rows.length > 0 && (
        <PaginationBar
          page={listQuery.data.page}
          pages={listQuery.data.pages}
          count={listQuery.data.count}
          pageSize={listQuery.data.page_size}
          onPageChange={(next) => onChange({ page: next, selectedId: null })}
          isLoading={listQuery.isFetching}
        />
      )}

      {/*
        A right-edge panel, not a centred dialog — the same shape as the refund
        and payment drawers. `panelClassName` matches RefundDrawer: full width
        on a phone, 60% of the viewport from `md` up. The breakpoint is 768px
        rather than `sm`, because at 640px a 60% panel is 384px — narrower than
        the form's own fields, so it would be a worse container than the phone
        layout it replaced.
      */}
      <Drawer
        open={formOpen}
        onOpenChange={onFormOpenChange}
        onRequestClose={requestCloseForm}
        title="Add follow-up"
        description="Schedule the next conversation with a lead."
        panelClassName="md:w-[60vw]"
        bodyClassName="px-4 py-5 sm:px-6"
        footer={createFooter}
      >
        <form
          id="follow-up-form"
          onSubmit={handleCreate}
          className="mx-auto w-full max-w-2xl space-y-4"
        >
          {formError && <ErrorBanner error={formError} />}
          {createMutation.isError && <ErrorBanner error={createMutation.error} />}

          <div className="space-y-1.5">
            <Label className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Student <span className="text-rose-500">*</span>
            </Label>
            {enquiriesQuery.isPending ? (
              <div className="h-10 animate-pulse rounded-md bg-slate-100" />
            ) : enquiriesQuery.isError ? (
              <ErrorState
                error={enquiriesQuery.error}
                onRetry={() => enquiriesQuery.refetch()}
                title="Could not load enquiries"
              />
            ) : (
              <>
                <SearchableSelect
                  options={enquiryOptions}
                  value={form.enquiryId}
                  onChange={(value) => setForm((prev) => ({ ...prev, enquiryId: value }))}
                  placeholder="Search enquiries…"
                />
                {enquiriesTruncated && (
                  <p className="text-xs text-slate-500">
                    Showing the {enquiries.length} most recent enquiries of{' '}
                    {enquiriesQuery.data?.count}. Older ones are not listed — open the enquiry and
                    schedule from there.
                  </p>
                )}
              </>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Assign to
              </Label>
              <Select
                value={form.assignedToId || ANY}
                onValueChange={(value) =>
                  setForm((prev) => ({ ...prev, assignedToId: value === ANY ? '' : value }))
                }
              >
                <SelectTrigger className="h-10">
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent className="max-h-60">
                  <SelectItem value={ANY}>Unassigned</SelectItem>
                  {staffOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Type
              </Label>
              <Select
                value={form.type}
                onValueChange={(value) => setForm((prev) => ({ ...prev, type: value }))}
              >
                <SelectTrigger className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FOLLOW_UP_TYPES.map((value) => (
                    <SelectItem key={value} value={value}>
                      <span className="flex items-center gap-2">
                        {TYPE_ICONS[value]} {value}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/*
            Three across only from `lg`. The panel is 60vw, so at a 768px
            viewport it is ~460px wide — but `sm:` keys off the VIEWPORT, and
            three date-sized inputs in 460px are unusable.
          */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1.5">
              <Label
                htmlFor="create-date"
                className="text-xs font-semibold uppercase tracking-wider text-slate-500"
              >
                Date <span className="text-rose-500">*</span>
              </Label>
              <Input
                id="create-date"
                type="date"
                className="h-10"
                value={form.date}
                onChange={(event) => setForm((prev) => ({ ...prev, date: event.target.value }))}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor="create-time"
                className="text-xs font-semibold uppercase tracking-wider text-slate-500"
              >
                Time <span className="text-rose-500">*</span>
              </Label>
              <Input
                id="create-time"
                type="time"
                className="h-10"
                value={form.time}
                onChange={(event) => setForm((prev) => ({ ...prev, time: event.target.value }))}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Priority
              </Label>
              <Select
                value={form.priority}
                onValueChange={(value) => setForm((prev) => ({ ...prev, priority: value }))}
              >
                <SelectTrigger className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FOLLOW_UP_PRIORITIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label
              htmlFor="create-notes"
              className="text-xs font-semibold uppercase tracking-wider text-slate-500"
            >
              Notes
            </Label>
            <Textarea
              id="create-notes"
              rows={3}
              value={form.notes}
              onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
              placeholder="What needs discussing?"
            />
          </div>
        </form>
      </Drawer>

      <Modal
        open={showReschedule}
        onClose={() => setShowReschedule(false)}
        title="Reschedule follow-up"
        description="Choose a new date and time."
        size="sm"
      >
        <form onSubmit={handleReschedule} className="space-y-4">
          {formError && <ErrorBanner error={formError} />}
          <div className="space-y-2">
            <Label htmlFor="reschedule-date">New date</Label>
            <Input
              id="reschedule-date"
              type="date"
              value={rescheduleDate}
              onChange={(event) => setRescheduleDate(event.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="reschedule-time">New time</Label>
            <Input
              id="reschedule-time"
              type="time"
              value={rescheduleTime}
              onChange={(event) => setRescheduleTime(event.target.value)}
              required
            />
          </div>
          <div className="flex flex-col-reverse gap-2 border-t border-slate-100 pt-4 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowReschedule(false)}
              disabled={patchMutation.isPending}
              className="w-full sm:w-auto"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={patchMutation.isPending} className="w-full sm:w-auto">
              {patchMutation.isPending ? 'Saving…' : 'Reschedule'}
            </Button>
          </div>
        </form>
      </Modal>

      <CompleteFollowUpModal
        followUp={selected}
        open={showComplete}
        onClose={() => setShowComplete(false)}
        onComplete={handleComplete}
        isLoading={patchMutation.isPending}
      />
    </>
  );
}

/* -------------------------------------------------------------------------- */

function FollowUpRow({
  followUp,
  isSelected,
  onSelect,
}: {
  followUp: FollowUp;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const avatar = getAvatarColor(followUp.enquiry_candidate);
  const scheduled = new Date(followUp.scheduled_for);
  const scheduledValid = !Number.isNaN(scheduled.getTime());
  const overdue = followUp.status === FOLLOW_UP_PENDING && scheduledValid && isPast(scheduled);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={isSelected}
      className={`w-full rounded-lg border bg-white p-3 text-left transition-all ${
        isSelected
          ? 'border-teal-500 shadow-md ring-1 ring-teal-500/20'
          : 'border-slate-200 hover:border-teal-300 hover:shadow-sm'
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${avatar.bg} ${avatar.text}`}
        >
          {getInitials(followUp.enquiry_candidate, 2)}
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-start justify-between gap-2">
            <span className="truncate text-sm font-semibold text-slate-900">
              {followUp.enquiry_candidate}
            </span>
            <Badge
              className={`h-4 shrink-0 px-1.5 py-0 text-[9px] ${
                PRIORITY_TONES[followUp.priority] ?? 'bg-slate-100 text-slate-600'
              }`}
            >
              {followUp.priority}
            </Badge>
          </div>

          <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
            <span className="flex items-center gap-1">
              {TYPE_ICONS[followUp.type] ?? <MessageCircle size={14} className="text-slate-400" />}
              {followUp.type}
            </span>
            <span className="text-slate-300">•</span>
            <span className={overdue ? 'font-semibold text-rose-600' : ''}>
              {scheduledValid ? formatDistanceToNow(scheduled, { addSuffix: true }) : 'No date'}
            </span>
            <span className="text-slate-300">•</span>
            <span className="truncate">{followUp.assigned_to_name}</span>
          </div>

          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="line-clamp-1 text-xs text-slate-600">
                {followUp.notes.trim() || `Scheduled ${followUp.type.toLowerCase()}`}
              </p>
              {(followUp.outcome_status || followUp.admission_possibility) && (
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {followUp.outcome_status && (
                    <Badge
                      variant="outline"
                      className={`h-4 px-1 text-[9px] ${OUTCOME_TONES[followUp.outcome_status]}`}
                    >
                      {FOLLOW_UP_OUTCOME_LABELS[followUp.outcome_status]}
                    </Badge>
                  )}
                  {followUp.admission_possibility && (
                    <Badge
                      variant="outline"
                      className={`h-4 px-1 text-[9px] ${LIKELIHOOD_TONES[followUp.admission_possibility]}`}
                    >
                      {followUp.admission_possibility} chance
                    </Badge>
                  )}
                </div>
              )}
            </div>
            <ChevronRight
              size={16}
              className={`shrink-0 ${isSelected ? 'text-teal-500' : 'text-slate-300'}`}
            />
          </div>
        </div>
      </div>
    </button>
  );
}

function DetailHeader({
  followUp,
  onClose,
  onOpenFull,
}: {
  followUp: FollowUp;
  onClose: () => void;
  onOpenFull: () => void;
}) {
  const avatar = getAvatarColor(followUp.enquiry_candidate);

  return (
    <div className="shrink-0 border-b border-slate-100 bg-white px-4 py-3">
      <div className="flex items-start gap-3">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold ${avatar.bg} ${avatar.text}`}
        >
          {getInitials(followUp.enquiry_candidate)}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-sm font-bold text-slate-900">
              {followUp.enquiry_candidate}
            </h2>
            <Badge
              className={`h-4 shrink-0 px-1.5 py-0 text-[9px] font-bold uppercase ${
                FOLLOW_UP_STATUS_TONES[followUp.status] ??
                'border-slate-200 bg-slate-100 text-slate-700'
              }`}
            >
              {followUp.status}
            </Badge>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
            <CalendarDays size={10} />
            <span>{formatWhen(followUp.scheduled_for, 'MMM d, yyyy')}</span>
            <span className="text-slate-300">•</span>
            <Clock3 size={10} />
            <span>{formatWhen(followUp.scheduled_for, 'p')}</span>
          </div>
          <p className="mt-0.5 truncate text-[10px] text-slate-500">
            Assigned to {followUp.assigned_to_name}
          </p>
        </div>

        <div className="flex shrink-0 gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[10px] text-slate-500 hover:text-teal-600"
            onClick={onOpenFull}
          >
            Open
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-slate-400 hover:text-rose-600"
            onClick={onClose}
            aria-label="Close details"
          >
            <X size={14} />
          </Button>
        </div>
      </div>

      {/*
        Four values, shown as a labelled chip. The old build drew a percentage
        bar here; `admission_possibility` has no numeric column behind it, so a
        bar would misrepresent the data.
      */}
      {(followUp.outcome_status || followUp.admission_possibility) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-slate-50 pt-2">
          {followUp.outcome_status && (
            <Badge
              variant="outline"
              className={`h-5 px-1.5 text-[9px] ${OUTCOME_TONES[followUp.outcome_status]}`}
            >
              {FOLLOW_UP_OUTCOME_LABELS[followUp.outcome_status]}
            </Badge>
          )}
          {followUp.admission_possibility && (
            <Badge
              variant="outline"
              className={`h-5 px-1.5 text-[9px] ${LIKELIHOOD_TONES[followUp.admission_possibility]}`}
            >
              Admission chance: {followUp.admission_possibility}
            </Badge>
          )}
        </div>
      )}
    </div>
  );
}

interface CommentThreadProps {
  comments: FollowUpComment[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  isSending: boolean;
}

/**
 * The discussion thread on a follow-up.
 *
 * FLAT and APPEND-ONLY: there is no `parent_comment` column, and the API
 * returns 403 on PATCH and DELETE. So no reply box, no edit pencil, no delete —
 * every one of those would be a button that can only fail. A correction is a
 * new comment.
 */
function CommentThread({
  comments,
  isPending,
  isError,
  error,
  onRetry,
  value,
  onChange,
  onSubmit,
  isSending,
}: CommentThreadProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/50 px-4 py-2">
        <h3 className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
          <MessageCircle size={10} /> Discussion
        </h3>
        <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold text-slate-500">
          {comments.length}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {isPending ? (
          <LoadingState rows={2} label="Loading discussion…" />
        ) : isError ? (
          <ErrorState error={error} onRetry={onRetry} title="Could not load the discussion" />
        ) : comments.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-slate-50">
              <MessageSquare size={16} className="text-slate-300" />
            </div>
            <p className="text-[11px] font-medium text-slate-400">Nothing discussed yet</p>
          </div>
        ) : (
          <div className="space-y-3">
            {comments.map((comment) => (
              <div key={comment.id} className="flex gap-2.5">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-slate-100 to-slate-200 text-[10px] font-bold text-slate-600">
                  {getInitials(comment.author_name)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-semibold text-slate-800">
                      {comment.author_name}
                    </span>
                    <span className="text-[9px] text-slate-400">
                      {formatWhen(comment.created_at, 'd MMM, h:mm a')}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap break-words rounded-lg border border-slate-100 bg-slate-50 px-2.5 py-2 text-xs leading-relaxed text-slate-700">
                    {comment.comment}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-slate-100 bg-white px-3 py-2.5">
        <div className="relative flex items-center">
          <Input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Add to the discussion…"
            aria-label="Add a comment"
            disabled={isSending}
            className="h-9 rounded-full border-slate-200 bg-slate-50 pl-3 pr-10 text-xs focus:border-teal-500 focus:bg-white"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                onSubmit();
              }
            }}
          />
          <Button
            size="icon"
            className="absolute right-1.5 h-6 w-6 rounded-full bg-teal-600 text-white hover:bg-teal-700"
            onClick={onSubmit}
            disabled={!value.trim() || isSending}
            aria-label="Post comment"
          >
            <Send size={11} />
          </Button>
        </div>
        <p className="mt-1 px-1 text-[9px] text-slate-400">
          Comments cannot be edited or deleted — add another to correct one.
        </p>
      </div>
    </div>
  );
}
