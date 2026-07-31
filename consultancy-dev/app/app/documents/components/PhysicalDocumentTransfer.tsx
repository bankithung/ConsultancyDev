'use client';

import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, FolderOpen, RotateCcw, Search, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  EmptyState,
  ErrorBanner,
  ErrorState,
  InlineSpinner,
  LoadingState,
  SuccessBanner,
} from '@/components/common/states';
import { apiClient } from '@/lib/apiClient';
import { getApiErrorMessage } from '@/lib/api';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { useDebounce } from '@/hooks/useDebounce';
import type { PageParams, StudentDocument } from '@/lib/types';
import { TransferModal, type HandoverInput } from './TransferModal';
import {
  PHYSICAL_STATUS_STYLE,
  appendHandoverNote,
  describeReturn,
  formatDateTime,
  isInCustody,
} from './physicalDocuments';

/** How many custody records back the picker and the activity feed. */
const WINDOW = 50;
const ACTIVITY_WINDOW = 10;

type Mode = 'handover' | 'return';

interface ActivityEntry {
  id: number;
  name: string;
  student: string;
  detail: string;
  at: number;
  status: StudentDocument['status'];
}

/**
 * Bulk custody actions on ORIGINAL PAPER (`apiClient.studentDocuments`).
 *
 * Hand a batch to a colleague (`current_holder` moves) or give a batch back to
 * the student (`returnDocs`). Neither is a record transfer: ownership of the
 * student's file is untouched, and nothing here goes near
 * `apiClient.transfers`.
 *
 * Renders bare into the documents panel, which supplies the heading and the
 * surface.
 */
export function PhysicalDocumentTransfer() {
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<Mode>('handover');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [searchInput, setSearchInput] = useState('');
  const search = useDebounce(searchInput, 300);
  const [handoverOpen, setHandoverOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const fetchAll = useCallback(
    (params?: PageParams) => apiClient.studentDocuments.list(undefined, params),
    [],
  );

  // `received_at` and `returned_at` are both in StudentDocumentViewSet's
  // ordering_fields, and `status` is in its filterset_fields, so each query is
  // narrowed and sorted server-side. The merged feed below is re-sorted on the
  // client only because it interleaves two differently-dated sources.
  const custody = usePaginatedQuery<StudentDocument>(
    ['student-documents', 'custody'],
    fetchAll,
    { search, ordering: '-received_at', pageSize: WINDOW },
  );

  const returned = usePaginatedQuery<StudentDocument>(
    ['student-documents', 'returned'],
    fetchAll,
    { ordering: '-returned_at', pageSize: ACTIVITY_WINDOW, filters: { status: 'Returned' } },
  );

  const available = useMemo(
    () => custody.rows.filter(isInCustody),
    [custody.rows],
  );

  const selectedDocs = useMemo(
    () => available.filter((doc) => selectedIds.includes(doc.id)),
    [available, selectedIds],
  );

  const activity = useMemo<ActivityEntry[]>(() => {
    // Merged by id, because if the backend ignores the status filter both
    // queries return the same rows — the entry type comes from each row's own
    // status, never from which query produced it.
    const byId = new Map<number, StudentDocument>();
    for (const doc of [...returned.rows, ...custody.rows]) {
      if (doc.status === 'Returned' || doc.status === 'With staff') byId.set(doc.id, doc);
    }

    return [...byId.values()]
      .map((doc) => {
        const stamp = doc.status === 'Returned' ? doc.returned_at : doc.received_at;
        const at = stamp ? new Date(stamp).getTime() : Number.NaN;
        return {
          id: doc.id,
          name: doc.name,
          student: doc.student_name || 'Unknown student',
          detail:
            doc.status === 'Returned'
              ? `Returned ${formatDateTime(doc.returned_at)}`
              : `With ${doc.current_holder_name || 'a colleague'}`,
          at: Number.isNaN(at) ? 0 : at,
          status: doc.status,
        };
      })
      .sort((a, b) => b.at - a.at);
  }, [returned.rows, custody.rows]);

  const clearSelection = () => setSelectedIds([]);

  const returnMutation = useMutation({
    mutationFn: (ids: number[]) => apiClient.studentDocuments.returnDocs(ids),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['student-documents'] });
      clearSelection();
      // Always `returned`, never `requested`: the two differ when an id was out
      // of scope or already back with the student.
      setNotice(describeReturn(result));
    },
  });

  const handoverMutation = useMutation<
    { moved: number; failed: number; firstError: string | null; holderName: string },
    Error,
    HandoverInput
  >({
    mutationFn: async (input) => {
      const results = await Promise.allSettled(
        selectedDocs.map((doc) => {
          const remarks = appendHandoverNote(doc, input.holderName, input.note);
          return apiClient.studentDocuments.update(doc.id, {
            current_holder: input.holderId,
            status: 'With staff',
            ...(remarks === undefined ? {} : { remarks }),
          });
        }),
      );

      const rejections = results.filter((result) => result.status === 'rejected');
      return {
        moved: results.length - rejections.length,
        failed: rejections.length,
        firstError: rejections[0] ? getApiErrorMessage(rejections[0].reason) : null,
        holderName: input.holderName,
      };
    },
    onSuccess: (outcome) => {
      queryClient.invalidateQueries({ queryKey: ['student-documents'] });
      setHandoverOpen(false);
      clearSelection();
      const noun = outcome.moved === 1 ? 'original' : 'originals';
      setNotice(
        outcome.failed === 0
          ? `${outcome.moved} ${noun} now recorded with ${outcome.holderName}.`
          : `${outcome.moved} of ${outcome.moved + outcome.failed} moved to ${outcome.holderName}. ${
              outcome.firstError ?? 'The rest were rejected.'
            }`,
      );
    },
  });

  const toggle = (id: number, checked: boolean) => {
    setNotice(null);
    setSelectedIds((current) => (checked ? [...current, id] : current.filter((value) => value !== id)));
  };

  const runAction = () => {
    if (selectedDocs.length === 0) return;
    if (mode === 'return') {
      returnMutation.mutate(selectedDocs.map((doc) => doc.id));
      return;
    }
    setHandoverOpen(true);
  };

  const busy = returnMutation.isPending || handoverMutation.isPending;
  const mutationError = returnMutation.error ?? handoverMutation.error;
  const selectionLabel =
    selectedDocs.length === 1 ? '1 original' : `${selectedDocs.length} originals`;

  return (
    <div>
      {(mutationError || notice) && (
        <div className="space-y-2 border-b border-slate-100 p-3">
          {mutationError && (
            <ErrorBanner
              error={mutationError}
              onDismiss={() => {
                returnMutation.reset();
                handoverMutation.reset();
              }}
            />
          )}
          {notice && <SuccessBanner message={notice} onDismiss={() => setNotice(null)} />}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2">
        <div className="space-y-4 border-b border-slate-100 p-3 sm:p-4 xl:border-b-0 xl:border-r">
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            <FolderOpen size={14} className="text-orange-600" />
            Custody action
          </h3>

          <div
            className="flex gap-1 rounded-lg bg-slate-100 p-1"
            role="radiogroup"
            aria-label="Custody action"
          >
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'handover'}
              className={`flex-1 rounded-md px-3 py-2 text-xs font-medium transition-all ${
                mode === 'handover'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
              onClick={() => setMode('handover')}
            >
              <Send size={12} className="mr-1.5 inline" />
              Hand to colleague
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'return'}
              className={`flex-1 rounded-md px-3 py-2 text-xs font-medium transition-all ${
                mode === 'return'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
              onClick={() => setMode('return')}
            >
              <RotateCcw size={12} className="mr-1.5 inline" />
              Return to student
            </button>
          </div>

          <div className="space-y-2">
            <Label className="font-medium font-body">
              Originals ({selectedIds.length} selected)
            </Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                placeholder="Search by document or student…"
                aria-label="Search originals in custody"
                className="h-10 pl-10"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </div>

            <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-200 bg-white">
              {custody.isError ? (
                <div className="p-3">
                  <ErrorState error={custody.error} onRetry={custody.refetch} />
                </div>
              ) : custody.isLoading ? (
                <div className="p-3">
                  <LoadingState rows={3} label="Loading originals" />
                </div>
              ) : available.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-slate-500">
                  {search
                    ? 'No originals in custody match that search.'
                    : 'Nothing in custody. Originals appear here once a student hands them in.'}
                </p>
              ) : (
                <div className="space-y-1 p-2">
                  {available.map((doc) => (
                    <label
                      key={doc.id}
                      className={`flex cursor-pointer items-center gap-3 rounded-lg p-3 transition-colors hover:bg-slate-50 ${
                        selectedIds.includes(doc.id) ? 'border border-orange-200 bg-orange-50' : ''
                      }`}
                    >
                      <Checkbox
                        checked={selectedIds.includes(doc.id)}
                        disabled={busy}
                        onCheckedChange={(checked) => toggle(doc.id, checked === true)}
                      />
                      <span className="min-w-0 flex-1 text-sm">
                        <span className="block truncate font-semibold text-slate-900">{doc.name}</span>
                        <span className="block truncate text-xs text-slate-500">
                          {doc.student_name || 'Unknown student'}
                          {doc.current_holder_name ? ` · with ${doc.current_holder_name}` : ''}
                        </span>
                      </span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${PHYSICAL_STATUS_STYLE[doc.status]}`}
                      >
                        {doc.status}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {custody.count > custody.rows.length && (
              <p className="text-xs text-slate-500">
                Showing the first {WINDOW} of {custody.count}. Search to narrow the list.
              </p>
            )}
          </div>

          <Button
            className={`h-10 w-full ${
              mode === 'return' ? 'bg-green-600 hover:bg-green-700' : 'bg-orange-600 hover:bg-orange-700'
            }`}
            onClick={runAction}
            disabled={selectedDocs.length === 0 || busy}
          >
            {busy ? (
              <>
                <InlineSpinner className="mr-2" /> Working…
              </>
            ) : mode === 'return' ? (
              <>
                <RotateCcw size={16} className="mr-2" /> Return {selectionLabel} to student
              </>
            ) : (
              <>
                <Send size={16} className="mr-2" /> Hand over {selectionLabel}
              </>
            )}
          </Button>
        </div>

        <div className="space-y-3 p-3 sm:p-4">
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            <Clock size={14} className="text-slate-400" />
            Recent custody changes
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium tabular-nums text-slate-500">
              {activity.length}
            </span>
          </h3>

          {custody.isError || returned.isError ? (
            <ErrorState
              error={custody.isError ? custody.error : returned.error}
              onRetry={() => {
                custody.refetch();
                returned.refetch();
              }}
            />
          ) : custody.isLoading || returned.isLoading ? (
            <LoadingState rows={3} label="Loading custody history" />
          ) : activity.length === 0 ? (
            <EmptyState
              icon={Clock}
              title="No custody changes yet"
              description="Hand-overs and returns show up here as they happen."
            />
          ) : (
            <div className="space-y-2">
              {activity.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 p-3 transition-colors hover:bg-slate-50"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <span
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded ${
                        entry.status === 'Returned'
                          ? 'bg-green-50 text-green-600'
                          : 'bg-amber-50 text-amber-600'
                      }`}
                    >
                      {entry.status === 'Returned' ? <RotateCcw size={14} /> : <Send size={14} />}
                    </span>
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium text-slate-900">{entry.name}</p>
                      <p className="break-words text-xs text-slate-500">{entry.student}</p>
                      <p className="mt-0.5 text-xs text-slate-400">{entry.detail}</p>
                    </div>
                  </div>
                  <span
                    className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium ${PHYSICAL_STATUS_STYLE[entry.status]}`}
                  >
                    {entry.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <TransferModal
        open={handoverOpen}
        onClose={() => setHandoverOpen(false)}
        documents={selectedDocs}
        isPending={handoverMutation.isPending}
        error={handoverMutation.error}
        onSubmit={(input) => handoverMutation.mutate(input)}
      />
    </div>
  );
}
