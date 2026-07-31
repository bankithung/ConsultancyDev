'use client';

import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Archive, Pencil, Plus, Trash2, Undo2 } from 'lucide-react';
import { apiClient } from '@/lib/apiClient';
import type { PageParams, StudentDocument, StudentDocumentStatus } from '@/lib/types';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { PaginationBar } from '@/components/common/PaginationBar';
import { EmptyState, ErrorState, LoadingState, InlineSpinner } from '@/components/common/states';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useCurrentRole } from '@/components/rbac/useCurrentRole';
import { toast } from '@/store/toastStore';
import { PhysicalDocumentModal } from './PhysicalDocumentModal';

interface PhysicalDocumentListProps {
  registrationId: string;
}

const STATUS_STYLE: Record<StudentDocumentStatus, string> = {
  Received: 'bg-amber-100 text-amber-700',
  'With staff': 'bg-blue-100 text-blue-700',
  Submitted: 'bg-indigo-100 text-indigo-700',
  Returned: 'bg-emerald-100 text-emerald-700',
  Lost: 'bg-red-100 text-red-700',
};

/**
 * A document the office is still holding, and therefore still liable to return.
 *
 * The old build tested `status === 'Held'`; that value does not exist in the
 * rebuilt API. Custody is now the absence of an end state.
 */
function isInCustody(document: StudentDocument): boolean {
  return document.status !== 'Returned' && document.status !== 'Lost';
}

/**
 * Custody of a student's ORIGINAL paper documents — the passport in the office
 * drawer. Uploaded scans are a different resource and live in `DocumentList`.
 */
export function PhysicalDocumentList({ registrationId }: PhysicalDocumentListProps) {
  const queryClient = useQueryClient();
  const { can } = useCurrentRole();
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editing, setEditing] = useState<StudentDocument | null>(null);
  const [pendingDelete, setPendingDelete] = useState<StudentDocument | null>(null);

  const fetchDocuments = useCallback(
    (params?: PageParams) => apiClient.studentDocuments.list(registrationId, params),
    [registrationId],
  );

  const documents = usePaginatedQuery<StudentDocument>(['student-documents', registrationId], fetchDocuments, {
    ordering: '-received_at',
    pageSize: 25,
    enabled: Boolean(registrationId),
  });

  const heldCount = useMemo(() => documents.rows.filter(isInCustody).length, [documents.rows]);

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['student-documents', registrationId] });
  }, [queryClient, registrationId]);

  const returnMutation = useMutation({
    mutationFn: (ids: number[]) => apiClient.studentDocuments.returnDocs(ids),
    onSuccess: (result) => {
      invalidate();
      setSelectedIds([]);
      // `returned` and `requested` differ when an id was already returned or sat
      // outside the caller's scope. Reporting `requested` would claim work the
      // API did not do.
      toast.success(
        `Returned ${result.returned} document${result.returned === 1 ? '' : 's'}`,
        result.returned < result.requested
          ? `${result.requested - result.returned} were skipped — already returned, or outside your branch.`
          : undefined,
      );
    },
    onError: () => toast.error('Could not return those documents'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiClient.studentDocuments.delete(id),
    onSuccess: () => {
      invalidate();
      setPendingDelete(null);
      toast.success('Document record removed');
    },
    onError: () => toast.error('Could not remove that record'),
  });

  const toggleSelected = (id: number, checked: boolean) => {
    setSelectedIds((current) => (checked ? [...current, id] : current.filter((value) => value !== id)));
  };

  const openCreate = () => {
    setEditing(null);
    setIsFormOpen(true);
  };

  const openEdit = (document: StudentDocument) => {
    setEditing(document);
    setIsFormOpen(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 rounded-lg border border-amber-100 bg-amber-50 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-amber-900 sm:text-sm">
            {heldCount} original{heldCount === 1 ? '' : 's'} in our custody on this page
          </p>
          <p className="text-[11px] text-amber-800">Physical papers we are holding — not uploaded scans.</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button size="sm" variant="outline" className="h-9 bg-white" onClick={openCreate}>
            <Plus size={14} className="mr-1" /> Add
          </Button>
          {selectedIds.length > 0 && (
            <Button
              size="sm"
              className="h-9 bg-emerald-600 hover:bg-emerald-700"
              onClick={() => returnMutation.mutate(selectedIds)}
              disabled={returnMutation.isPending}
            >
              {returnMutation.isPending ? (
                <>
                  <InlineSpinner className="mr-2" /> Returning…
                </>
              ) : (
                <>
                  <Undo2 size={14} className="mr-1" /> Return {selectedIds.length}
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {documents.isLoading && <LoadingState rows={3} label="Loading physical documents" />}

      {documents.isError && (
        <ErrorState error={documents.error} onRetry={documents.refetch} title="Could not load document custody" />
      )}

      {!documents.isLoading && !documents.isError && documents.isEmpty && (
        <EmptyState
          title="No originals recorded"
          description="Log a passport, marksheet or certificate as soon as the office takes it in."
          icon={Archive}
          action={
            <Button size="sm" className="h-9" onClick={openCreate}>
              <Plus size={14} className="mr-1" /> Add document
            </Button>
          }
        />
      )}

      {!documents.isError && documents.rows.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[540px] text-left text-sm">
              <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                <tr>
                  <th scope="col" className="w-10 p-2">
                    <span className="sr-only">Select</span>
                  </th>
                  <th scope="col" className="p-2">
                    Document
                  </th>
                  <th scope="col" className="p-2">
                    Reference
                  </th>
                  <th scope="col" className="p-2">
                    Held by
                  </th>
                  <th scope="col" className="p-2">
                    Status
                  </th>
                  <th scope="col" className="p-2 text-right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white text-xs text-slate-700">
                {documents.rows.map((document) => {
                  const held = isInCustody(document);
                  return (
                    <tr key={document.id}>
                      <td className="p-2 text-center">
                        {held && (
                          <Checkbox
                            checked={selectedIds.includes(document.id)}
                            onCheckedChange={(checked) => toggleSelected(document.id, checked === true)}
                            aria-label={`Select ${document.name} for return`}
                          />
                        )}
                      </td>
                      <td className="p-2">
                        <p className="font-medium text-slate-900">{document.name}</p>
                        {document.remarks && <p className="text-[11px] text-slate-500">{document.remarks}</p>}
                        <p className="text-[10px] text-slate-400">
                          Received {document.received_at ? format(new Date(document.received_at), 'dd MMM yyyy') : '—'}
                          {document.returned_at &&
                            ` · Returned ${format(new Date(document.returned_at), 'dd MMM yyyy')}`}
                        </p>
                      </td>
                      <td className="p-2 text-slate-500">{document.document_number || '—'}</td>
                      <td className="p-2 text-slate-500">{document.current_holder_name || '—'}</td>
                      <td className="p-2">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${STATUS_STYLE[document.status]}`}
                        >
                          {document.status}
                        </span>
                      </td>
                      <td className="p-2">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 hover:bg-teal-50 hover:text-teal-600"
                            onClick={() => openEdit(document)}
                            title={`Edit ${document.name}`}
                          >
                            <Pencil size={14} />
                            <span className="sr-only">Edit {document.name}</span>
                          </Button>
                          {can('deleteRecords') && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 hover:bg-red-50 hover:text-red-600"
                              onClick={() => setPendingDelete(document)}
                              title={`Remove ${document.name}`}
                            >
                              <Trash2 size={14} />
                              <span className="sr-only">Remove {document.name}</span>
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
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
        </div>
      )}

      <PhysicalDocumentModal
        open={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        registrationId={registrationId}
        document={editing}
        onSaved={invalidate}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => pendingDelete && deleteMutation.mutate(pendingDelete.id)}
        title="Remove document record"
        description={
          pendingDelete
            ? `Remove the custody record for “${pendingDelete.name}”? This deletes the record, not the paper itself.`
            : ''
        }
        confirmText="Remove"
        confirmVariant="destructive"
        isLoading={deleteMutation.isPending}
      />
    </div>
  );
}
