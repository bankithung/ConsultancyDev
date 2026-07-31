'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, Send, User } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ErrorBanner, InlineSpinner } from '@/components/common/states';
import { apiClient } from '@/lib/apiClient';
import { useAuth } from '@/hooks/useAuth';
import type { StudentDocument } from '@/lib/types';

export interface HandoverInput {
  holderId: number;
  holderName: string;
  note: string;
}

interface TransferModalProps {
  open: boolean;
  onClose: () => void;
  /** The originals being handed over. One row, or a batch from the transfer tab. */
  documents: StudentDocument[];
  onSubmit: (input: HandoverInput) => void;
  isPending: boolean;
  /** Error from the caller's mutation, rendered inline so the modal stays open. */
  error?: unknown;
}

/**
 * Hands custody of ORIGINAL PAPER to a colleague.
 *
 * This is a physical hand-off, not a record transfer: the caller patches
 * `current_holder` on the `studentDocuments` record. Nothing changes ownership
 * of the student's file — that is `apiClient.transfers`, driven from
 * /app/transfers.
 */
export function TransferModal({
  open,
  onClose,
  documents,
  onSubmit,
  isPending,
  error,
}: TransferModalProps) {
  const { user } = useAuth();
  const [holderId, setHolderId] = useState('');
  const [note, setNote] = useState('');

  // Cleared when the modal opens, adjusted during render rather than in an
  // effect: React re-runs this component immediately with the blank fields, so
  // the previous recipient never flashes on screen.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setHolderId('');
      setNote('');
    }
  }

  const recipients = useQuery({
    queryKey: ['handover-recipients'],
    queryFn: () => apiClient.users.list({ page_size: 200, ordering: 'first_name' }),
    staleTime: 5 * 60_000,
    enabled: open,
  });

  // Handing paper to yourself is a no-op, so the current holder of the batch and
  // the signed-in user are both off the list.
  const heldBy = new Set(documents.map((doc) => doc.current_holder).filter((id): id is number => id !== null));
  const candidates = (recipients.data?.results ?? []).filter(
    (candidate) => candidate.id !== user?.id && !(documents.length === 1 && heldBy.has(candidate.id)),
  );

  const selected = candidates.find((candidate) => String(candidate.id) === holderId);
  const headline =
    documents.length === 1
      ? documents[0].name
      : `${documents.length} originals`;
  const subline =
    documents.length === 1
      ? documents[0].student_name
      : [...new Set(documents.map((doc) => doc.student_name))].join(', ');

  const submit = () => {
    if (!selected) return;
    onSubmit({
      holderId: selected.id,
      holderName: selected.full_name || selected.username,
      note,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !isPending && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send size={18} className="text-teal-600" />
            Hand over originals
          </DialogTitle>
          <DialogDescription>
            The colleague you choose becomes the recorded holder of this paper.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {error !== undefined && error !== null && <ErrorBanner error={error} />}

          <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-100 text-teal-600">
                <FileText size={20} />
              </span>
              <div className="min-w-0">
                <p className="break-words text-sm font-medium text-slate-900">{headline}</p>
                <p className="break-words text-xs text-slate-500">{subline || 'Unknown student'}</p>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="handover-holder" className="text-sm font-medium">
              Hand to
            </Label>
            <Select value={holderId} onValueChange={setHolderId}>
              <SelectTrigger id="handover-holder" className="h-10">
                <SelectValue
                  placeholder={recipients.isLoading ? 'Loading colleagues…' : 'Select a colleague…'}
                />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((candidate) => (
                  <SelectItem key={candidate.id} value={String(candidate.id)}>
                    <span className="flex items-center gap-2">
                      <User size={14} className="text-slate-400" />
                      {candidate.full_name || candidate.username}
                      {candidate.branch_name ? ` · ${candidate.branch_name}` : ''}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {recipients.isError && <ErrorBanner error={recipients.error} />}
            {!recipients.isLoading && candidates.length === 0 && (
              <p className="text-xs text-slate-500">
                There is nobody else in your company to hand these to yet.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="handover-note" className="text-sm font-medium">
              Note <span className="font-normal text-slate-400">(optional)</span>
            </Label>
            <Textarea
              id="handover-note"
              className="h-20 resize-none text-sm"
              placeholder="Where it is going, condition, anything the next holder needs…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <p className="text-xs text-slate-500">Added to the document&rsquo;s remarks.</p>
          </div>

          <div className="flex flex-col gap-2 pt-2 sm:flex-row">
            <Button variant="outline" className="flex-1" onClick={onClose} disabled={isPending}>
              Cancel
            </Button>
            <Button
              className="flex-1 bg-teal-600 hover:bg-teal-700"
              onClick={submit}
              disabled={!selected || isPending}
            >
              {isPending ? (
                <>
                  <InlineSpinner className="mr-2" /> Handing over…
                </>
              ) : (
                'Confirm hand-over'
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
