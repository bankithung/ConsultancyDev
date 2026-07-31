'use client';

import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, RotateCcw, Search, Send, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { PaginationBar } from '@/components/common/PaginationBar';
import { EmptyState, ErrorBanner, ErrorState, LoadingState, SuccessBanner } from '@/components/common/states';
import { apiClient } from '@/lib/apiClient';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { useDebounce } from '@/hooks/useDebounce';
import type { PageParams, StudentDocument, StudentDocumentStatus } from '@/lib/types';
import { TransferModal, type HandoverInput } from './TransferModal';
import {
  PHYSICAL_STATUSES,
  PHYSICAL_STATUS_HINT,
  PHYSICAL_STATUS_STYLE,
  appendHandoverNote,
  describeReturn,
  formatDate,
  isInCustody,
} from './physicalDocuments';

interface PhysicalDocumentListProps {
  /** Narrows the list to one student's originals. Omit for the whole branch. */
  registrationId?: number | string;
}

/**
 * The register of ORIGINAL PAPER the office is holding
 * (`apiClient.studentDocuments`).
 *
 * Two actions, both custody rather than ownership: hand a document to a
 * colleague (`current_holder`), or give it back to the student (`returnDocs`).
 *
 * Renders BARE — no card, no heading. Both hosts (the documents panel and the
 * per-registration transfer detail) already provide a titled surface, and the
 * `showHeading` escape hatch this used to need went with the duplicate.
 */
export function PhysicalDocumentList({ registrationId }: PhysicalDocumentListProps) {
  const queryClient = useQueryClient();

  const [searchInput, setSearchInput] = useState('');
  const search = useDebounce(searchInput, 300);
  const [statusFilter, setStatusFilter] = useState<'all' | StudentDocumentStatus>('all');
  const [returnTarget, setReturnTarget] = useState<StudentDocument | null>(null);
  const [handoverTarget, setHandoverTarget] = useState<StudentDocument | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // `studentDocuments.list` takes the registration id first, so it is adapted to
  // the `(params) => …` shape `usePaginatedQuery` expects.
  const fetchDocuments = useCallback(
    (params?: PageParams) => apiClient.studentDocuments.list(registrationId, params),
    [registrationId],
  );

  // Verified against StudentDocumentViewSet:
  //   filterset_fields ('registration', 'status', 'current_holder')
  //   search_fields    ('name', 'document_number', 'registration__student_name')
  //   ordering_fields  ('received_at', 'returned_at', 'status')
  // so the status filter, the search box and this sort are all honoured
  // server-side rather than silently dropped.
  const documents = usePaginatedQuery<StudentDocument>(
    ['student-documents', 'list', registrationId ?? 'all'],
    fetchDocuments,
    {
      search,
      ordering: '-received_at',
      pageSize: 25,
      filters: statusFilter === 'all' ? undefined : { status: statusFilter },
    },
  );

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['student-documents'] });
  };

  const returnMutation = useMutation({
    mutationFn: (doc: StudentDocument) => apiClient.studentDocuments.returnDocs([doc.id]),
    onSuccess: (result) => {
      invalidate();
      setReturnTarget(null);
      // `returned` is what actually happened; `requested` is only what we asked
      // for. Reporting the latter would claim work the API did not do.
      setNotice(describeReturn(result));
    },
  });

  const handoverMutation = useMutation({
    mutationFn: ({ doc, input }: { doc: StudentDocument; input: HandoverInput }) => {
      const remarks = appendHandoverNote(doc, input.holderName, input.note);
      return apiClient.studentDocuments.update(doc.id, {
        current_holder: input.holderId,
        status: 'With staff',
        ...(remarks === undefined ? {} : { remarks }),
      });
    },
    onSuccess: (updated) => {
      invalidate();
      setHandoverTarget(null);
      setNotice(`${updated.name} is now with ${updated.current_holder_name || 'the chosen colleague'}.`);
    },
  });

  const mutationError = returnMutation.error ?? handoverMutation.error;

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

      <div className="flex flex-col gap-2 border-b border-slate-100 p-3 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            placeholder="Search by document or student…"
            aria-label="Search physical documents"
            className="h-9 pl-9 text-sm"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(value) => setStatusFilter(value as 'all' | StudentDocumentStatus)}
        >
          <SelectTrigger className="h-9 w-full text-sm sm:w-48" aria-label="Filter by custody status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {PHYSICAL_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {status}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {documents.isError ? (
        <div className="p-4">
          <ErrorState error={documents.error} onRetry={documents.refetch} />
        </div>
      ) : documents.isLoading ? (
        <div className="p-4">
          <LoadingState rows={5} label="Loading physical documents" />
        </div>
      ) : documents.rows.length === 0 ? (
        <div className="p-4">
          <EmptyState
            icon={FolderOpen}
            title={
              search || statusFilter !== 'all'
                ? 'No originals match this search'
                : 'No physical documents recorded'
            }
            description="Originals are recorded when a student hands them in from their profile."
          />
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700">
                    Document
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700">
                    Student
                  </th>
                  <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 md:table-cell">
                    Number
                  </th>
                  <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 lg:table-cell">
                    Held by
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700">
                    Status
                  </th>
                  <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 xl:table-cell">
                    Received
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-slate-700">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {documents.rows.map((doc) => (
                  <tr key={doc.id} className="transition-colors hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-orange-50 text-orange-600">
                          <FolderOpen size={14} />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-medium text-slate-900">{doc.name}</p>
                          {doc.remarks && (
                            <p className="truncate text-xs text-slate-400" title={doc.remarks}>
                              {doc.remarks}
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1.5 text-slate-600">
                        <User size={12} className="shrink-0 text-slate-400" />
                        <span className="truncate">{doc.student_name || '—'}</span>
                      </span>
                    </td>
                    <td className="hidden px-4 py-3 font-mono text-xs text-slate-500 md:table-cell">
                      {doc.document_number || '—'}
                    </td>
                    <td className="hidden px-4 py-3 text-xs text-slate-600 lg:table-cell">
                      {doc.current_holder_name || '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${PHYSICAL_STATUS_STYLE[doc.status]}`}
                        title={PHYSICAL_STATUS_HINT[doc.status]}
                      >
                        {doc.status}
                      </span>
                    </td>
                    <td className="hidden px-4 py-3 text-xs text-slate-500 xl:table-cell">
                      {formatDate(doc.received_at)}
                    </td>
                    <td className="px-4 py-3">
                      {isInCustody(doc) ? (
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 gap-1 px-2 text-xs hover:bg-teal-50 hover:text-teal-700"
                            onClick={() => setHandoverTarget(doc)}
                          >
                            <Send size={12} />
                            <span className="hidden sm:inline">Hand over</span>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 gap-1 px-2 text-xs hover:bg-green-50 hover:text-green-700"
                            onClick={() => setReturnTarget(doc)}
                          >
                            <RotateCcw size={12} />
                            <span className="hidden sm:inline">Return</span>
                          </Button>
                        </div>
                      ) : (
                        <p className="text-right text-xs text-slate-400">
                          {doc.status === 'Returned'
                            ? `Returned ${formatDate(doc.returned_at)}`
                            : PHYSICAL_STATUS_HINT[doc.status]}
                        </p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <PaginationBar
            page={documents.page}
            pages={documents.pages}
            count={documents.count}
            pageSize={documents.pageSize}
            onPageChange={documents.setPage}
            isLoading={documents.isFetching}
          />
        </>
      )}

      <ConfirmDialog
        open={returnTarget !== null}
        onClose={() => setReturnTarget(null)}
        onConfirm={() => returnTarget && returnMutation.mutate(returnTarget)}
        title="Return this original?"
        description={`${returnTarget?.name ?? 'This document'} goes back to ${
          returnTarget?.student_name || 'the student'
        }. The office stops being answerable for it.`}
        confirmText="Mark as returned"
        isLoading={returnMutation.isPending}
      />

      <TransferModal
        open={handoverTarget !== null}
        onClose={() => setHandoverTarget(null)}
        documents={handoverTarget ? [handoverTarget] : []}
        isPending={handoverMutation.isPending}
        error={handoverMutation.error}
        onSubmit={(input) => handoverTarget && handoverMutation.mutate({ doc: handoverTarget, input })}
      />
    </div>
  );
}
