'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle } from 'lucide-react';
import { apiClient } from '@/lib/apiClient';
import type { Payment, RefundInput } from '@/lib/types';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ErrorBanner, InlineSpinner } from '@/components/common/states';
import { toast } from '@/store/toastStore';
import { NUMERIC_FIELD, formatCurrency, toNumber } from '../constants';

const refundSchema = z.object({
  amount: z
    .string()
    .regex(NUMERIC_FIELD, 'Enter an amount')
    .refine((value) => toNumber(value) > 0, 'Amount must be greater than zero'),
  reason: z.string().min(1, 'Give a reason — this is what the approver reads'),
});

type RefundFormValues = z.infer<typeof refundSchema>;

interface RefundRequestModalProps {
  open: boolean;
  onClose: () => void;
  studentName: string;
  /**
   * Registration id. The refund serializer requires this FK — `student_name` is
   * read-only server-side, so a refund cannot be raised without it.
   */
  registrationId: string;
  /** The payment being refunded. Sent as the `payment` FK. */
  payment: Payment | null;
}

export function RefundRequestModal({
  open,
  onClose,
  studentName,
  registrationId,
  payment,
}: RefundRequestModalProps) {
  const queryClient = useQueryClient();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<RefundFormValues>({
    resolver: zodResolver(refundSchema),
    defaultValues: { amount: '', reason: '' },
  });

  useEffect(() => {
    if (!open) return;
    reset({ amount: payment ? String(payment.amount) : '', reason: '' });
  }, [open, payment, reset]);

  const createMutation = useMutation({
    mutationFn: (values: RefundFormValues) => {
      const payload: RefundInput = {
        student: registrationId,
        payment: payment ? payment.id : null,
        amount: toNumber(values.amount),
        reason: values.reason.trim(),
        status: 'Pending',
      };
      return apiClient.refunds.create(payload);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['refunds'] });
      toast.success('Refund requested', 'It needs approval before any money moves.');
      onClose();
    },
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Request a refund"
      description={`For ${studentName}`}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" className="h-10" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="refund-form"
            className="h-10 bg-orange-600 hover:bg-orange-700"
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? (
              <>
                <InlineSpinner className="mr-2" /> Submitting…
              </>
            ) : (
              'Submit request'
            )}
          </Button>
        </div>
      }
    >
      <form id="refund-form" onSubmit={handleSubmit((values) => createMutation.mutate(values))} className="space-y-4">
        {createMutation.isError && <ErrorBanner error={createMutation.error} />}

        {payment && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
            <p className="font-semibold text-slate-800">
              {payment.type} payment · {formatCurrency(payment.amount)}
            </p>
            <p>
              {payment.method} · {payment.status}
              {payment.reference ? ` · ${payment.reference}` : ''}
            </p>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="refund-amount">
            Refund amount <span className="text-red-500">*</span>
          </Label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-500">₹</span>
            <Input id="refund-amount" inputMode="decimal" className="h-10 pl-7" {...register('amount')} />
          </div>
          {errors.amount && <p className="text-xs text-red-600">{errors.amount.message}</p>}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="refund-reason">
            Reason <span className="text-red-500">*</span>
          </Label>
          <Textarea id="refund-reason" placeholder="Why is this being refunded?" {...register('reason')} />
          {errors.reason && <p className="text-xs text-red-600">{errors.reason.message}</p>}
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-amber-600" />
          <p className="text-[11px] text-amber-800">
            This creates a pending refund. No money moves until someone with refund permissions approves it.
          </p>
        </div>
      </form>
    </Modal>
  );
}
