'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNow, isPast } from 'date-fns';
import { CheckCircle, Clock, MessageSquare, NotebookPen } from 'lucide-react';

import { apiClient } from '@/lib/apiClient';
import type { FollowUp } from '@/lib/types';
import { getInitials } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { BackButton } from '@/components/ui/back-button';
import { Modal } from '@/components/common/Modal';
import { toArray } from '@/components/common/pagination';
import { EmptyState, ErrorBanner, ErrorState, LoadingState } from '@/components/common/states';
import {
  CompleteFollowUpModal,
  FOLLOW_UP_COMPLETED_STATUS,
  type FollowUpCompletion,
} from '@/components/common/CompleteFollowUpModal';
import { FOLLOW_UP_OUTCOME_LABELS } from '@/components/common/followUps';
import { useAuth } from '@/hooks/useAuth';
import { toast } from '@/store/toastStore';

/**
 * `FollowUp.status` is a free CharField defaulting to 'Pending'. Only 'Pending'
 * is a server-side default the app can rely on; everything else is convention,
 * so these are compared as data rather than treated as an enum.
 */
const PENDING_STATUS = 'Pending';

const STATUS_TONES: Record<string, string> = {
  Pending: 'bg-amber-100 text-amber-700 border-amber-200',
  Completed: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  Missed: 'bg-rose-100 text-rose-700 border-rose-200',
};

const PRIORITY_TONES: Record<string, string> = {
  High: 'bg-rose-50 text-rose-700 border-rose-200',
  Medium: 'bg-amber-50 text-amber-700 border-amber-200',
  Low: 'bg-slate-50 text-slate-600 border-slate-200',
};

/** Local date + time inputs to the ISO datetime `scheduled_for` expects. */
function toIsoDateTime(date: string, time: string): string | null {
  const parsed = new Date(`${date}T${time}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export default function FollowUpDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, isManager } = useAuth();
  const id = params.id;

  const [showComplete, setShowComplete] = useState(false);
  const [showReschedule, setShowReschedule] = useState(false);
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [rescheduleTime, setRescheduleTime] = useState('');
  const [rescheduleError, setRescheduleError] = useState<string | null>(null);
  const [newComment, setNewComment] = useState('');

  const followUpQuery = useQuery({
    queryKey: ['followUp', id],
    queryFn: () => apiClient.followUps.get(id),
    enabled: Boolean(id),
  });

  const commentsQuery = useQuery({
    queryKey: ['followUpComments', id],
    queryFn: () => apiClient.followUpComments.list(id, { page_size: 100, ordering: 'created_at' }),
    enabled: Boolean(id),
  });

  const followUp = followUpQuery.data;
  const comments = toArray(commentsQuery.data);

  const patchMutation = useMutation({
    mutationFn: (patch: Partial<FollowUp>) => apiClient.followUps.update(id, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(['followUp', id], updated);
      queryClient.invalidateQueries({ queryKey: ['followUps'] });
    },
  });

  const handleComplete = (patch: FollowUpCompletion) => {
    patchMutation.mutate(patch, {
      onSuccess: () => {
        setShowComplete(false);
        toast.success('Follow-up completed');
      },
    });
  };

  const handleReschedule = (event: React.FormEvent) => {
    event.preventDefault();
    const iso = toIsoDateTime(rescheduleDate, rescheduleTime);
    if (!iso) {
      setRescheduleError('Pick a valid date and time.');
      return;
    }
    setRescheduleError(null);
    patchMutation.mutate(
      { scheduled_for: iso },
      {
        onSuccess: () => {
          setShowReschedule(false);
          toast.success('Follow-up rescheduled');
        },
      },
    );
  };

  /**
   * The discussion thread, now a real resource (`follow-up-comments/`).
   *
   * It replaces appending to the single `notes` TextField, which was a
   * read-modify-write: two people writing at the same moment silently lost one
   * of the entries. `author` is stamped server-side, and the API refuses PATCH
   * and DELETE with 403 — the thread is FLAT and append-only, so there is no
   * reply, edit or delete control below.
   */
  const commentMutation = useMutation({
    mutationFn: (comment: string) =>
      apiClient.followUpComments.create({ follow_up: id, comment }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['followUpComments', id] });
      setNewComment('');
      toast.success('Comment added');
    },
  });

  const handleAddComment = () => {
    const trimmed = newComment.trim();
    if (!trimmed) return;
    commentMutation.mutate(trimmed);
  };

  if (followUpQuery.isPending) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        <BackButton label="Back to follow-ups" />
        <LoadingState rows={5} label="Loading follow-up…" />
      </div>
    );
  }

  if (followUpQuery.isError) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        <BackButton label="Back to follow-ups" />
        <ErrorState error={followUpQuery.error} onRetry={() => followUpQuery.refetch()} />
      </div>
    );
  }

  if (!followUp) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        <BackButton label="Back to follow-ups" />
        <EmptyState
          title="Follow-up not found"
          description="It may have been deleted."
          action={
            <Button variant="outline" onClick={() => router.push('/app/follow-ups')}>
              Back to follow-ups
            </Button>
          }
        />
      </div>
    );
  }

  const isPending = followUp.status === PENDING_STATUS;
  // Presentation only — the backend is the authority on who may write.
  const canAct = isPending && (followUp.assigned_to === user?.id || isManager);
  const scheduledOn = new Date(followUp.scheduled_for);
  const overdue = isPending && !Number.isNaN(scheduledOn.getTime()) && isPast(scheduledOn);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <BackButton label="Back to follow-ups" />

      {patchMutation.isError && (
        <ErrorBanner error={patchMutation.error} onDismiss={() => patchMutation.reset()} />
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <div className="rounded-lg border border-slate-200 bg-white p-4 sm:p-6">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm font-semibold text-emerald-700">
                {followUp.enquiry_candidate.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-lg font-semibold text-slate-900 sm:text-xl">
                  {followUp.enquiry_candidate}
                </h1>
                <p className="mt-0.5 text-sm text-slate-500">Follow-up via {followUp.type}</p>
                <Link
                  href={`/app/enquiries/${followUp.enquiry}`}
                  className="mt-1 inline-block text-xs font-medium text-teal-700 underline underline-offset-2 hover:text-teal-800"
                >
                  View the enquiry
                </Link>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Badge
                  className={
                    STATUS_TONES[followUp.status] ?? 'bg-slate-100 text-slate-700 border-slate-200'
                  }
                >
                  {followUp.status}
                </Badge>
                <Badge
                  className={
                    PRIORITY_TONES[followUp.priority] ?? 'bg-slate-50 text-slate-600 border-slate-200'
                  }
                >
                  {followUp.priority} priority
                </Badge>
              </div>
            </div>

            {overdue && (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Overdue by {formatDistanceToNow(scheduledOn)}.
              </p>
            )}
          </div>

          <div className="rounded-lg border border-slate-200 bg-white">
            <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 sm:px-6">
              <MessageSquare size={16} className="text-slate-400" />
              <h2 className="text-base font-semibold text-slate-900">Notes</h2>
            </div>

            <div className="px-4 py-4 sm:px-6">
              {followUp.notes.trim() ? (
                <p className="whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-4 text-sm leading-relaxed text-slate-700">
                  {followUp.notes}
                </p>
              ) : (
                <div className="py-8 text-center">
                  <NotebookPen size={26} className="mx-auto mb-2 text-slate-300" />
                  <p className="text-sm text-slate-500">Nothing recorded yet.</p>
                </div>
              )}
            </div>

          </div>

          <div className="rounded-lg border border-slate-200 bg-white">
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 sm:px-6">
              <div className="flex items-center gap-2">
                <MessageSquare size={16} className="text-slate-400" />
                <h2 className="text-base font-semibold text-slate-900">Discussion</h2>
              </div>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">
                {comments.length}
              </span>
            </div>

            <div className="px-4 py-4 sm:px-6">
              {commentsQuery.isPending ? (
                <LoadingState rows={2} label="Loading discussion…" />
              ) : commentsQuery.isError ? (
                <ErrorState
                  error={commentsQuery.error}
                  onRetry={() => commentsQuery.refetch()}
                  title="Could not load the discussion"
                />
              ) : comments.length === 0 ? (
                <div className="py-8 text-center">
                  <MessageSquare size={26} className="mx-auto mb-2 text-slate-300" />
                  <p className="text-sm text-slate-500">Nothing discussed yet.</p>
                </div>
              ) : (
                <ul className="space-y-4">
                  {comments.map((comment) => (
                    <li key={comment.id} className="flex gap-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-bold text-slate-600">
                        {getInitials(comment.author_name)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-slate-800">
                            {comment.author_name}
                          </span>
                          <span className="text-xs text-slate-400">
                            {format(new Date(comment.created_at), 'dd MMM yyyy, h:mm a')}
                          </span>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap break-words rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-sm leading-relaxed text-slate-700">
                          {comment.comment}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-3 border-t border-slate-200 bg-slate-50 px-4 py-4 sm:px-6">
              {commentMutation.isError && (
                <ErrorBanner error={commentMutation.error} onDismiss={() => commentMutation.reset()} />
              )}
              <Label htmlFor="new-comment" className="text-sm font-medium text-slate-700">
                Add a comment
              </Label>
              <Textarea
                id="new-comment"
                value={newComment}
                onChange={(event) => setNewComment(event.target.value)}
                rows={3}
                placeholder="What happened? Anything the next person should know?"
                disabled={commentMutation.isPending}
                className="bg-white"
              />
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-slate-500">
                  Comments cannot be edited or deleted — add another to correct one.
                </p>
                <Button
                  size="sm"
                  onClick={handleAddComment}
                  disabled={commentMutation.isPending || !newComment.trim()}
                  className="w-full sm:w-auto"
                >
                  {commentMutation.isPending ? 'Posting…' : 'Add comment'}
                </Button>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-5 lg:col-span-1">
          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <h2 className="mb-4 text-sm font-semibold text-slate-900">Details</h2>
            <dl className="space-y-4">
              <div>
                <dt className="mb-1 text-xs text-slate-500">Scheduled for</dt>
                <dd className="text-sm font-medium text-slate-900">
                  {Number.isNaN(scheduledOn.getTime())
                    ? '—'
                    : format(scheduledOn, 'dd MMM yyyy')}
                </dd>
                {!Number.isNaN(scheduledOn.getTime()) && (
                  <dd className="text-xs text-slate-500">{format(scheduledOn, 'h:mm a')}</dd>
                )}
              </div>

              <div className="border-t border-slate-100 pt-3">
                <dt className="mb-1 text-xs text-slate-500">Assigned to</dt>
                {/* The serializer already renders '—' when unassigned. */}
                <dd className="truncate text-sm font-medium text-slate-900">
                  {followUp.assigned_to_name}
                </dd>
              </div>

              <div className="border-t border-slate-100 pt-3">
                <dt className="mb-1 text-xs text-slate-500">Created by</dt>
                <dd className="truncate text-sm font-medium text-slate-900">
                  {followUp.created_by_name}
                </dd>
              </div>

              <div className="border-t border-slate-100 pt-3">
                <dt className="mb-1 text-xs text-slate-500">Contact method</dt>
                <dd className="text-sm font-medium text-slate-900">{followUp.type}</dd>
              </div>

              {followUp.completed_at && (
                <div className="border-t border-slate-100 pt-3">
                  <dt className="mb-1 text-xs text-slate-500">Completed</dt>
                  <dd className="text-sm font-medium text-slate-900">
                    {format(new Date(followUp.completed_at), 'dd MMM yyyy, h:mm a')}
                  </dd>
                </div>
              )}

              {followUp.outcome_status && (
                <div className="border-t border-slate-100 pt-3">
                  <dt className="mb-1 text-xs text-slate-500">Outcome</dt>
                  <dd className="text-sm font-medium text-slate-900">
                    {FOLLOW_UP_OUTCOME_LABELS[followUp.outcome_status]}
                  </dd>
                </div>
              )}

              {/*
                Four values ('High' | 'Medium' | 'Low' | 'Unknown'), not a
                percentage — there is no numeric column behind this field.
              */}
              {followUp.admission_possibility && (
                <div className="border-t border-slate-100 pt-3">
                  <dt className="mb-1 text-xs text-slate-500">Admission likelihood</dt>
                  <dd className="text-sm font-medium text-slate-900">
                    {followUp.admission_possibility}
                  </dd>
                </div>
              )}
            </dl>
          </div>

          {canAct ? (
            <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-5">
              <h2 className="text-sm font-semibold text-slate-900">Actions</h2>
              <Button
                onClick={() => setShowComplete(true)}
                disabled={patchMutation.isPending}
                className="w-full bg-emerald-600 text-white hover:bg-emerald-700"
              >
                <CheckCircle size={16} className="mr-2" />
                Mark complete
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  const base = Number.isNaN(scheduledOn.getTime()) ? new Date() : scheduledOn;
                  setRescheduleDate(format(base, 'yyyy-MM-dd'));
                  setRescheduleTime(format(base, 'HH:mm'));
                  setRescheduleError(null);
                  setShowReschedule(true);
                }}
                disabled={patchMutation.isPending}
                className="w-full"
              >
                <Clock size={16} className="mr-2" />
                Reschedule
              </Button>
            </div>
          ) : (
            <div className="rounded-lg border border-slate-200 bg-white p-5">
              <p
                className={`rounded-lg border py-3 text-center text-sm font-medium ${
                  STATUS_TONES[followUp.status] ?? 'border-slate-200 bg-slate-50 text-slate-600'
                }`}
              >
                {followUp.status === FOLLOW_UP_COMPLETED_STATUS
                  ? 'Completed'
                  : isPending
                    ? 'Assigned to someone else'
                    : followUp.status}
              </p>
            </div>
          )}
        </div>
      </div>

      <Modal
        open={showReschedule}
        onClose={() => setShowReschedule(false)}
        title="Reschedule follow-up"
        description="Choose a new date and time."
        size="sm"
      >
        <form onSubmit={handleReschedule} className="space-y-4">
          {rescheduleError && <ErrorBanner error={rescheduleError} />}
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
        followUp={followUp}
        open={showComplete}
        onClose={() => setShowComplete(false)}
        onComplete={handleComplete}
        isLoading={patchMutation.isPending}
      />
    </div>
  );
}
