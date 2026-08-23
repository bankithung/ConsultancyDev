'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useForm, useFieldArray, Controller, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import {
  ArrowLeft,
  BookOpen,
  Check,
  FileText,
  GraduationCap,
  Info,
  Loader2,
  Plus,
  Settings,
  Trash2,
  User,
  Users,
  Wand2,
} from 'lucide-react';
import { apiClient } from '@/lib/apiClient';
import { toArray } from '@/components/common/pagination';
import { ErrorBanner } from '@/components/common/states';
import { DocumentUpload } from '@/components/common/DocumentUpload';
import { ExistingDocumentsList } from '@/components/common/ExistingDocumentsList';
import {
  DocumentTakeover,
  type PhysicalDocumentDraft,
} from '@/components/common/DocumentTakeover';
import {
  INDIAN_STATES,
  SCHOOL_BOARDS,
  COURSES,
  CLASS_12_STREAMS,
  RELIGIONS,
  CASTES,
  GENDERS,
} from '@/lib/utils';
import type { Document } from '@/lib/types';
import type { ProfileDetail, RegistrationWrite } from './wire';

/* -------------------------------------------------------------------------- */
/* Schema                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Blank numeric inputs must become `undefined`, not `NaN` or `0` -- a blank
 * "Physics" box turning into a zero is a wrong mark that looks deliberate.
 */
const asOptionalNumber = (value: unknown): number | undefined => {
  if (value === '' || value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Same, but for a required amount: blank stays blank so zod can reject it. */
const asNumber = (value: unknown): number | undefined => asOptionalNumber(value);

const preferenceSchema = z.object({
  courseName: z.string().min(1, 'Required'),
  location: z.string().min(1, 'Required'),
  priority: z.number().min(1),
});

const physicalDocumentSchema = z.object({
  name: z.string(),
  document_number: z.string(),
  remarks: z.string(),
});

const registrationSchema = z.object({
  // --- Stored on Registration -------------------------------------------
  studentName: z.string().min(1, 'Required'),
  email: z.string().email('Enter a valid email'),
  mobile: z.string().min(10, 'Enter a valid mobile number'),
  dateOfBirth: z.string().min(1, 'Required'),
  fatherName: z.string().min(1, 'Required'),
  motherName: z.string().min(1, 'Required'),
  permanentAddress: z.string().min(1, 'Required'),
  registrationFee: z.number('Required').min(0, 'Cannot be negative'),
  paymentMethod: z.enum(['Cash', 'Card', 'UPI', 'Other']),
  paymentStatus: z.enum(['Paid', 'Pending', 'Partial']),
  needsLoan: z.boolean(),
  preferences: z.array(preferenceSchema).min(1, 'At least one preference required'),

  // --- Collected, but with no column on this backend ---------------------
  // Written to the student's remarks log instead. See `ProfileDetail`.
  gender: z.enum(['Male', 'Female', 'Other']).optional(),
  caste: z.string().optional(),
  religion: z.string().optional(),
  fatherOccupation: z.string().optional(),
  motherOccupation: z.string().optional(),
  fatherMobile: z.string().optional(),
  motherMobile: z.string().optional(),
  familyPlace: z.string().optional(),
  familyState: z.string().optional(),
  schoolName: z.string().optional(),
  schoolBoard: z.string().optional(),
  schoolPlace: z.string().optional(),
  schoolState: z.string().optional(),
  stream: z.string().optional(),
  class12PassingYear: z.string().optional(),
  class12Percentage: z.number().optional(),
  class10SchoolName: z.string().optional(),
  class10Board: z.string().optional(),
  class10Place: z.string().optional(),
  class10State: z.string().optional(),
  class10PassingYear: z.string().optional(),
  class10Percentage: z.number().optional(),
  physicsMarks: z.number().optional(),
  chemistryMarks: z.number().optional(),
  biologyMarks: z.number().optional(),
  mathsMarks: z.number().optional(),
  pcbPercentage: z.number().optional(),
  pcmPercentage: z.number().optional(),
  previousNeetMarks: z.number().optional(),
  presentNeetMarks: z.number().optional(),
  gapYear: z.boolean(),
  gapYearFrom: z.number().optional(),
  gapYearTo: z.number().optional(),
  collegeDropout: z.boolean(),

  // --- Written through their own endpoints after the registration exists --
  /** Scans already accepted by `documents/`. Uploaded as they are picked. */
  documents: z.array(z.custom<Document>()),
  /** Originals to take into custody via `student-documents/`. */
  student_documents: z.array(physicalDocumentSchema),
});

export type RegistrationFormValues = z.infer<typeof registrationSchema>;

/* -------------------------------------------------------------------------- */
/* Mapping out of the form                                                     */
/* -------------------------------------------------------------------------- */

/** The subset the API actually stores, in `RegistrationSerializer`'s names. */
export function toRegistrationWrite(
  values: RegistrationFormValues,
  enquiryId?: number | null,
): RegistrationWrite {
  return {
    student_name: values.studentName.trim(),
    mobile: values.mobile.trim(),
    email: values.email.trim(),
    date_of_birth: values.dateOfBirth || null,
    father_name: values.fatherName.trim(),
    mother_name: values.motherName.trim(),
    permanent_address: values.permanentAddress.trim(),
    needs_loan: values.needsLoan,
    payment_status: values.paymentStatus,
    payment_method: values.paymentMethod,
    registration_fee: values.registrationFee,
    preferences: values.preferences,
    enquiry: enquiryId ?? null,
  };
}

/** Everything the form collects that has nowhere to go on the model. */
export function toProfileDetail(values: RegistrationFormValues): ProfileDetail {
  return {
    gender: values.gender,
    caste: values.caste,
    religion: values.religion,
    fatherOccupation: values.fatherOccupation,
    motherOccupation: values.motherOccupation,
    fatherMobile: values.fatherMobile,
    motherMobile: values.motherMobile,
    familyPlace: values.familyPlace,
    familyState: values.familyState,
    schoolName: values.schoolName,
    schoolBoard: values.schoolBoard,
    schoolPlace: values.schoolPlace,
    schoolState: values.schoolState,
    stream: values.stream,
    class12PassingYear: values.class12PassingYear,
    class12Percentage: values.class12Percentage,
    class10SchoolName: values.class10SchoolName,
    class10Board: values.class10Board,
    class10Place: values.class10Place,
    class10State: values.class10State,
    class10PassingYear: values.class10PassingYear,
    class10Percentage: values.class10Percentage,
    physicsMarks: values.physicsMarks,
    chemistryMarks: values.chemistryMarks,
    biologyMarks: values.biologyMarks,
    mathsMarks: values.mathsMarks,
    pcbPercentage: values.pcbPercentage,
    pcmPercentage: values.pcmPercentage,
    previousNeetMarks: values.previousNeetMarks,
    presentNeetMarks: values.presentNeetMarks,
    gapYear: values.gapYear,
    gapYearFrom: values.gapYearFrom,
    gapYearTo: values.gapYearTo,
    collegeDropout: values.collegeDropout,
  };
}

export function emptyRegistrationValues(): RegistrationFormValues {
  return {
    studentName: '',
    email: '',
    mobile: '',
    dateOfBirth: '',
    fatherName: '',
    motherName: '',
    permanentAddress: '',
    registrationFee: 5000,
    paymentMethod: 'Cash',
    paymentStatus: 'Paid',
    needsLoan: false,
    preferences: [{ courseName: '', location: '', priority: 1 }],
    gapYear: false,
    collegeDropout: false,
    documents: [],
    student_documents: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Auto-fill                                                                   */
/* -------------------------------------------------------------------------- */

const SAMPLE_FIRST = ['Aarav', 'Diya', 'Ishaan', 'Meera', 'Rohan', 'Ananya', 'Kabir', 'Sara'];
const SAMPLE_LAST = ['Sharma', 'Nair', 'Patel', 'Reddy', 'Bose', 'Iyer', 'Khan', 'Gill'];
const SAMPLE_CITIES = ['Guwahati', 'Shillong', 'Kolkata', 'Pune', 'Jaipur', 'Kochi'];
const SAMPLE_OCCUPATIONS = ['Teacher', 'Govt. Servant', 'Business', 'Engineer', 'Homemaker'];

const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];
const between = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

/**
 * Plausible demo data for the Auto-fill button.
 *
 * Was `@/app/utils/generateRandomRegistration`, which does not exist in this
 * build. Inlined rather than dropped -- it is how the office demos the form.
 */
function generateRandomRegistration(): RegistrationFormValues {
  const first = pick(SAMPLE_FIRST);
  const last = pick(SAMPLE_LAST);
  const city = pick(SAMPLE_CITIES);
  const physics = between(55, 98);
  const chemistry = between(55, 98);
  const biology = between(55, 98);
  const maths = between(55, 98);

  return {
    ...emptyRegistrationValues(),
    studentName: `${first} ${last}`,
    email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
    mobile: `9${between(100000000, 999999999)}`,
    dateOfBirth: `${between(2003, 2007)}-0${between(1, 9)}-1${between(0, 9)}`,
    gender: pick(['Male', 'Female', 'Other'] as const),
    caste: pick(CASTES),
    religion: pick(RELIGIONS),
    fatherName: `${pick(SAMPLE_FIRST)} ${last}`,
    motherName: `${pick(SAMPLE_FIRST)} ${last}`,
    fatherOccupation: pick(SAMPLE_OCCUPATIONS),
    motherOccupation: pick(SAMPLE_OCCUPATIONS),
    fatherMobile: `9${between(100000000, 999999999)}`,
    motherMobile: `9${between(100000000, 999999999)}`,
    permanentAddress: `${between(1, 90)} Main Road, ${city}`,
    familyPlace: city,
    familyState: pick(INDIAN_STATES),
    schoolName: `${city} Higher Secondary School`,
    schoolBoard: pick(SCHOOL_BOARDS),
    schoolPlace: city,
    schoolState: pick(INDIAN_STATES),
    stream: pick(CLASS_12_STREAMS),
    class12PassingYear: String(between(2021, 2025)),
    class12Percentage: between(60, 96),
    class10SchoolName: `${city} Public School`,
    class10Board: pick(SCHOOL_BOARDS),
    class10Place: city,
    class10State: pick(INDIAN_STATES),
    class10PassingYear: String(between(2019, 2023)),
    class10Percentage: between(60, 96),
    physicsMarks: physics,
    chemistryMarks: chemistry,
    biologyMarks: biology,
    mathsMarks: maths,
    previousNeetMarks: between(200, 650),
    presentNeetMarks: between(200, 700),
    registrationFee: 5000,
    preferences: [
      { courseName: pick(COURSES), location: pick(SAMPLE_CITIES), priority: 1 },
      { courseName: pick(COURSES), location: pick(SAMPLE_CITIES), priority: 2 },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Section chrome                                                              */
/* -------------------------------------------------------------------------- */

const SECTIONS = [
  {
    id: 'personal-details',
    label: 'Student Details',
    icon: User,
    color: 'teal',
    fields: ['studentName', 'email', 'mobile', 'gender', 'dateOfBirth', 'caste', 'religion'],
  },
  {
    id: 'family-address',
    label: 'Family & Address',
    icon: Users,
    color: 'purple',
    fields: [
      'fatherName',
      'motherName',
      'fatherOccupation',
      'motherOccupation',
      'fatherMobile',
      'motherMobile',
      'permanentAddress',
      'familyPlace',
      'familyState',
    ],
  },
  {
    id: 'academic-profile',
    label: 'Academic Profile',
    icon: GraduationCap,
    color: 'blue',
    fields: [
      'schoolName',
      'schoolBoard',
      'class12PassingYear',
      'class12Percentage',
      'stream',
      'class10SchoolName',
      'class10Board',
      'class10PassingYear',
      'class10Percentage',
      'collegeDropout',
      'gapYear',
    ],
  },
  {
    id: 'preferences-fees',
    label: 'Preferences & Fee',
    icon: Settings,
    color: 'orange',
    fields: ['preferences', 'registrationFee', 'paymentMethod', 'paymentStatus'],
  },
  {
    id: 'documents',
    label: 'Documents',
    icon: FileText,
    color: 'rose',
    fields: ['documents', 'student_documents'],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  icon: typeof User;
  color: string;
  fields: readonly (keyof RegistrationFormValues)[];
}>;

function ProgressRing({
  progress,
  size = 32,
  strokeWidth = 3,
  color = 'teal',
}: {
  progress: number;
  size?: number;
  strokeWidth?: number;
  color?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (progress / 100) * circumference;
  const isComplete = progress === 100;

  const colorClasses: Record<string, string> = {
    teal: 'stroke-teal-500',
    purple: 'stroke-purple-500',
    blue: 'stroke-blue-500',
    orange: 'stroke-orange-500',
    rose: 'stroke-rose-500',
  };

  const bgClasses: Record<string, string> = {
    teal: 'bg-teal-500',
    purple: 'bg-purple-500',
    blue: 'bg-blue-500',
    orange: 'bg-orange-500',
    rose: 'bg-rose-500',
  };

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      {isComplete ? (
        <div
          className={`flex h-full w-full items-center justify-center rounded-full ${bgClasses[color] || 'bg-teal-500'}`}
        >
          <Check size={size * 0.5} className="text-white" />
        </div>
      ) : (
        <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#e2e8f0" strokeWidth={strokeWidth} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            className={colorClasses[color] || 'stroke-teal-500'}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            style={{ transition: 'stroke-dashoffset 0.3s ease' }}
          />
        </svg>
      )}
      {!isComplete && (
        <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-slate-600">
          {Math.round(progress)}%
        </span>
      )}
    </div>
  );
}

function FormNavigation({
  sectionProgress,
  scrollToSection,
}: {
  sectionProgress: Record<string, number>;
  scrollToSection: (id: string) => void;
}) {
  return (
    <div className="fixed right-8 top-1/2 z-30 hidden w-52 -translate-y-1/2 flex-col gap-2 rounded-xl border border-slate-200 bg-white/95 p-4 shadow-lg backdrop-blur-sm xl:flex">
      <h4 className="mb-2 px-1 text-xs font-bold uppercase tracking-wider text-slate-500">Sections</h4>
      {SECTIONS.map((section) => {
        const progress = sectionProgress[section.id] || 0;
        const isComplete = progress === 100;
        const Icon = section.icon;
        return (
          <button
            key={section.id}
            type="button"
            onClick={() => scrollToSection(section.id)}
            className={`flex items-center gap-3 rounded-lg border p-2.5 text-left transition-all hover:bg-slate-50 ${
              isComplete ? 'border-green-200 bg-green-50/50' : 'border-transparent'
            }`}
          >
            <ProgressRing progress={progress} size={28} strokeWidth={2.5} color={section.color} />
            <div className="min-w-0 flex-1">
              <p className={`truncate text-sm font-medium ${isComplete ? 'text-green-700' : 'text-slate-700'}`}>
                {section.label}
              </p>
              {isComplete && <p className="text-[10px] font-medium text-green-600">Complete</p>}
            </div>
            <Icon size={14} className="shrink-0 text-slate-300" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

/**
 * Marks a block whose values are kept as a remark rather than as columns.
 *
 * Shown rather than left implicit: the counsellor should know before typing
 * that these will not come back into the form, and will not be filterable.
 */
function NotStoredNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      <Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">{children}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Form                                                                        */
/* -------------------------------------------------------------------------- */

export interface RegistrationFormProps {
  onSubmit: (data: RegistrationFormValues) => void;
  isLoading: boolean;
  /** Enquiry to pre-fill from, when converting one. */
  enquiryId?: string | null;
  initialData?: Partial<RegistrationFormValues> & { id?: string; registrationNo?: string };
  isEdit?: boolean;
  /** Surfaced above the submit button so a failed save is not silent. */
  submitError?: unknown;
}

/** Registration fields holding a number that an enquiry can pre-fill. */
type NumericPrefillField =
  | 'class12Percentage'
  | 'class10Percentage'
  | 'physicsMarks'
  | 'chemistryMarks'
  | 'biologyMarks'
  | 'mathsMarks'
  | 'pcbPercentage'
  | 'pcmPercentage'
  | 'previousNeetMarks'
  | 'presentNeetMarks'
  | 'gapYearFrom'
  | 'gapYearTo';

/**
 * DRF serialises DecimalField as a string, so an enquiry's marks and
 * percentages arrive as `string | number` while the registration schema wants
 * a plain number. Returns undefined for anything unparseable, so a junk value
 * leaves the form default alone instead of writing NaN into the field.
 */
const toNumber = (value: string | number | null | undefined): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export function RegistrationForm({
  onSubmit,
  isLoading,
  enquiryId,
  initialData,
  isEdit = false,
  submitError,
}: RegistrationFormProps) {
  const [prefillError, setPrefillError] = useState<string | null>(null);

  const {
    register,
    control,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<RegistrationFormValues>({
    resolver: zodResolver(registrationSchema),
    defaultValues: { ...emptyRegistrationValues(), ...initialData },
  });

  const { fields, append, remove, replace } = useFieldArray({ control, name: 'preferences' });

  const physicsMarks = watch('physicsMarks');
  const chemistryMarks = watch('chemistryMarks');
  const biologyMarks = watch('biologyMarks');
  const mathsMarks = watch('mathsMarks');
  const gapYear = watch('gapYear');
  const studentName = watch('studentName');
  const formValues = watch();

  // PCB / PCM are averages of the three relevant subjects, recomputed whenever
  // a mark changes so the read-only boxes never disagree with the inputs.
  useEffect(() => {
    const filled = (value: number | undefined): value is number =>
      typeof value === 'number' && Number.isFinite(value);

    if (filled(physicsMarks) && filled(chemistryMarks) && filled(biologyMarks)) {
      const pcb = (physicsMarks + chemistryMarks + biologyMarks) / 3;
      setValue('pcbPercentage', Number(pcb.toFixed(2)));
    }
    if (filled(physicsMarks) && filled(chemistryMarks) && filled(mathsMarks)) {
      const pcm = (physicsMarks + chemistryMarks + mathsMarks) / 3;
      setValue('pcmPercentage', Number(pcm.toFixed(2)));
    }
  }, [physicsMarks, chemistryMarks, biologyMarks, mathsMarks, setValue]);

  useEffect(() => {
    if (isEdit && initialData) {
      reset({ ...emptyRegistrationValues(), ...initialData });
    }
  }, [isEdit, initialData, reset]);

  const handleAutoFill = useCallback(() => {
    const sample = generateRandomRegistration();
    reset(sample, { keepDefaultValues: true });
  }, [reset]);

  /**
   * Pre-fill from the enquiry being converted.
   *
   * `EnquirySerializer` now returns the full academic and personal profile --
   * `date_of_birth`, `gender`, `caste`, `religion`, `family_*`, `school_*`,
   * `class10_*`, `class12_*`, the marks and the gap-year range all have real
   * columns. An earlier comment here claimed none of them existed and skipped
   * them; that left the converted registration blank on fields the counsellor
   * had already typed once, including the required date of birth.
   *
   * Each value is only written when the enquiry actually carries it, so a
   * missing field leaves the form default alone rather than clearing it.
   */
  useEffect(() => {
    if (!enquiryId) return;
    let cancelled = false;

    const prefill = async () => {
      try {
        const enquiry = await apiClient.enquiries.get(enquiryId);
        if (cancelled || !enquiry) return;

        setValue('studentName', enquiry.candidateName ?? '');
        setValue('email', enquiry.email ?? '');
        setValue('mobile', enquiry.mobile ?? '');
        setValue('fatherName', enquiry.fatherName ?? '');
        setValue('motherName', enquiry.motherName ?? '');
        setValue('permanentAddress', enquiry.permanentAddress ?? '');
        if (enquiry.fatherOccupation) setValue('fatherOccupation', enquiry.fatherOccupation);
        if (enquiry.motherOccupation) setValue('motherOccupation', enquiry.motherOccupation);
        if (enquiry.fatherMobile) setValue('fatherMobile', enquiry.fatherMobile);
        if (enquiry.motherMobile) setValue('motherMobile', enquiry.motherMobile);
        if (enquiry.schoolName) setValue('schoolName', enquiry.schoolName);
        if (enquiry.stream) setValue('stream', enquiry.stream);
        setValue('gapYear', Boolean(enquiry.gapYear));
        setValue('collegeDropout', Boolean(enquiry.collegeDropout));

        // Required on the registration, so leaving it blank blocked the save.
        if (enquiry.dateOfBirth) setValue('dateOfBirth', enquiry.dateOfBirth);

        if (enquiry.gender === 'Male' || enquiry.gender === 'Female' || enquiry.gender === 'Other') {
          setValue('gender', enquiry.gender);
        }
        if (enquiry.caste) setValue('caste', enquiry.caste);
        if (enquiry.religion) setValue('religion', enquiry.religion);
        if (enquiry.familyPlace) setValue('familyPlace', enquiry.familyPlace);
        if (enquiry.familyState) setValue('familyState', enquiry.familyState);

        if (enquiry.schoolBoard) setValue('schoolBoard', enquiry.schoolBoard);
        if (enquiry.schoolPlace) setValue('schoolPlace', enquiry.schoolPlace);
        if (enquiry.schoolState) setValue('schoolState', enquiry.schoolState);
        if (enquiry.class12PassingYear) setValue('class12PassingYear', enquiry.class12PassingYear);

        if (enquiry.class10SchoolName) setValue('class10SchoolName', enquiry.class10SchoolName);
        if (enquiry.class10Board) setValue('class10Board', enquiry.class10Board);
        if (enquiry.class10Place) setValue('class10Place', enquiry.class10Place);
        if (enquiry.class10State) setValue('class10State', enquiry.class10State);
        if (enquiry.class10PassingYear) setValue('class10PassingYear', enquiry.class10PassingYear);

        const numeric: ReadonlyArray<
          readonly [NumericPrefillField, string | number | null | undefined]
        > = [
          ['class12Percentage', enquiry.class12Percentage],
          ['class10Percentage', enquiry.class10Percentage],
          ['physicsMarks', enquiry.physicsMarks],
          ['chemistryMarks', enquiry.chemistryMarks],
          ['biologyMarks', enquiry.biologyMarks],
          ['mathsMarks', enquiry.mathsMarks],
          ['pcbPercentage', enquiry.pcbPercentage],
          ['pcmPercentage', enquiry.pcmPercentage],
          ['previousNeetMarks', enquiry.previousNeetMarks],
          ['presentNeetMarks', enquiry.presentNeetMarks],
          ['gapYearFrom', enquiry.gapYearFrom],
          ['gapYearTo', enquiry.gapYearTo],
        ];
        for (const [field, raw] of numeric) {
          const value = toNumber(raw);
          if (value !== undefined) setValue(field, value);
        }

        const locations = enquiry.preferredLocations ?? [];
        if (locations.length > 0 && enquiry.courseInterested) {
          replace(
            locations.map((location, index) => ({
              courseName: enquiry.courseInterested,
              location,
              priority: index + 1,
            })),
          );
        }

        // Scans already filed under this candidate's name, so the counsellor
        // can see what is on hand before asking for it again.
        const uploaded = toArray(
          await apiClient.documents.list({ search: enquiry.candidateName, page_size: 50 }),
        ).filter(
          (doc) => doc.studentName?.trim().toLowerCase() === enquiry.candidateName.trim().toLowerCase(),
        );
        if (!cancelled && uploaded.length > 0) setValue('documents', uploaded);
      } catch {
        if (!cancelled) {
          setPrefillError(
            'Could not load the enquiry to pre-fill from. You can still fill the form in by hand.',
          );
        }
      }
    };

    void prefill();
    return () => {
      cancelled = true;
    };
  }, [enquiryId, setValue, replace]);

  const handleFormSubmit: SubmitHandler<RegistrationFormValues> = (data) => {
    // "Delhi, Mumbai" in one location box is two preferences, not one.
    const preferences = data.preferences
      .flatMap((preference) =>
        preference.location.includes(',')
          ? preference.location
              .split(',')
              .map((location) => ({ ...preference, location: location.trim() }))
              .filter((entry) => entry.location !== '')
          : [preference],
      )
      .map((preference, index) => ({ ...preference, priority: index + 1 }));

    onSubmit({ ...data, preferences });
  };

  const sectionProgress = useMemo(() => {
    const progress: Record<string, number> = {};
    for (const section of SECTIONS) {
      const filled = section.fields.filter((field) => {
        const value = formValues[field];
        if (Array.isArray(value)) return value.length > 0;
        if (typeof value === 'number') return Number.isFinite(value);
        if (typeof value === 'boolean') return true;
        return typeof value === 'string' && value.trim() !== '';
      });
      progress[section.id] = Math.round((filled.length / section.fields.length) * 100);
    }
    return progress;
  }, [formValues]);

  const scrollToSection = useCallback((id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  /** `setValueAs` wrapper so blank numeric inputs stay undefined. */
  const optionalNumber = (name: keyof RegistrationFormValues) =>
    register(name, { setValueAs: asOptionalNumber });

  return (
    <>
      <div className="fixed right-8 top-24 z-40 hidden xl:block">
        <Button
          type="button"
          onClick={handleAutoFill}
          variant="outline"
          className="mb-4 w-52 gap-2 border-slate-200 bg-white/95 text-teal-600 shadow-sm backdrop-blur-sm hover:bg-teal-50 hover:text-teal-700"
        >
          <Wand2 size={16} />
          <span>Auto-fill Form</span>
        </Button>
      </div>
      <FormNavigation sectionProgress={sectionProgress} scrollToSection={scrollToSection} />

      <div className="relative mx-auto max-w-3xl space-y-6 pb-12">
        <form onSubmit={handleSubmit(handleFormSubmit)} className="space-y-8">
          <div className="mb-4 flex justify-end xl:hidden">
            <Button
              type="button"
              onClick={handleAutoFill}
              variant="outline"
              size="sm"
              className="gap-2 border-slate-200 bg-white text-teal-600"
            >
              <Wand2 size={14} />
              Auto-fill
            </Button>
          </div>

          {prefillError && <ErrorBanner error={prefillError} onDismiss={() => setPrefillError(null)} />}

          {/* 1. Student personal details ---------------------------------- */}
          <section
            id="personal-details"
            className="scroll-mt-24 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
          >
            <header className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/50 px-4 py-4 sm:px-6">
              <div className="flex min-w-0 items-center gap-3">
                <button
                  type="button"
                  onClick={() => window.history.back()}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
                  aria-label="Go back"
                >
                  <ArrowLeft size={18} />
                </button>
                <div className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-100 text-teal-700 sm:flex">
                  <User size={20} />
                </div>
                <div className="min-w-0">
                  <h3 className="font-heading text-base font-bold text-slate-800 sm:text-lg">Student Details</h3>
                  <p className="truncate text-sm text-slate-500">Personal information and contact</p>
                </div>
              </div>
              <ProgressRing progress={sectionProgress['personal-details'] || 0} size={36} color="teal" />
            </header>

            <div className="space-y-6 p-4 sm:p-6 md:p-8">
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="studentName" className="text-sm font-medium text-slate-700">Student Name</Label>
                  <Input id="studentName" {...register('studentName')} className="h-11 border-slate-300" placeholder="Full Name" />
                  {errors.studentName && <p className="text-sm text-red-500">{errors.studentName.message}</p>}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email" className="text-sm font-medium text-slate-700">Email Address</Label>
                  <Input id="email" type="email" {...register('email')} className="h-11 border-slate-300" placeholder="email@example.com" />
                  {errors.email && <p className="text-sm text-red-500">{errors.email.message}</p>}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mobile" className="text-sm font-medium text-slate-700">Mobile Number</Label>
                  <Input id="mobile" inputMode="tel" {...register('mobile')} className="h-11 border-slate-300" placeholder="+91" />
                  {errors.mobile && <p className="text-sm text-red-500">{errors.mobile.message}</p>}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="dateOfBirth" className="text-sm font-medium text-slate-700">Date of Birth</Label>
                  <Input id="dateOfBirth" type="date" {...register('dateOfBirth')} className="h-11 border-slate-300" />
                  {errors.dateOfBirth && <p className="text-sm text-red-500">{errors.dateOfBirth.message}</p>}
                </div>
              </div>

              <div className="space-y-4">
                <NotStoredNotice>
                  Gender, caste and religion have no field on the student record. They are saved to
                  the student&rsquo;s remarks log, so they stay on file but do not reload into this form.
                </NotStoredNotice>
                <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
                  <div className="space-y-2">
                    <Label className="text-sm font-medium text-slate-700">Gender</Label>
                    <Controller
                      name="gender"
                      control={control}
                      render={({ field }) => (
                        <Select onValueChange={field.onChange} value={field.value ?? ''}>
                          <SelectTrigger className="h-11 border-slate-300">
                            <SelectValue placeholder="Select Gender" />
                          </SelectTrigger>
                          <SelectContent>
                            {GENDERS.map((gender) => (
                              <SelectItem key={gender} value={gender}>{gender}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm font-medium text-slate-700">Caste</Label>
                    <Controller
                      name="caste"
                      control={control}
                      render={({ field }) => (
                        <Select onValueChange={field.onChange} value={field.value ?? ''}>
                          <SelectTrigger className="h-11 border-slate-300">
                            <SelectValue placeholder="Select Caste" />
                          </SelectTrigger>
                          <SelectContent>
                            {CASTES.map((caste) => (
                              <SelectItem key={caste} value={caste}>{caste}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm font-medium text-slate-700">Religion</Label>
                    <Controller
                      name="religion"
                      control={control}
                      render={({ field }) => (
                        <Select onValueChange={field.onChange} value={field.value ?? ''}>
                          <SelectTrigger className="h-11 border-slate-300">
                            <SelectValue placeholder="Select Religion" />
                          </SelectTrigger>
                          <SelectContent>
                            {RELIGIONS.map((religion) => (
                              <SelectItem key={religion} value={religion}>{religion}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* 2. Family & address ------------------------------------------ */}
          <section
            id="family-address"
            className="scroll-mt-24 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
          >
            <header className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/50 px-4 py-4 sm:px-6">
              <div className="flex min-w-0 items-center gap-3">
                <div className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-purple-100 text-purple-700 sm:flex">
                  <Users size={20} />
                </div>
                <div className="min-w-0">
                  <h3 className="font-heading text-base font-bold text-slate-800 sm:text-lg">Family &amp; Address</h3>
                  <p className="truncate text-sm text-slate-500">Guardian details</p>
                </div>
              </div>
              <ProgressRing progress={sectionProgress['family-address'] || 0} size={36} color="purple" />
            </header>

            <div className="space-y-6 p-4 sm:p-6 md:p-8">
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="fatherName" className="text-sm font-medium text-slate-700">Father&rsquo;s Name</Label>
                  <Input id="fatherName" {...register('fatherName')} className="h-11 border-slate-300" placeholder="Father's Full Name" />
                  {errors.fatherName && <p className="text-sm text-red-500">{errors.fatherName.message}</p>}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="motherName" className="text-sm font-medium text-slate-700">Mother&rsquo;s Name</Label>
                  <Input id="motherName" {...register('motherName')} className="h-11 border-slate-300" placeholder="Mother's Full Name" />
                  {errors.motherName && <p className="text-sm text-red-500">{errors.motherName.message}</p>}
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="permanentAddress" className="text-sm font-medium text-slate-700">Permanent Address</Label>
                  <Input id="permanentAddress" {...register('permanentAddress')} className="h-11 border-slate-300" placeholder="Full Permanent Address" />
                  {errors.permanentAddress && <p className="text-sm text-red-500">{errors.permanentAddress.message}</p>}
                </div>
              </div>

              <div className="space-y-4">
                <NotStoredNotice>
                  Occupations, parent mobiles and the family&rsquo;s city/state are kept in the
                  student&rsquo;s remarks log &mdash; the student record has no fields for them.
                </NotStoredNotice>
                <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="fatherOccupation" className="text-sm font-medium text-slate-700">Father&rsquo;s Occupation</Label>
                    <Input id="fatherOccupation" {...register('fatherOccupation')} className="h-11 border-slate-300" placeholder="e.g. Govt. Servant" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="motherOccupation" className="text-sm font-medium text-slate-700">Mother&rsquo;s Occupation</Label>
                    <Input id="motherOccupation" {...register('motherOccupation')} className="h-11 border-slate-300" placeholder="e.g. Homemaker" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="fatherMobile" className="text-sm font-medium text-slate-700">Father&rsquo;s Mobile</Label>
                    <Input id="fatherMobile" inputMode="tel" {...register('fatherMobile')} className="h-11 border-slate-300" placeholder="Father's Contact No" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="motherMobile" className="text-sm font-medium text-slate-700">Mother&rsquo;s Mobile</Label>
                    <Input id="motherMobile" inputMode="tel" {...register('motherMobile')} className="h-11 border-slate-300" placeholder="Mother's Contact No" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="familyPlace" className="text-sm font-medium text-slate-700">Family City/Place</Label>
                    <Input id="familyPlace" {...register('familyPlace')} className="h-11 border-slate-300" placeholder="City or Town" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm font-medium text-slate-700">Family State</Label>
                    <Controller
                      name="familyState"
                      control={control}
                      render={({ field }) => (
                        <Select onValueChange={field.onChange} value={field.value ?? ''}>
                          <SelectTrigger className="h-11 border-slate-300"><SelectValue placeholder="Select State" /></SelectTrigger>
                          <SelectContent className="max-h-60">
                            {INDIAN_STATES.map((state) => (
                              <SelectItem key={state} value={state}>{state}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* 3. Academic profile ------------------------------------------ */}
          <section
            id="academic-profile"
            className="scroll-mt-24 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
          >
            <header className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/50 px-4 py-4 sm:px-6">
              <div className="flex min-w-0 items-center gap-3">
                <div className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-100 text-blue-700 sm:flex">
                  <GraduationCap size={20} />
                </div>
                <div className="min-w-0">
                  <h3 className="font-heading text-base font-bold text-slate-800 sm:text-lg">Academic Profile</h3>
                  <p className="truncate text-sm text-slate-500">Education history and marks</p>
                </div>
              </div>
              <ProgressRing progress={sectionProgress['academic-profile'] || 0} size={36} color="blue" />
            </header>

            <div className="space-y-6 p-4 sm:p-6 md:p-8">
              <NotStoredNotice>
                The whole academic profile is written to the student&rsquo;s remarks log as one dated
                note. It cannot be filtered or reported on until the API gains real columns for it.
              </NotStoredNotice>

              <div className="mb-2 flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 shadow-sm">
                <Controller
                  name="collegeDropout"
                  control={control}
                  render={({ field }) => (
                    <Checkbox checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} id="collegeDropout" />
                  )}
                />
                <Label htmlFor="collegeDropout" className="cursor-pointer font-medium text-slate-700">
                  Student is a College Dropout?
                </Label>
              </div>

              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 sm:p-5">
                  <h4 className="mb-4 flex items-center gap-2 text-sm font-bold text-slate-800">
                    <span className="h-4 w-1 rounded-full bg-teal-500" />
                    HSLC (Class 10)
                  </h4>
                  <div className="grid grid-cols-1 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="class10SchoolName" className="text-xs text-slate-500">School Name</Label>
                      <Input id="class10SchoolName" {...register('class10SchoolName')} className="h-10 bg-white" placeholder="School Name" />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label className="text-xs text-slate-500">Board</Label>
                        <Controller
                          name="class10Board"
                          control={control}
                          render={({ field }) => (
                            <Select onValueChange={field.onChange} value={field.value ?? ''}>
                              <SelectTrigger className="h-10 bg-white"><SelectValue placeholder="Board" /></SelectTrigger>
                              <SelectContent>
                                {SCHOOL_BOARDS.map((board) => (
                                  <SelectItem key={board} value={board}>{board}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="class10PassingYear" className="text-xs text-slate-500">Passing Year</Label>
                        <Input id="class10PassingYear" {...register('class10PassingYear')} className="h-10 bg-white" placeholder="YYYY" />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="class10Percentage" className="text-xs text-slate-500">% / CGPA</Label>
                        <Input id="class10Percentage" type="number" step="0.01" {...optionalNumber('class10Percentage')} className="h-10 bg-white" placeholder="e.g. 85.50" />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="class10Place" className="text-xs text-slate-500">City/Place</Label>
                        <Input id="class10Place" {...register('class10Place')} className="h-10 bg-white" placeholder="City" />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-slate-500">State</Label>
                      <Controller
                        name="class10State"
                        control={control}
                        render={({ field }) => (
                          <Select onValueChange={field.onChange} value={field.value ?? ''}>
                            <SelectTrigger className="h-10 bg-white"><SelectValue placeholder="State" /></SelectTrigger>
                            <SelectContent className="max-h-60">
                              {INDIAN_STATES.map((state) => (
                                <SelectItem key={state} value={state}>{state}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      />
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border border-blue-100 bg-blue-50/50 p-4 sm:p-5">
                  <h4 className="mb-4 flex items-center gap-2 text-sm font-bold text-slate-800">
                    <span className="h-4 w-1 rounded-full bg-blue-500" />
                    HSSLC (Class 12)
                  </h4>
                  <div className="grid grid-cols-1 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="schoolName" className="text-xs text-slate-500">School Name</Label>
                      <Input id="schoolName" {...register('schoolName')} className="h-10 bg-white" placeholder="School Name" />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label className="text-xs text-slate-500">Board</Label>
                        <Controller
                          name="schoolBoard"
                          control={control}
                          render={({ field }) => (
                            <Select onValueChange={field.onChange} value={field.value ?? ''}>
                              <SelectTrigger className="h-10 bg-white"><SelectValue placeholder="Board" /></SelectTrigger>
                              <SelectContent>
                                {SCHOOL_BOARDS.map((board) => (
                                  <SelectItem key={board} value={board}>{board}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="class12PassingYear" className="text-xs text-slate-500">Passing Year</Label>
                        <Input id="class12PassingYear" {...register('class12PassingYear')} className="h-10 bg-white" placeholder="YYYY" />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="class12Percentage" className="text-xs text-slate-500">% / CGPA</Label>
                        <Input id="class12Percentage" type="number" step="0.01" {...optionalNumber('class12Percentage')} className="h-10 bg-white" placeholder="e.g. 85.50" />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="schoolPlace" className="text-xs text-slate-500">City/Place</Label>
                        <Input id="schoolPlace" {...register('schoolPlace')} className="h-10 bg-white" placeholder="City" />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-slate-500">State</Label>
                      <Controller
                        name="schoolState"
                        control={control}
                        render={({ field }) => (
                          <Select onValueChange={field.onChange} value={field.value ?? ''}>
                            <SelectTrigger className="h-10 bg-white"><SelectValue placeholder="State" /></SelectTrigger>
                            <SelectContent className="max-h-60">
                              {INDIAN_STATES.map((state) => (
                                <SelectItem key={state} value={state}>{state}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                  <BookOpen size={14} className="text-slate-400" aria-hidden="true" />
                  Stream (Class 12)
                </Label>
                <Controller
                  name="stream"
                  control={control}
                  render={({ field }) => (
                    <Select onValueChange={field.onChange} value={field.value ?? ''}>
                      <SelectTrigger className="h-11 border-slate-300"><SelectValue placeholder="Select Stream" /></SelectTrigger>
                      <SelectContent>
                        {CLASS_12_STREAMS.map((stream) => (
                          <SelectItem key={stream} value={stream}>{stream}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div className="space-y-2">
                  <Label htmlFor="physicsMarks" className="text-xs text-slate-500">Physics</Label>
                  <Input id="physicsMarks" type="number" {...optionalNumber('physicsMarks')} className="h-10" placeholder="Marks" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="chemistryMarks" className="text-xs text-slate-500">Chemistry</Label>
                  <Input id="chemistryMarks" type="number" {...optionalNumber('chemistryMarks')} className="h-10" placeholder="Marks" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="biologyMarks" className="text-xs text-slate-500">Biology</Label>
                  <Input id="biologyMarks" type="number" {...optionalNumber('biologyMarks')} className="h-10" placeholder="Marks" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mathsMarks" className="text-xs text-slate-500">Maths</Label>
                  <Input id="mathsMarks" type="number" {...optionalNumber('mathsMarks')} className="h-10" placeholder="Marks" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pcbPercentage" className="text-xs font-medium text-slate-500">PCB %</Label>
                  <Input id="pcbPercentage" type="number" step="0.01" {...optionalNumber('pcbPercentage')} className="h-10 bg-slate-50" readOnly />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pcmPercentage" className="text-xs font-medium text-slate-500">PCM %</Label>
                  <Input id="pcmPercentage" type="number" step="0.01" {...optionalNumber('pcmPercentage')} className="h-10 bg-slate-50" readOnly />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="previousNeetMarks" className="text-xs text-slate-500">Prev. NEET</Label>
                  <Input id="previousNeetMarks" type="number" {...optionalNumber('previousNeetMarks')} className="h-10" placeholder="Score" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="presentNeetMarks" className="text-xs text-slate-500">Cur. NEET</Label>
                  <Input id="presentNeetMarks" type="number" {...optionalNumber('presentNeetMarks')} className="h-10" placeholder="Score" />
                </div>
              </div>

              <div className="rounded-lg border border-yellow-100 bg-yellow-50/50 p-4">
                <div className="mb-4 flex items-center space-x-2">
                  <Controller
                    name="gapYear"
                    control={control}
                    render={({ field }) => (
                      <Checkbox checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} id="gapYear" />
                    )}
                  />
                  <Label htmlFor="gapYear" className="cursor-pointer font-medium text-slate-800">Has Gap Year?</Label>
                </div>
                {gapYear && (
                  <div className="grid grid-cols-2 gap-4 sm:pl-6">
                    <div className="space-y-2">
                      <Label htmlFor="gapYearFrom" className="text-xs text-slate-500">From Year</Label>
                      <Input id="gapYearFrom" type="number" {...optionalNumber('gapYearFrom')} className="h-10 bg-white" placeholder="YYYY" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="gapYearTo" className="text-xs text-slate-500">To Year</Label>
                      <Input id="gapYearTo" type="number" {...optionalNumber('gapYearTo')} className="h-10 bg-white" placeholder="YYYY" />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* 4. Preferences & fees ---------------------------------------- */}
          <section
            id="preferences-fees"
            className="scroll-mt-24 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
          >
            <header className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/50 px-4 py-4 sm:px-6">
              <div className="flex min-w-0 items-center gap-3">
                <div className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-orange-100 text-orange-700 sm:flex">
                  <Settings size={20} />
                </div>
                <div className="min-w-0">
                  <h3 className="font-heading text-base font-bold text-slate-800 sm:text-lg">Preferences &amp; Fees</h3>
                  <p className="truncate text-sm text-slate-500">Study preferences and payment</p>
                </div>
              </div>
              <ProgressRing progress={sectionProgress['preferences-fees'] || 0} size={36} color="orange" />
            </header>

            <div className="space-y-8 p-4 sm:p-6 md:p-8">
              <div>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <h3 className="text-base font-medium text-slate-900 sm:text-lg">Study Preferences</h3>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => append({ courseName: '', location: '', priority: fields.length + 1 })}
                    className="h-9 shrink-0 border-teal-200 text-teal-600 hover:bg-teal-50 hover:text-teal-700"
                  >
                    <Plus size={16} className="mr-2" /> Add
                  </Button>
                </div>

                <div className="space-y-3">
                  {fields.map((field, index) => (
                    <div
                      key={field.id}
                      className="grid grid-cols-1 items-end gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 md:grid-cols-12"
                    >
                      <div className="flex items-center gap-2 md:col-span-1 md:justify-center">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-200 font-mono text-xs font-bold text-slate-600">
                          {index + 1}
                        </span>
                        <span className="text-xs text-slate-500 md:hidden">Preference</span>
                      </div>
                      <div className="space-y-1 md:col-span-5">
                        <Label className="text-xs text-slate-500">Course</Label>
                        <Input {...register(`preferences.${index}.courseName`)} className="h-9 bg-white" placeholder="e.g. MBBS" />
                        {errors.preferences?.[index]?.courseName && (
                          <p className="text-xs text-red-500">{errors.preferences[index]?.courseName?.message}</p>
                        )}
                      </div>
                      <div className="space-y-1 md:col-span-5">
                        <Label className="text-xs text-slate-500">Location(s)</Label>
                        <Input {...register(`preferences.${index}.location`)} className="h-9 bg-white" placeholder="City or Country" />
                        {errors.preferences?.[index]?.location && (
                          <p className="text-xs text-red-500">{errors.preferences[index]?.location?.message}</p>
                        )}
                      </div>
                      <div className="flex justify-end md:col-span-1 md:justify-center md:pb-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove preference ${index + 1}`}
                          disabled={fields.length === 1}
                          onClick={() => remove(index)}
                          className="h-8 w-8 text-red-400 hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 size={16} />
                        </Button>
                      </div>
                    </div>
                  ))}
                  {errors.preferences?.message && (
                    <p className="px-1 text-sm text-red-500">{errors.preferences.message}</p>
                  )}
                </div>
              </div>

              <div className="border-t border-slate-100 pt-6">
                <h3 className="mb-4 text-base font-medium text-slate-900 sm:text-lg">Registration Details</h3>
                <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor="registrationFee" className="text-sm font-medium text-slate-700">Fee Amount</Label>
                    <Input
                      id="registrationFee"
                      type="number"
                      {...register('registrationFee', { setValueAs: asNumber })}
                      className="h-11 border-slate-300"
                      placeholder="e.g. 5000"
                    />
                    {errors.registrationFee && <p className="text-sm text-red-500">{errors.registrationFee.message}</p>}
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm font-medium text-slate-700">Payment Method</Label>
                    <Controller
                      name="paymentMethod"
                      control={control}
                      render={({ field }) => (
                        <Select onValueChange={field.onChange} value={field.value}>
                          <SelectTrigger className="h-11 border-slate-300"><SelectValue placeholder="Select Method" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="Cash">Cash</SelectItem>
                            <SelectItem value="Card">Card</SelectItem>
                            <SelectItem value="UPI">UPI</SelectItem>
                            <SelectItem value="Other">Other</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm font-medium text-slate-700">Payment Status</Label>
                    <Controller
                      name="paymentStatus"
                      control={control}
                      render={({ field }) => (
                        <Select onValueChange={field.onChange} value={field.value}>
                          <SelectTrigger className="h-11 border-slate-300"><SelectValue placeholder="Select Status" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="Paid">Paid</SelectItem>
                            <SelectItem value="Pending">Pending</SelectItem>
                            <SelectItem value="Partial">Partial</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    />
                    {/* Only the exact string 'Paid' makes the server book the
                        fee as a Success payment; anything else lands Pending. */}
                    <p className="text-xs text-slate-500">
                      Marking this <span className="font-medium">Paid</span> books the fee as a
                      successful payment. Any other value leaves it pending.
                    </p>
                  </div>
                  <div className="pt-2 md:col-span-3">
                    <div className="flex items-center space-x-2">
                      <Controller
                        name="needsLoan"
                        control={control}
                        render={({ field }) => (
                          <Checkbox checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} id="needsLoan" />
                        )}
                      />
                      <Label htmlFor="needsLoan" className="cursor-pointer font-medium">Student Needs Edu Loan Support</Label>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* 5. Documents -------------------------------------------------- */}
          <section
            id="documents"
            className="scroll-mt-24 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
          >
            <header className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/50 px-4 py-4 sm:px-6">
              <div className="flex min-w-0 items-center gap-3">
                <div className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-rose-100 text-rose-700 sm:flex">
                  <FileText size={20} />
                </div>
                <div className="min-w-0">
                  <h3 className="font-heading text-base font-bold text-slate-800 sm:text-lg">Documents</h3>
                  <p className="truncate text-sm text-slate-500">Scans to upload, and originals taken in</p>
                </div>
              </div>
              <ProgressRing progress={sectionProgress['documents'] || 0} size={36} color="rose" />
            </header>

            <div className="space-y-8 p-4 sm:p-6 md:p-8">
              <div className="space-y-3">
                <h4 className="text-sm font-bold text-slate-700">Digital copies</h4>
                <p className="text-xs text-slate-500">
                  Files upload as soon as you press Upload, so they survive even if this form is
                  abandoned. They are filed against the student&rsquo;s name.
                </p>
                {/*
                  Neither component takes `registrationNo`, deliberately:
                  DocumentSerializer exposes a `registration` FK and has no
                  `registration_no` field, so a registration number sent with an
                  upload is discarded by DRF without error. Passing it would
                  look like it linked the scan to a student when it did not.
                  Scans are filed and found by student NAME.
                */}
                <DocumentUpload
                  variant="minimal"
                  studentName={studentName || undefined}
                  onUploaded={(uploaded) => setValue('documents', [...watch('documents'), ...uploaded])}
                />
                {studentName && (
                  <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Already on file
                    </p>
                    <ExistingDocumentsList
                      studentName={studentName}
                      emptyMessage="Nothing uploaded for this student yet."
                    />
                  </div>
                )}
              </div>

              <div className="space-y-3 border-t border-slate-100 pt-6">
                <h4 className="text-sm font-bold text-slate-700">Original papers taken into custody</h4>
                <p className="text-xs text-slate-500">
                  Recorded against the student once the registration is saved, so the office can
                  answer &ldquo;who has my certificate&rdquo; later.
                </p>
                <Controller
                  name="student_documents"
                  control={control}
                  render={({ field }) => (
                    <DocumentTakeover
                      value={field.value as PhysicalDocumentDraft[]}
                      onChange={field.onChange}
                    />
                  )}
                />
              </div>
            </div>
          </section>

          {submitError ? <ErrorBanner error={submitError} /> : null}

          <div className="flex justify-end pt-4">
            <Button
              type="submit"
              disabled={isLoading}
              className="h-11 min-w-full bg-teal-600 text-base text-white shadow-sm hover:bg-teal-700 sm:min-w-[200px]"
            >
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {isEdit ? 'Updating…' : 'Creating…'}
                </>
              ) : isEdit ? (
                'Update Registration'
              ) : (
                'Create Registration'
              )}
            </Button>
          </div>
        </form>
      </div>
    </>
  );
}
