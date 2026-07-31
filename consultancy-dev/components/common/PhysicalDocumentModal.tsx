'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderOpen } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ErrorBanner, InlineSpinner } from '@/components/common/states';
import {
  DocumentTakeover,
  blankPhysicalDocument,
  usablePhysicalDocuments,
  type PhysicalDocumentDraft,
} from '@/components/common/DocumentTakeover';
import { apiClient } from '@/lib/apiClient';
import { getApiErrorMessage } from '@/lib/api';

interface PhysicalDocumentModalProps {
  open: boolean;
  onClose: () => void;
  /** Registration whose originals these are. */
  registrationId: number | string;
  studentName?: string;
  /** Called with the number of custody records actually created. */
  onSuccess?: (created: number) => void;
}

interface SaveOutcome {
  created: number;
  /** Rows the API rejected, in their original order, so they can be retried. */
  failedRows: PhysicalDocumentDraft[];
  firstError: string | null;
}

/**
 * Records originals handed in at the counter.
 *
 * Writes to `apiClient.studentDocuments` — CUSTODY, no file content. Each row
 * becomes one record with status `Received`, which is what "the office has the
 * paper" means on this API. Uploading a scan is `DocumentUpload`.
 */
export function PhysicalDocumentModal({
  open,
  onClose,
  registrationId,
  studentName,
  onSuccess,
}: PhysicalDocumentModalProps) {
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<PhysicalDocumentDraft[]>([blankPhysicalDocument()]);
  const [validationError, setValidationError] = useState<string | null>(null);

  const saveMutation = useMutation<SaveOutcome, Error, PhysicalDocumentDraft[]>({
    // One POST per row. `allSettled` rather than `all` so a single rejected row
    // does not discard the ones that did save — the office would otherwise
    // re-enter documents the API already holds.
    mutationFn: async (documents) => {
      const results = await Promise.allSettled(
        documents.map((doc) =>
          apiClient.studentDocuments.create({
            registration: registrationId,
            name: doc.name.trim(),
            document_number: doc.document_number.trim(),
            remarks: doc.remarks.trim(),
            status: 'Received',
          }),
        ),
      );

      const failedRows = documents.filter((_, index) => results[index].status === 'rejected');
      const firstRejection = results.find((result) => result.status === 'rejected');

      return {
        created: results.length - failedRows.length,
        failedRows,
        firstError: firstRejection ? getApiErrorMessage(firstRejection.reason) : null,
      };
    },
    onSuccess: (outcome) => {
      if (outcome.created > 0) {
        queryClient.invalidateQueries({ queryKey: ['student-documents'] });
        onSuccess?.(outcome.created);
      }

      if (outcome.failedRows.length === 0) {
        setRows([blankPhysicalDocument()]);
        setValidationError(null);
        onClose();
        return;
      }

      // Leave only what still needs saving, so pressing Save again cannot
      // duplicate the records that already went through.
      setRows(outcome.failedRows);
    },
  });

  const close = () => {
    if (saveMutation.isPending) return;
    setRows([blankPhysicalDocument()]);
    setValidationError(null);
    saveMutation.reset();
    onClose();
  };

  const handleSubmit = () => {
    const valid = usablePhysicalDocuments(rows);
    if (valid.length === 0) {
      setValidationError('Name at least one document before saving.');
      return;
    }
    setValidationError(null);
    saveMutation.mutate(valid);
  };

  const outcome = saveMutation.data;
  const pendingCount = usablePhysicalDocuments(rows).length;
  const saveLabel = pendingCount > 1 ? `Save ${pendingCount} documents` : 'Save document';

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderOpen size={18} className="text-teal-600" />
            Add physical documents
          </DialogTitle>
          <DialogDescription>
            {studentName
              ? `Record the originals ${studentName} has handed to the office.`
              : 'Record the originals the student has handed to the office.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {saveMutation.isError && <ErrorBanner error={saveMutation.error} />}
          {outcome && outcome.failedRows.length > 0 && (
            <ErrorBanner
              error={`Saved ${outcome.created} of ${outcome.created + outcome.failedRows.length}. ${
                outcome.firstError ?? 'The rest could not be saved.'
              } Only the unsaved rows are left below.`}
            />
          )}
          {validationError && <ErrorBanner error={validationError} />}

          <DocumentTakeover
            value={rows}
            onChange={(next) => {
              setValidationError(null);
              setRows(next);
            }}
            disabled={saveMutation.isPending}
            alwaysOpen
          />
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={close} disabled={saveMutation.isPending}>
            Cancel
          </Button>
          <Button
            type="button"
            className="bg-teal-600 hover:bg-teal-700"
            onClick={handleSubmit}
            disabled={saveMutation.isPending || pendingCount === 0}
          >
            {saveMutation.isPending ? (
              <>
                <InlineSpinner className="mr-2" /> Saving…
              </>
            ) : (
              saveLabel
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
