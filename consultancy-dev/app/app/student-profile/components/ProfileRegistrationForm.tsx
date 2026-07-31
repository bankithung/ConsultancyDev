'use client';

import { useMemo, useState } from 'react';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { BookOpen, Check, ChevronRight, Info, Lock, Mail, MapPin, Phone, Plus, Save, Trash2, User, Users, Wallet } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Registration, RegistrationInput, StudyPreference } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { InlineSpinner } from '@/components/common/states';
import {
  COURSES,
  NUMERIC_FIELD,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  fromNumber,
  toDateInput,
  toNumber,
} from '../constants';

const INPUT_CLASS = 'h-10 rounded-md border-slate-200 bg-white text-sm focus:border-teal-500 focus:ring-teal-500';

/**
 * Mirrors `RegistrationInput` — the full writable surface for a registration.
 *
 * `paymentMethod` and `paymentStatus` are plain strings rather than enums: both
 * are free CharFields server-side, so an enum here would reject a value the API
 * happily stores (and that an older record may already hold).
 */
const registrationSchema = z.object({
  studentName: z.string().min(1, 'Student name is required'),
  mobile: z.string().min(10, 'Enter a valid mobile number'),
  email: z.string().email('Enter a valid email address'),
  dateOfBirth: z.string(),
  fatherName: z.string().min(1, "Father's name is required"),
  motherName: z.string().min(1, "Mother's name is required"),
  permanentAddress: z.string().min(1, 'Address is required'),
  registrationFee: z.string().regex(NUMERIC_FIELD, 'Enter an amount'),
  paymentMethod: z.string().min(1, 'Payment method is required'),
  paymentStatus: z.string().min(1, 'Payment status is required'),
  needsLoan: z.boolean(),
  preferences: z
    .array(
      z.object({
        courseName: z.string().min(1, 'Pick a course'),
        /** Comma-separated; split into one preference per location on submit. */
        location: z.string().min(1, 'Enter at least one location'),
        priority: z.string().regex(NUMERIC_FIELD, 'Enter a number'),
      }),
    )
    .min(1, 'Add at least one study preference'),
});

type RegistrationFormValues = z.infer<typeof registrationSchema>;

type SectionId = 'student-info' | 'family-address' | 'preferences' | 'payment';

interface Section {
  id: SectionId;
  label: string;
  icon: LucideIcon;
  activeClass: string;
  iconClass: string;
  fields: Array<keyof RegistrationFormValues>;
}

const SECTIONS: readonly Section[] = [
  {
    id: 'student-info',
    label: 'Student info',
    icon: User,
    activeClass: 'bg-teal-600',
    iconClass: 'bg-teal-50 text-teal-700',
    fields: ['studentName', 'mobile', 'email', 'dateOfBirth'],
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
    id: 'preferences',
    label: 'Study preferences',
    icon: BookOpen,
    activeClass: 'bg-indigo-600',
    iconClass: 'bg-indigo-50 text-indigo-700',
    fields: ['preferences'],
  },
  {
    id: 'payment',
    label: 'Fee & payment',
    icon: Wallet,
    activeClass: 'bg-orange-600',
    iconClass: 'bg-orange-50 text-orange-600',
    fields: ['registrationFee', 'paymentMethod', 'paymentStatus', 'needsLoan'],
  },
];

function toFormValues(registration: Registration): RegistrationFormValues {
  const preferences = registration.preferences ?? [];
  return {
    studentName: registration.studentName ?? '',
    mobile: registration.mobile ?? '',
    email: registration.email ?? '',
    dateOfBirth: toDateInput(registration.date_of_birth),
    fatherName: registration.fatherName ?? '',
    motherName: registration.motherName ?? '',
    permanentAddress: registration.permanentAddress ?? '',
    registrationFee: fromNumber(registration.registrationFee),
    paymentMethod: registration.paymentMethod ?? 'Cash',
    paymentStatus: registration.paymentStatus ?? 'Pending',
    needsLoan: Boolean(registration.needsLoan),
    preferences:
      preferences.length > 0
        ? preferences.map((preference) => ({
            courseName: preference.courseName,
            location: preference.location,
            priority: fromNumber(preference.priority),
          }))
        : [{ courseName: '', location: '', priority: '1' }],
  };
}

/** `"Bangalore, Delhi"` becomes two preferences at the same priority. */
function expandPreferences(rows: RegistrationFormValues['preferences']): StudyPreference[] {
  return rows.flatMap((row) => {
    const priority = toNumber(row.priority, 1);
    return row.location
      .split(',')
      .map((location) => location.trim())
      .filter(Boolean)
      .map((location) => ({ courseName: row.courseName, location, priority }));
  });
}

interface ProfileRegistrationFormProps {
  initialData: Registration;
  onSubmit: (data: RegistrationInput) => void;
  isLoading: boolean;
}

export function ProfileRegistrationForm({ initialData, onSubmit, isLoading }: ProfileRegistrationFormProps) {
  const [activeSection, setActiveSection] = useState<SectionId>('student-info');

  const {
    register,
    control,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<RegistrationFormValues>({
    resolver: zodResolver(registrationSchema),
    defaultValues: toFormValues(initialData),
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'preferences' });

  const values = watch();

  const completion = useMemo(() => {
    const result: Record<SectionId, boolean> = {
      'student-info': false,
      'family-address': false,
      preferences: false,
      payment: false,
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

  const focusFirstError = () => {
    const invalid = Object.keys(errors)[0];
    if (!invalid) return;
    const section = SECTIONS.find((candidate) =>
      candidate.fields.some((field) => field === invalid || (field === 'preferences' && invalid.startsWith('preferences'))),
    );
    if (section) setActiveSection(section.id);
  };

  const submit = handleSubmit((formValues) => {
    // `RegistrationInput` uses the serializer's own field names, so the payload
    // is snake_case. Sending camelCase keys here would type-check against a
    // looser shape but arrive at the API as unrecognised fields and be dropped.
    onSubmit({
      student_name: formValues.studentName.trim(),
      mobile: formValues.mobile.trim(),
      email: formValues.email.trim(),
      // Omitted when blank: the PATCH then leaves the stored date alone rather
      // than clearing it with an empty string.
      date_of_birth: formValues.dateOfBirth || undefined,
      father_name: formValues.fatherName.trim(),
      mother_name: formValues.motherName.trim(),
      permanent_address: formValues.permanentAddress.trim(),
      registration_fee: toNumber(formValues.registrationFee),
      payment_method: formValues.paymentMethod,
      payment_status: formValues.paymentStatus,
      needs_loan: formValues.needsLoan,
      preferences: expandPreferences(formValues.preferences),
    });
  }, focusFirstError);

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 lg:flex-row lg:gap-6">
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
        {activeSection === 'student-info' && (
          <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <header className="flex items-center gap-3 border-b border-teal-100 bg-teal-50/50 px-4 py-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-100 text-teal-700">
                <User size={16} />
              </span>
              <div>
                <h3 className="text-sm font-bold text-slate-800">Student information</h3>
                <p className="text-xs text-slate-500">Identity and contact details</p>
              </div>
            </header>
            <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="reg-name">
                  Student name <span className="text-red-500">*</span>
                </Label>
                <Input id="reg-name" className={INPUT_CLASS} {...register('studentName')} />
                {errors.studentName && <p className="text-xs text-red-600">{errors.studentName.message}</p>}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="reg-mobile" className="flex items-center gap-1">
                  <Phone size={12} /> Mobile <span className="text-red-500">*</span>
                </Label>
                <Input id="reg-mobile" inputMode="tel" className={INPUT_CLASS} {...register('mobile')} />
                {errors.mobile && <p className="text-xs text-red-600">{errors.mobile.message}</p>}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="reg-email" className="flex items-center gap-1">
                  <Mail size={12} /> Email <span className="text-red-500">*</span>
                </Label>
                <Input id="reg-email" type="email" className={INPUT_CLASS} {...register('email')} />
                {errors.email && <p className="text-xs text-red-600">{errors.email.message}</p>}
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="reg-dob">Date of birth</Label>
                <Input id="reg-dob" type="date" className={INPUT_CLASS} {...register('dateOfBirth')} />
                <p className="flex items-start gap-1.5 text-xs text-slate-500">
                  <Info size={12} className="mt-0.5 shrink-0" />
                  The API accepts a date of birth but does not return one, so this box always starts empty. Leave it
                  blank to keep whatever is already stored.
                </p>
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
            <div className="space-y-4 p-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="reg-father">
                    Father&apos;s name <span className="text-red-500">*</span>
                  </Label>
                  <Input id="reg-father" className={INPUT_CLASS} {...register('fatherName')} />
                  {errors.fatherName && <p className="text-xs text-red-600">{errors.fatherName.message}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reg-mother">
                    Mother&apos;s name <span className="text-red-500">*</span>
                  </Label>
                  <Input id="reg-mother" className={INPUT_CLASS} {...register('motherName')} />
                  {errors.motherName && <p className="text-xs text-red-600">{errors.motherName.message}</p>}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="reg-address" className="flex items-center gap-1">
                  <MapPin size={12} /> Permanent address <span className="text-red-500">*</span>
                </Label>
                <Input id="reg-address" className={INPUT_CLASS} {...register('permanentAddress')} />
                {errors.permanentAddress && <p className="text-xs text-red-600">{errors.permanentAddress.message}</p>}
              </div>
            </div>
          </section>
        )}

        {activeSection === 'preferences' && (
          <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <header className="flex items-center gap-3 border-b border-indigo-100 bg-indigo-50/50 px-4 py-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700">
                <BookOpen size={16} />
              </span>
              <div>
                <h3 className="text-sm font-bold text-slate-800">Study preferences</h3>
                <p className="text-xs text-slate-500">Course and location choices, in priority order</p>
              </div>
            </header>
            <div className="space-y-3 p-4">
              {fields.map((field, index) => (
                <div
                  key={field.id}
                  className="grid grid-cols-1 gap-3 rounded-lg border border-slate-100 bg-slate-50 p-3 sm:grid-cols-[1fr_1fr_5rem_auto] sm:items-end"
                >
                  <div className="space-y-1.5">
                    <Label htmlFor={`pref-course-${index}`} className="text-xs">
                      Course
                    </Label>
                    <Controller
                      control={control}
                      name={`preferences.${index}.courseName`}
                      render={({ field: courseField }) => (
                        <Select value={courseField.value} onValueChange={courseField.onChange}>
                          <SelectTrigger id={`pref-course-${index}`} className={`${INPUT_CLASS} w-full`}>
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
                    {errors.preferences?.[index]?.courseName && (
                      <p className="text-xs text-red-600">{errors.preferences[index]?.courseName?.message}</p>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor={`pref-location-${index}`} className="text-xs">
                      Location
                    </Label>
                    <Input
                      id={`pref-location-${index}`}
                      placeholder="Bangalore, Delhi"
                      className={INPUT_CLASS}
                      {...register(`preferences.${index}.location`)}
                    />
                    {errors.preferences?.[index]?.location && (
                      <p className="text-xs text-red-600">{errors.preferences[index]?.location?.message}</p>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor={`pref-priority-${index}`} className="text-xs">
                      Priority
                    </Label>
                    <Input
                      id={`pref-priority-${index}`}
                      inputMode="numeric"
                      className={INPUT_CLASS}
                      {...register(`preferences.${index}.priority`)}
                    />
                  </div>

                  <Button
                    type="button"
                    variant="ghost"
                    className="h-10 w-full text-red-500 hover:bg-red-50 hover:text-red-600 sm:w-10 sm:p-0"
                    onClick={() => remove(index)}
                    disabled={fields.length === 1}
                    title={fields.length === 1 ? 'At least one preference is required' : 'Remove this preference'}
                  >
                    <Trash2 size={16} />
                    <span className="ml-2 sm:sr-only">Remove</span>
                  </Button>
                </div>
              ))}

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 border-teal-200 text-teal-600 hover:bg-teal-50"
                  onClick={() => append({ courseName: '', location: '', priority: String(fields.length + 1) })}
                >
                  <Plus size={14} className="mr-1" /> Add preference
                </Button>
                <p className="text-xs text-slate-500">
                  Separate multiple locations with commas — each becomes its own preference.
                </p>
              </div>

              {errors.preferences?.root && <p className="text-xs text-red-600">{errors.preferences.root.message}</p>}
            </div>
          </section>
        )}

        {activeSection === 'payment' && (
          <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <header className="flex items-center gap-3 border-b border-orange-100 bg-orange-50/50 px-4 py-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-100 text-orange-600">
                <Wallet size={16} />
              </span>
              <div>
                <h3 className="text-sm font-bold text-slate-800">Fee &amp; payment</h3>
                <p className="text-xs text-slate-500">What was charged and how it was settled</p>
              </div>
            </header>
            <div className="space-y-4 p-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="reg-fee">Registration fee</Label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-500">₹</span>
                    <Input id="reg-fee" inputMode="decimal" className={`${INPUT_CLASS} pl-7`} {...register('registrationFee')} />
                  </div>
                  {errors.registrationFee && <p className="text-xs text-red-600">{errors.registrationFee.message}</p>}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="reg-method">Payment method</Label>
                  <Controller
                    name="paymentMethod"
                    control={control}
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger id="reg-method" className={`${INPUT_CLASS} w-full`}>
                          <SelectValue />
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

                <div className="space-y-1.5">
                  <Label htmlFor="reg-payment-status">Payment status</Label>
                  <Controller
                    name="paymentStatus"
                    control={control}
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger id="reg-payment-status" className={`${INPUT_CLASS} w-full`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PAYMENT_STATUSES.map((status) => (
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

              <div className="flex w-fit items-center gap-2 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                <Controller
                  name="needsLoan"
                  control={control}
                  render={({ field }) => (
                    <Checkbox
                      id="reg-needs-loan"
                      checked={field.value}
                      onCheckedChange={(checked) => field.onChange(checked === true)}
                    />
                  )}
                />
                <Label htmlFor="reg-needs-loan" className="cursor-pointer text-xs font-medium">
                  Needs an education loan
                </Label>
              </div>
            </div>
          </section>
        )}

        <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-center gap-1.5 text-xs text-slate-500">
            <Lock size={12} className="shrink-0" />
            Documents are managed on the Documents tab, not from this form.
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
