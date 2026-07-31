import { api } from '@/lib/api';
import { fetchPage } from '@/lib/apiClient';
import type { Paginated, PaymentStatus, RefundStatus } from '@/lib/types';

/**
 * Full payment/refund wire shapes, straight off `PaymentSerializer` and
 * `RefundSerializer`.
 *
 * WHY THIS EXISTS RATHER THAN `apiClient.payments`: that client maps rows
 * through `mapPayment`, which returns six keys —
 * `{id, date, type, amount, status, method, studentName}` — and drops
 * `registration`, `enrollment`, `installment`, `reference` and `metadata`.
 * The `Payment` TYPE declares the first four as optional, so
 * `apiClient.payments.get(id).reference` compiles and is always `undefined`:
 * the serializer sends the field and the mapper discards it. A receipt built
 * on that client could never show a reference number, and nothing would fail
 * loudly enough to notice.
 *
 * These helpers talk to the endpoints directly with the serializer's own
 * shape, so they are unaffected — the same approach
 * `components/common/approvals.ts` takes. The status vocabularies are imported
 * from lib rather than redeclared, so there is one definition of each.
 */

export type { PaymentStatus, RefundStatus };

/** All four values of `Payment.Status`. */
export const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'Pending',
  'Success',
  'Failed',
  'Refunded',
];

/**
 * `Payment.type` is a free CharField with no choices. These are what the
 * seeder writes, so they are the values already in the database — offered as
 * suggestions, not enforced as a union.
 */
export const PAYMENT_TYPES = ['Registration', 'Enrollment'] as const;

/** `Payment.method` is a free CharField defaulting to 'Cash'. */
export const PAYMENT_METHODS = ['Cash', 'Card', 'UPI', 'Bank Transfer', 'Cheque'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** All four values of `Refund.Status`. Note 'Processed', which Payment lacks. */
export const REFUND_STATUSES: readonly RefundStatus[] = [
  'Pending',
  'Approved',
  'Processed',
  'Rejected',
];

/**
 * Method-specific transaction detail, stored in `Payment.metadata`
 * (JSONField, `default=dict`).
 *
 * Keys are fixed and snake_case so a later migration to real columns stays
 * mechanical. `reference` is deliberately NOT in here — it stays a flat
 * top-level CharField as the one human-facing reference number.
 *
 * Full card numbers are never stored: `card_last4` is four digits for
 * identification and nothing more.
 */
export interface PaymentMetadata {
  cheque_no?: string;
  bank?: string;
  upi_id?: string;
  card_last4?: string;
  card_network?: string;
}

/** Full `PaymentSerializer` row. */
export interface PaymentRecord {
  id: number;
  registration: number | null;
  enrollment: number | null;
  installment: number | null;
  student_name: string;
  /** Decimal(12,2); DRF serialises decimals as strings by default. */
  amount: string | number;
  /** DateTimeField, not a date. */
  date: string;
  type: string;
  status: PaymentStatus;
  method: string;
  reference: string;
  metadata: PaymentMetadata | null;
  company_name: string | null;
  branch_name: string | null;
  created_by_name: string;
  owner_name: string;
  created_at: string;
  updated_at: string;
}

/** Writable fields on `POST payments/`. Everything else is server-stamped. */
export interface PaymentInput {
  student_name: string;
  amount: number;
  date: string;
  type: string;
  status: PaymentStatus;
  method: string;
  reference?: string;
  metadata?: PaymentMetadata;
  /** Registration FK. Set this whenever the payer is a known registration. */
  registration?: number | null;
  enrollment?: number | null;
}

/** Full `RefundSerializer` row. */
export interface RefundRecord {
  id: number;
  /** Registration FK. Required on write. */
  student: number;
  /** Read-only, sourced from `student.student_name`. */
  student_name: string;
  payment: number | null;
  amount: string | number;
  reason: string;
  status: RefundStatus;
  processed_at: string | null;
  created_at: string;
  created_by_name: string;
}

/** Decimals arrive as strings; coerce once, at the boundary. */
export function toAmount(value: string | number | null | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Drops blank values so `metadata` never stores `{cheque_no: ''}`. */
export function compactMetadata(metadata: PaymentMetadata): PaymentMetadata {
  return Object.fromEntries(
    Object.entries(metadata).filter(
      ([, value]) => typeof value === 'string' && value.trim() !== '',
    ),
  );
}

/** True when the object holds at least one recorded key. */
export function hasMetadata(metadata: PaymentMetadata | null | undefined): boolean {
  return metadata != null && Object.keys(metadata).length > 0;
}

/** Human labels for the metadata keys, for read-only display. */
export const METADATA_LABELS: Record<keyof PaymentMetadata, string> = {
  cheque_no: 'Cheque number',
  bank: 'Bank',
  upi_id: 'UPI ID',
  card_last4: 'Card (last 4)',
  card_network: 'Card network',
};

export async function getPayment(id: number | string): Promise<PaymentRecord> {
  const res = await api.get<PaymentRecord>(`payments/${id}/`);
  return res.data;
}

export async function createPayment(input: PaymentInput): Promise<PaymentRecord> {
  const res = await api.post<PaymentRecord>('payments/', input);
  return res.data;
}

/** Write shape for a refund. `student` is the Registration FK and is REQUIRED. */
export interface RefundCreateInput {
  student: number;
  payment?: number | null;
  amount: number;
  reason: string;
  status?: RefundStatus;
}

/**
 * Raises a refund request.
 *
 * `student` (a Registration id) is the required field — `student_name` is
 * read-only on the serializer, derived from the linked registration, so posting
 * a typed-in name satisfies nothing and the create fails validation.
 */
export async function createRefund(input: RefundCreateInput): Promise<RefundRecord> {
  const res = await api.post<RefundRecord>('refunds/', input);
  return res.data;
}

/**
 * Refunds raised against one payment.
 *
 * This used to fetch a 200-row page and filter it in the browser, because
 * `RefundViewSet` declared no filters at all and DjangoFilterBackend silently
 * dropped `?payment=<id>` — trusting the parameter would have shown every
 * refund in scope on one payment's receipt. `RefundFilter` registers it now,
 * so the narrowing happens in SQL and a payment past the first 200 refunds is
 * no longer invisible.
 */
export async function listRefundsForPayment(paymentId: number | string): Promise<RefundRecord[]> {
  const page: Paginated<RefundRecord> = await fetchPage<RefundRecord>('refunds/', {
    page_size: 200,
    ordering: '-created_at',
    filters: { payment: String(paymentId) },
  });
  return page.results;
}
