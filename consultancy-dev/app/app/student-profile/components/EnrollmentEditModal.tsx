'use client';

import { useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import type { Enrollment, EnrollmentInput } from '@/lib/types';
import { toArray } from '@/components/common/pagination';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ErrorBanner, InlineSpinner } from '@/components/common/states';
import { toast } from '@/store/toastStore';
import { NUMERIC_FIELD, formatCurrency, fromNumber, toDateInput, toNumber } from '../constants';

/** Sentinel for "not in the catalogue" — reveals the free-text name field. */
const OTHER_UNIVERSITY = 'other';

const enrollmentSchema = z.object({
  programName: z.string().min(1, 'Program name is required'),
  /** University id as a string, `''` for none, or the OTHER sentinel. */
  university: z.string(),
  universityName: z.string(),
  country: z.string(),
  startDate: z.string().min(1, 'Start date is required'),
  durationMonths: z.string().regex(NUMERIC_FIELD, 'Enter a number of months'),
  totalFees: z.string().regex(NUMERIC_FIELD, 'Enter an amount'),
  commissionAmount: z.string().regex(NUMERIC_FIELD, 'Enter an amount'),
  status: z.string().min(1, 'Status is required'),
});

type EnrollmentFormValues = z.infer<typeof enrollmentSchema>;

interface EnrollmentEditModalProps {
  open: boolean;
  onClose: () => void;
  enrollment: Enrollment;
  onSaved: () => void;
}

function toFormValues(enrollment: Enrollment): EnrollmentFormValues {
  const hasCatalogueUniversity = enrollment.university !== null && enrollment.university !== undefined;
  return {
    programName: enrollment.programName ?? '',
    university: hasCatalogueUniversity ? String(enrollment.university) : enrollment.university_name ? OTHER_UNIVERSITY : '',
    universityName: enrollment.university_name ?? '',
    country: enrollment.country ?? '',
    startDate: toDateInput(enrollment.startDate),
    durationMonths: fromNumber(enrollment.durationMonths),
    totalFees: fromNumber(enrollment.totalFees),
    commissionAmount: fromNumber(enrollment.commission_amount),
    status: enrollment.status || 'Active',
  };
}

/**
 * Edits an enrollment's program, university and commercial terms.
 *
 * Two deliberate omissions against the old build:
 *
 * - The service-charge / school-fee / hostel-fee breakdown and the loan and
 *   payment-type fields are gone. They have no column on the rebuilt server, so
 *   offering them would have silently discarded whatever was typed. Only
 *   `total_fees` and `commission_amount` are real.
 * - `installments_count` / `installment_amount` are not exposed here. They
 *   REGENERATE the payment schedule, which would quietly destroy a part-paid
 *   plan; rebuilding a schedule belongs in its own deliberate action.
 *
 * The update is a PUT, so `student` is carried through untouched — omitting it
 * would detach the enrollment from its registration.
 */
export function EnrollmentEditModal({ open, onClose, enrollment, onSaved }: EnrollmentEditModalProps) {
  const queryClient = useQueryClient();

  const {
    register,
    control,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<EnrollmentFormValues>({
    resolver: zodResolver(enrollmentSchema),
    defaultValues: toFormValues(enrollment),
  });

  useEffect(() => {
    if (open) reset(toFormValues(enrollment));
  }, [open, enrollment, reset]);

  const universitiesQuery = useQuery({
    queryKey: ['universities', 'enrollment-picker'],
    queryFn: () => apiClient.universities.list({ page_size: 200, ordering: 'name' }),
    enabled: open,
  });
  const universities = toArray(universitiesQuery.data);

  const selectedUniversity = watch('university');
  const totalFees = toNumber(watch('totalFees'));

  const updateMutation = useMutation({
    mutationFn: (values: EnrollmentFormValues) => {
      const isOther = values.university === OTHER_UNIVERSITY;
      const catalogueId = isOther || values.university === '' ? null : Number(values.university);
      const catalogueName = universities.find((entry) => String(entry.id) === values.university)?.name;

      const payload: EnrollmentInput = {
        student: enrollment.student,
        program_name: values.programName.trim(),
        university: catalogueId,
        university_name: isOther ? values.universityName.trim() : (catalogueName ?? ''),
        country: values.country.trim(),
        start_date: values.startDate,
        duration_months: toNumber(values.durationMonths, 12),
        total_fees: toNumber(values.totalFees),
        commission_amount: toNumber(values.commissionAmount),
        status: values.status,
      };
      return apiClient.enrollments.update(enrollment.id, payload);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['enrollments'] });
      onSaved();
      onClose();
      toast.success('Enrollment updated');
    },
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit enrollment"
      description={enrollment.enrollmentNo}
      size="lg"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm font-semibold text-emerald-700">Total fees {formatCurrency(totalFees)}</p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" className="h-10" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form="enrollment-edit-form" className="h-10" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? (
                <>
                  <InlineSpinner className="mr-2" /> Saving…
                </>
              ) : (
                'Save changes'
              )}
            </Button>
          </div>
        </div>
      }
    >
      <form
        id="enrollment-edit-form"
        onSubmit={handleSubmit((values) => updateMutation.mutate(values))}
        className="space-y-6"
      >
        {updateMutation.isError && <ErrorBanner error={updateMutation.error} />}

        <section className="space-y-4">
          <h4 className="border-b pb-2 text-sm font-bold uppercase tracking-wider text-slate-700">Program</h4>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="enrollment-program">
                Program name <span className="text-red-500">*</span>
              </Label>
              <Input id="enrollment-program" className="h-10" {...register('programName')} />
              {errors.programName && <p className="text-xs text-red-600">{errors.programName.message}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="enrollment-university">University</Label>
              <Controller
                name="university"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value === '' ? 'none' : field.value}
                    onValueChange={(next) => field.onChange(next === 'none' ? '' : next)}
                  >
                    <SelectTrigger id="enrollment-university" className="h-10 w-full bg-white">
                      <SelectValue placeholder="Select a university" />
                    </SelectTrigger>
                    <SelectContent className="max-h-60">
                      <SelectItem value="none">Not set</SelectItem>
                      {universities.map((university) => (
                        <SelectItem key={university.id} value={String(university.id)}>
                          {university.name}
                        </SelectItem>
                      ))}
                      <SelectItem value={OTHER_UNIVERSITY}>Other (not in the catalogue)</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
              {universitiesQuery.isError && (
                <p className="text-xs text-amber-700">
                  Could not load the catalogue — choose “Other” and type the name.
                </p>
              )}
            </div>

            {selectedUniversity === OTHER_UNIVERSITY && (
              <div className="space-y-1.5">
                <Label htmlFor="enrollment-university-name">University name</Label>
                <Input id="enrollment-university-name" className="h-10" {...register('universityName')} />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="enrollment-country">Country</Label>
              <Input id="enrollment-country" className="h-10" placeholder="e.g. India" {...register('country')} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="enrollment-start">
                Start date <span className="text-red-500">*</span>
              </Label>
              <Input id="enrollment-start" type="date" className="h-10" {...register('startDate')} />
              {errors.startDate && <p className="text-xs text-red-600">{errors.startDate.message}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="enrollment-duration">Duration (months)</Label>
              <Input id="enrollment-duration" inputMode="numeric" className="h-10" {...register('durationMonths')} />
              {errors.durationMonths && <p className="text-xs text-red-600">{errors.durationMonths.message}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="enrollment-status">Status</Label>
              <Controller
                name="status"
                control={control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="enrollment-status" className="h-10 w-full bg-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Active">Active</SelectItem>
                      <SelectItem value="Completed">Completed</SelectItem>
                      <SelectItem value="Dropped">Dropped</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h4 className="border-b pb-2 text-sm font-bold uppercase tracking-wider text-slate-700">Commercials</h4>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="enrollment-total">Total fees</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-500">₹</span>
                <Input id="enrollment-total" inputMode="decimal" className="h-10 pl-7" {...register('totalFees')} />
              </div>
              {errors.totalFees && <p className="text-xs text-red-600">{errors.totalFees.message}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="enrollment-commission">Commission</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-500">₹</span>
                <Input
                  id="enrollment-commission"
                  inputMode="decimal"
                  className="h-10 pl-7"
                  {...register('commissionAmount')}
                />
              </div>
              {errors.commissionAmount && <p className="text-xs text-red-600">{errors.commissionAmount.message}</p>}
            </div>
          </div>
          <p className="text-xs text-slate-500">
            The installment schedule is not edited here — changing it regenerates every instalment, including ones
            already paid.
          </p>
        </section>
      </form>
    </Modal>
  );
}
