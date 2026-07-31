'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, UserCircle } from 'lucide-react';

import { apiClient } from '@/lib/apiClient';
import { getApiErrorMessage } from '@/lib/api';
import { toArray } from '@/components/common/pagination';
import { Modal } from '@/components/common/Modal';
import { ErrorBanner, LoadingState } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { useAuth } from '@/hooks/useAuth';
import { useDebounce } from '@/hooks/useDebounce';
import { toast } from '@/store/toastStore';

/**
 * Record types the transfer service accepts.
 *
 * These are the WIRE values -- `core.services.TRANSFERABLE`. The old build's
 * modal took a display string ('Enquiry') and POSTed to a non-existent
 * `<resource>/<id>/transfer/` endpoint that only rewrote an `assigned_to`
 * column; ownership never moved. This is the real vocabulary.
 */
export const TRANSFER_ENTITY_TYPES = [
  'enquiry',
  'registration',
  'enrollment',
  'document',
  'task',
  'follow_up',
  'visa_tracking',
] as const;

export type TransferEntityType = (typeof TRANSFER_ENTITY_TYPES)[number];

/** Human labels, kept strictly separate from the wire values above. */
const ENTITY_LABELS: Record<TransferEntityType, string> = {
  enquiry: 'Enquiry',
  registration: 'Registration',
  enrollment: 'Enrollment',
  document: 'Document',
  task: 'Task',
  follow_up: 'Follow-up',
  visa_tracking: 'Visa tracking',
};

/**
 * react-query keys the list pages use, so the source list refetches after a
 * transfer applies. Spelled out rather than derived: `${entityType}s` would
 * produce 'enquirys' and the enquiry list would silently keep showing the
 * record as still owned by the sender.
 */
const LIST_QUERY_KEYS: Record<TransferEntityType, string> = {
  enquiry: 'enquiries',
  registration: 'registrations',
  enrollment: 'enrollments',
  document: 'documents',
  task: 'tasks',
  follow_up: 'followUps',
  visa_tracking: 'visaTracking',
};

/**
 * Display names the existing call sites pass, mapped onto the wire values.
 *
 * `entity_type` is validated against `TRANSFERABLE` server-side and a
 * mismatch is a 400, not a silent no-op -- but both sides are `string`, so
 * nothing would catch 'Enquiry' vs 'enquiry' at compile time. Accepting both
 * spellings here is what keeps that from being a runtime surprise.
 */
const LEGACY_TYPE_ALIASES = {
  Enquiry: 'enquiry',
  Registration: 'registration',
  Enrollment: 'enrollment',
  Document: 'document',
  Task: 'task',
} as const satisfies Record<string, TransferEntityType>;

type TransferTypeProp = TransferEntityType | keyof typeof LEGACY_TYPE_ALIASES;

function toWireType(value: TransferTypeProp): TransferEntityType {
  return value in LEGACY_TYPE_ALIASES
    ? LEGACY_TYPE_ALIASES[value as keyof typeof LEGACY_TYPE_ALIASES]
    : (value as TransferEntityType);
}

interface TransferStudentModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Primary key of the record. Accepts a string because several list pages
   * carry ids as strings; `entity_id` is a PositiveIntegerField on the wire, so
   * it is coerced before sending.
   */
  studentId: string | number;
  /** Wire entity type, or the legacy display name for it. */
  type: TransferTypeProp;
  /** Shown in the dialog so the user can confirm they picked the right record. */
  studentName?: string;
  /** Current owner, excluded from the recipient list. */
  currentAssigneeId?: string | number | null;
  onSuccess?: () => void;
}

/**
 * Hands ownership of a record to another user via `POST transfers/`.
 *
 * Two outcomes, and the difference matters to the person clicking: an admin or
 * manager transfer applies immediately, while a peer-to-peer transfer between
 * employees is only a REQUEST until the recipient accepts it from their inbox.
 * The server decides which, and reports it back on `requires_acceptance`, so
 * the confirmation message is driven by the response rather than guessed from
 * the sender's own role.
 */
export function TransferStudentModal({
  isOpen,
  onClose,
  studentId,
  type,
  studentName,
  currentAssigneeId,
  onSuccess,
}: TransferStudentModalProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const entityType = toWireType(type);
  const entityId = Number(studentId);
  const currentOwnerId = currentAssigneeId == null ? null : Number(currentAssigneeId);

  const [recipientId, setRecipientId] = useState('');
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);

  // Reset when the dialog opens. Done during render rather than in an effect:
  // an effect runs after paint, so the previous transfer's recipient would
  // flash for a frame when the dialog is reopened.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setRecipientId('');
      setNote('');
      setSearch('');
    }
  }

  const usersQuery = useQuery({
    queryKey: ['users', 'transfer-recipients', debouncedSearch],
    // A thunk, not a bare reference: `list` takes PageParams and returns the
    // paginated envelope, never a bare array.
    queryFn: () => apiClient.users.list({ search: debouncedSearch, page_size: 50 }),
    enabled: isOpen,
  });

  const recipients = useMemo(() => {
    const rows = toArray(usersQuery.data);
    return rows.filter(
      (candidate) =>
        // The serializer rejects both of these, so never offer them.
        candidate.id !== user?.id &&
        candidate.id !== currentOwnerId &&
        candidate.is_active_employee,
    );
  }, [usersQuery.data, user?.id, currentOwnerId]);

  const options = useMemo(
    () =>
      recipients.map((candidate) => ({
        value: String(candidate.id),
        label: candidate.branch_name
          ? `${candidate.full_name} — ${candidate.branch_name}`
          : candidate.full_name,
      })),
    [recipients],
  );

  const transferMutation = useMutation({
    mutationFn: () =>
      apiClient.transfers.create({
        entity_type: entityType,
        entity_id: entityId,
        to_user: Number(recipientId),
        note: note.trim(),
      }),
    onSuccess: (transfer) => {
      queryClient.invalidateQueries({ queryKey: ['transfers'] });
      queryClient.invalidateQueries({ queryKey: [LIST_QUERY_KEYS[entityType]] });

      toast.success(
        transfer.requires_acceptance ? 'Transfer requested' : 'Transfer complete',
        transfer.requires_acceptance
          ? `${transfer.to_user_name} must accept it before ownership moves.`
          : `${transfer.to_user_name} now owns this record.`,
      );
      onSuccess?.();
      onClose();
    },
  });

  const title = `Transfer ${ENTITY_LABELS[entityType].toLowerCase()}`;

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={title}
      description={
        studentName
          ? `Hand ${studentName} over to another member of your company.`
          : 'Hand this record over to another member of your company.'
      }
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={transferMutation.isPending}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            onClick={() => transferMutation.mutate()}
            disabled={transferMutation.isPending || !recipientId}
            className="w-full sm:w-auto"
          >
            {transferMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Transfer
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {transferMutation.isError && (
          <ErrorBanner error={transferMutation.error} onDismiss={() => transferMutation.reset()} />
        )}

        <div className="space-y-2">
          <Label htmlFor="transfer-recipient">Transfer to</Label>
          <Input
            id="transfer-recipient-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name or username…"
            className="mb-2"
          />

          {usersQuery.isPending ? (
            <LoadingState rows={2} label="Loading colleagues…" />
          ) : usersQuery.isError ? (
            <p className="text-sm text-red-600">{getApiErrorMessage(usersQuery.error)}</p>
          ) : options.length === 0 ? (
            <p className="rounded-md border border-dashed border-slate-300 px-3 py-4 text-center text-sm text-slate-500">
              {search
                ? `Nobody matches “${search}”.`
                : 'No other active colleague is available to receive this record.'}
            </p>
          ) : (
            <SearchableSelect
              options={options}
              value={recipientId}
              onChange={setRecipientId}
              placeholder="Select a colleague"
              disabled={transferMutation.isPending}
            />
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="transfer-note">Note (optional)</Label>
          <Textarea
            id="transfer-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            placeholder="Why are you handing this over?"
            disabled={transferMutation.isPending}
          />
        </div>

        <p className="flex items-start gap-2 rounded-md bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
          <UserCircle className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          <span>
            Managers and admins transfer immediately. Between colleagues of equal standing the
            recipient has to accept first, and the record stays yours until they do.
          </span>
        </p>
      </div>
    </Modal>
  );
}

export default TransferStudentModal;
