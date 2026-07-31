'use client';

import { useEffect, useMemo, useState } from 'react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CreditCard,
  FileText,
  GraduationCap,
  Loader2,
  Plus,
  Save,
  Trash2,
  User,
  Wallet,
} from 'lucide-react';

import { apiClient, fetchAllPages } from '@/lib/apiClient';
import type { EnrollmentInput, Registration, University } from '@/lib/types';
import { toArray } from '@/components/common/pagination';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DocumentUpload } from '@/components/common/DocumentUpload';
import { ErrorBanner, InlineSpinner } from '@/components/common/states';
import { useDebounce } from '@/hooks/useDebounce';
import { cn } from '@/lib/utils';
import { toast } from '@/store/toastStore';
import { AddUniversityModal } from '@/app/app/universities/components/AddUniversityModal';

/**
 * Creates an enrollment for an already-registered student.
 *
 * CONTRACT NOTES — each of these was a live bug in the previous build:
 *
 * - `student` is a REQUIRED foreign key to a Registration. The old form sent
 *   `student_id`, which the serializer does not have, so every create 400'd.
 * - `enrollment_no` is server-assigned. It is not asked for and not sent; the
 *   backend allocates the next per-company reference (ENR-2026-004).
 * - There is no fee breakdown. `schoolFees` / `hostelFees` had no column and
 *   were summed into `total_fees` and discarded, so this form asks for the
 *   total directly. `serviceCharge` was RENAMED to `commission_amount` and is
 *   still live — it is the "Service charge" box on the Fees step.
 * - There is no `payment_type`. A split fee is expressed as
 *   `installments_count` / `installment_amount`, which make the server build a
 *   schedule summing exactly to `total_fees` (the last row takes the
 *   remainder). Never build that schedule on the client.
 */

const DRAFT_KEY = 'enrollment_wizard_draft';

/** Sentinel for "not in the catalogue" — reveals the free-text name field. */
const OTHER_UNIVERSITY = 'other';

const COMMON_DOCUMENTS = [
  'Class 10 Marksheet',
  'Class 10 Passing Certificate',
  'Class 12 Marksheet',
  'Class 12 Passing Certificate',
  'Admit Card',
  'Migration Certificate',
  'Transfer Certificate (TC)',
  'Character Certificate',
  'Aadhaar Card',
  'PAN Card',
  'Passport',
  'NEET Score Card',
  'Gap Certificate',
  'Domicile Certificate',
  'Caste Certificate',
  'Income Certificate',
  'Passport Size Photos',
] as const;

const PAYMENT_METHODS = ['Cash', 'Card', 'UPI', 'Bank Transfer', 'Cheque'] as const;
const CARD_NETWORKS = ['Visa', 'Mastercard', 'RuPay', 'AmEx'] as const;

/** Empty, or a plain number. Keeps every field a string until submit. */
const NUMERIC_FIELD = /^$|^\d+(\.\d+)?$/;

const physicalDocumentSchema = z.object({
  name: z.string(),
  documentNumber: z.string(),
  remarks: z.string(),
});

const wizardSchema = z.object({
  /** Registration primary key, as a string. */
  student: z.string().min(1, 'Please select a student'),
  programName: z.string().min(1, 'Program name is required'),
  /** '' for none, a university id, or `OTHER_UNIVERSITY`. */
  university: z.string(),
  universityName: z.string(),
  country: z.string(),
  durationMonths: z.string().regex(NUMERIC_FIELD, 'Enter a number of months'),
  startDate: z.string().min(1, 'Start date is required'),
  totalFees: z.string().regex(NUMERIC_FIELD, 'Enter an amount'),
  commissionAmount: z.string().regex(NUMERIC_FIELD, 'Enter an amount'),
  /** '1' means a single payment; anything higher generates a schedule. */
  installmentsCount: z.string().regex(NUMERIC_FIELD, 'Enter a number of installments'),
  installmentAmount: z.string().regex(NUMERIC_FIELD, 'Enter an amount'),
  recordPayment: z.boolean(),
  paymentMethod: z.string(),
  paymentAmount: z.string().regex(NUMERIC_FIELD, 'Enter an amount'),
  paymentDate: z.string(),
  paymentReference: z.string(),
  cardLast4: z.string().max(4, 'Four digits at most'),
  cardNetwork: z.string(),
  upiId: z.string(),
  bankName: z.string(),
  chequeNumber: z.string(),
  trackPhysicalDocuments: z.boolean(),
  physicalDocuments: z.array(physicalDocumentSchema),
});

type WizardFormValues = z.infer<typeof wizardSchema>;

/** A paper original taken from the student, created against their registration. */
export interface PhysicalDocumentDraft {
  name: string;
  documentNumber: string;
  remarks: string;
}

/** Money actually collected at the counter, recorded against the new enrollment. */
export interface EnrollmentPaymentDraft {
  amount: number;
  method: string;
  date: string;
  /**
   * Composed free text. `Payment.reference` is the only free-text column, so
   * the method-specific details (card network, UPI id, cheque number) are
   * folded into it rather than discarded.
   */
  reference: string;
}

export interface EnrollmentWizardPayload {
  /** Exactly the writable fields on `EnrollmentSerializer`. */
  enrollment: EnrollmentInput;
  /** Registration primary key, for documents that hang off the student. */
  registrationId: number;
  studentName: string;
  universityLabel: string;
  payment: EnrollmentPaymentDraft | null;
  physicalDocuments: PhysicalDocumentDraft[];
}

interface EnrollmentWizardProps {
  onSubmit: (payload: EnrollmentWizardPayload) => void;
  isLoading: boolean;
  /** Surfaced inline so a failed create is never silent. */
  error?: unknown;
}

const STEPS = [
  { id: 1, name: 'Student', icon: User },
  { id: 2, name: 'Program', icon: GraduationCap },
  { id: 3, name: 'Fees', icon: Wallet },
  { id: 4, name: 'Documents', icon: FileText },
  { id: 5, name: 'Payment', icon: CreditCard },
] as const;

const LAST_STEP = STEPS.length;

const EMPTY_DOCUMENT: PhysicalDocumentDraft = { name: '', documentNumber: '', remarks: '' };

function today(): string {
  return new Date().toISOString().split('T')[0] ?? '';
}

/**
 * A function rather than a module constant: `paymentDate` defaults to today,
 * and a module-level date would freeze at whenever the bundle first ran — a tab
 * left open overnight would pre-fill yesterday.
 */
function defaultValues(): WizardFormValues {
  return {
    student: '',
    programName: '',
    university: '',
    universityName: '',
    country: '',
    durationMonths: '12',
    startDate: '',
    totalFees: '',
    commissionAmount: '',
    installmentsCount: '1',
    installmentAmount: '',
    recordPayment: true,
    paymentMethod: '',
    paymentAmount: '',
    paymentDate: today(),
    paymentReference: '',
    cardLast4: '',
    cardNetwork: '',
    upiId: '',
    bankName: '',
    chequeNumber: '',
    trackPhysicalDocuments: false,
    physicalDocuments: [],
  };
}

function toNumber(value: string, fallback = 0): number {
  const trimmed = value.trim();
  if (trimmed === '') return fallback;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatCurrency(value: number): string {
  return `₹${value.toLocaleString('en-IN')}`;
}

/**
 * Restores a saved draft, discarding anything that no longer parses.
 *
 * The draft outlives deploys, so a shape from an older build must not be
 * spread into the form — that is how a stale `paymentType` would have come
 * back after the field was removed.
 */
function loadDraft(): WizardFormValues | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = wizardSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Folds the method-specific fields into a single reference string.
 *
 * `Payment.reference` is `max_length=120` server-side; a longer value is a 400.
 */
function composePaymentReference(values: WizardFormValues): string {
  const parts: string[] = [];
  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) parts.push(trimmed);
  };

  push(values.paymentReference);
  push(values.cardNetwork);
  if (values.cardLast4.trim()) parts.push(`****${values.cardLast4.trim()}`);
  push(values.upiId);
  if (values.chequeNumber.trim()) parts.push(`Cheque ${values.chequeNumber.trim()}`);
  push(values.bankName);

  return parts.join(' · ').slice(0, 120);
}

export function EnrollmentWizard({ onSubmit, isLoading, error }: EnrollmentWizardProps) {
  const [currentStep, setCurrentStep] = useState(1);
  const [showLeaveModal, setShowLeaveModal] = useState(false);
  const [isAddUniOpen, setIsAddUniOpen] = useState(false);
  const [studentSearch, setStudentSearch] = useState('');
  const [uploadedCount, setUploadedCount] = useState(0);
  const queryClient = useQueryClient();

  const debouncedStudentSearch = useDebounce(studentSearch, 300);

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    getValues,
    reset,
    formState: { errors },
  } = useForm<WizardFormValues>({
    resolver: zodResolver(wizardSchema),
    defaultValues: defaultValues(),
  });

  // Restored after mount, never during the first render: this component is
  // server-rendered, `localStorage` only exists on the client, and seeding the
  // form from it during render would make the client's markup disagree with the
  // server's wherever a draft value drives conditional UI.
  useEffect(() => {
    const draft = loadDraft();
    if (draft) {
      reset(draft);
      toast.info('Draft restored', 'Picking up where you left off.');
    }
  }, [reset]);

  const { fields, append, remove, replace } = useFieldArray({ control, name: 'physicalDocuments' });
  const values = watch();

  /* ------------------------------------------------------------------ */
  /* Data                                                                */
  /* ------------------------------------------------------------------ */

  // Server-side search: the picker must reach every registration, not the 25
  // rows that happen to be on page one.
  const registrationsQuery = useQuery({
    queryKey: ['registrations', 'enrollment-picker', debouncedStudentSearch],
    queryFn: () =>
      apiClient.registrations.list({
        search: debouncedStudentSearch,
        page_size: 50,
        ordering: '-created_at',
      }),
  });
  const registrations: Registration[] = toArray(registrationsQuery.data);

  // Every page is walked: a student already enrolled on page 3 must not be
  // offered again just because the first page did not mention them.
  const enrolledIdsQuery = useQuery({
    queryKey: ['enrollments', 'enrolled-student-ids'],
    queryFn: () => fetchAllPages<{ student: number }, number>('enrollments/', (row) => row.student),
  });

  const enrolledStudentIds = useMemo(
    () => new Set((enrolledIdsQuery.data ?? []).map((id) => String(id))),
    [enrolledIdsQuery.data],
  );

  const availableStudents = useMemo(
    () => registrations.filter((registration) => !enrolledStudentIds.has(String(registration.id))),
    [registrations, enrolledStudentIds],
  );

  const universitiesQuery = useQuery({
    queryKey: ['universities', 'enrollment-picker'],
    queryFn: () =>
      fetchAllPages<University, University>('universities/', (u) => u, { ordering: 'name' }, 200, 5),
  });
  const universitiesData = universitiesQuery.data;
  const universities: University[] = useMemo(() => universitiesData ?? [], [universitiesData]);

  const selectedStudent = useMemo(
    () => availableStudents.find((registration) => String(registration.id) === values.student),
    [availableStudents, values.student],
  );

  const selectedUniversity = useMemo(
    () => universities.find((university) => String(university.id) === values.university),
    [universities, values.university],
  );

  /**
   * The label shown on the receipt. Falls back to the free-text name so an
   * off-catalogue university still prints.
   */
  const universityLabel = selectedUniversity?.name ?? values.universityName.trim();

  const studentOptions = useMemo(
    () =>
      availableStudents.map((registration) => ({
        value: String(registration.id),
        label: registration.mobile
          ? `${registration.studentName} — ${registration.mobile}`
          : registration.studentName,
      })),
    [availableStudents],
  );

  const totalFees = toNumber(values.totalFees);
  const installmentsCount = Math.max(1, Math.round(toNumber(values.installmentsCount, 1)));
  const isSplit = installmentsCount > 1;
  /** What the server will use when the amount box is left blank. */
  const suggestedInstallment = isSplit ? Math.floor(totalFees / installmentsCount) : 0;
  const paymentAmount = toNumber(values.paymentAmount);

  /* ------------------------------------------------------------------ */
  /* Draft + leave guard                                                 */
  /* ------------------------------------------------------------------ */

  const isDirty = Boolean(values.student || values.programName || values.university || values.totalFees);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  const saveDraft = () => {
    try {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify(getValues()));
      toast.success('Draft saved', 'You can pick this up later on this device.');
    } catch {
      toast.error('Could not save the draft', 'Browser storage is unavailable or full.');
    }
  };

  const clearDraft = () => {
    try {
      window.localStorage.removeItem(DRAFT_KEY);
    } catch {
      // A draft we cannot clear is harmless — it fails the schema check or is
      // simply overwritten on the next save.
    }
  };

  const handleBack = () => {
    if (isDirty) {
      setShowLeaveModal(true);
    } else {
      window.history.back();
    }
  };

  /* ------------------------------------------------------------------ */
  /* Step handling                                                       */
  /* ------------------------------------------------------------------ */

  const handleStudentSelect = (studentId: string) => {
    setValue('student', studentId, { shouldValidate: true });
  };

  const handleUniversitySelect = (next: string) => {
    const value = next === 'none' ? '' : next;
    setValue('university', value);
    const picked = universities.find((university) => String(university.id) === value);
    if (picked) {
      setValue('universityName', picked.name);
      setValue('country', picked.country);
    } else if (value === '') {
      setValue('universityName', '');
    }
  };

  const completionPercentage = useMemo(() => {
    const checks = [
      Boolean(values.student),
      Boolean(values.programName),
      Boolean(values.university || values.universityName),
      Boolean(values.startDate),
      totalFees > 0,
      uploadedCount > 0 || fields.length > 0,
    ];
    return Math.round((checks.filter(Boolean).length / checks.length) * 100);
  }, [values.student, values.programName, values.university, values.universityName, values.startDate, totalFees, uploadedCount, fields.length]);

  const canProceed = (): boolean => {
    switch (currentStep) {
      case 1:
        return Boolean(values.student);
      case 2:
        return Boolean(values.programName.trim() && values.startDate);
      case 3:
        return totalFees > 0;
      case 4:
        return true;
      case 5:
        return values.recordPayment ? Boolean(values.paymentMethod) && paymentAmount > 0 : true;
      default:
        return false;
    }
  };

  const handleFormSubmit = (formValues: WizardFormValues) => {
    const isOther = formValues.university === OTHER_UNIVERSITY;
    const catalogueId = isOther || formValues.university === '' ? null : Number(formValues.university);
    const catalogueName = universities.find(
      (university) => String(university.id) === formValues.university,
    )?.name;

    const count = Math.max(1, Math.round(toNumber(formValues.installmentsCount, 1)));
    const amount = toNumber(formValues.installmentAmount);

    const enrollment: EnrollmentInput = {
      // `enrollment_no` is deliberately absent — the server allocates it.
      student: Number(formValues.student),
      program_name: formValues.programName.trim(),
      university: catalogueId,
      university_name: isOther ? formValues.universityName.trim() : (catalogueName ?? ''),
      country: formValues.country.trim(),
      start_date: formValues.startDate,
      duration_months: Math.round(toNumber(formValues.durationMonths, 12)),
      total_fees: toNumber(formValues.totalFees),
      commission_amount: toNumber(formValues.commissionAmount),
      status: 'Active',
    };

    // Only send the schedule fields when the fee is genuinely split; a count of
    // 1 would create a one-row schedule that means nothing.
    if (count > 1) {
      enrollment.installments_count = count;
      if (amount > 0) enrollment.installment_amount = amount;
    }

    const payment: EnrollmentPaymentDraft | null = formValues.recordPayment
      ? {
          amount: toNumber(formValues.paymentAmount),
          method: formValues.paymentMethod,
          date: formValues.paymentDate || (new Date().toISOString().split('T')[0] ?? ''),
          reference: composePaymentReference(formValues),
        }
      : null;

    const physicalDocuments = formValues.trackPhysicalDocuments
      ? formValues.physicalDocuments.filter((document) => document.name.trim() !== '')
      : [];

    clearDraft();
    onSubmit({
      enrollment,
      registrationId: Number(formValues.student),
      studentName: selectedStudent?.studentName ?? '',
      universityLabel,
      payment,
      physicalDocuments,
    });
  };

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
  /* ------------------------------------------------------------------ */

  return (
    <>
      <Card className="overflow-hidden border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-4 sm:px-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              onClick={handleBack}
              className="flex items-center gap-2 self-start text-sm font-medium text-slate-500 hover:text-slate-800"
            >
              <ArrowLeft size={16} /> Back
            </button>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={saveDraft}
                className="h-8 border-slate-300 text-xs"
              >
                <Save size={14} className="mr-1" /> Save draft
              </Button>
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium uppercase text-slate-500">Progress</span>
                <div className="h-2 w-24 overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full bg-teal-500 transition-all"
                    style={{ width: `${completionPercentage}%` }}
                  />
                </div>
                <span className="text-xs font-bold text-teal-600">{completionPercentage}%</span>
              </div>
            </div>
          </div>
        </div>

        {/* Step indicators */}
        <div className="border-b border-slate-100 bg-white px-2 py-4 sm:px-6">
          <ol className="flex items-center justify-between sm:justify-center">
            {STEPS.map((step, index) => (
              <li key={step.id} className="flex items-center">
                <div className="flex flex-col items-center">
                  <div
                    className={cn(
                      'flex h-9 w-9 items-center justify-center rounded-full text-sm font-medium transition-all sm:h-10 sm:w-10',
                      currentStep === step.id
                        ? 'bg-teal-600 text-white'
                        : currentStep > step.id
                          ? 'bg-teal-100 text-teal-600'
                          : 'bg-slate-100 text-slate-400',
                    )}
                    aria-current={currentStep === step.id ? 'step' : undefined}
                  >
                    {currentStep > step.id ? <Check size={18} /> : <step.icon size={18} />}
                  </div>
                  <span
                    className={cn(
                      'mt-1.5 text-[10px] font-medium uppercase tracking-wide',
                      currentStep === step.id ? 'text-teal-600' : 'text-slate-400',
                    )}
                  >
                    {step.name}
                  </span>
                </div>
                {index < STEPS.length - 1 && (
                  <div
                    className={cn(
                      'mx-1 h-0.5 w-4 sm:mx-2 sm:w-10',
                      currentStep > step.id ? 'bg-teal-500' : 'bg-slate-200',
                    )}
                  />
                )}
              </li>
            ))}
          </ol>
        </div>

        <form onSubmit={handleSubmit(handleFormSubmit)}>
          <div className="min-h-[340px] px-4 py-6 sm:px-6">
            {Boolean(error) && (
              <div className="mb-4">
                <ErrorBanner error={error} />
              </div>
            )}

            {/* Step 1 — Student */}
            {currentStep === 1 && (
              <div className="mx-auto max-w-lg space-y-5">
                <div>
                  <h3 className="text-lg font-semibold text-slate-800">Select student</h3>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Registered students who are not already enrolled.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label className="text-xs font-medium uppercase tracking-wide text-slate-600">
                    Search registrations
                  </Label>
                  <Input
                    value={studentSearch}
                    onChange={(event) => setStudentSearch(event.target.value)}
                    placeholder="Search by name, mobile or email…"
                    className="h-11 border-slate-200 bg-white"
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-xs font-medium uppercase tracking-wide text-slate-600">Student</Label>
                  {registrationsQuery.isLoading || enrolledIdsQuery.isLoading ? (
                    <div className="flex h-11 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-500">
                      <InlineSpinner /> Loading students…
                    </div>
                  ) : (
                    <SearchableSelect
                      options={studentOptions}
                      value={values.student}
                      onChange={handleStudentSelect}
                      placeholder={
                        studentOptions.length === 0 ? 'No students available' : 'Select a student…'
                      }
                      disabled={studentOptions.length === 0}
                    />
                  )}
                  {registrationsQuery.isError && (
                    <ErrorBanner error={registrationsQuery.error} />
                  )}
                  {enrolledIdsQuery.isError && (
                    <p className="text-xs text-amber-700">
                      Could not check which students are already enrolled — the list below may include
                      one.
                    </p>
                  )}
                  {errors.student && <p className="text-xs text-red-600">{errors.student.message}</p>}
                  {!registrationsQuery.isLoading && studentOptions.length === 0 && (
                    <p className="text-xs text-slate-500">
                      Every registration matching this search is already enrolled. Register the student
                      first, or refine the search.
                    </p>
                  )}
                </div>

                {selectedStudent && (
                  <div className="rounded-lg border border-purple-100 bg-purple-50 p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-purple-100 font-bold text-purple-600">
                        {selectedStudent.studentName.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-slate-800">
                          {selectedStudent.studentName}
                        </p>
                        <p className="truncate text-xs text-slate-500">
                          {selectedStudent.registrationNo}
                          {selectedStudent.mobile ? ` · ${selectedStudent.mobile}` : ''}
                        </p>
                      </div>
                    </div>
                    {selectedStudent.needsLoan && (
                      <p className="mt-3 text-xs text-amber-700">
                        This student has flagged that they need a loan.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Step 2 — Program */}
            {currentStep === 2 && (
              <div className="mx-auto max-w-lg space-y-5">
                <div>
                  <h3 className="text-lg font-semibold text-slate-800">Program details</h3>
                  <p className="mt-0.5 text-xs text-slate-500">Course, university and start date.</p>
                </div>

                <div className="space-y-2">
                  <Label className="text-xs font-medium uppercase tracking-wide text-slate-600">
                    University
                  </Label>
                  <div className="flex gap-2">
                    <div className="min-w-0 flex-1">
                      <Controller
                        name="university"
                        control={control}
                        render={({ field }) => (
                          <Select
                            value={field.value === '' ? 'none' : field.value}
                            onValueChange={handleUniversitySelect}
                          >
                            <SelectTrigger className="h-11 border-slate-200 bg-white focus:border-teal-500">
                              <SelectValue placeholder="Select university…" />
                            </SelectTrigger>
                            <SelectContent className="max-h-60">
                              <SelectItem value="none">Not set</SelectItem>
                              {universities.map((university) => (
                                <SelectItem key={university.id} value={String(university.id)}>
                                  {university.name} ({university.country})
                                </SelectItem>
                              ))}
                              <SelectItem value={OTHER_UNIVERSITY}>Other (not in the catalogue)</SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11 w-11 shrink-0 border-slate-200 p-0 text-teal-600 hover:border-teal-200 hover:bg-teal-50"
                      onClick={() => setIsAddUniOpen(true)}
                      aria-label="Add a new university"
                      title="Add a new university"
                    >
                      <Plus size={20} />
                    </Button>
                  </div>
                  {universitiesQuery.isError && (
                    <p className="text-xs text-amber-700">
                      Could not load the catalogue — choose “Other” and type the name.
                    </p>
                  )}
                </div>

                {values.university === OTHER_UNIVERSITY && (
                  <div className="space-y-2">
                    <Label className="text-xs font-medium uppercase tracking-wide text-slate-600">
                      University name
                    </Label>
                    <Input
                      {...register('universityName')}
                      placeholder="e.g. Kyrgyz State Medical Academy"
                      className="h-11 border-slate-200 bg-white"
                    />
                  </div>
                )}

                <div className="space-y-2">
                  <Label className="text-xs font-medium uppercase tracking-wide text-slate-600">
                    Program / course
                  </Label>
                  <Input
                    {...register('programName')}
                    placeholder="e.g. MBBS"
                    className="h-11 border-slate-200 bg-white focus:border-teal-500"
                  />
                  {errors.programName && (
                    <p className="text-xs text-red-600">{errors.programName.message}</p>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label className="text-xs font-medium uppercase tracking-wide text-slate-600">
                      Country
                    </Label>
                    <Input
                      {...register('country')}
                      placeholder="e.g. Kyrgyzstan"
                      className="h-11 border-slate-200 bg-white"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs font-medium uppercase tracking-wide text-slate-600">
                      Duration (months)
                    </Label>
                    <Input
                      inputMode="numeric"
                      {...register('durationMonths')}
                      placeholder="12"
                      className="h-11 border-slate-200 bg-white"
                    />
                    {errors.durationMonths && (
                      <p className="text-xs text-red-600">{errors.durationMonths.message}</p>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-xs font-medium uppercase tracking-wide text-slate-600">
                    Start date
                  </Label>
                  <Input
                    type="date"
                    {...register('startDate')}
                    className="h-11 border-slate-200 bg-white focus:border-teal-500"
                  />
                  {errors.startDate && <p className="text-xs text-red-600">{errors.startDate.message}</p>}
                </div>
              </div>
            )}

            {/* Step 3 — Fees */}
            {currentStep === 3 && (
              <div className="mx-auto max-w-lg space-y-5">
                <div>
                  <h3 className="text-lg font-semibold text-slate-800">Fees</h3>
                  <p className="mt-0.5 text-xs text-slate-500">
                    What the student owes, and what the consultancy earns on it.
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label className="text-xs font-medium uppercase tracking-wide text-slate-600">
                      Total fees
                    </Label>
                    <Input
                      inputMode="decimal"
                      {...register('totalFees')}
                      placeholder="0"
                      className="h-11 border-slate-200 bg-white focus:border-teal-500"
                    />
                    {errors.totalFees && <p className="text-xs text-red-600">{errors.totalFees.message}</p>}
                  </div>
                  <div className="space-y-2">
                    {/* Formerly "service charge" — the same live field, renamed. */}
                    <Label className="text-xs font-medium uppercase tracking-wide text-slate-600">
                      Service charge (commission)
                    </Label>
                    <Input
                      inputMode="decimal"
                      {...register('commissionAmount')}
                      placeholder="0"
                      className="h-11 border-slate-200 bg-white focus:border-teal-500"
                    />
                    {errors.commissionAmount && (
                      <p className="text-xs text-red-600">{errors.commissionAmount.message}</p>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-green-100 bg-green-50 p-4">
                  <span className="text-sm font-medium text-green-700">Total fees</span>
                  <span className="text-2xl font-bold text-green-700">{formatCurrency(totalFees)}</span>
                </div>

                {totalFees <= 0 && (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                    <p className="text-xs text-amber-700">
                      Enter the total fee to continue — the payment schedule is derived from it.
                    </p>
                  </div>
                )}

                <p className="text-xs text-slate-500">
                  A single total is stored. The old tuition / hostel split had no column on the server
                  and was discarded on save, so it is not collected here.
                </p>
              </div>
            )}

            {/* Step 4 — Documents */}
            {currentStep === 4 && (
              <div className="mx-auto max-w-3xl space-y-6">
                <div className="text-center">
                  <h3 className="text-xl font-semibold text-slate-800">Documents</h3>
                  <p className="mt-1 text-sm text-slate-500">Upload scans, and log any originals taken.</p>
                </div>

                <Card className="overflow-hidden border-slate-200">
                  <div className="border-b border-slate-200 bg-gradient-to-r from-teal-50 to-cyan-50 px-4 py-3 sm:px-5">
                    <div className="flex items-center gap-2">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-teal-600">
                        <FileText className="h-4 w-4 text-white" />
                      </div>
                      <div className="min-w-0">
                        <h4 className="text-sm font-semibold text-slate-800">Digital uploads</h4>
                        <p className="text-xs text-slate-500">Scans are stored against the student.</p>
                      </div>
                    </div>
                  </div>
                  <div className="p-4 sm:p-5">
                    {selectedStudent ? (
                      <DocumentUpload
                        studentName={selectedStudent.studentName}
                        variant="minimal"
                        onUploaded={(uploaded) => {
                          setUploadedCount((previous) => previous + uploaded.length);
                          void queryClient.invalidateQueries({ queryKey: ['documents'] });
                        }}
                      />
                    ) : (
                      <p className="text-sm text-slate-500">Select a student first to upload scans.</p>
                    )}
                  </div>
                </Card>

                <Card className="overflow-hidden border-slate-200">
                  <div className="border-b border-slate-200 bg-gradient-to-r from-purple-50 to-pink-50 px-4 py-3 sm:px-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-purple-600">
                          <FileText className="h-4 w-4 text-white" />
                        </div>
                        <div className="min-w-0">
                          <h4 className="text-sm font-semibold text-slate-800">Physical documents</h4>
                          <p className="text-xs text-slate-500">Originals the office is taking custody of.</p>
                        </div>
                      </div>
                      <Controller
                        control={control}
                        name="trackPhysicalDocuments"
                        render={({ field }) => (
                          <div className="flex items-center gap-2">
                            <Checkbox
                              id="track-physical-docs"
                              checked={field.value}
                              onCheckedChange={(checked) => {
                                const enabled = checked === true;
                                field.onChange(enabled);
                                if (enabled && fields.length === 0) append(EMPTY_DOCUMENT);
                                if (!enabled) replace([]);
                              }}
                              className="data-[state=checked]:border-purple-600 data-[state=checked]:bg-purple-600"
                            />
                            <Label htmlFor="track-physical-docs" className="cursor-pointer text-sm">
                              Enable
                            </Label>
                          </div>
                        )}
                      />
                    </div>
                  </div>

                  {values.trackPhysicalDocuments ? (
                    <div className="space-y-3 p-4 sm:p-5">
                      {fields.map((field, index) => (
                        <div
                          key={field.id}
                          className="rounded-lg border border-slate-200 bg-slate-50 p-3 transition-colors hover:border-purple-300 sm:p-4"
                        >
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
                            <div className="sm:col-span-4">
                              <Label className="mb-1.5 block text-xs text-slate-600">Document name</Label>
                              <Input
                                list={`common-documents-${index}`}
                                {...register(`physicalDocuments.${index}.name`)}
                                placeholder="e.g. Class 10 Marksheet"
                                className="h-9 border-slate-300 bg-white text-sm"
                              />
                              <datalist id={`common-documents-${index}`}>
                                {COMMON_DOCUMENTS.map((document) => (
                                  <option key={document} value={document} />
                                ))}
                              </datalist>
                            </div>
                            <div className="sm:col-span-3">
                              <Label className="mb-1.5 block text-xs text-slate-600">Document number</Label>
                              <Input
                                {...register(`physicalDocuments.${index}.documentNumber`)}
                                placeholder="Optional"
                                className="h-9 border-slate-300 bg-white text-sm"
                              />
                            </div>
                            <div className="sm:col-span-4">
                              <Label className="mb-1.5 block text-xs text-slate-600">Remarks</Label>
                              <Input
                                {...register(`physicalDocuments.${index}.remarks`)}
                                placeholder="Condition or notes"
                                className="h-9 border-slate-300 bg-white text-sm"
                              />
                            </div>
                            <div className="flex items-end sm:col-span-1 sm:justify-center">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => remove(index)}
                                className="h-9 w-9 p-0 text-slate-400 hover:bg-red-50 hover:text-red-600"
                                aria-label={`Remove document ${index + 1}`}
                              >
                                <Trash2 size={16} />
                              </Button>
                            </div>
                          </div>
                        </div>
                      ))}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => append(EMPTY_DOCUMENT)}
                        className="w-full border-purple-200 text-purple-600 hover:bg-purple-50"
                      >
                        <Plus size={16} className="mr-2" /> Add another document
                      </Button>
                      <p className="text-xs text-slate-500">
                        Rows with no name are ignored. Each saved row is recorded as “Received”.
                      </p>
                    </div>
                  ) : (
                    <div className="px-4 pb-5 pt-2 sm:px-5">
                      <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-center">
                        <p className="text-sm text-slate-500">
                          Enable physical document tracking to log originals.
                        </p>
                      </div>
                    </div>
                  )}
                </Card>
              </div>
            )}

            {/* Step 5 — Payment */}
            {currentStep === 5 && (
              <div className="mx-auto max-w-2xl space-y-5">
                <div>
                  <h3 className="text-lg font-semibold text-slate-800">Payment</h3>
                  <p className="mt-0.5 text-xs text-slate-500">
                    How the fee is split, and what was collected today.
                  </p>
                </div>

                <div className="space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <h4 className="text-sm font-medium text-slate-700">Payment plan</h4>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label className="text-xs text-slate-600">Number of installments</Label>
                      <Input
                        inputMode="numeric"
                        {...register('installmentsCount')}
                        placeholder="1"
                        className="h-10 border-slate-200 bg-white"
                      />
                      {errors.installmentsCount && (
                        <p className="text-xs text-red-600">{errors.installmentsCount.message}</p>
                      )}
                      <p className="text-xs text-slate-500">1 means a single payment.</p>
                    </div>
                    {isSplit && (
                      <div className="space-y-2">
                        <Label className="text-xs text-slate-600">Amount per installment</Label>
                        <Input
                          inputMode="decimal"
                          {...register('installmentAmount')}
                          placeholder={String(suggestedInstallment)}
                          className="h-10 border-slate-200 bg-white"
                        />
                        {errors.installmentAmount && (
                          <p className="text-xs text-red-600">{errors.installmentAmount.message}</p>
                        )}
                      </div>
                    )}
                  </div>
                  {isSplit && (
                    <p className="text-xs text-slate-500">
                      The server builds {installmentsCount} rows summing exactly to{' '}
                      {formatCurrency(totalFees)}; the last one absorbs any rounding remainder.
                    </p>
                  )}
                </div>

                <Controller
                  control={control}
                  name="recordPayment"
                  render={({ field }) => (
                    <div className="flex items-start gap-2">
                      <Checkbox
                        id="record-payment"
                        checked={field.value}
                        onCheckedChange={(checked) => field.onChange(checked === true)}
                        className="mt-0.5"
                      />
                      <Label htmlFor="record-payment" className="cursor-pointer text-sm text-slate-700">
                        Record a payment collected today
                      </Label>
                    </div>
                  )}
                />

                {values.recordPayment && (
                  <div className="space-y-5">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                      <div className="space-y-2">
                        <Label className="text-xs font-medium uppercase tracking-wide text-slate-600">
                          Method *
                        </Label>
                        <Controller
                          name="paymentMethod"
                          control={control}
                          render={({ field }) => (
                            <Select value={field.value} onValueChange={field.onChange}>
                              <SelectTrigger className="h-11 border-slate-200 bg-white focus:border-teal-500">
                                <SelectValue placeholder="Select method" />
                              </SelectTrigger>
                              <SelectContent>
                                {PAYMENT_METHODS.map((method) => (
                                  <SelectItem key={method} value={method}>
                                    {method}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs font-medium uppercase tracking-wide text-slate-600">
                          Amount received *
                        </Label>
                        <Input
                          inputMode="decimal"
                          {...register('paymentAmount')}
                          placeholder="0"
                          className="h-11 border-slate-200 bg-white"
                        />
                        {errors.paymentAmount && (
                          <p className="text-xs text-red-600">{errors.paymentAmount.message}</p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs font-medium uppercase tracking-wide text-slate-600">
                          Date
                        </Label>
                        <Input
                          type="date"
                          {...register('paymentDate')}
                          className="h-11 border-slate-200 bg-white"
                        />
                      </div>
                    </div>

                    {!values.paymentMethod && (
                      <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                        <p className="text-xs text-amber-700">
                          Choose a payment method, or untick “Record a payment” to enroll without one.
                        </p>
                      </div>
                    )}

                    {values.paymentMethod === 'Card' && (
                      <div className="space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
                        <h4 className="flex items-center gap-2 text-sm font-medium text-slate-700">
                          <CreditCard size={16} /> Card details
                        </h4>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                          <div className="space-y-2">
                            <Label className="text-xs text-slate-600">Reference / receipt no.</Label>
                            <Input
                              {...register('paymentReference')}
                              placeholder="e.g. REC-001"
                              className="h-10 border-slate-200 bg-white"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs text-slate-600">Last 4 digits</Label>
                            <Input
                              {...register('cardLast4')}
                              placeholder="XXXX"
                              maxLength={4}
                              inputMode="numeric"
                              className="h-10 border-slate-200 bg-white"
                            />
                            {errors.cardLast4 && (
                              <p className="text-xs text-red-600">{errors.cardLast4.message}</p>
                            )}
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs text-slate-600">Card network</Label>
                            <Controller
                              name="cardNetwork"
                              control={control}
                              render={({ field }) => (
                                <Select value={field.value} onValueChange={field.onChange}>
                                  <SelectTrigger className="h-10 border-slate-200 bg-white">
                                    <SelectValue placeholder="Select" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {CARD_NETWORKS.map((network) => (
                                      <SelectItem key={network} value={network}>
                                        {network}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              )}
                            />
                          </div>
                        </div>
                      </div>
                    )}

                    {values.paymentMethod === 'UPI' && (
                      <div className="space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
                        <h4 className="text-sm font-medium text-slate-700">UPI details</h4>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                          <div className="space-y-2">
                            <Label className="text-xs text-slate-600">Transaction ID</Label>
                            <Input
                              {...register('paymentReference')}
                              placeholder="e.g. 123456789012"
                              className="h-10 border-slate-200 bg-white"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs text-slate-600">UPI ID</Label>
                            <Input
                              {...register('upiId')}
                              placeholder="e.g. user@upi"
                              className="h-10 border-slate-200 bg-white"
                            />
                          </div>
                        </div>
                      </div>
                    )}

                    {values.paymentMethod === 'Bank Transfer' && (
                      <div className="space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
                        <h4 className="text-sm font-medium text-slate-700">Bank transfer details</h4>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                          <div className="space-y-2">
                            <Label className="text-xs text-slate-600">Reference number</Label>
                            <Input
                              {...register('paymentReference')}
                              placeholder="e.g. REF123456"
                              className="h-10 border-slate-200 bg-white"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs text-slate-600">Bank name</Label>
                            <Input
                              {...register('bankName')}
                              placeholder="e.g. HDFC Bank"
                              className="h-10 border-slate-200 bg-white"
                            />
                          </div>
                        </div>
                      </div>
                    )}

                    {values.paymentMethod === 'Cheque' && (
                      <div className="space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
                        <h4 className="text-sm font-medium text-slate-700">Cheque details</h4>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                          <div className="space-y-2">
                            <Label className="text-xs text-slate-600">Cheque number</Label>
                            <Input
                              {...register('chequeNumber')}
                              placeholder="e.g. 123456"
                              className="h-10 border-slate-200 bg-white"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs text-slate-600">Bank name</Label>
                            <Input
                              {...register('bankName')}
                              placeholder="e.g. HDFC Bank"
                              className="h-10 border-slate-200 bg-white"
                            />
                          </div>
                        </div>
                      </div>
                    )}

                    {values.paymentMethod === 'Cash' && (
                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                        <div className="space-y-2">
                          <Label className="text-xs text-slate-600">Receipt no. (optional)</Label>
                          <Input
                            {...register('paymentReference')}
                            placeholder="e.g. CASH-001"
                            className="h-10 border-slate-200 bg-white"
                          />
                        </div>
                      </div>
                    )}

                    {paymentAmount > totalFees && totalFees > 0 && (
                      <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                        <p className="text-xs text-amber-700">
                          The amount received is more than the total fee of {formatCurrency(totalFees)}.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-4 py-4 sm:px-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => setCurrentStep((step) => Math.max(1, step - 1))}
              disabled={currentStep === 1}
              className="h-10 border-slate-200 px-4 text-slate-600 sm:px-5"
            >
              <ArrowLeft size={16} className="sm:mr-2" />
              <span className="hidden sm:inline">Previous</span>
            </Button>

            {currentStep < LAST_STEP ? (
              <Button
                type="button"
                onClick={() => setCurrentStep((step) => Math.min(LAST_STEP, step + 1))}
                disabled={!canProceed()}
                className="h-10 bg-teal-600 px-4 text-white hover:bg-teal-700 sm:px-6"
              >
                Continue <ArrowRight size={16} className="ml-2" />
              </Button>
            ) : (
              <Button
                type="submit"
                disabled={isLoading || !canProceed()}
                className="h-10 min-w-[140px] bg-teal-600 px-4 text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50 sm:px-6"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating…
                  </>
                ) : (
                  'Create enrollment'
                )}
              </Button>
            )}
          </div>
        </form>
      </Card>

      <Dialog open={showLeaveModal} onOpenChange={setShowLeaveModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="mb-2 flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100">
                <AlertTriangle className="h-5 w-5 text-amber-600" />
              </div>
              <DialogTitle className="text-lg font-semibold text-slate-800">Unsaved changes</DialogTitle>
            </div>
            <DialogDescription className="text-slate-500">
              This enrollment has not been created yet. Save it as a draft before leaving?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 flex flex-col gap-2 sm:flex-row">
            <Button
              variant="outline"
              onClick={() => setShowLeaveModal(false)}
              className="flex-1 border-slate-200"
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setShowLeaveModal(false);
                clearDraft();
                window.history.back();
              }}
              className="flex-1 border-red-200 text-red-600 hover:bg-red-50"
            >
              Discard &amp; leave
            </Button>
            <Button
              onClick={() => {
                saveDraft();
                setShowLeaveModal(false);
                window.history.back();
              }}
              className="flex-1 bg-teal-600 text-white hover:bg-teal-700"
            >
              <Save size={16} className="mr-2" /> Save &amp; leave
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AddUniversityModal
        isOpen={isAddUniOpen}
        onClose={() => {
          setIsAddUniOpen(false);
          void queryClient.invalidateQueries({ queryKey: ['universities'] });
        }}
      />
    </>
  );
}
