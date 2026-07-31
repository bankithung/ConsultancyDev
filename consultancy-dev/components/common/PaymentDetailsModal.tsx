'use client';

import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Calendar, FileText, Printer, Wallet } from 'lucide-react';

import { Modal } from '@/components/common/Modal';
import { ErrorState, LoadingState } from '@/components/common/states';
import {
  getPayment,
  listRefundsForPayment,
  toAmount,
  type PaymentStatus,
} from '@/components/common/payments';
import { Button } from '@/components/ui/button';

/** Badge colours for every value `Payment.Status` can hold. */
const STATUS_TONES: Record<PaymentStatus, string> = {
  Success: 'bg-green-50 text-green-700 border-green-100',
  Pending: 'bg-yellow-50 text-yellow-700 border-yellow-100',
  Failed: 'bg-red-50 text-red-700 border-red-100',
  // 'Refunded' had no case in the old build, so a refunded payment rendered
  // with the styling for 'Failed'.
  Refunded: 'bg-slate-100 text-slate-700 border-slate-200',
};

const REFUND_TONES: Record<string, string> = {
  Pending: 'bg-orange-100 text-orange-700',
  Approved: 'bg-blue-100 text-blue-700',
  Processed: 'bg-green-100 text-green-700',
  Rejected: 'bg-red-100 text-red-700',
};

/**
 * Escapes text before it is interpolated into the print document.
 *
 * The old build wrote `payment.student_name` and friends straight into an
 * `iframeDoc.write()` template. Those values are user-supplied (a student name
 * is typed by staff, a reference is free text), so a name containing markup
 * executed script in the print frame. Every interpolation below goes through
 * this.
 */
function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMoney(value: string | number | null | undefined): string {
  return `₹${toAmount(value).toLocaleString('en-IN')}`;
}

interface PaymentDetailsModalProps {
  open: boolean;
  onClose: () => void;
  paymentId: number | string;
}

/**
 * Receipt for a single payment, with a print view.
 *
 * Fetches the payment rather than taking it as a prop: `apiClient.payments`
 * maps rows through `mapPayment`, which keeps six fields and drops
 * `reference`, `registration` and `enrollment` — so a receipt built from a
 * list row could never show a reference number.
 */
export function PaymentDetailsModal({ open, onClose, paymentId }: PaymentDetailsModalProps) {
  const paymentQuery = useQuery({
    queryKey: ['payment', paymentId],
    queryFn: () => getPayment(paymentId),
    enabled: open && paymentId != null,
  });

  const refundsQuery = useQuery({
    queryKey: ['refunds', 'for-payment', paymentId],
    queryFn: () => listRefundsForPayment(paymentId),
    enabled: open && paymentId != null,
  });

  const payment = paymentQuery.data;
  // Memoised so the `??` fallback does not produce a new array identity every
  // render and re-create the print callback with it.
  const refunds = useMemo(() => refundsQuery.data ?? [], [refundsQuery.data]);

  const handlePrint = useCallback(() => {
    if (!payment) return;

    const refundRows = refunds
      .map(
        (refund) => `
          <div class="refund-item">
            <div>
              <div style="font-size:12px;font-weight:500;">Refund #${escapeHtml(refund.id)}</div>
              <div style="font-size:10px;color:#94a3b8;">${escapeHtml(refund.status)}</div>
            </div>
            <div style="font-weight:600;">${escapeHtml(formatMoney(refund.amount))}</div>
          </div>`,
      )
      .join('');

    const doc = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Payment receipt</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;padding:40px;background:#fff;color:#1e293b;line-height:1.5}
  .header{text-align:center;padding-bottom:24px;border-bottom:2px dashed #e2e8f0;margin-bottom:24px}
  .title{font-size:24px;font-weight:700;color:#0f172a;margin-bottom:4px}
  .subtitle{font-size:12px;color:#64748b}
  .amount-block{text-align:center;padding:24px 0;border-bottom:1px dashed #e2e8f0;margin-bottom:24px}
  .amount-label{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;margin-bottom:4px}
  .amount-value{font-size:36px;font-weight:700;color:#0f172a}
  .badge{display:inline-block;padding:4px 12px;border-radius:9999px;font-size:11px;font-weight:600;margin-top:8px;background:#f1f5f9;color:#334155}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px 32px;margin-bottom:24px}
  .label{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px}
  .value{font-size:14px;font-weight:500;color:#0f172a}
  .span2{grid-column:span 2}
  .section{margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0}
  .section-title{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#64748b;margin-bottom:12px}
  .refund-item{background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:10px;display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
  .footer{margin-top:32px;padding-top:16px;border-top:1px solid #e2e8f0;text-align:center;font-size:10px;color:#94a3b8}
  @page{size:auto;margin:10mm}
</style>
</head>
<body>
  <div class="header">
    <div class="title">Payment receipt</div>
    <div class="subtitle">Transaction ID: ${escapeHtml(payment.id)}</div>
  </div>

  <div class="amount-block">
    <div class="amount-label">Amount</div>
    <div class="amount-value">${escapeHtml(formatMoney(payment.amount))}</div>
    <span class="badge">${escapeHtml(payment.status)}</span>
  </div>

  <div class="grid">
    <div>
      <div class="label">Date &amp; time</div>
      <div class="value">${escapeHtml(format(new Date(payment.date), 'dd MMM yyyy, h:mm a'))}</div>
    </div>
    <div>
      <div class="label">Method</div>
      <div class="value">${escapeHtml(payment.method)}</div>
    </div>
    <div>
      <div class="label">Student</div>
      <div class="value">${escapeHtml(payment.student_name)}</div>
    </div>
    <div>
      <div class="label">Purpose</div>
      <div class="value">${escapeHtml(payment.type)}</div>
    </div>
    ${
      payment.reference
        ? `<div class="span2">
             <div class="label">Reference</div>
             <div class="value" style="font-family:monospace">${escapeHtml(payment.reference)}</div>
           </div>`
        : ''
    }
    <div class="span2">
      <div class="label">Recorded by</div>
      <div class="value">${escapeHtml(payment.created_by_name)}${
        payment.branch_name ? ` — ${escapeHtml(payment.branch_name)}` : ''
      }</div>
    </div>
  </div>

  ${
    refundRows
      ? `<div class="section"><div class="section-title">Refund history</div>${refundRows}</div>`
      : ''
  }

  <div class="footer">This is a computer-generated receipt.</div>
</body>
</html>`;

    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:absolute;top:-10000px;left:-10000px;width:0;height:0;border:0';
    // Listener attached before the document is written: with `srcdoc` the load
    // event can fire before a later-assigned handler would see it.
    iframe.addEventListener('load', () => {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
      // Removing the frame synchronously cancels the print dialog in Safari.
      window.setTimeout(() => iframe.remove(), 1000);
    });
    iframe.srcdoc = doc;
    document.body.appendChild(iframe);
  }, [payment, refunds]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Payment receipt"
      description={payment ? `Transaction ID ${payment.id}` : undefined}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button
            variant="outline"
            onClick={handlePrint}
            disabled={!payment}
            className="w-full gap-2 sm:w-auto"
          >
            <Printer size={14} /> Print receipt
          </Button>
          <Button onClick={onClose} className="w-full sm:w-auto">
            Done
          </Button>
        </div>
      }
    >
      {paymentQuery.isPending ? (
        <LoadingState rows={4} label="Loading receipt…" />
      ) : paymentQuery.isError ? (
        <ErrorState error={paymentQuery.error} onRetry={() => paymentQuery.refetch()} />
      ) : !payment ? (
        <p className="py-6 text-center text-sm text-slate-500">Payment not found.</p>
      ) : (
        <div className="space-y-6">
          <div className="border-b border-dashed border-slate-200 py-5 text-center">
            <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Amount</p>
            <p className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
              {formatMoney(payment.amount)}
            </p>
            <span
              className={`mt-2 inline-block rounded-full border px-2.5 py-0.5 text-xs font-bold ${
                STATUS_TONES[payment.status] ?? STATUS_TONES.Pending
              }`}
            >
              {payment.status}
            </span>
          </div>

          <dl className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
            <div>
              <dt className="mb-1 flex items-center gap-1.5 text-xs text-slate-500">
                <Calendar size={12} /> Date &amp; time
              </dt>
              <dd className="text-sm font-medium text-slate-900">
                {format(new Date(payment.date), 'dd MMM yyyy')}
              </dd>
              <dd className="text-xs text-slate-500">
                {format(new Date(payment.date), 'h:mm a')}
              </dd>
            </div>

            <div>
              <dt className="mb-1 flex items-center gap-1.5 text-xs text-slate-500">
                <Wallet size={12} /> Method
              </dt>
              <dd className="text-sm font-medium text-slate-900">{payment.method}</dd>
            </div>

            <div className="min-w-0">
              <dt className="mb-1 text-xs text-slate-500">Student</dt>
              <dd className="truncate text-sm font-medium text-slate-900">{payment.student_name}</dd>
            </div>

            <div className="min-w-0">
              <dt className="mb-1 flex items-center gap-1.5 text-xs text-slate-500">
                <FileText size={12} /> Purpose
              </dt>
              <dd className="truncate text-sm font-medium text-slate-900">{payment.type}</dd>
            </div>

            {payment.reference && (
              <div className="min-w-0 sm:col-span-2">
                <dt className="mb-1 text-xs text-slate-500">Reference</dt>
                <dd className="break-all font-mono text-sm font-medium text-slate-900">
                  {payment.reference}
                </dd>
              </div>
            )}

            <div className="min-w-0 sm:col-span-2">
              <dt className="mb-1 text-xs text-slate-500">Recorded by</dt>
              <dd className="truncate text-sm font-medium text-slate-900">
                {payment.created_by_name}
                {payment.branch_name ? ` — ${payment.branch_name}` : ''}
              </dd>
            </div>
          </dl>

          <div className="border-t border-slate-100 pt-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-500">
              Refund history
            </p>
            {refundsQuery.isPending ? (
              <LoadingState rows={1} label="Loading refunds…" />
            ) : refundsQuery.isError ? (
              <p className="text-sm text-slate-500">Refund history is unavailable right now.</p>
            ) : refunds.length === 0 ? (
              <p className="text-sm text-slate-500">No refunds have been raised against this payment.</p>
            ) : (
              <ul className="space-y-2">
                {refunds.map((refund) => (
                  <li
                    key={refund.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-slate-700">Refund #{refund.id}</p>
                      <p className="truncate text-[10px] text-slate-400">{refund.reason || '—'}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <span
                        className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${
                          REFUND_TONES[refund.status] ?? 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        {refund.status}
                      </span>
                      <p className="mt-0.5 text-xs font-bold text-slate-900">
                        {formatMoney(refund.amount)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
