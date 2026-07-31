'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Loader2, Search } from 'lucide-react';

import { apiClient } from '@/lib/apiClient';
import { toArray } from '@/components/common/pagination';
import { Drawer } from '@/components/common/Drawer';
import { ErrorBanner, ErrorState, LoadingState } from '@/components/common/states';
import {
  createRefund,
  getPayment,
  toAmount,
  type RefundRecord,
} from '@/components/common/payments';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useDebounce } from '@/hooks/useDebounce';
import { toast } from '@/store/toastStore';

const MIN_REASON_LENGTH = 10;

interface RefundDrawerProps {
  open: boolean;
  onClose: () => void;
  /**
   * Payment being refunded. The full record is fetched, not passed in.
   *
   * Null is the standalone case carried over from the old /app/refunds screen:
   * a refund raised against a student rather than against one transaction.
   */
  paymentId?: number | string | null;
  onCreated?: (refund: RefundRecord) => void;
}

/**
 * Raises a refund request, either against one payment or against a student.
 *
 * Two things the old build got wrong, both fatal:
 *
 * 1. It posted `student_name`. On `RefundSerializer` that field is READ-ONLY
 *    (`source='student.student_name'`); the writable field is `student`, a
 *    required FK to Registration. Every refund the old modal submitted was
 *    rejected.
 * 2. It collected a refund method and refund date. `Refund` has neither
 *    column — it has `status` and a server-set `processed_at`. Those inputs
 *    are gone rather than silently dropped.
 *
 * The payment record is fetched here rather than taken as a prop because the
 * `Payment` type the list pages hold is a reduced camelCase view that has no
 * `registration` field, and that FK is what the refund needs.
 *
 * PANEL, NOT DIALOG: this is the one drawer in the app that holds a form, so
 * unlike the filter panel a stray click on the scrim can destroy typed work.
 * `onRequestClose` vetoes the dismiss and swaps the footer for an explicit
 * discard/keep-editing choice; see `requestClose` below.
 */
export function RefundDrawer({ open, onClose, paymentId, onCreated }: RefundDrawerProps) {
  const queryClient = useQueryClient();

  const hasPayment = paymentId != null;

  /**
   * Null means "untouched", which reads as the full payment amount once it has
   * loaded. Storing the default instead would need an effect to backfill it
   * after the fetch resolves, and that effect would clobber the user's typing
   * on any refetch.
   */
  const [amountInput, setAmountInput] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [registrationId, setRegistrationId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const debouncedSearch = useDebounce(search, 300);

  const paymentQuery = useQuery({
    queryKey: ['payment', paymentId],
    queryFn: () => getPayment(paymentId as number | string),
    enabled: open && hasPayment,
  });

  const payment = hasPayment ? paymentQuery.data : undefined;
  const paidAmount = toAmount(payment?.amount);

  // A refund needs a Registration. Most payments carry one; those recorded
  // against a bare name do not, so the user has to say who is being refunded —
  // and with no payment at all, that is the first thing asked.
  const needsRegistrationPicker = !hasPayment || (Boolean(payment) && payment?.registration == null);
  const effectiveRegistration = payment?.registration ?? registrationId;

  // Reset during render rather than in an effect: an effect runs after paint,
  // so the previous refund's amount and reason would flash on reopen.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setAmountInput(null);
      setReason('');
      setRegistrationId(null);
      setSearch('');
      setValidationError(null);
      setConfirmDiscard(false);
    }
  }

  const amount = amountInput ?? (payment ? String(paidAmount) : '');

  /**
   * The picker runs with an empty term too, so the panel opens on a browsable
   * first page instead of an empty box that only reacts to typing.
   */
  const registrationsQuery = useQuery({
    queryKey: ['registrations', 'refund-payer', debouncedSearch],
    queryFn: () =>
      apiClient.registrations.list({
        search: debouncedSearch || undefined,
        page_size: 20,
        ordering: 'student_name',
      }),
    enabled: open && needsRegistrationPicker,
  });

  const registrationOptions = useMemo(
    () => toArray(registrationsQuery.data),
    [registrationsQuery.data],
  );

  const refundMutation = useMutation({
    mutationFn: () =>
      createRefund({
        student: Number(effectiveRegistration),
        payment: hasPayment ? Number(paymentId) : null,
        amount: Number(amount),
        reason: reason.trim(),
        // Server default, and the only correct value for a request that has
        // not been reviewed. Approval moves it to Approved, then Processed.
        status: 'Pending',
      }),
    onSuccess: (refund) => {
      queryClient.invalidateQueries({ queryKey: ['refunds'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      if (hasPayment) queryClient.invalidateQueries({ queryKey: ['payment', paymentId] });
      toast.success('Refund requested', 'It now needs approval before it can be processed.');
      onCreated?.(refund);
      onClose();
    },
  });

  /**
   * Anything the user typed that a close would throw away.
   *
   * The amount only counts once it differs from the payment's own total: the
   * field arrives pre-filled, so treating its initial value as user input would
   * make every refund drawer refuse to close.
   */
  const isDirty =
    reason.trim() !== '' ||
    registrationId !== null ||
    search.trim() !== '' ||
    (amountInput !== null && amountInput !== String(paidAmount));

  /**
   * Vetoes scrim clicks, Escape and the close button while there is unsaved
   * input, and asks instead. A half-written refund reason silently vanishing
   * on a misplaced click is the failure this exists to prevent.
   */
  const requestClose = (): boolean => {
    // Mid-submit the record may already be on its way; closing would leave the
    // user unsure whether it went through.
    if (refundMutation.isPending) return false;
    if (!isDirty || confirmDiscard) return true;
    setConfirmDiscard(true);
    return false;
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();

    if (!effectiveRegistration) {
      setValidationError('Select the registration this refund belongs to.');
      return;
    }
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setValidationError('Enter a refund amount greater than zero.');
      return;
    }
    if (paidAmount > 0 && numericAmount > paidAmount) {
      setValidationError('A refund cannot exceed the original payment.');
      return;
    }
    if (reason.trim().length < MIN_REASON_LENGTH) {
      setValidationError(`Give at least ${MIN_REASON_LENGTH} characters explaining the refund.`);
      return;
    }

    setValidationError(null);
    refundMutation.mutate();
  };

  const footer = confirmDiscard ? (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm font-medium text-slate-700">
        Discard this refund request? What you have entered will be lost.
      </p>
      <div className="flex shrink-0 gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => setConfirmDiscard(false)}
          className="flex-1 sm:flex-none"
        >
          Keep editing
        </Button>
        <Button
          type="button"
          onClick={onClose}
          className="flex-1 bg-rose-600 hover:bg-rose-700 sm:flex-none"
        >
          Discard
        </Button>
      </div>
    </div>
  ) : (
    <div className="mx-auto flex w-full max-w-2xl flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          if (requestClose()) onClose();
        }}
        disabled={refundMutation.isPending}
        className="w-full sm:w-auto"
      >
        Cancel
      </Button>
      <Button
        type="submit"
        form="refund-form"
        disabled={refundMutation.isPending || (hasPayment && (paymentQuery.isPending || !payment))}
        className="w-full bg-teal-600 hover:bg-teal-700 sm:w-auto"
      >
        {refundMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Request refund
      </Button>
    </div>
  );

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      onRequestClose={requestClose}
      title="Request refund"
      description="Refunds are reviewed before any money moves."
      /*
        60% of the viewport from `md` up, full width below it. The breakpoint is
        768px rather than `sm`: at 640px a 60% panel is 384px, narrower than the
        form's own fields, so it would be a worse container than the phone
        layout it replaced.
      */
      panelClassName="md:w-[60vw]"
      bodyClassName="px-4 py-5 sm:px-6"
      footer={footer}
    >
      <div className="mx-auto w-full max-w-2xl">
        {hasPayment && paymentQuery.isPending ? (
          <LoadingState rows={3} label="Loading payment…" />
        ) : hasPayment && paymentQuery.isError ? (
          <ErrorState error={paymentQuery.error} onRetry={() => paymentQuery.refetch()} />
        ) : hasPayment && !payment ? (
          <p className="py-6 text-center text-sm text-slate-500">Payment not found.</p>
        ) : (
          <form id="refund-form" onSubmit={handleSubmit} className="space-y-5">
            {validationError && (
              <ErrorBanner error={validationError} onDismiss={() => setValidationError(null)} />
            )}
            {refundMutation.isError && (
              <ErrorBanner error={refundMutation.error} onDismiss={() => refundMutation.reset()} />
            )}

            {payment && (
              <dl className="grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-4 text-sm">
                <dt className="text-slate-500">Student</dt>
                <dd className="truncate text-right font-medium text-slate-900">
                  {payment.student_name}
                </dd>
                <dt className="text-slate-500">Original amount</dt>
                <dd className="text-right font-medium text-slate-900">
                  ₹{paidAmount.toLocaleString('en-IN')}
                </dd>
                <dt className="text-slate-500">Paid by</dt>
                <dd className="text-right font-medium text-slate-900">{payment.method}</dd>
                <dt className="text-slate-500">Paid on</dt>
                <dd className="text-right font-medium text-slate-900">
                  {format(new Date(payment.date), 'dd MMM yyyy')}
                </dd>
              </dl>
            )}

            {needsRegistrationPicker && (
              <div className="space-y-2">
                <Label htmlFor="refund-registration">
                  Registration <span className="text-red-500">*</span>
                </Label>
                <p className="text-xs text-slate-500">
                  {hasPayment
                    ? 'This payment was recorded against a name only, so pick the registration the refund belongs to.'
                    : 'A refund is raised against a registered student, so pick who it is for.'}
                </p>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    id="refund-registration"
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setRegistrationId(null);
                    }}
                    placeholder="Search registrations…"
                    className="pl-9"
                    autoComplete="off"
                  />
                </div>

                {!registrationId && (
                  <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200">
                    {registrationsQuery.isFetching ? (
                      <p className="p-3 text-center text-sm text-slate-500">Searching…</p>
                    ) : registrationOptions.length === 0 ? (
                      <p className="p-3 text-center text-sm text-slate-500">
                        {search.trim()
                          ? 'No registration matches.'
                          : 'No registrations available. A refund must be attached to a registered student.'}
                      </p>
                    ) : (
                      <ul>
                        {registrationOptions.map((registration) => (
                          <li key={registration.id}>
                            <button
                              type="button"
                              onClick={() => {
                                setRegistrationId(Number(registration.id));
                                setSearch(registration.studentName);
                              }}
                              className="flex w-full flex-col items-start border-b border-slate-50 px-3 py-2 text-left last:border-0 hover:bg-slate-50"
                            >
                              <span className="text-sm font-semibold text-slate-900">
                                {registration.studentName}
                              </span>
                              <span className="text-xs text-slate-500">
                                {registration.registrationNo}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {registrationId && (
                  <p className="text-xs font-semibold text-teal-700">Registration selected.</p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="refund-amount">
                Refund amount (₹) <span className="text-red-500">*</span>
              </Label>
              <Input
                id="refund-amount"
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                max={paidAmount || undefined}
                value={amount}
                onChange={(event) => setAmountInput(event.target.value)}
                placeholder="0.00"
              />
              {Number(amount) > paidAmount && paidAmount > 0 && (
                <p className="text-sm text-amber-600">
                  That is more than the ₹{paidAmount.toLocaleString('en-IN')} paid.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="refund-reason">
                Reason <span className="text-red-500">*</span>
              </Label>
              <Textarea
                id="refund-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={4}
                placeholder="Why is this refund being requested?"
              />
              <p className="text-xs text-slate-500">
                {reason.trim().length}/{MIN_REASON_LENGTH} characters minimum
              </p>
            </div>
          </form>
        )}
      </div>
    </Drawer>
  );
}
