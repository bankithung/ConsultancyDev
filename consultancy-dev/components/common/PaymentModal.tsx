'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Banknote,
  CheckCircle2,
  CreditCard,
  FileText,
  Landmark,
  Loader2,
  QrCode,
  Search,
} from 'lucide-react';

import { apiClient } from '@/lib/apiClient';
import { toArray } from '@/components/common/pagination';
import { Drawer } from '@/components/common/Drawer';
import { ErrorBanner } from '@/components/common/states';
import {
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  PAYMENT_TYPES,
  createPayment,
  type PaymentInput,
  type PaymentMethod,
  type PaymentRecord,
  type PaymentStatus,
} from '@/components/common/payments';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDebounce } from '@/hooks/useDebounce';
import { toast } from '@/store/toastStore';

/**
 * What the `reference` field should hold, per method.
 *
 * The old build collected a `metadata` object per method — cheque number,
 * issuing bank, cheque date, UPI id, card network, card last-4, transaction id
 * — and posted it. `Payment` has no JSON column: the only tracking field on the
 * model is `reference`, a CharField(120). Every one of those inputs was
 * discarded by the server.
 *
 * So there is one field, labelled for the method in play. Collecting six
 * inputs that go nowhere is worse than collecting the one that does.
 */
const REFERENCE_HINTS: Record<PaymentMethod, { label: string; placeholder: string; hint: string }> = {
  Cash: {
    label: 'Receipt number',
    placeholder: 'e.g. REC-001',
    hint: 'A receipt number is what makes a cash payment traceable later.',
  },
  Card: {
    label: 'Authorisation / transaction ID',
    placeholder: 'e.g. AUTH-88213',
    hint: 'Record the acquirer reference. Never store full card numbers.',
  },
  UPI: {
    label: 'UPI transaction ID',
    placeholder: 'e.g. 412345678901',
    hint: 'The 12-digit UTR from the payment app.',
  },
  'Bank Transfer': {
    label: 'NEFT / IMPS reference',
    placeholder: 'e.g. HDFCN52412345678',
    hint: 'The bank reference from the remittance advice.',
  },
  Cheque: {
    label: 'Cheque number',
    placeholder: 'e.g. 004512',
    hint: 'Cheque number, so it can be matched when it clears.',
  },
};

const METHOD_ICONS: Record<PaymentMethod, React.ComponentType<{ size?: number; className?: string }>> = {
  Cash: Banknote,
  Card: CreditCard,
  UPI: QrCode,
  'Bank Transfer': Landmark,
  Cheque: FileText,
};

/** A payer the payment can be attached to, with the FK that links it. */
interface PayerOption {
  key: string;
  name: string;
  detail: string;
  kind: 'Registration' | 'Enrollment';
  registration: number | null;
  enrollment: number | null;
}

interface PaymentModalProps {
  open: boolean;
  onClose: () => void;
  /** Fixes the payer. When set, the student picker is hidden. */
  studentName?: string;
  /** Links the payment to a registration when the caller already knows it. */
  registrationId?: number | null;
  enrollmentId?: number | null;
  onCreated?: (payment: PaymentRecord) => void;
}

function todayIsoDate(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Records a payment against `POST payments/`.
 *
 * Links the payment to its registration or enrollment where it can. The old
 * build sent a bare `student_name` string, which is why the backend comment on
 * `Payment.registration` reads "was a bare student_name string, which made
 * reconciliation impossible" — picking a payer here sets the FK.
 *
 * PANEL, NOT DIALOG: presented as a right-edge drawer, matching the refund
 * flow it sits beside on the payments screen. The name is kept because it is
 * the component's public API and every call site imports it by this name.
 */
export function PaymentModal({
  open,
  onClose,
  studentName,
  registrationId = null,
  enrollmentId = null,
  onCreated,
}: PaymentModalProps) {
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [payer, setPayer] = useState<PayerOption | null>(null);
  const [manualName, setManualName] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayIsoDate);
  const [method, setMethod] = useState<PaymentMethod>('Cash');
  const [type, setType] = useState<string>(PAYMENT_TYPES[0]);
  const [status, setStatus] = useState<PaymentStatus>('Success');
  const [reference, setReference] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  /**
   * The date the form opened on. Held so an untouched date field does not read
   * as unsaved input — comparing against a fresh `todayIsoDate()` every render
   * would also make a panel left open across midnight look edited.
   */
  const [defaultDate, setDefaultDate] = useState(todayIsoDate);

  const debouncedSearch = useDebounce(search, 300);
  const pickerEnabled = open && !studentName;
  const searching = debouncedSearch.trim().length > 0;

  // Reset during render rather than in an effect: an effect runs after paint,
  // so the previous payment's amount would flash on reopen — genuinely
  // alarming on a form that records money.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      const today = todayIsoDate();
      setSearch('');
      setPayer(null);
      setManualName('');
      setAmount('');
      setDate(today);
      setDefaultDate(today);
      setMethod('Cash');
      setType(PAYMENT_TYPES[0]);
      setStatus('Success');
      setReference('');
      setValidationError(null);
      setConfirmDiscard(false);
    }
  }

  const registrationsQuery = useQuery({
    queryKey: ['registrations', 'payer-search', debouncedSearch],
    queryFn: () => apiClient.registrations.list({ search: debouncedSearch, page_size: 20 }),
    enabled: pickerEnabled && searching,
  });

  const enrollmentsQuery = useQuery({
    queryKey: ['enrollments', 'payer-search', debouncedSearch],
    queryFn: () => apiClient.enrollments.list({ search: debouncedSearch, page_size: 20 }),
    enabled: pickerEnabled && searching,
  });

  const payerOptions = useMemo<PayerOption[]>(() => {
    const enrollments = toArray(enrollmentsQuery.data).map<PayerOption>((row) => ({
      key: `enr-${row.id}`,
      name: row.studentName,
      detail: row.enrollmentNo || row.programName,
      kind: 'Enrollment',
      registration: null,
      enrollment: Number(row.id),
    }));

    const registrations = toArray(registrationsQuery.data).map<PayerOption>((row) => ({
      key: `reg-${row.id}`,
      name: row.studentName,
      detail: row.registrationNo || row.mobile,
      kind: 'Registration',
      registration: Number(row.id),
      enrollment: null,
    }));

    return [...enrollments, ...registrations];
  }, [enrollmentsQuery.data, registrationsQuery.data]);

  const isSearchingPayers = registrationsQuery.isFetching || enrollmentsQuery.isFetching;

  const createMutation = useMutation({
    mutationFn: (input: PaymentInput) => createPayment(input),
    onSuccess: (payment) => {
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      toast.success('Payment recorded', `₹${Number(payment.amount).toLocaleString('en-IN')} from ${payment.student_name}.`);
      onCreated?.(payment);
      onClose();
    },
  });

  const resolvedName = studentName || payer?.name || manualName.trim();

  /**
   * Anything typed or picked that a close would throw away.
   *
   * Every field is compared against the value the form opened with rather than
   * against empty, because method, purpose, status and date all arrive
   * pre-filled — treating those defaults as input would make the panel refuse
   * to close before the user had done anything.
   */
  const isDirty =
    search.trim() !== '' ||
    payer !== null ||
    manualName.trim() !== '' ||
    amount !== '' ||
    reference.trim() !== '' ||
    date !== defaultDate ||
    method !== 'Cash' ||
    type !== PAYMENT_TYPES[0] ||
    status !== 'Success';

  /**
   * Vetoes scrim clicks, Escape and the close button while there is unsaved
   * input, and asks instead. A half-entered payment vanishing on a misplaced
   * click is the failure this exists to prevent.
   */
  const requestClose = (): boolean => {
    // Mid-submit the payment may already be on its way; closing would leave the
    // user unsure whether the money was recorded.
    if (createMutation.isPending) return false;
    if (!isDirty || confirmDiscard) return true;
    setConfirmDiscard(true);
    return false;
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();

    if (!resolvedName) {
      setValidationError('Choose a student, or type the payer’s name.');
      return;
    }

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setValidationError('Enter an amount greater than zero.');
      return;
    }
    if (!date) {
      setValidationError('A payment date is required.');
      return;
    }

    setValidationError(null);
    createMutation.mutate({
      student_name: resolvedName,
      amount: numericAmount,
      // `date` is a DateTimeField server-side; a bare date would land at
      // midnight UTC and show as the previous day in IST.
      date: new Date(`${date}T${new Date().toTimeString().slice(0, 8)}`).toISOString(),
      type,
      status,
      method,
      reference: reference.trim(),
      registration: payer?.registration ?? registrationId,
      enrollment: payer?.enrollment ?? enrollmentId,
    });
  };

  const MethodIcon = METHOD_ICONS[method];
  const referenceHint = REFERENCE_HINTS[method];

  const footer = confirmDiscard ? (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm font-medium text-slate-700">
        Discard this payment? What you have entered will be lost.
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
        disabled={createMutation.isPending}
        className="w-full sm:w-auto"
      >
        Cancel
      </Button>
      <Button
        type="submit"
        form="payment-form"
        disabled={createMutation.isPending}
        className="w-full sm:w-auto"
      >
        {createMutation.isPending ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Recording…
          </>
        ) : (
          <>
            <CheckCircle2 className="mr-2 h-4 w-4" /> Confirm payment
          </>
        )}
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
      title="Record payment"
      description="Enter the transaction details and who paid."
      /*
        60% of the viewport from `md` up, full width below it — the same
        geometry as the refund drawer this sits beside. The form keeps its old
        `size="lg"` reading measure inside that panel via `max-w-2xl`.
      */
      panelClassName="md:w-[60vw]"
      bodyClassName="px-4 py-5 sm:px-6"
      footer={footer}
    >
      <form id="payment-form" onSubmit={handleSubmit} className="mx-auto w-full max-w-2xl space-y-5">
        {validationError && <ErrorBanner error={validationError} onDismiss={() => setValidationError(null)} />}
        {createMutation.isError && (
          <ErrorBanner error={createMutation.error} onDismiss={() => createMutation.reset()} />
        )}

        {studentName ? (
          <div className="rounded-lg bg-slate-50 px-4 py-3">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Payer</p>
            <p className="truncate text-sm font-bold text-slate-800">{studentName}</p>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="payment-student">
              Student <span className="text-red-500">*</span>
            </Label>

            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                id="payment-student"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPayer(null);
                }}
                placeholder="Search registrations and enrollments…"
                className="pl-9"
                autoComplete="off"
              />
            </div>

            {payer && (
              <p className="flex items-center gap-1.5 text-xs font-semibold text-teal-700">
                <CheckCircle2 size={12} /> {payer.name} — {payer.kind}
              </p>
            )}

            {searching && !payer && (
              <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200">
                {isSearchingPayers ? (
                  <p className="p-4 text-center text-sm text-slate-500">Searching…</p>
                ) : payerOptions.length === 0 ? (
                  <p className="p-4 text-center text-sm text-slate-500">
                    No student matches “{search}”. You can type the name below instead.
                  </p>
                ) : (
                  <ul>
                    {payerOptions.map((option) => (
                      <li key={option.key}>
                        <button
                          type="button"
                          onClick={() => {
                            setPayer(option);
                            setSearch(option.name);
                            setManualName('');
                          }}
                          className="flex w-full flex-col items-start gap-0.5 border-b border-slate-50 px-4 py-2.5 text-left transition-colors last:border-0 hover:bg-slate-50"
                        >
                          <span className="text-sm font-semibold text-slate-900">{option.name}</span>
                          <span className="flex items-center gap-2">
                            <span
                              className={`rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                                option.kind === 'Enrollment'
                                  ? 'border-blue-100 bg-blue-50 text-blue-600'
                                  : 'border-purple-100 bg-purple-50 text-purple-600'
                              }`}
                            >
                              {option.kind}
                            </span>
                            <span className="text-xs text-slate-500">{option.detail}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <span className="h-px flex-1 bg-slate-100" />
              <span className="text-[10px] font-bold uppercase text-slate-400">or</span>
              <span className="h-px flex-1 bg-slate-100" />
            </div>
            <Input
              value={manualName}
              onChange={(event) => {
                setManualName(event.target.value);
                setPayer(null);
              }}
              placeholder="Type the payer’s name"
              aria-label="Payer name typed manually"
            />
            {manualName.trim() && (
              <p className="text-xs text-amber-600">
                Unlinked payments cannot be reconciled against a student record later.
              </p>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="payment-amount">
              Amount (₹) <span className="text-red-500">*</span>
            </Label>
            <Input
              id="payment-amount"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0.00"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="payment-date">
              Date <span className="text-red-500">*</span>
            </Label>
            <Input
              id="payment-date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="payment-method">Method</Label>
            <Select value={method} onValueChange={(value) => setMethod(value as PaymentMethod)}>
              <SelectTrigger id="payment-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_METHODS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="payment-type">Purpose</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger id="payment-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_TYPES.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="payment-status">Status</Label>
            <Select value={status} onValueChange={(value) => setStatus(value as PaymentStatus)}>
              <SelectTrigger id="payment-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* 'Refunded' is reached by raising a refund, not by picking it here. */}
                {PAYMENT_STATUSES.filter((option) => option !== 'Refunded').map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <MethodIcon size={16} className="text-teal-600" />
            {method} details
          </h3>
          <Label htmlFor="payment-reference" className="text-xs font-semibold text-slate-600">
            {referenceHint.label}
          </Label>
          <Input
            id="payment-reference"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            placeholder={referenceHint.placeholder}
            maxLength={120}
            className="bg-white"
          />
          <p className="text-xs text-slate-500">{referenceHint.hint}</p>
        </div>
      </form>
    </Drawer>
  );
}
