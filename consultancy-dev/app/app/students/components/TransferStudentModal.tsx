'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ArrowRightLeft } from 'lucide-react';
import { apiClient } from '@/lib/apiClient';
import { toArray } from '@/components/common/pagination';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ErrorBanner, InlineSpinner } from '@/components/common/states';
import { useAuth } from '@/hooks/useAuth';
import { roleShortLabel } from '@/components/rbac/roles';
import { toast } from '@/store/toastStore';
import { toForeignKey } from '../../student-profile/constants';

/** One record to hand over. `entityType` matches the backend's transfer vocabulary. */
export interface TransferTarget {
  entityType: 'enquiry' | 'registration' | 'enrollment';
  entityId: string;
  label: string;
}

interface TransferStudentModalProps {
  open: boolean;
  onClose: () => void;
  targets: TransferTarget[];
  /** Called after at least one transfer was requested successfully. */
  onTransferred: () => void;
}

/**
 * Hands records over to another member of staff.
 *
 * The old build POSTed to `enquiries/<id>/transfer/` with an `assigned_to` id.
 * That endpoint is gone: ownership now moves through the `transfers` resource,
 * which creates a PENDING request the recipient has to accept. The wording here
 * says "requested" for that reason — nothing changes hands until they accept.
 */
export function TransferStudentModal({ open, onClose, targets, onTransferred }: TransferStudentModalProps) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [recipient, setRecipient] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open) return;
    setRecipient('');
    setNote('');
  }, [open]);

  const colleaguesQuery = useQuery({
    queryKey: ['users', 'transfer-recipients'],
    queryFn: () => apiClient.users.list({ page_size: 200, ordering: 'first_name' }),
    enabled: open,
  });

  // The backend scopes `users/` to what the caller may see, so this is already
  // the right company; we only need to drop the signed-in user.
  const colleagues = toArray(colleaguesQuery.data).filter(
    (colleague) => colleague.id !== user?.id && colleague.is_active_employee,
  );

  const transferMutation = useMutation({
    mutationFn: async (toUser: number) => {
      const results = await Promise.allSettled(
        targets.map((target) => {
          // `entity_id` is a number on the wire. Posting `Number('abc')` would
          // serialise as null and create a transfer pointing at nothing.
          const entityId = toForeignKey(target.entityId);
          if (entityId === null) {
            return Promise.reject(new Error(`“${target.label}” has an id that is not a number.`));
          }
          return apiClient.transfers.create({
            entity_type: target.entityType,
            entity_id: entityId,
            to_user: toUser,
            note: note.trim(),
          });
        }),
      );

      const succeeded = results.filter((result) => result.status === 'fulfilled').length;
      const firstFailure = results.find((result) => result.status === 'rejected');

      // Nothing went through — surface the underlying error rather than a
      // cheerful "0 transferred".
      if (succeeded === 0 && firstFailure && firstFailure.status === 'rejected') {
        throw firstFailure.reason;
      }
      return { succeeded, total: targets.length };
    },
    onSuccess: ({ succeeded, total }) => {
      void queryClient.invalidateQueries({ queryKey: ['enquiries'] });
      void queryClient.invalidateQueries({ queryKey: ['registrations'] });
      void queryClient.invalidateQueries({ queryKey: ['enrollments'] });
      void queryClient.invalidateQueries({ queryKey: ['transfers'] });

      toast.success(
        `Requested ${succeeded} transfer${succeeded === 1 ? '' : 's'}`,
        succeeded < total
          ? `${total - succeeded} could not be sent. They stay with you for now.`
          : 'They move across once the recipient accepts.',
      );
      onTransferred();
      onClose();
    },
  });

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!recipient) return;
    transferMutation.mutate(Number(recipient));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Transfer students"
      description="Hand these records to another team member"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" className="h-10" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="transfer-form"
            className="h-10"
            disabled={!recipient || targets.length === 0 || transferMutation.isPending}
          >
            {transferMutation.isPending ? (
              <>
                <InlineSpinner className="mr-2" /> Sending…
              </>
            ) : (
              <>
                <ArrowRightLeft className="mr-2 h-4 w-4" /> Request transfer
              </>
            )}
          </Button>
        </div>
      }
    >
      <form id="transfer-form" onSubmit={handleSubmit} className="space-y-4">
        {transferMutation.isError && <ErrorBanner error={transferMutation.error} />}

        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p className="mb-2 text-xs font-medium text-slate-700">
            Transferring {targets.length} record{targets.length === 1 ? '' : 's'}
          </p>
          <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
            {targets.map((target) => (
              <span
                key={`${target.entityType}-${target.entityId}`}
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  target.entityType === 'enquiry'
                    ? 'bg-blue-100 text-blue-700'
                    : target.entityType === 'registration'
                      ? 'bg-purple-100 text-purple-700'
                      : 'bg-emerald-100 text-emerald-700'
                }`}
              >
                {target.label}
              </span>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="transfer-recipient">
            Transfer to <span className="text-red-500">*</span>
          </Label>
          <Select value={recipient} onValueChange={setRecipient}>
            <SelectTrigger id="transfer-recipient" className="h-10 w-full bg-white">
              <SelectValue placeholder="Select a team member…" />
            </SelectTrigger>
            <SelectContent className="max-h-60">
              {colleagues.length === 0 ? (
                <div className="p-3 text-center text-xs text-slate-500">
                  {colleaguesQuery.isLoading ? 'Loading colleagues…' : 'No other team members available'}
                </div>
              ) : (
                colleagues.map((colleague) => (
                  <SelectItem key={colleague.id} value={String(colleague.id)}>
                    {colleague.full_name || colleague.username}
                    <span className="ml-1 text-slate-400">({roleShortLabel(colleague.role)})</span>
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          {colleaguesQuery.isError && <p className="text-xs text-red-600">Could not load the team list.</p>}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="transfer-note">Note</Label>
          <Textarea
            id="transfer-note"
            placeholder="Context for whoever picks this up"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-amber-600" />
          <p className="text-[11px] text-amber-800">
            This creates a pending transfer. The records stay with you until the recipient accepts, and you can track
            them on the Transfers page.
          </p>
        </div>
      </form>
    </Modal>
  );
}
