'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Download, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ErrorBanner, ErrorState, InlineSpinner, LoadingState } from '@/components/common/states';
import { apiClient } from '@/lib/apiClient';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import type { Document } from '@/lib/types';

/** How many rows are pulled before the list stops claiming to be complete. */
const WINDOW = 50;

interface ExistingDocumentsListProps {
  /**
   * Whose scans these are. The only identifier that works today:
   * `DocumentViewSet.search_fields` is ('file_name', 'student_name', 'type')
   * and `filterset_fields` is ('status', 'branch', 'type') — there is no way to
   * select by registration. See the note on the component.
   */
  studentName: string;
  emptyMessage?: string;
}

function normalise(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * Scans already uploaded for a student (`apiClient.documents`).
 *
 * Read-only: downloads go through `documents/{id}/download/` so the request
 * carries the Authorization header — the file is encrypted at rest outside any
 * web-served directory, so there is no URL to link to directly.
 *
 * KNOWN GAP — matching is by student NAME, which is not an identity.
 * `Document` does have a nullable `registration` FK server-side, but it is
 * neither a filterset_field nor a search_field, and `mapDocument` in
 * lib/apiClient.ts does not carry it onto the client `Document` type at all
 * (that type's `registrationNo` has no counterpart on the wire and is always
 * undefined). Until `registration` is filterable and mapped, two students who
 * share a name share this list.
 */
export function ExistingDocumentsList({
  studentName,
  emptyMessage = 'No documents uploaded yet.',
}: ExistingDocumentsListProps) {
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const term = studentName.trim();

  const documents = usePaginatedQuery<Document>(
    ['documents', 'for', term],
    apiClient.documents.list,
    {
      search: term,
      ordering: '-uploaded_at',
      pageSize: WINDOW,
      enabled: term !== '',
    },
  );

  const downloadMutation = useMutation({
    mutationFn: (doc: Document) => apiClient.documents.downloadAndSave(doc.id, doc.fileName),
    onSettled: () => setDownloadingId(null),
  });

  // `search` also matches file_name and type, so a document called
  // "ravi-passport.pdf" belonging to someone else would come back too.
  // Re-checking student_name on the client is what keeps this list honest.
  const wanted = normalise(term);
  const rows = documents.rows.filter((doc) => normalise(doc.studentName) === wanted);

  if (term === '') {
    return <p className="text-sm text-slate-500">No student selected.</p>;
  }

  if (documents.isError) {
    return <ErrorState error={documents.error} onRetry={documents.refetch} />;
  }

  if (documents.isLoading) {
    return <LoadingState rows={2} label="Loading documents" />;
  }

  if (rows.length === 0) {
    return <p className="text-sm italic text-slate-500">{emptyMessage}</p>;
  }

  return (
    <div className="space-y-2">
      {downloadMutation.isError && (
        <ErrorBanner error={downloadMutation.error} onDismiss={() => downloadMutation.reset()} />
      )}

      {rows.map((doc) => (
        <div
          key={doc.id}
          className="flex flex-col gap-2 rounded border border-slate-100 bg-slate-50 p-2 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 items-center gap-2">
            <FileText size={14} className="shrink-0 text-slate-400" />
            <div className="min-w-0">
              <p className="break-all font-medium text-slate-900">{doc.fileName}</p>
              <p className="text-xs text-slate-500">
                {doc.type} · {new Date(doc.uploadedAt).toLocaleDateString()}
              </p>
            </div>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 self-start text-teal-700 hover:bg-teal-50 sm:self-auto"
            disabled={downloadingId === doc.id}
            onClick={() => {
              setDownloadingId(doc.id);
              downloadMutation.mutate(doc);
            }}
          >
            {downloadingId === doc.id ? (
              <InlineSpinner className="mr-1.5" />
            ) : (
              <Download size={14} className="mr-1.5" />
            )}
            Download
          </Button>
        </div>
      ))}

      {documents.count > documents.rows.length && (
        <p className="text-xs text-slate-500">
          Showing the {WINDOW} most recent matches. Open the Documents page to search the rest.
        </p>
      )}
    </div>
  );
}
