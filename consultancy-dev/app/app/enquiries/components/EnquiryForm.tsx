'use client';

import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { INDIAN_STATES, SCHOOL_BOARDS, COURSES, CLASS_12_STREAMS, CASTES, RELIGIONS } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { Enquiry } from '@/lib/types';
import { User, GraduationCap, Users, BookOpen, Phone, Mail, MapPin, Check, Settings, ArrowLeft, Wand2 } from 'lucide-react';
import { generateRandomEnquiry } from '@/app/utils/generateRandomEnquiry';
import { useEffect, useMemo, useCallback } from 'react';
import { ErrorBanner } from '@/components/common/states';
import { toast } from '@/store/toastStore';

/**
 * READ BEFORE ADDING A FIELD.
 *
 * Every field on this form now has a column behind it and is persisted — the
 * academic block included. That was not always true, and the failure mode was
 * silent: DRF ignores keys it does not recognise, so a save that dropped
 * two-thirds of the form still answered 200.
 *
 * So a new input here is only half the work. It needs, in order:
 *   1. a column on `Enquiry` in backend/core/models.py (+ migration),
 *   2. an entry in `EnquirySerializer.Meta.fields`,
 *   3. a line in `toEnquiryPayload` AND `mapEnquiry` in lib/apiClient.ts.
 *
 * Miss step 3 and the field will look like it works while storing nothing.
 */

const STANDARD_INPUT_STYLE = "h-11 bg-white border-slate-300 focus:border-teal-500 focus:ring-teal-500 rounded-md";
const BLUE_INPUT_STYLE = "h-11 bg-white border-blue-200 focus:border-blue-400 focus:ring-blue-400 rounded-md";

// Section configuration for progress tracking
const SECTIONS = [
  {
    id: 'student-details',
    label: 'Student Details',
    icon: User,
    color: 'teal',
    fields: ['date', 'candidateName', 'mobile', 'email', 'gender', 'dob', 'caste', 'religion'],
    requiredFields: ['date', 'candidateName', 'mobile', 'email'],
  },
  {
    id: 'family-address',
    label: 'Family & Address',
    icon: Users,
    color: 'purple',
    fields: ['fatherName', 'motherName', 'fatherOccupation', 'motherOccupation', 'fatherMobile', 'motherMobile', 'permanentAddress', 'familyPlace', 'familyState'],
    requiredFields: ['fatherName', 'motherName', 'permanentAddress'],
  },
  {
    id: 'academic-profile',
    label: 'Academic Profile',
    icon: GraduationCap,
    color: 'blue',
    fields: ['courseInterested', 'schoolName', 'stream', 'schoolBoard', 'class12PassingYear', 'class12Percentage', 'schoolPlace', 'schoolState', 'class10SchoolName', 'class10Board', 'class10PassingYear', 'class10Percentage', 'class10Place', 'class10State'],
    requiredFields: ['courseInterested', 'schoolName', 'stream'],
  },
  {
    id: 'preferences-payment',
    label: 'Preferences',
    icon: Settings,
    color: 'orange',
    fields: ['preferredLocations', 'otherLocation', 'paymentAmount'],
    requiredFields: [],
  },
];

/**
 * An optional number that treats "left blank" as absent.
 *
 * A bare `z.coerce.number().optional()` does not: an untouched number input
 * hands back `''`, `Number('')` is `0`, and the record ends up claiming the
 * candidate scored zero in physics. A mark of 0 is meaningful in this data, so
 * the two cannot be told apart afterwards — the distinction has to survive
 * validation.
 */
const optionalNumber = z.preprocess(
  (value) => (value === '' || value === null ? undefined : value),
  z.coerce.number().optional(),
);

const enquirySchema = z.object({
  date: z.string().min(1, "Date is required"),
  schoolName: z.string().min(1, "School Name is required"),
  stream: z.string().trim().min(1, 'Stream is required').max(50, 'Stream must be 50 characters or fewer'),
  candidateName: z.string().min(1, "Candidate Name is required"),
  courseInterested: z.string().min(1, "Course is required"),
  mobile: z.string().min(10, "Valid mobile number is required"),
  email: z.string().email("Valid email is required"),
  fatherName: z.string().min(1, "Father's Name is required"),
  motherName: z.string().min(1, "Mother's Name is required"),
  fatherOccupation: z.string().optional(),
  motherOccupation: z.string().optional(),
  fatherMobile: z.string().optional(),
  motherMobile: z.string().optional(),
  permanentAddress: z.string().min(1, "Address is required"),
  class12PassingYear: z.string().optional(),
  class10Percentage: optionalNumber,
  class12Percentage: optionalNumber,
  schoolBoard: z.string().optional(),
  schoolPlace: z.string().optional(),
  schoolState: z.string().optional(),
  class10SchoolName: z.string().optional(),
  class10Board: z.string().optional(),
  class10PassingYear: z.string().optional(),
  class10Place: z.string().optional(),
  class10State: z.string().optional(),
  familyPlace: z.string().optional(),
  familyState: z.string().optional(),
  gender: z.string().optional(),
  dob: z.string().optional(),
  caste: z.string().optional(),
  religion: z.string().optional(),
  gapYearFrom: optionalNumber,
  gapYearTo: optionalNumber,
  pcbPercentage: optionalNumber,
  pcmPercentage: optionalNumber,
  physicsMarks: optionalNumber,
  mathsMarks: optionalNumber,
  chemistryMarks: optionalNumber,
  biologyMarks: optionalNumber,
  previousNeetMarks: optionalNumber,
  presentNeetMarks: optionalNumber,
  gapYear: z.boolean().default(false),
  collegeDropout: z.boolean().default(false),
  preferredLocations: z.array(z.string()).optional(),
  otherLocation: z.string().optional(),
  paymentAmount: optionalNumber,
});

/**
 * The schema uses `z.coerce.number()` (number inputs hand back strings) and
 * `.default()`, so what the form HOLDS and what validation PRODUCES are two
 * different types. Naming both is what lets `useForm` type itself without a
 * suppression: react-hook-form's third generic is the transformed value handed
 * to `handleSubmit`.
 */
type EnquiryFormInput = z.input<typeof enquirySchema>;
type EnquiryFormValues = z.output<typeof enquirySchema>;

interface EnquiryFormProps {
  initialData?: Enquiry;
  onSubmit: (data: EnquiryFormValues) => void;
  isLoading: boolean;
  submitError?: unknown;
}

/** Coerced numeric fields arrive as `unknown`; render only real numbers. */
function numericDisplay(value: unknown): string {
  return typeof value === 'number' && !Number.isNaN(value) ? String(value) : '-';
}

// Progress Ring Component
function ProgressRing({ progress, size = 32, strokeWidth = 3, color = 'teal' }: { progress: number; size?: number; strokeWidth?: number; color?: string }) {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (progress / 100) * circumference;
  const isComplete = progress === 100;

  const colorClasses: Record<string, string> = {
    teal: 'stroke-teal-500',
    purple: 'stroke-purple-500',
    blue: 'stroke-blue-500',
    orange: 'stroke-orange-500',
  };

  const bgClasses: Record<string, string> = {
    teal: 'bg-teal-500',
    purple: 'bg-purple-500',
    blue: 'bg-blue-500',
    orange: 'bg-orange-500',
  };

  return (
    <div className="relative" style={{ width: size, height: size }}>
      {isComplete ? (
        <div className={`w-full h-full rounded-full ${bgClasses[color] || 'bg-teal-500'} flex items-center justify-center`}>
          <Check size={size * 0.5} className="text-white" />
        </div>
      ) : (
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#e2e8f0" strokeWidth={strokeWidth} />
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" className={colorClasses[color] || 'stroke-teal-500'} strokeWidth={strokeWidth} strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round" style={{ transition: 'stroke-dashoffset 0.3s ease' }} />
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

// Navigation Sidebar Component - Fixed on Right
function FormNavigation({ sectionProgress, scrollToSection }: { sectionProgress: Record<string, number>; scrollToSection: (id: string) => void }) {
  return (
    <div className="hidden xl:flex flex-col gap-2 fixed right-8 top-1/2 -translate-y-1/2 w-52 bg-white/95 backdrop-blur-sm p-4 rounded-xl shadow-lg border border-slate-200 z-30">
      <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 px-1">Sections</h4>
      {SECTIONS.map((section) => {
        const progress = sectionProgress[section.id] || 0;
        const isComplete = progress === 100;
        const Icon = section.icon;
        return (
          <button
            key={section.id}
            type="button"
            onClick={() => scrollToSection(section.id)}
            className={`flex items-center gap-3 p-2.5 rounded-lg text-left transition-all hover:bg-slate-50 border ${isComplete ? 'border-green-200 bg-green-50/50' : 'border-transparent'}`}
          >
            <ProgressRing progress={progress} size={28} strokeWidth={2.5} color={section.color} />
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-medium truncate ${isComplete ? 'text-green-700' : 'text-slate-700'}`}>{section.label}</p>
              {isComplete && <p className="text-[10px] text-green-600 font-medium">Complete</p>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function EnquiryForm({ initialData, onSubmit, isLoading, submitError }: EnquiryFormProps) {
  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors, submitCount },
  } = useForm<EnquiryFormInput, unknown, EnquiryFormValues>({
    resolver: zodResolver(enquirySchema),
    defaultValues: initialData ? {
      ...initialData,
      date: initialData.date ? new Date(initialData.date).toISOString().split('T')[0] : '',
      // The API returns this as `dateOfBirth`, but the input is registered as
      // `dob`, so the spread above never lands on it. Every other field in the
      // schema matches mapEnquiry's output by name -- this is the one rename.
      // Without this line a saved date of birth silently vanishes each time
      // the enquiry is reopened, and it looks like the save never worked.
      dob: initialData.dateOfBirth ?? '',
    } : {
      date: new Date().toISOString().split('T')[0],
      gapYear: false,
      collegeDropout: false,
      stream: 'Science',
    },
  });

  const formValues = watch();
  const selectedStream = watch('stream');
  const streamOptions = [...new Set([...CLASS_12_STREAMS, ...(initialData?.stream ? [initialData.stream] : [])])];
  const physicsMarks = watch('physicsMarks');
  const chemistryMarks = watch('chemistryMarks');
  const biologyMarks = watch('biologyMarks');
  const mathsMarks = watch('mathsMarks');

  // Calculate section progress
  const sectionProgress = useMemo(() => {
    const progress: Record<string, number> = {};
    SECTIONS.forEach((section) => {
      const filledFields = section.fields.filter((field) => {
        const value = formValues[field as keyof EnquiryFormInput];
        if (Array.isArray(value)) return value.length > 0;
        if (typeof value === 'number') return !isNaN(value) && value !== 0;
        return !!value && String(value).trim() !== '';
      });
      progress[section.id] = section.fields.length > 0 ? Math.round((filledFields.length / section.fields.length) * 100) : 0;
    });
    return progress;
  }, [formValues]);

  // Scroll to section
  const scrollToSection = useCallback((id: string) => {
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  // Auto-calculate percentages
  useEffect(() => {
    if (physicsMarks && chemistryMarks && biologyMarks) {
      const pcb = (Number(physicsMarks) + Number(chemistryMarks) + Number(biologyMarks)) / 3;
      setValue('pcbPercentage', parseFloat(pcb.toFixed(2)));
    } else {
      setValue('pcbPercentage', undefined);
    }
  }, [physicsMarks, chemistryMarks, biologyMarks, setValue]);

  useEffect(() => {
    if (physicsMarks && chemistryMarks && mathsMarks) {
      const pcm = (Number(physicsMarks) + Number(chemistryMarks) + Number(mathsMarks)) / 3;
      setValue('pcmPercentage', parseFloat(pcm.toFixed(2)));
    } else {
      setValue('pcmPercentage', undefined);
    }
  }, [physicsMarks, chemistryMarks, mathsMarks, setValue]);

  // `generateRandomEnquiry` returns every field in the schema, so resetting the
  // whole form is both simpler and type-safe — the previous per-key `setValue`
  // loop needed a `@ts-ignore` because the key/value pair could not be
  // correlated.
  const handleAutoFill = useCallback(() => {
    reset(generateRandomEnquiry(), { keepDefaultValues: true });
  }, [reset]);


  return (
    <>
      {/* Fixed Navigation Sidebar on Right */}
      <div className="fixed top-24 right-8 z-40 hidden xl:block">
        <Button 
          type="button" 
          onClick={handleAutoFill}
          variant="outline"
          className="bg-white/95 backdrop-blur-sm shadow-sm border-slate-200 text-teal-600 hover:text-teal-700 hover:bg-teal-50 gap-2 mb-4 w-52"
        >
          <Wand2 size={16} />
          <span>Auto-fill Form</span>
        </Button>
      </div>
      <FormNavigation sectionProgress={sectionProgress} scrollToSection={scrollToSection} />

      {/* Main Form - Centered with max width */}
      <form onInvalidCapture={(event) => toast.error('Check the highlighted field', (event.target as HTMLInputElement).validationMessage)} onSubmit={handleSubmit((data) => onSubmit(data))} className="max-w-3xl mx-auto space-y-8 pb-32 md:pb-12 relative">
        <div className="xl:hidden flex justify-end mb-4">
           <Button 
            type="button" 
            onClick={handleAutoFill}
            variant="outline" 
            size="sm"
            className="bg-white border-slate-200 text-teal-600 gap-2"
          >
            <Wand2 size={14} />
            Auto-fill
          </Button>
        </div>

        {/* 1. Student Personal Details */}
        <div id="student-details" className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden scroll-mt-24">
          <div className="bg-slate-50/50 px-6 py-4 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => window.history.back()}
                className="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
                title="Go Back"
              >
                <ArrowLeft size={18} />
              </button>
              <div className="w-10 h-10 bg-teal-100 text-teal-700 rounded-lg flex items-center justify-center">
                <User size={20} />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-800 font-heading">Student Details</h3>
                <p className="text-sm text-slate-500">Personal information and contact</p>
              </div>
            </div>
            <ProgressRing progress={sectionProgress['student-details'] || 0} size={36} strokeWidth={3} color="teal" />
          </div>

          <div className="p-6 md:p-8 grid grid-cols-1 md:grid-cols-12 gap-6">
            {/* Quick Info Row */}
            <div className="md:col-span-4 space-y-2">
              <Label htmlFor="date" className="text-slate-700 font-semibold flex items-center gap-1">
                Enquiry Date <span className="text-red-500">*</span>
              </Label>
              <Input type="date" {...register('date')} className={STANDARD_INPUT_STYLE} />
              {errors.date && <p className="text-xs text-red-500 mt-1">{errors.date.message}</p>}
            </div>

            <div className="md:col-span-8 space-y-2">
              <Label htmlFor="candidateName" className="text-slate-700 font-semibold flex items-center gap-1">
                Candidate Name <span className="text-red-500">*</span>
              </Label>
              <Input {...register('candidateName')} placeholder="Full Name as per records" className={STANDARD_INPUT_STYLE} />
              {errors.candidateName && <p className="text-xs text-red-500 mt-1">{errors.candidateName.message}</p>}
            </div>

            {/* Contact Row */}
            <div className="md:col-span-4 space-y-2">
              <Label htmlFor="mobile" className="text-slate-700 font-semibold flex items-center gap-1">
                <Phone size={14} className="text-slate-400" /> Mobile <span className="text-red-500">*</span>
              </Label>
              <Input {...register('mobile')} placeholder="10-digit number" className={STANDARD_INPUT_STYLE} />
              {errors.mobile && <p className="text-xs text-red-500 mt-1">{errors.mobile.message}</p>}
            </div>

            <div className="md:col-span-4 space-y-2">
              <Label htmlFor="email" className="text-slate-700 font-semibold flex items-center gap-1">
                <Mail size={14} className="text-slate-400" /> Email <span className="text-red-500">*</span>
              </Label>
              <Input type="email" {...register('email')} placeholder="student@example.com" className={STANDARD_INPUT_STYLE} />
              {errors.email && <p className="text-xs text-red-500 mt-1">{errors.email.message}</p>}
            </div>

            <div className="md:col-span-4 space-y-2">
              <Label htmlFor="gender" className="text-slate-700 font-semibold">Gender</Label>
              <Controller
                name="gender"
                control={control}
                render={({ field }) => (
                  <Select onValueChange={field.onChange} value={field.value}>
                    <SelectTrigger className={STANDARD_INPUT_STYLE}>
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Male">Male</SelectItem>
                      <SelectItem value="Female">Female</SelectItem>
                      <SelectItem value="Other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            {/* DOB */}
            <div className="md:col-span-4 space-y-2">
              <Label htmlFor="dob" className="text-slate-700 font-semibold">Date of Birth</Label>
              <Input id="dob" type="date" {...register('dob')} className={STANDARD_INPUT_STYLE} />
            </div>


            {/* Caste & Religion */}
            <div className="md:col-span-4 space-y-2">
              <Label htmlFor="caste" className="text-slate-700 font-semibold">Caste</Label>
              <Controller
                name="caste"
                control={control}
                render={({ field }) => (
                  <Select onValueChange={field.onChange} value={field.value}>
                    <SelectTrigger className={STANDARD_INPUT_STYLE}>
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

            <div className="md:col-span-4 space-y-2">
              <Label htmlFor="religion" className="text-slate-700 font-semibold">Religion</Label>
              <Controller
                name="religion"
                control={control}
                render={({ field }) => (
                  <Select onValueChange={field.onChange} value={field.value}>
                    <SelectTrigger className={STANDARD_INPUT_STYLE}>
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

        {/* 2. Parent & Family Details */}
        <div id="family-address" className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden scroll-mt-24">
          <div className="bg-slate-50/50 px-6 py-4 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-purple-100 text-purple-700 rounded-lg flex items-center justify-center">
                <Users size={20} />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-800 font-heading">Family & Address</h3>
                <p className="text-sm text-slate-500">Guardian details</p>
              </div>
            </div>
            <ProgressRing progress={sectionProgress['family-address'] || 0} size={36} strokeWidth={3} color="purple" />
          </div>
          <div className="p-6 md:p-8">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
              {/* Father */}
              <div className="space-y-4">
                <h4 className="text-sm font-bold text-slate-900 border-b border-slate-100 pb-2 uppercase tracking-wide">Father’s Info</h4>
                <div className="space-y-3">
                  <div>
                    <Label className="text-xs text-slate-500 font-medium">Name <span className="text-red-500">*</span></Label>
                    <Input {...register('fatherName')} className={STANDARD_INPUT_STYLE} placeholder="Father's Name" />
                    {errors.fatherName && <p className="text-xs text-red-500 mt-1">{errors.fatherName.message}</p>}
                  </div>
                  <div>
                    <Label className="text-xs text-slate-500 font-medium">Occupation</Label>
                    <Input {...register('fatherOccupation')} className={STANDARD_INPUT_STYLE} placeholder="Occupation" />
                  </div>
                  <div>
                    <Label className="text-xs text-slate-500 font-medium">Mobile</Label>
                    <Input {...register('fatherMobile')} className={STANDARD_INPUT_STYLE} placeholder="Mobile Number" />
                  </div>
                </div>
              </div>

              {/* Mother */}
              <div className="space-y-4">
                <h4 className="text-sm font-bold text-slate-900 border-b border-slate-100 pb-2 uppercase tracking-wide">Mother’s Info</h4>
                <div className="space-y-3">
                  <div>
                    <Label className="text-xs text-slate-500 font-medium">Name <span className="text-red-500">*</span></Label>
                    <Input {...register('motherName')} className={STANDARD_INPUT_STYLE} placeholder="Mother's Name" />
                    {errors.motherName && <p className="text-xs text-red-500 mt-1">{errors.motherName.message}</p>}
                  </div>
                  <div>
                    <Label className="text-xs text-slate-500 font-medium">Occupation</Label>
                    <Input {...register('motherOccupation')} className={STANDARD_INPUT_STYLE} placeholder="Occupation" />
                  </div>
                  <div>
                    <Label className="text-xs text-slate-500 font-medium">Mobile</Label>
                    <Input {...register('motherMobile')} className={STANDARD_INPUT_STYLE} placeholder="Mobile Number" />
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-8 pt-6 border-t border-slate-100">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <Label htmlFor="permanentAddress" className="text-slate-700 font-semibold flex items-center gap-1">
                    <MapPin size={14} className="text-slate-400" /> Permanent Address <span className="text-red-500">*</span>
                  </Label>
                  <Input {...register('permanentAddress')} placeholder="Street, Colony, House No." className={STANDARD_INPUT_STYLE} />
                  {errors.permanentAddress && <p className="text-xs text-red-500 mt-1">{errors.permanentAddress.message}</p>}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-slate-700 font-semibold">City / Place</Label>
                    <Input {...register('familyPlace')} className={STANDARD_INPUT_STYLE} placeholder="City" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-slate-700 font-semibold">State</Label>
                    <Controller
                      name="familyState"
                      control={control}
                      render={({ field }) => (
                        <Select onValueChange={field.onChange} value={field.value}>
                          <SelectTrigger className={STANDARD_INPUT_STYLE}>
                            <SelectValue placeholder="State" />
                          </SelectTrigger>
                          <SelectContent>
                            {INDIAN_STATES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 3. Academic Details */}
        <div id="academic-profile" className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden scroll-mt-24">
          <div className="bg-slate-50/50 px-6 py-4 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-100 text-blue-700 rounded-lg flex items-center justify-center">
                <GraduationCap size={20} />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-800 font-heading">Academic Profile</h3>
                <p className="text-sm text-slate-500">Education history and marks</p>
              </div>
            </div>
            <ProgressRing progress={sectionProgress['academic-profile'] || 0} size={36} strokeWidth={3} color="blue" />
          </div>

          <div className="p-6 md:p-8 space-y-8">

            {/* Interest - Top Level */}
            <div className="bg-slate-50 p-4 rounded-lg border border-slate-100 flex flex-col md:flex-row gap-6">
              <div className="flex-1 space-y-2">
                <Label className="text-slate-700 font-bold flex items-center gap-2">
                  <BookOpen size={16} className="text-teal-600" /> Course Interested <span className="text-red-500">*</span>
                </Label>
                <Controller
                  name="courseInterested"
                  control={control}
                  render={({ field }) => (
                    <Select onValueChange={field.onChange} value={field.value}>
                      <SelectTrigger className={STANDARD_INPUT_STYLE}>
                        <SelectValue placeholder="Select Course" />
                      </SelectTrigger>
                      <SelectContent className="max-h-60">
                        {COURSES.map(course => <SelectItem key={course} value={course}>{course}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )}
                />
                {errors.courseInterested && <p className="text-xs text-red-500">{errors.courseInterested.message}</p>}
              </div>

              <div className="flex-1 flex gap-6 items-center pt-6">
                <div className="flex items-center gap-2 bg-white px-4 py-2 rounded-md border border-slate-200 shadow-sm">
                  <Controller
                    name="gapYear"
                    control={control}
                    render={({ field }) => (
                      <Checkbox checked={field.value} onCheckedChange={field.onChange} id="gapYear" />
                    )}
                  />
                  <Label htmlFor="gapYear" className="cursor-pointer font-medium text-slate-700">Gap Year?</Label>
                </div>

                <div className="flex items-center gap-2 bg-white px-4 py-2 rounded-md border border-slate-200 shadow-sm">
                  <Controller
                    name="collegeDropout"
                    control={control}
                    render={({ field }) => (
                      <Checkbox checked={field.value} onCheckedChange={field.onChange} id="collegeDropout" />
                    )}
                  />
                  <Label htmlFor="collegeDropout" className="cursor-pointer font-medium text-slate-700">College Dropout?</Label>
                </div>
              </div>

              {watch('gapYear') && (
                <div className="w-full md:w-auto flex items-end gap-2 animate-in fade-in slide-in-from-top-1">
                  <div className="space-y-1">
                    <Label className="text-xs text-slate-500">From</Label>
                    <Input type="number" {...register('gapYearFrom')} className={STANDARD_INPUT_STYLE + " w-24"} placeholder="YYYY" />
                  </div>
                  <div className="self-center pb-2 text-slate-400">-</div>
                  <div className="space-y-1">
                    <Label className="text-xs text-slate-500">To</Label>
                    <Input type="number" {...register('gapYearTo')} className={STANDARD_INPUT_STYLE + " w-24"} placeholder="YYYY" />
                  </div>
                </div>
              )}
            </div>

            {/* Academic Boxes Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">

              {/* HSLC Box */}
              <div className="bg-white border rounded-lg overflow-hidden border-slate-200 shadow-sm hover:shadow-md transition-shadow relative">
                <div className="absolute top-0 left-0 w-1 h-full bg-teal-500"></div>
                <div className="bg-gradient-to-r from-slate-100 to-white px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                  <span className="font-bold text-slate-700 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-teal-500"></span> HSLC (Class 10)
                  </span>
                </div>
                <div className="p-5 space-y-4">
                  <div className="space-y-2">
                    <Label className="text-sm">School Name</Label>
                    <Input {...register('class10SchoolName')} className={STANDARD_INPUT_STYLE} placeholder="School Name" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-sm">Board</Label>
                      <Controller
                        name="class10Board"
                        control={control}
                        render={({ field }) => (
                          <Select onValueChange={field.onChange} value={field.value}>
                            <SelectTrigger className={STANDARD_INPUT_STYLE}><SelectValue placeholder="Select" /></SelectTrigger>
                            <SelectContent>
                              {SCHOOL_BOARDS.map(board => <SelectItem key={board} value={board}>{board}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        )}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-sm">Passing Year</Label>
                      <Input {...register('class10PassingYear')} className={STANDARD_INPUT_STYLE} placeholder="YYYY" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-sm">Percentage</Label>
                      <Input type="number" step="0.01" {...register('class10Percentage')} className={STANDARD_INPUT_STYLE} placeholder="%" />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-sm">City/Place</Label>
                      <Input {...register('class10Place')} className={STANDARD_INPUT_STYLE} placeholder="City/Town" />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm">State</Label>
                    <Controller
                      name="class10State"
                      control={control}
                      render={({ field }) => (
                        <Select onValueChange={field.onChange} value={field.value}>
                          <SelectTrigger className={STANDARD_INPUT_STYLE}><SelectValue placeholder="Select" /></SelectTrigger>
                          <SelectContent>
                            {INDIAN_STATES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>
                </div>
              </div>

              {/* HSSLC Box */}
              <div className="bg-white border rounded-lg overflow-hidden border-blue-200 shadow-sm hover:shadow-md transition-shadow relative">
                <div className="absolute top-0 left-0 w-1 h-full bg-blue-500"></div>
                <div className="bg-gradient-to-r from-blue-50 to-white px-4 py-3 border-b border-blue-100 flex items-center justify-between">
                  <span className="font-bold text-blue-900 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-blue-600"></span> HSSLC (Class 12)
                  </span>
                  <span className="text-xs font-medium text-blue-600 bg-blue-100 px-2 py-0.5 rounded">Higher Secondary</span>
                </div>
                <div className="p-5 space-y-4">
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">School Name <span className="text-red-500">*</span></Label>
                    <Input {...register('schoolName')} className={BLUE_INPUT_STYLE} placeholder="School Name" />
                    {errors.schoolName && <p className="text-xs text-red-500">{errors.schoolName.message}</p>}
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-sm">Board</Label>
                      <Controller
                        name="schoolBoard"
                        control={control}
                        render={({ field }) => (
                          <Select onValueChange={field.onChange} value={field.value}>
                            <SelectTrigger className={BLUE_INPUT_STYLE}><SelectValue placeholder="Select" /></SelectTrigger>
                            <SelectContent>
                              {SCHOOL_BOARDS.map(board => <SelectItem key={board} value={board}>{board}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        )}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-sm">Stream <span className="text-red-500">*</span></Label>
                      <Controller
                        name="stream"
                        control={control}
                        render={({ field }) => (
                          <Select onValueChange={field.onChange} value={field.value}>
                            <SelectTrigger ref={field.ref} onBlur={field.onBlur} aria-invalid={!!errors.stream} aria-describedby={errors.stream ? 'stream-error' : undefined} className={BLUE_INPUT_STYLE}><SelectValue placeholder="Select" /></SelectTrigger>
                            <SelectContent>
                              {streamOptions.map(stream => <SelectItem key={stream} value={stream}>{stream}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        )}
                      />
                      {errors.stream && <p id="stream-error" className="text-xs text-red-600">{errors.stream.message}</p>}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-sm">Year</Label>
                      <Input {...register('class12PassingYear')} className={BLUE_INPUT_STYLE} placeholder="YYYY" />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-sm">Percentage</Label>
                      <Input type="number" step="0.01" {...register('class12Percentage')} className={BLUE_INPUT_STYLE} placeholder="%" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-sm">City</Label>
                      <Input {...register('schoolPlace')} className={BLUE_INPUT_STYLE} placeholder="City/Town" />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-sm">State</Label>
                      <Controller
                        name="schoolState"
                        control={control}
                        render={({ field }) => (
                          <Select onValueChange={field.onChange} value={field.value}>
                            <SelectTrigger className={BLUE_INPUT_STYLE}><SelectValue placeholder="Select" /></SelectTrigger>
                            <SelectContent>
                              {INDIAN_STATES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        )}
                      />
                    </div>
                  </div>
                </div>
              </div>

            </div>

            {/* Science Marks Scorecard */}
            {['science', 'pcb', 'pcm', 'pcmb'].includes(selectedStream?.toLowerCase()) && (
              <div className="bg-gradient-to-b from-slate-50 to-white rounded-xl border border-slate-200 overflow-hidden mt-2">
                <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
                  <h4 className="font-bold text-slate-800 text-sm uppercase tracking-wide">Science Scorecard</h4>
                  <span className="text-xs text-slate-500 bg-white border border-slate-200 px-2 py-1 rounded">Auto-calculated</span>
                </div>
                <div className="p-6">
                  <div className="grid grid-cols-2 md:grid-cols-6 gap-4 mb-6">
                    <div className="col-span-1 md:col-span-1 bg-green-50 rounded-lg p-3 text-center border border-green-100">
                      <Label className="text-[10px] text-green-700 font-bold uppercase block mb-1">PCB %</Label>
                      <div className="text-lg font-bold text-green-700">{numericDisplay(watch('pcbPercentage'))}%</div>
                    </div>
                    <div className="col-span-1 md:col-span-1 bg-blue-50 rounded-lg p-3 text-center border border-blue-100">
                      <Label className="text-[10px] text-blue-700 font-bold uppercase block mb-1">PCM %</Label>
                      <div className="text-lg font-bold text-blue-700">{numericDisplay(watch('pcmPercentage'))}%</div>
                    </div>
                    <div className="col-span-2 md:col-span-4 grid grid-cols-4 gap-2">
                      <div className="space-y-1">
                        <Label className="text-[10px] text-slate-500 uppercase">Physics</Label>
                        <Input type="number" step="0.01" {...register('physicsMarks')} className="h-9 text-sm bg-white border-slate-300 focus:border-teal-500 focus:ring-teal-500 rounded-md" placeholder="Mk" />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[10px] text-slate-500 uppercase">Chem</Label>
                        <Input type="number" step="0.01" {...register('chemistryMarks')} className="h-9 text-sm bg-white border-slate-300 focus:border-teal-500 focus:ring-teal-500 rounded-md" placeholder="Mk" />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[10px] text-slate-500 uppercase">Bio</Label>
                        <Input type="number" step="0.01" {...register('biologyMarks')} className="h-9 text-sm bg-white border-slate-300 focus:border-teal-500 focus:ring-teal-500 rounded-md" placeholder="Mk" />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[10px] text-slate-500 uppercase">Maths</Label>
                        <Input type="number" step="0.01" {...register('mathsMarks')} className="h-9 text-sm bg-white border-slate-300 focus:border-teal-500 focus:ring-teal-500 rounded-md" placeholder="Mk" />
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-6 pt-4 border-t border-slate-100">
                    <div className="flex-1 space-y-2">
                      <Label className="text-xs font-semibold text-slate-700">Previous NEET Score</Label>
                      <Input type="number" step="0.01" {...register('previousNeetMarks')} className={STANDARD_INPUT_STYLE} placeholder="Score" />
                    </div>
                    <div className="flex-1 space-y-2">
                      <Label className="text-xs font-semibold text-slate-700">Present NEET Score</Label>
                      <Input type="number" step="0.01" {...register('presentNeetMarks')} className={STANDARD_INPUT_STYLE} placeholder="Score" />
                    </div>
                  </div>
                </div>
              </div>
            )}

          </div>
        </div>

        {/* 4. Preferences & Payment */}
        <div id="preferences-payment" className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden scroll-mt-24">
          <div className="bg-slate-50/50 px-6 py-4 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-orange-100 text-orange-600 rounded-lg flex items-center justify-center">
                <MapPin size={20} />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-800 font-heading">Preferences & Payment</h3>
                <p className="text-sm text-slate-500">Additional requirements</p>
              </div>
            </div>
            <ProgressRing progress={sectionProgress['preferences-payment'] || 0} size={36} strokeWidth={3} color="orange" />
          </div>
          <div className="p-6 md:p-8 space-y-6">
            <div className="space-y-3">
              <Label className="text-slate-700 font-semibold">Preferred Education Hubs</Label>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                {['Bangalore', 'Chennai', 'Delhi', 'Hyderabad', 'Mumbai', 'Pune', 'Kota', 'Overseas'].map((city) => (
                  <Controller
                    key={city}
                    name="preferredLocations"
                    control={control}
                    render={({ field }) => {
                      // Ensure value is an array
                      const currentVal = Array.isArray(field.value) ? field.value : [];
                      const isChecked = currentVal.includes(city);
                      return (
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id={`loc-${city}`}
                            checked={isChecked}
                            onCheckedChange={(checked) => {
                              if (checked) {
                                field.onChange([...currentVal, city]);
                              } else {
                                field.onChange(currentVal.filter((c: string) => c !== city));
                              }
                            }}
                          />
                          <Label htmlFor={`loc-${city}`} className="font-normal cursor-pointer text-slate-700">
                            {city}
                          </Label>
                        </div>
                      )
                    }}
                  />
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-slate-100">
              <div className="space-y-2">
                <Label className="text-slate-700 font-semibold">Other Preferred Location</Label>
                <Input {...register('otherLocation')} placeholder="E.g. Kolkata, Guwahati" className={STANDARD_INPUT_STYLE} />
              </div>
              <div className="space-y-2">
                <Label className="text-slate-700 font-semibold">Budget / Payment Limit</Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 font-bold">₹</span>
                  <Input type="number" step="0.01" {...register('paymentAmount')} placeholder="0.00" className={STANDARD_INPUT_STYLE + " pl-8"} />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Floating Action Bar / Mobile Action */}
        <div className="fixed bottom-0 left-0 right-0 bg-white/80 backdrop-blur-md border-t border-slate-200 p-4 md:relative md:bg-transparent md:border-0 md:p-0 z-20">
          {submitCount > 0 && Object.keys(errors).length > 0 && (
            <div role="alert" className="mx-auto mb-3 max-h-28 max-w-5xl overflow-y-auto rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <p className="font-semibold">Couldn’t save. Check these fields:</p>
              <ul className="mt-1 list-disc pl-4">{Object.entries(errors).map(([field, error]) => <li key={field}>{error?.message ? String(error.message) : `Check ${field}`}</li>)}</ul>
            </div>
          )}
          {!!submitError && <div role="alert" className="mx-auto mb-3 max-w-5xl"><ErrorBanner error={submitError} /></div>}
          <div className="max-w-5xl mx-auto flex justify-end gap-4">
            <Button
              type="button"
              onClick={() => window.history.back()}
              variant="outline"
              className="h-12 px-8 border-slate-300 text-slate-700 font-medium hover:bg-slate-50"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading} className="h-12 px-10 bg-teal-600 hover:bg-teal-700 text-white font-bold shadow-lg shadow-teal-200">
              {isLoading ? (
                <div className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-white/50 border-t-white rounded-full animate-spin"></span>
                  Saving...
                </div>
              ) : 'Save Enquiry'}
            </Button>
          </div>
        </div>

      </form>
    </>
  );
}
