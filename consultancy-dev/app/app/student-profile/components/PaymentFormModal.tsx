'use client';

import { useCallback, useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import type { PaymentInput } from '@/lib/types';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ErrorBanner, InlineSpinner } from '@/components/common/states';
import { toast } from '@/store/toastStore';
import { NUMERIC_FIELD, formatCurrency, toNumber } from '../constants';

/** `Payment.type` and `.method` are free text server-side; these keep staff consistent. */
const PAYMENT_TYPES = ['Enquiry', 'Registration', 'Enrollment'] as const;
const PAYMENT_METHODS = ['Cash', 'Card', 'UPI', 'Bank Transfer', 'Cheque', 'Other'] as const;

/** A payment is never *created* as Refunded — that state is reached via a refund. */
const CREATABLE_STATUSES = ['Success', 'Pending', 'Failed'] as const;

export type PaymentStage = (typeof PAYMENT_TYPES)[number];

const paymentSchema = z.object({
  date: z.string().min(1, 'Date is required'),
  type: z.enum(PAYMENT_TYPES),
  amount: z
    .string()
    .regex(NUMERIC_FIELD, 'Enter an amount')
    .refine((value) => toNumber(value) > 0, 'Amount must be greater than zero'),
  method: z.enum(PAYMENT_METHODS),
  status: z.enum(CREATABLE_STATUSES),
  reference: z.string(),
});

type PaymentFormValues = z.infer<typeof paymentSchema>;

interface PaymentFormModalProps {
  open: boolean;
  onClose: () => void;
  studentName: string;
  /** Pre-selects the stage the profile was opened at. */
  defaultType: PaymentStage;
  /** Registration FK, when the student has one. Makes the payment reconcilable. */
  registrationId?: string | null;
  /** Enrollment FK, when the profile is an enrollment. */
  enrollmentId?: string | null;
}

export function PaymentFormModal({
  open,
  onClose,
  studentName,
  defaultType,
  registrationId,
  enrollmentId,
}: PaymentFormModalProps) {
  const queryClient = useQueryClient();

  const buildDefaults = useCallback(
    (): PaymentFormValues => ({
      date: new Date().toISOString().split('T')[0],
      type: defaultType,
      amount: '',
      method: 'Cash',
      status: 'Success',
      reference: '',
    }),
    [defaultType],
  );

  const {
    register,
    control,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<PaymentFormValues>({
    resolver: zodResolver(paymentSchema),
    defaultValues: buildDefaults(),
  });

  useEffect(() => {
    if (open) reset(buildDefaults());
  }, [open, reset, buildDefaults]);

  const method = watch('method');
  const amount = toNumber(watch('amount'));

  const createMutation = useMutation({
    mutationFn: (values: PaymentFormValues) => {
      const payload: PaymentInput = {
        student_name: studentName,
        date: values.date,
        type: values.type,
        amount: toNumber(values.amount),
        method: values.method,
        status: values.status,
        reference: values.reference.trim(),
        // Sending the foreign keys is what makes the payment reconcilable later.
        // Omitted rather than sent as null when the student has no such record.
        ...(registrationId ? { registration: registrationId } : {}),
        ...(enrollmentId ? { enrollment: enrollmentId } : {}),
      };
      return apiClient.payments.create(payload);
    },
    onSuccess: (payment) => {
      void queryClient.invalidateQueries({ queryKey: ['payments'] });
      toast.success(`Payment of ${formatCurrency(payment.amount)} recorded`);
      onClose();
    },
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a payment"
      description={`Against ${studentName}`}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm font-semibold text-teal-700">{formatCurrency(amount)}</p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" className="h-10" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form="payment-form" className="h-10" disabled={createMutation.isPending}>
              {createMutation.isPending ? (
                <>
                  <InlineSpinner className="mr-2" /> Saving…
                </>
              ) : (
                'Record payment'
              )}
            </Button>
          </div>
        </div>
      }
    >
      <form
        id="payment-form"
        onSubmit={handleSubmit((values) => createMutation.mutate(values))}
        className="space-y-4"
      >
        {createMutation.isError && <ErrorBanner error={createMutation.error} />}

        {!registrationId && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            This student has no registration yet, so the payment will be filed under their name only and will not be
            linked to a registration record.
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="payment-date">
              Date <span className="text-red-500">*</span>
            </Label>
            <Input id="payment-date" type="date" className="h-10" {...register('date')} />
            {errors.date && <p className="text-xs text-red-600">{errors.date.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="payment-amount">
              Amount <span className="text-red-500">*</span>
            </Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-500">₹</span>
              <Input
                id="payment-amount"
                inputMode="decimal"
                className="h-10 pl-7"
                placeholder="0"
                {...register('amount')}
              />
            </div>
            {errors.amount && <p className="text-xs text-red-600">{errors.amount.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="payment-type">Stage</Label>
            <Controller
              name="type"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="payment-type" className="h-10 w-full bg-white">
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
              )}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="payment-method">Method</Label>
            <Controller
              name="method"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="payment-method" className="h-10 w-full bg-white">
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
              )}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="payment-status">Status</Label>
            <Controller
              name="status"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="payment-status" className="h-10 w-full bg-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CREATABLE_STATUSES.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="payment-reference">Reference</Label>
            <Input
              id="payment-reference"
              className="h-10"
              placeholder={method === 'Cheque' ? 'Cheque number' : 'Transaction / UPI reference'}
              {...register('reference')}
            />
          </div>
        </div>
      </form>
    </Modal>
  );
}
