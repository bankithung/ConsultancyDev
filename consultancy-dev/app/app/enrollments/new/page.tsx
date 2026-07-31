'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { CheckCircle, Printer, X } from 'lucide-react';

import { apiClient } from '@/lib/apiClient';
import { getApiErrorMessage } from '@/lib/api';
import type { Enrollment } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { toast } from '@/store/toastStore';
import { EnrollmentWizard, type EnrollmentWizardPayload } from '../components/EnrollmentWizard';

/**
 * Creates an enrollment, then the records that hang off it.
 *
 * Three writes, deliberately sequential and deliberately not silent:
 *
 *  1. `enrollments/` — the only one that must succeed. The server allocates
 *     `enrollment_no` and, when `installments_count` is sent, builds a schedule
 *     summing exactly to `total_fees`.
 *  2. `payments/` — linked by the new enrollment's id, so the money is
 *     reconcilable instead of being matched back by student name.
 *  3. `student-documents/` — custody of paper originals, attached to the
 *     student's REGISTRATION rather than the enrollment.
 *
 * A failure in 2 or 3 leaves a valid enrollment, so it is reported as a warning
 * naming what did not save rather than rolled into a generic error.
 */

interface ReceiptData {
  enrollment: Enrollment;
  studentName: string;
  universityLabel: string;
  payment: EnrollmentWizardPayload['payment'];
  installmentsCount: number;
  installmentAmount: number | null;
  commissionAmount: number;
}

/** Values are interpolated into a printed document, so markup must not survive. */
function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatCurrency(value: number): string {
  return `₹${Number(value || 0).toLocaleString('en-IN')}`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleDateString('en-IN');
}

export default function NewEnrollmentPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);

  const mutation = useMutation({
    mutationFn: async (payload: EnrollmentWizardPayload): Promise<ReceiptData> => {
      const enrollment = await apiClient.enrollments.create(payload.enrollment);

      // The server-echoed name is the reliable one; the wizard's copy is blank
      // when the form was restored from a draft whose student is off the
      // current picker page.
      const studentName = payload.studentName || enrollment.studentName;
      const failed: string[] = [];

      if (payload.payment) {
        try {
          await apiClient.payments.create({
            student_name: studentName,
            amount: payload.payment.amount,
            type: 'Enrollment',
            status: 'Success',
            method: payload.payment.method,
            date: payload.payment.date,
            enrollment: enrollment.id,
            registration: payload.registrationId,
            reference: payload.payment.reference,
          });
        } catch (error) {
          failed.push(`the payment (${getApiErrorMessage(error)})`);
        }
      }

      for (const document of payload.physicalDocuments) {
        try {
          await apiClient.studentDocuments.create({
            registration: payload.registrationId,
            name: document.name.trim(),
            document_number: document.documentNumber.trim(),
            remarks: document.remarks.trim(),
            status: 'Received',
          });
        } catch (error) {
          failed.push(`the document “${document.name.trim()}” (${getApiErrorMessage(error)})`);
        }
      }

      if (failed.length > 0) {
        toast.warning(
          'Enrollment created, but not everything saved',
          `Could not record ${failed.join('; ')}. Add it from the student's profile.`,
        );
      }

      return {
        enrollment,
        studentName,
        universityLabel: payload.universityLabel || enrollment.university_name || '',
        payment: payload.payment,
        installmentsCount: payload.enrollment.installments_count ?? 1,
        installmentAmount:
          payload.enrollment.installment_amount === undefined
            ? null
            : Number(payload.enrollment.installment_amount),
        commissionAmount: Number(payload.enrollment.commission_amount ?? 0),
      };
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['enrollments'] });
      void queryClient.invalidateQueries({ queryKey: ['payments'] });
      void queryClient.invalidateQueries({ queryKey: ['student-documents'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard-activity'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard-revenue'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard-weekly'] });
      setReceipt(data);
    },
    onError: (error: unknown) => {
      toast.error('Could not create the enrollment', getApiErrorMessage(error));
    },
  });

  const handleClose = () => {
    setReceipt(null);
    router.push('/app/enrollments');
  };

  const handlePrint = () => {
    if (!receipt) return;

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      toast.error('Could not open the receipt', 'Allow pop-ups for this site and try again.');
      return;
    }

    const { enrollment, studentName, universityLabel, payment } = receipt;
    const total = Number(enrollment.totalFees) || 0;

    const paymentBlock = payment
      ? `
        <div class="info-box">
          <div class="info-box-title">Payment received</div>
          <div class="info-box-content">
            <div><span class="label">Method:</span> <span class="payment-badge">${escapeHtml(payment.method)}</span></div>
            <div style="margin-top:10px;"><span class="label">Amount:</span> ${escapeHtml(formatCurrency(payment.amount))}</div>
            <div style="margin-top:10px;"><span class="label">Date:</span> ${escapeHtml(formatDate(payment.date))}</div>
            ${payment.reference ? `<div style="margin-top:10px;"><span class="label">Reference:</span> ${escapeHtml(payment.reference)}</div>` : ''}
            ${
              payment.amount < total
                ? `<div style="margin-top:10px;"><span class="label">Balance:</span> ${escapeHtml(formatCurrency(total - payment.amount))}</div>`
                : ''
            }
          </div>
        </div>`
      : `
        <div class="info-box">
          <div class="info-box-title">Payment</div>
          <div class="info-box-content">No payment was collected at the time of enrollment.</div>
        </div>`;

    const scheduleBlock =
      receipt.installmentsCount > 1
        ? `
        <div class="info-box" style="border-left-color:#f59e0b;">
          <div class="info-box-title">Installment plan</div>
          <div class="info-box-content">
            <div><span class="label">Installments:</span> ${escapeHtml(receipt.installmentsCount)}</div>
            ${
              receipt.installmentAmount
                ? `<div style="margin-top:8px;"><span class="label">Amount each:</span> ${escapeHtml(formatCurrency(receipt.installmentAmount))}</div>`
                : ''
            }
            <div style="margin-top:8px;">The final installment absorbs any rounding remainder.</div>
          </div>
        </div>`
        : '';

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Receipt ${escapeHtml(enrollment.enrollmentNo)}</title>
  <style>
    body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 40px; color: #333; max-width: 800px; margin: 0 auto; }
    .header { text-align: center; margin-bottom: 40px; border-bottom: 2px solid #eee; padding-bottom: 20px; }
    .logo { font-size: 28px; font-weight: bold; color: #0d9488; letter-spacing: -0.5px; }
    .subtitle { font-size: 14px; color: #666; margin-top: 6px; text-transform: uppercase; letter-spacing: 1px; }
    .details-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-bottom: 40px; }
    .label { font-size: 11px; color: #888; text-transform: uppercase; font-weight: 600; }
    .value { font-size: 16px; font-weight: 500; color: #000; }
    .enrollment-badge { display: inline-block; background: #f0fdf4; color: #166534; padding: 8px 12px; border-radius: 6px; font-family: monospace; font-size: 16px; font-weight: bold; border: 1px solid #bbf7d0; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 40px; }
    th { text-align: left; padding: 12px 8px; border-bottom: 2px solid #eee; color: #666; font-size: 12px; text-transform: uppercase; }
    td { padding: 16px 8px; border-bottom: 1px solid #f5f5f5; }
    .amount-col { text-align: right; }
    .total-row td { border-top: 2px solid #eee; border-bottom: none; padding-top: 20px; font-weight: bold; font-size: 18px; }
    .info-box { margin-bottom: 24px; padding: 20px; background: #f8fafc; border-radius: 8px; border-left: 4px solid #0d9488; }
    .info-box-title { font-size: 12px; color: #666; text-transform: uppercase; margin-bottom: 12px; font-weight: 600; }
    .info-box-content { font-size: 14px; color: #333; line-height: 1.6; }
    .payment-badge { display: inline-block; background: #dbeafe; color: #1e40af; padding: 4px 10px; border-radius: 4px; font-size: 13px; font-weight: 600; }
    .footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #999; font-size: 12px; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">Kikons Consultancy</div>
    <div class="subtitle">Enrollment Receipt</div>
  </div>

  <div class="details-grid">
    <div>
      <div style="margin-bottom:20px;">
        <div class="label">Student</div>
        <div class="value">${escapeHtml(studentName)}</div>
      </div>
      <div style="margin-bottom:20px;">
        <div class="label">University</div>
        <div class="value">${escapeHtml(universityLabel || '—')}</div>
      </div>
      <div>
        <div class="label">Program</div>
        <div class="value">${escapeHtml(enrollment.programName)}</div>
      </div>
    </div>
    <div style="text-align:right;">
      <div style="margin-bottom:20px;">
        <div class="label">Date</div>
        <div class="value">${escapeHtml(new Date().toLocaleDateString('en-IN'))}</div>
      </div>
      <div style="margin-bottom:20px;">
        <div class="label">Start date</div>
        <div class="value">${escapeHtml(formatDate(enrollment.startDate))}</div>
      </div>
      <div>
        <div class="label">Enrollment number</div>
        <div style="margin-top:5px;"><span class="enrollment-badge">${escapeHtml(enrollment.enrollmentNo)}</span></div>
      </div>
    </div>
  </div>

  <table>
    <thead>
      <tr><th>Description</th><th class="amount-col">Amount</th></tr>
    </thead>
    <tbody>
      <tr>
        <td>Program fees — ${escapeHtml(enrollment.programName)}</td>
        <td class="amount-col">${escapeHtml(formatCurrency(total))}</td>
      </tr>
      <tr class="total-row">
        <td>Total payable</td>
        <td class="amount-col">${escapeHtml(formatCurrency(total))}</td>
      </tr>
    </tbody>
  </table>

  ${scheduleBlock}
  ${paymentBlock}

  <div class="footer">
    <p>Generated by the Kikons Consultancy system.<br />Please retain this receipt for your records.</p>
  </div>

  <script>window.onload = function () { window.print(); };</script>
</body>
</html>`;

    printWindow.document.write(html);
    printWindow.document.close();
  };

  return (
    <div className="mx-auto max-w-4xl px-3 py-6 sm:px-4">
      <EnrollmentWizard
        onSubmit={(payload) => mutation.mutate(payload)}
        isLoading={mutation.isPending}
        error={mutation.isError ? mutation.error : undefined}
      />

      <Dialog.Root open={receipt !== null} onOpenChange={(next) => !next && handleClose()}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-1.5rem)] max-w-[480px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-slate-100 bg-white p-6 shadow-2xl focus:outline-none">
            <div className="mb-6 flex flex-col items-center text-center">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
                <CheckCircle className="h-8 w-8 text-green-600" />
              </div>
              <Dialog.Title className="text-xl font-bold text-slate-900">Enrollment created</Dialog.Title>
              <Dialog.Description className="mt-2 text-sm text-slate-600">
                {receipt?.studentName} is now enrolled.
                <br />
                Enrollment no:{' '}
                <span className="ml-1 rounded bg-slate-100 px-2 py-1 font-mono font-bold text-slate-900">
                  {receipt?.enrollment.enrollmentNo}
                </span>
              </Dialog.Description>
            </div>

            <div className="space-y-3">
              <Button className="h-11 w-full bg-teal-600 font-medium hover:bg-teal-700" onClick={handlePrint}>
                <Printer className="mr-2 h-4 w-4" /> Print receipt
              </Button>
              <Button
                variant="outline"
                className="h-11 w-full border-slate-300 hover:bg-slate-50"
                onClick={handleClose}
              >
                Close &amp; go to the list
              </Button>
            </div>

            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close dialog"
                className="absolute right-4 top-4 rounded-full p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
              >
                <X size={18} />
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
