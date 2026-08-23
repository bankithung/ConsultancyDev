'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Download, FileText, Trash2, Upload } from 'lucide-react';
import { apiClient } from '@/lib/apiClient';
import type { Document } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LoadingState, InlineSpinner } from '@/components/common/states';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useCurrentRole } from '@/components/rbac/useCurrentRole';
import { toast } from '@/store/toastStore';
import { loadAllPages } from '../aggregate';
import { sameName } from '../constants';
import { DocumentUploadModal } from './DocumentUploadModal';

interface DocumentListProps {
  studentName: string;
  /** Human reference (e.g. `REG-…`), shown to the user. Not a key. */
  registrationNo?: string;
  /** The actual records an upload is attached to. */
  registrationId?: string;
  enquiryId?: string;
}

function formatSize(bytes: number | undefined): string | null {
  if (!bytes || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Uploaded scans for this student.
 *
 * Distinct from `PhysicalDocumentList`, which tracks the original paper the
 * office physically holds.
 */
export function DocumentList({
  studentName,
  registrationNo,
  registrationId,
  enquiryId,
}: DocumentListProps) {
  const queryClient = useQueryClient();
  const { can } = useCurrentRole();
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Document | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  // Membership is a foreign key, so the server can answer it. The name match
  // below is only a fallback for documents uploaded before the link existed --
  // those carry a name and nothing else.
  const linkFilter: Record<string, string> | null = registrationId
    ? { registration: registrationId }
    : enquiryId
      ? { enquiry: enquiryId }
      : null;
  const searchTerm = registrationNo || studentName;

  const documentsQuery = useQuery({
    queryKey: ['documents', 'for-student', linkFilter ?? searchTerm],
    queryFn: () =>
      loadAllPages<Document>(
        (params) => apiClient.documents.list(params),
        linkFilter ? { filters: linkFilter } : { search: searchTerm },
      ),
    enabled: Boolean(linkFilter) || Boolean(searchTerm),
  });

  const studentDocuments = useMemo(() => {
    const rows = documentsQuery.data ?? [];
    return rows
      .filter((doc) => {
        // Already narrowed server-side; nothing further to decide.
        if (linkFilter) return true;
        if (registrationNo && doc.registrationNo) return doc.registrationNo === registrationNo;
        return sameName(doc.studentName, studentName);
      })
      .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
  }, [documentsQuery.data, linkFilter, registrationNo, studentName]);

  const downloadMutation = useMutation({
    mutationFn: async (doc: Document) => {
      setDownloadingId(doc.id);
      await apiClient.documents.downloadAndSave(doc.id, doc.fileName);
    },
    onSuccess: () => toast.success('Download started'),
    onError: () => toast.error('Could not download that file'),
    onSettled: () => setDownloadingId(null),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiClient.documents.delete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      setPendingDelete(null);
      toast.success('Document deleted');
    },
    onError: () => toast.error('Could not delete that document'),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-slate-500">
          Scans and uploads
          {registrationNo ? ` linked to ${registrationNo}` : ` matched to ${studentName}`}.
        </p>
        <Button size="sm" className="h-9 shrink-0" onClick={() => setIsUploadOpen(true)}>
          <Upload size={14} className="mr-2" /> Upload
        </Button>
      </div>

      {documentsQuery.isLoading && <LoadingState rows={3} label="Loading documents" />}

      {documentsQuery.isError && (
        <ErrorState
          error={documentsQuery.error}
          onRetry={() => void documentsQuery.refetch()}
          title="Could not load documents"
        />
      )}

      {!documentsQuery.isLoading && !documentsQuery.isError && studentDocuments.length === 0 && (
        <EmptyState
          title="No documents uploaded"
          description="Upload marksheets, passports or offer letters and they will show up here."
          icon={FileText}
          action={
            <Button size="sm" className="h-9" onClick={() => setIsUploadOpen(true)}>
              <Upload size={14} className="mr-2" /> Upload document
            </Button>
          }
        />
      )}

      {studentDocuments.length > 0 && (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {studentDocuments.map((doc) => {
            const size = formatSize(doc.fileSize);
            return (
              <li
                key={doc.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 p-2.5 transition-colors hover:bg-slate-50"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-600">
                    <FileText size={16} />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">{doc.fileName}</p>
                    <p className="truncate text-[10px] text-slate-500">
                      {doc.type} · {format(new Date(doc.uploadedAt), 'dd MMM yyyy')}
                      {size ? ` · ${size}` : ''}
                    </p>
                    <p className="truncate text-[10px] text-slate-400">
                      By {doc.uploadedBy}
                      {doc.expiryDate ? ` · Expires ${format(new Date(doc.expiryDate), 'dd MMM yyyy')}` : ''}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={() => downloadMutation.mutate(doc)}
                    disabled={downloadingId === doc.id}
                    title={`Download ${doc.fileName}`}
                  >
                    {downloadingId === doc.id ? <InlineSpinner /> : <Download size={16} />}
                    <span className="sr-only">Download {doc.fileName}</span>
                  </Button>
                  {can('deleteRecords') && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 hover:bg-red-50 hover:text-red-600"
                      onClick={() => setPendingDelete(doc)}
                      title={`Delete ${doc.fileName}`}
                    >
                      <Trash2 size={16} />
                      <span className="sr-only">Delete {doc.fileName}</span>
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <DocumentUploadModal
        open={isUploadOpen}
        onClose={() => setIsUploadOpen(false)}
        studentName={studentName}
        registrationNo={registrationNo}
        registrationId={registrationId}
        enquiryId={enquiryId}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => pendingDelete && deleteMutation.mutate(pendingDelete.id)}
        title="Delete document"
        description={pendingDelete ? `Permanently delete “${pendingDelete.fileName}”? This cannot be undone.` : ''}
        confirmText="Delete"
        confirmVariant="destructive"
        isLoading={deleteMutation.isPending}
      />
    </div>
  );
}
