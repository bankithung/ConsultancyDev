'use client';

import { useMemo, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { BookOpen, Check, ChevronRight, GraduationCap, Lock, Mail, MapPin, Phone, Save, Settings, User, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Enquiry } from '@/lib/types';
import type { EnquiryInput } from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { InlineSpinner } from '@/components/common/states';
import {
  CLASS_12_STREAMS,
  COURSES,
  ENQUIRY_STATUSES,
  PREFERRED_LOCATIONS,
  toDateInput,
} from '../constants';
import { ReadOnlyField, ReadOnlyPanel } from './ReadOnlyPanel';

const INPUT_CLASS = 'h-10 rounded-md border-slate-200 bg-white text-sm focus:border-teal-500 focus:ring-teal-500';

/**
 * Every field here is one the API will actually persist.
 *
 * `EnquiryInput` in `lib/apiClient` is the full writable surface for an enquiry;
 * `toEnquiryPayload` drops anything else on the floor. The extra properties that
 * the read type still carries (parents' occupations and mobiles, subject marks,
 * budget) are shown read-only further down instead of being offered as inputs
 * that would silently discard whatever was typed into them.
 *
 * No `.coerce`, `.default` or `.transform`, so `z.input` === `z.output` and the
 * resolver's generics line up without a `@ts-ignore`.
 */
const enquirySchema = z.object({
  date: z.string().min(1, 'Enquiry date is required'),
  candidateName: z.string().min(1, 'Candidate name is required'),
  mobile: z.string().min(10, 'Enter a valid mobile number'),
  email: z.string().email('Enter a valid email address'),
  // Must list every value `Enquiry.Status` allows. Omitting 'Contacted'
  // made this form unable to load an enquiry that was already in it.
  status: z.enum(['New', 'Contacted', 'Converted', 'Closed']),
  fatherName: z.string().min(1, "Father's name is required"),
  motherName: z.string().min(1, "Mother's name is required"),
  permanentAddress: z.string().min(1, 'Address is required'),
  schoolName: z.string().min(1, 'School name is required'),
  stream: z.enum(['Science', 'Commerce', 'Arts']),
  courseInterested: z.string().min(1, 'Course is required'),
  gapYear: z.boolean(),
  collegeDropout: z.boolean(),
  preferredLocations: z.array(z.string()),
});

type EnquiryFormValues = z.infer<typeof enquirySchema>;

type SectionId = 'student-details' | 'family-address' | 'academic' | 'preferences';

interface Section {
  id: SectionId;
  label: string;
  icon: LucideIcon;
  activeClass: string;
  iconClass: string;
  fields: Array<keyof EnquiryFormValues>;
}

const SECTIONS: readonly Section[] = [
  {
    id: 'student-details',
    label: 'Student details',
    icon: User,
    activeClass: 'bg-teal-600',
    iconClass: 'bg-teal-50 text-teal-700',
    fields: ['date', 'candidateName', 'mobile', 'email', 'status'],
  },
  {
    id: 'family-address',
    label: 'Family & address',
    icon: Users,
    activeClass: 'bg-purple-600',
    iconClass: 'bg-purple-50 text-purple-700',
    fields: ['fatherName', 'motherName', 'permanentAddress'],
  },
  {
    id: 'academic',
    label: 'Academic profile',
    icon: GraduationCap,
    activeClass: 'bg-blue-600',
    iconClass: 'bg-blue-50 text-blue-700',
    fields: ['schoolName', 'stream', 'courseInterested'],
  },
  {
    id: 'preferences',
    label: 'Preferences',
    icon: Settings,
    activeClass: 'bg-orange-600',
    iconClass: 'bg-orange-50 text-orange-700',
    fields: ['preferredLocations'],
  },
];

function toFormValues(enquiry: Enquiry): EnquiryFormValues {
  return {
    date: toDateInput(enquiry.date),
    candidateName: enquiry.candidateName ?? '',
    mobile: enquiry.mobile ?? '',
    email: enquiry.email ?? '',
    status: enquiry.status ?? 'New',
    fatherName: enquiry.fatherName ?? '',
    motherName: enquiry.motherName ?? '',
    permanentAddress: enquiry.permanentAddress ?? '',
    schoolName: enquiry.schoolName ?? '',
    stream: enquiry.stream ?? 'Science',
    courseInterested: enquiry.courseInterested ?? '',
    gapYear: Boolean(enquiry.gapYear),
    collegeDropout: Boolean(enquiry.collegeDropout),
    preferredLocations: enquiry.preferredLocations ?? [],
  };
}

interface ProfileEnquiryFormProps {
  initialData: Enquiry;
  onSubmit: (data: EnquiryInput) => void;
  isLoading: boolean;
}

export function ProfileEnquiryForm({ initialData, onSubmit, isLoading }: ProfileEnquiryFormProps) {
  const [activeSection, setActiveSection] = useState<SectionId>('student-details');

  const {
    register,
    control,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<EnquiryFormValues>({
    resolver: zodResolver(enquirySchema),
    defaultValues: toFormValues(initialData),
  });

  const values = watch();

  /** Share of a section's fields that carry a value — drives the sidebar ticks. */
  const completion = useMemo(() => {
    const result: Record<SectionId, boolean> = {
      'student-details': false,
      'family-address': false,
      academic: false,
      preferences: false,
    };
    for (const section of SECTIONS) {
      result[section.id] = section.fields.every((field) => {
        const value = values[field];
        if (Array.isArray(value)) return value.length > 0;
        if (typeof value === 'boolean') return true;
        return typeof value === 'string' && value.trim() !== '';
      });
    }
    return result;
  }, [values]);

  /** Jumps to the first section holding an invalid field so the error is visible. */
  const focusFirstError = () => {
    const invalid = Object.keys(errors)[0] as keyof EnquiryFormValues | undefined;
    if (!invalid) return;
    const section = SECTIONS.find((candidate) => candidate.fields.includes(invalid));
    if (section) setActiveSection(section.id);
  };

  const submit = handleSubmit(
    (formValues) =>
      onSubmit({
        date: formValues.date,
        stream: formValues.stream,
        mobile: formValues.mobile.trim(),
        email: formValues.email.trim(),
        status: formValues.status,
        gapYear: formValues.gapYear,
        collegeDropout: formValues.collegeDropout,
        candidateName: formValues.candidateName.trim(),
        schoolName: formValues.schoolName.trim(),
        courseInterested: formValues.courseInterested,
        fatherName: formValues.fatherName.trim(),
        motherName: formValues.motherName.trim(),
        permanentAddress: formValues.permanentAddress.trim(),
        preferredLocations: formValues.preferredLocations,
      }),
    focusFirstError,
  );

  const marks = [
    { label: 'Physics', value: initialData.physicsMarks },
    { label: 'Chemistry', value: initialData.chemistryMarks },
    { label: 'Biology', value: initialData.biologyMarks },
    { label: 'Maths', value: initialData.mathsMarks },
  ];

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 lg:flex-row lg:gap-6">
      {/* Section nav — a horizontal strip on phones, a rail from lg up. */}
      <nav aria-label="Form sections" className="shrink-0 lg:w-56">
        <div className="rounded-lg border border-slate-200 bg-white p-2 shadow-sm lg:sticky lg:top-4">
          <h4 className="hidden px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-slate-400 lg:block">
            Sections
          </h4>
          <div className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
            {SECTIONS.map((section) => {
              const isActive = activeSection === section.id;
              const hasErrors = section.fields.some((field) => Boolean(errors[field]));
              const Icon = section.icon;

              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => setActiveSection(section.id)}
                  aria-current={isActive ? 'step' : undefined}
                  className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2.5 text-left transition-all lg:w-full lg:gap-3 ${
                    isActive ? `${section.activeClass} text-white shadow-sm` : 'text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <span
                    className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
                      isActive
                        ? 'bg-white/20'
                        : completion[section.id] && !hasErrors
                          ? 'bg-green-100 text-green-600'
                          : section.iconClass
                    }`}
                  >
                    {completion[section.id] && !isActive && !hasErrors ? <Check size={14} /> : <Icon size={14} />}
                    {hasErrors && (
                      <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-red-500" />
                    )}
                  </span>
                  <span className={`whitespace-nowrap text-sm font-medium ${hasErrors && !isActive ? 'text-red-600' : ''}`}>
                    {section.label}
                  </span>
                  {isActive && <ChevronRight size={14} className="ml-auto hidden text-white/70 lg:block" />}
                </button>
              );
            })}
          </div>
        </div>
      </nav>

      <div className="min-w-0 flex-1 space-y-4">
        {activeSection === 'student-details' && (
          <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <header className="flex items-center gap-3 border-b border-teal-100 bg-teal-50/50 px-4 py-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-100 text-teal-700">
                <User size={16} />
              </span>
              <div>
                <h3 className="text-sm font-bold text-slate-800">Student details</h3>
                <p className="text-xs text-slate-500">Who they are and how to reach them</p>
              </div>
            </header>
            <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="enquiry-date">
                  Enquiry date <span className="text-red-500">*</span>
                </Label>
                <Input id="enquiry-date" type="date" className={INPUT_CLASS} {...register('date')} />
                {errors.date && <p className="text-xs text-red-600">{errors.date.message}</p>}
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="enquiry-name">
                  Candidate name <span className="text-red-500">*</span>
                </Label>
                <Input id="enquiry-name" placeholder="Full name" className={INPUT_CLASS} {...register('candidateName')} />
                {errors.candidateName && <p className="text-xs text-red-600">{errors.candidateName.message}</p>}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="enquiry-mobile" className="flex items-center gap-1">
                  <Phone size={12} /> Mobile <span className="text-red-500">*</span>
                </Label>
                <Input id="enquiry-mobile" inputMode="tel" className={INPUT_CLASS} {...register('mobile')} />
                {errors.mobile && <p className="text-xs text-red-600">{errors.mobile.message}</p>}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="enquiry-email" className="flex items-center gap-1">
                  <Mail size={12} /> Email <span className="text-red-500">*</span>
                </Label>
                <Input id="enquiry-email" type="email" className={INPUT_CLASS} {...register('email')} />
                {errors.email && <p className="text-xs text-red-600">{errors.email.message}</p>}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="enquiry-status">Status</Label>
                <Controller
                  name="status"
                  control={control}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="enquiry-status" className={`${INPUT_CLASS} w-full`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ENQUIRY_STATUSES.map((status) => (
                          <SelectItem key={status} value={status}>
                            {status}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
            </div>
          </section>
        )}

        {activeSection === 'family-address' && (
          <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <header className="flex items-center gap-3 border-b border-purple-100 bg-purple-50/50 px-4 py-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-100 text-purple-700">
                <Users size={16} />
              </span>
              <div>
                <h3 className="text-sm font-bold text-slate-800">Family &amp; address</h3>
                <p className="text-xs text-slate-500">Parents and where the family lives</p>
              </div>
            </header>
            <div className="space-y-5 p-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="enquiry-father">
                    Father&apos;s name <span className="text-red-500">*</span>
                  </Label>
                  <Input id="enquiry-father" className={INPUT_CLASS} {...register('fatherName')} />
                  {errors.fatherName && <p className="text-xs text-red-600">{errors.fatherName.message}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="enquiry-mother">
                    Mother&apos;s name <span className="text-red-500">*</span>
                  </Label>
                  <Input id="enquiry-mother" className={INPUT_CLASS} {...register('motherName')} />
                  {errors.motherName && <p className="text-xs text-red-600">{errors.motherName.message}</p>}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="enquiry-address" className="flex items-center gap-1">
                  <MapPin size={12} /> Permanent address <span className="text-red-500">*</span>
                </Label>
                <Input id="enquiry-address" className={INPUT_CLASS} {...register('permanentAddress')} />
                {errors.permanentAddress && <p className="text-xs text-red-600">{errors.permanentAddress.message}</p>}
              </div>

              <ReadOnlyPanel title="Also on file">
                <ReadOnlyField label="Father's occupation" value={initialData.fatherOccupation} />
                <ReadOnlyField label="Father's mobile" value={initialData.fatherMobile} />
                <ReadOnlyField label="Mother's occupation" value={initialData.motherOccupation} />
                <ReadOnlyField label="Mother's mobile" value={initialData.motherMobile} />
              </ReadOnlyPanel>
            </div>
          </section>
        )}

        {activeSection === 'academic' && (
          <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <header className="flex items-center gap-3 border-b border-blue-100 bg-blue-50/50 px-4 py-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 text-blue-700">
                <GraduationCap size={16} />
              </span>
              <div>
                <h3 className="text-sm font-bold text-slate-800">Academic profile</h3>
                <p className="text-xs text-slate-500">School, stream and what they want to study</p>
              </div>
            </header>
            <div className="space-y-5 p-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-1.5 sm:col-span-2 lg:col-span-1">
                  <Label htmlFor="enquiry-school">
                    School name <span className="text-red-500">*</span>
                  </Label>
                  <Input id="enquiry-school" className={INPUT_CLASS} {...register('schoolName')} />
                  {errors.schoolName && <p className="text-xs text-red-600">{errors.schoolName.message}</p>}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="enquiry-stream">Stream</Label>
                  <Controller
                    name="stream"
                    control={control}
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger id="enquiry-stream" className={`${INPUT_CLASS} w-full`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CLASS_12_STREAMS.map((stream) => (
                            <SelectItem key={stream} value={stream}>
                              {stream}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="enquiry-course" className="flex items-center gap-1">
                    <BookOpen size={12} /> Course interested <span className="text-red-500">*</span>
                  </Label>
                  <Controller
                    name="courseInterested"
                    control={control}
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger id="enquiry-course" className={`${INPUT_CLASS} w-full`}>
                          <SelectValue placeholder="Select a course" />
                        </SelectTrigger>
                        <SelectContent className="max-h-60">
                          {COURSES.map((course) => (
                            <SelectItem key={course} value={course}>
                              {course}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                  {errors.courseInterested && <p className="text-xs text-red-600">{errors.courseInterested.message}</p>}
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2">
                  <Controller
                    name="gapYear"
                    control={control}
                    render={({ field }) => (
                      <Checkbox
                        id="enquiry-gap-year"
                        checked={field.value}
                        onCheckedChange={(checked) => field.onChange(checked === true)}
                      />
                    )}
                  />
                  <Label htmlFor="enquiry-gap-year" className="cursor-pointer text-xs font-medium">
                    Gap year
                  </Label>
                </div>
                <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2">
                  <Controller
                    name="collegeDropout"
                    control={control}
                    render={({ field }) => (
                      <Checkbox
                        id="enquiry-dropout"
                        checked={field.value}
                        onCheckedChange={(checked) => field.onChange(checked === true)}
                      />
                    )}
                  />
                  <Label htmlFor="enquiry-dropout" className="cursor-pointer text-xs font-medium">
                    College dropout
                  </Label>
                </div>
              </div>

              <ReadOnlyPanel title="Scorecard on file">
                <ReadOnlyField label="Class 12 passing year" value={initialData.class12PassingYear} />
                <ReadOnlyField label="PCB %" value={initialData.pcbPercentage} />
                <ReadOnlyField label="PCM %" value={initialData.pcmPercentage} />
                {marks.map((mark) => (
                  <ReadOnlyField key={mark.label} label={mark.label} value={mark.value} />
                ))}
                <ReadOnlyField label="Previous NEET" value={initialData.previousNeetMarks} />
                <ReadOnlyField label="Present NEET" value={initialData.presentNeetMarks} />
              </ReadOnlyPanel>
            </div>
          </section>
        )}

        {activeSection === 'preferences' && (
          <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <header className="flex items-center gap-3 border-b border-orange-100 bg-orange-50/50 px-4 py-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-100 text-orange-600">
                <MapPin size={16} />
              </span>
              <div>
                <h3 className="text-sm font-bold text-slate-800">Preferences</h3>
                <p className="text-xs text-slate-500">Where they would like to study</p>
              </div>
            </header>
            <div className="space-y-5 p-4">
              <fieldset className="space-y-2">
                <legend className="text-xs font-medium text-slate-700">Preferred education hubs</legend>
                <Controller
                  name="preferredLocations"
                  control={control}
                  render={({ field }) => (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                      {PREFERRED_LOCATIONS.map((city) => {
                        const selected = field.value.includes(city);
                        return (
                          <div
                            key={city}
                            className="flex items-center gap-2 rounded border border-slate-100 bg-slate-50 px-2 py-1.5"
                          >
                            <Checkbox
                              id={`enquiry-loc-${city}`}
                              checked={selected}
                              onCheckedChange={(checked) =>
                                field.onChange(
                                  checked === true
                                    ? [...field.value, city]
                                    : field.value.filter((value) => value !== city),
                                )
                              }
                            />
                            <Label htmlFor={`enquiry-loc-${city}`} className="cursor-pointer text-xs font-normal">
                              {city}
                            </Label>
                          </div>
                        );
                      })}
                    </div>
                  )}
                />
              </fieldset>

              <ReadOnlyPanel title="Also on file">
                <ReadOnlyField label="Other location" value={initialData.otherLocation} />
                <ReadOnlyField label="Budget" value={initialData.paymentAmount} prefix="₹" />
              </ReadOnlyPanel>
            </div>
          </section>
        )}

        <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-center gap-1.5 text-xs text-slate-500">
            <Lock size={12} className="shrink-0" />
            Fields marked read-only are returned by the API but cannot be updated through it.
          </p>
          <Button type="submit" className="h-10 shrink-0 px-6" disabled={isLoading}>
            {isLoading ? (
              <>
                <InlineSpinner className="mr-2" /> Saving…
              </>
            ) : (
              <>
                <Save size={16} className="mr-2" /> Save changes
              </>
            )}
          </Button>
        </div>
      </div>
    </form>
  );
}
