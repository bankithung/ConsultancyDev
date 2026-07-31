'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import {
  ArrowRight,
  CheckCircle,
  Clock,
  FileText,
  GraduationCap,
  Mail,
  MapPin,
  Pencil,
  Phone,
  UserCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { apiClient, type EnquiryInput } from '@/lib/apiClient';
// RegistrationInput is defined in lib/types (apiClient only imports it), so it
// must come from there — a type re-imported into a module is not re-exported.
import type { RegistrationInput } from '@/lib/types';
import type { Enquiry, Enrollment, Registration } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { BackButton } from '@/components/ui/back-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ErrorState, LoadingState } from '@/components/common/states';
import { useUIStore } from '@/store/uiStore';
import { toast } from '@/store/toastStore';
import { formatCurrency, sameName, type ProfileType } from '../constants';
import type { PaymentStage } from './PaymentFormModal';
import { ProfileEnquiryForm } from './ProfileEnquiryForm';
import { ProfileRegistrationForm } from './ProfileRegistrationForm';
import { PaymentHistory } from './PaymentHistory';
import { RefundHistory } from './RefundHistory';
import { DocumentList } from './DocumentList';
import { PhysicalDocumentList } from './PhysicalDocumentList';
import { StudentRemarkList } from './StudentRemarkList';
import { EnrollmentEditModal } from './EnrollmentEditModal';

interface StudentProfileViewProps {
  type: ProfileType;
  id: string;
}

/** The record the URL points at, narrowed so each branch keeps its own type. */
type PrimaryRecord =
  | { kind: 'enquiry'; enquiry: Enquiry }
  | { kind: 'registration'; registration: Registration }
  | { kind: 'enrollment'; enrollment: Enrollment };

const PAYMENT_STAGE: Record<ProfileType, PaymentStage> = {
  enquiry: 'Enquiry',
  registration: 'Registration',
  enrollment: 'Enrollment',
};

const TYPE_BADGE: Record<ProfileType, string> = {
  enquiry: 'border-blue-500/30 bg-blue-500/20 text-blue-100',
  registration: 'border-purple-500/30 bg-purple-500/20 text-purple-100',
  enrollment: 'border-emerald-500/30 bg-emerald-500/20 text-emerald-100',
};

function SidebarDetail({ icon: Icon, value, label }: { icon: LucideIcon; value?: string | null; label: string }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-3 text-sm">
      <Icon size={16} className="mt-0.5 shrink-0 text-slate-400" />
      <div className="flex min-w-0 flex-col">
        <span className="break-words font-medium leading-tight text-slate-700">{value}</span>
        <span className="text-[10px] uppercase tracking-wide text-slate-400">{label}</span>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  icon: Icon,
  className = '',
}: {
  label: string;
  value: React.ReactNode;
  icon?: LucideIcon;
  className?: string;
}) {
  const isBlank = value === null || value === undefined || value === '';
  return (
    <div className={`flex min-w-0 flex-col ${className}`}>
      <div className="mb-0.5 flex shrink-0 items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-400">
        {Icon && <Icon size={10} className="shrink-0" />}
        <span className="truncate">{label}</span>
      </div>
      <div className="break-words text-sm font-medium leading-snug text-slate-800">
        {isBlank ? <span className="text-xs italic text-slate-300">N/A</span> : value}
      </div>
    </div>
  );
}

function SectionHeader({ title, icon: Icon }: { title: string; icon?: LucideIcon }) {
  return (
    <div className="flex items-center gap-2">
      {Icon && <Icon size={14} className="text-slate-500" />}
      <h3 className="text-xs font-bold uppercase tracking-widest text-slate-700">{title}</h3>
    </div>
  );
}

export function StudentProfileView({ type, id }: StudentProfileViewProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const setPageTitle = useUIStore((state) => state.setPageTitle);

  const [activeTab, setActiveTab] = useState('overview');
  const [journeyView, setJourneyView] = useState<ProfileType>(type);
  const [documentView, setDocumentView] = useState<'digital' | 'physical'>('digital');
  const [isEditingEnrollment, setIsEditingEnrollment] = useState(false);

  /* ---------------------------------------------------------------------- */
  /* Records                                                                 */
  /* ---------------------------------------------------------------------- */

  const primaryQuery = useQuery({
    queryKey: ['student-profile', type, id],
    queryFn: async (): Promise<PrimaryRecord> => {
      if (type === 'enquiry') return { kind: 'enquiry', enquiry: await apiClient.enquiries.get(id) };
      if (type === 'registration') return { kind: 'registration', registration: await apiClient.registrations.get(id) };
      return { kind: 'enrollment', enrollment: await apiClient.enrollments.get(id) };
    },
  });

  const primary = primaryQuery.data;
  const enrollment = primary?.kind === 'enrollment' ? primary.enrollment : null;

  // An enrollment carries the registration it belongs to in `student`.
  const linkedRegistrationId = enrollment ? String(enrollment.student) : null;

  const linkedRegistrationQuery = useQuery({
    queryKey: ['registrations', linkedRegistrationId],
    queryFn: () => apiClient.registrations.get(linkedRegistrationId as string),
    enabled: linkedRegistrationId !== null,
  });

  const registration: Registration | null =
    primary?.kind === 'registration' ? primary.registration : (linkedRegistrationQuery.data ?? null);

  // A registration keeps the FK back to the enquiry it was converted from.
  const linkedEnquiryId =
    registration?.enquiry === null || registration?.enquiry === undefined ? null : String(registration.enquiry);

  const linkedEnquiryQuery = useQuery({
    queryKey: ['enquiries', linkedEnquiryId],
    queryFn: () => apiClient.enquiries.get(linkedEnquiryId as string),
    enabled: type !== 'enquiry' && linkedEnquiryId !== null,
  });

  const enquiry: Enquiry | null =
    primary?.kind === 'enquiry' ? primary.enquiry : (linkedEnquiryQuery.data ?? null);

  const studentName =
    enrollment?.studentName || registration?.studentName || enquiry?.candidateName || 'Student';

  useEffect(() => {
    if (studentName !== 'Student') setPageTitle(studentName);
    return () => setPageTitle(null);
  }, [studentName, setPageTitle]);

  // The journey toggle defaults to the stage the profile was opened at, but that
  // stage may have no record once the links resolve (e.g. an enrollment with no
  // findable enquiry). Fall back to something that exists.
  useEffect(() => {
    const available: ProfileType[] = [];
    if (enquiry) available.push('enquiry');
    if (registration) available.push('registration');
    if (enrollment) available.push('enrollment');
    if (available.length > 0 && !available.includes(journeyView)) setJourneyView(available[0]);
  }, [enquiry, registration, enrollment, journeyView]);

  /* ---------------------------------------------------------------------- */
  /* Mutations                                                               */
  /* ---------------------------------------------------------------------- */

  const updateEnquiryMutation = useMutation({
    mutationFn: (data: EnquiryInput) => {
      if (!enquiry) throw new Error('No enquiry is linked to this student.');
      return apiClient.enquiries.update(enquiry.id, data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['student-profile'] });
      void queryClient.invalidateQueries({ queryKey: ['enquiries'] });
      toast.success('Enquiry updated');
    },
    onError: () => toast.error('Could not update the enquiry'),
  });

  const updateRegistrationMutation = useMutation({
    mutationFn: (data: RegistrationInput) => {
      if (!registration) throw new Error('No registration is linked to this student.');
      return apiClient.registrations.update(registration.id, data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['student-profile'] });
      void queryClient.invalidateQueries({ queryKey: ['registrations'] });
      toast.success('Registration updated');
    },
    onError: () => toast.error('Could not update the registration'),
  });

  /* ---------------------------------------------------------------------- */
  /* Derived view data                                                       */
  /* ---------------------------------------------------------------------- */

  const steps = useMemo(
    () => [
      { label: 'Enquiry', date: enquiry?.date ?? null, active: Boolean(enquiry) },
      { label: 'Registration', date: registration?.registrationDate ?? null, active: Boolean(registration) },
      { label: 'Enrollment', date: enrollment?.startDate ?? null, active: Boolean(enrollment) },
    ],
    [enquiry, registration, enrollment],
  );

  const subjectMarks = useMemo(
    () => [
      { label: 'Physics', value: enquiry?.physicsMarks },
      { label: 'Chemistry', value: enquiry?.chemistryMarks },
      { label: 'Biology', value: enquiry?.biologyMarks },
      { label: 'Maths', value: enquiry?.mathsMarks },
    ],
    [enquiry],
  );

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  if (primaryQuery.isLoading) {
    return (
      <div className="mx-auto max-w-[1600px] px-4 py-6">
        <LoadingState rows={6} label="Loading student profile" />
      </div>
    );
  }

  if (primaryQuery.isError || !primary) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10">
        <ErrorState
          error={primaryQuery.error ?? 'That record could not be found.'}
          onRetry={() => void primaryQuery.refetch()}
          title="Could not load this student"
        />
      </div>
    );
  }

  const journeyOptions: Array<{ value: ProfileType; label: string; available: boolean }> = [
    { value: 'enquiry', label: 'Enquiry', available: Boolean(enquiry) },
    { value: 'registration', label: 'Registration', available: Boolean(registration) },
    { value: 'enrollment', label: 'Enrollment', available: Boolean(enrollment) },
  ];

  return (
    <div className="mx-auto min-h-screen max-w-[1600px] bg-slate-50/30 px-3 py-2 sm:px-4 lg:px-6">
      <div className="mb-3 flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
        <BackButton />
        <div className="flex flex-wrap gap-2">
          {type === 'enquiry' && (
            <Button
              size="sm"
              className="h-9 bg-emerald-600 text-xs shadow-sm hover:bg-emerald-700 sm:text-sm"
              onClick={() => router.push(`/app/registrations/new?enquiryId=${id}`)}
            >
              <span className="hidden sm:inline">Convert to registration</span>
              <span className="sm:hidden">Convert</span>
              <ArrowRight className="ml-1.5 h-4 w-4" />
            </Button>
          )}
          {type === 'registration' && (
            <Button
              size="sm"
              className="h-9 bg-purple-600 text-xs shadow-sm hover:bg-purple-700 sm:text-sm"
              onClick={() => router.push(`/app/enrollments/new?regId=${id}`)}
            >
              <span className="hidden sm:inline">Enroll student</span>
              <span className="sm:hidden">Enroll</span>
              <GraduationCap className="ml-1.5 h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12 lg:gap-6">
        {/* Identity rail */}
        <div className="space-y-4 lg:col-span-4 xl:col-span-3">
          <Card className="overflow-hidden border border-slate-200 shadow-sm">
            <CardHeader className="flex flex-col items-center bg-gradient-to-br from-slate-900 to-slate-800 p-6 text-center">
              <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-white/10 text-3xl font-bold text-white shadow-inner ring-2 ring-white/20">
                {studentName.charAt(0).toUpperCase()}
              </div>
              <h1 className="text-xl font-bold leading-tight text-white">{studentName}</h1>
              <span
                className={`mt-2 rounded border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${TYPE_BADGE[type]}`}
              >
                {type}
              </span>
              {registration?.registrationNo && (
                <code className="mt-2 rounded bg-white/10 px-2 py-0.5 font-mono text-[10px] text-slate-200">
                  {registration.registrationNo}
                </code>
              )}
            </CardHeader>
            <CardContent className="space-y-4 p-5">
              <SidebarDetail icon={Phone} value={registration?.mobile || enquiry?.mobile} label="Mobile" />
              <SidebarDetail icon={Mail} value={registration?.email || enquiry?.email} label="Email" />
              <SidebarDetail
                icon={MapPin}
                value={registration?.permanentAddress || enquiry?.permanentAddress}
                label="Address"
              />
            </CardContent>
          </Card>

          <Card className="border border-slate-200 shadow-sm">
            <CardHeader className="border-b border-slate-100 bg-slate-50/50 px-4 py-3">
              <SectionHeader title="Family" icon={UserCircle} />
            </CardHeader>
            <CardContent className="p-3.5">
              <div className="grid grid-cols-2 gap-x-3 gap-y-3">
                <div>
                  <DetailRow label="Father" value={registration?.fatherName || enquiry?.fatherName} />
                  {enquiry?.fatherOccupation && (
                    <p className="mt-0.5 pl-0.5 text-[10px] font-medium text-slate-400">{enquiry.fatherOccupation}</p>
                  )}
                  {enquiry?.fatherMobile && (
                    <p className="pl-0.5 text-[10px] text-slate-400">{enquiry.fatherMobile}</p>
                  )}
                </div>
                <div>
                  <DetailRow label="Mother" value={registration?.motherName || enquiry?.motherName} />
                  {enquiry?.motherOccupation && (
                    <p className="mt-0.5 pl-0.5 text-[10px] font-medium text-slate-400">{enquiry.motherOccupation}</p>
                  )}
                  {enquiry?.motherMobile && (
                    <p className="pl-0.5 text-[10px] text-slate-400">{enquiry.motherMobile}</p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {type !== 'enquiry' && linkedEnquiryId === null && registration && (
            <p className="rounded-lg border border-dashed border-slate-300 bg-white px-3 py-2.5 text-xs text-slate-500">
              This registration was created directly rather than converted from an enquiry, so there is no enquiry to
              show.
            </p>
          )}
        </div>

        {/* Main column */}
        <div className="space-y-4 lg:col-span-8 xl:col-span-9">
          <ol className="flex flex-col items-stretch gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm sm:flex-row sm:items-center sm:gap-0">
            {steps.map((step, index) => (
              <li
                key={step.label}
                className={`flex flex-1 items-center ${
                  index < steps.length - 1
                    ? 'border-b border-slate-100 pb-3 sm:mr-4 sm:border-b-0 sm:border-r sm:pb-0 sm:pr-4'
                    : ''
                }`}
              >
                <span
                  className={`mr-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors ${
                    step.active ? 'bg-teal-600 text-white shadow-md shadow-teal-200' : 'bg-slate-100 text-slate-300'
                  }`}
                >
                  {step.active ? <CheckCircle size={16} /> : <span className="h-2 w-2 rounded-full bg-slate-300" />}
                </span>
                <span className="min-w-0">
                  <span
                    className={`block text-[11px] font-bold uppercase tracking-wide ${
                      step.active ? 'text-teal-700' : 'text-slate-400'
                    }`}
                  >
                    {step.label}
                  </span>
                  <span className="block text-[10px] font-medium text-slate-500">
                    {step.date ? format(new Date(step.date), 'dd MMM yyyy') : 'Pending'}
                  </span>
                </span>
              </li>
            ))}
          </ol>

          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <div className="mb-4 overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
              <TabsList className="h-11 w-max min-w-full justify-start gap-1 bg-white px-2 sm:gap-4">
                {[
                  { value: 'overview', label: 'Overview', show: true },
                  { value: 'journey', label: 'Journey', show: Boolean(enquiry || registration || enrollment) },
                  { value: 'documents', label: 'Documents', show: true },
                  { value: 'payments', label: 'Payments', show: true },
                  { value: 'refunds', label: 'Refunds', show: true },
                  { value: 'remarks', label: 'Remarks', show: Boolean(registration) },
                ]
                  .filter((tab) => tab.show)
                  .map((tab) => (
                    <TabsTrigger
                      key={tab.value}
                      value={tab.value}
                      className="h-11 whitespace-nowrap rounded-none border-b-2 border-transparent px-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500 transition-all hover:text-slate-800 data-[state=active]:border-teal-600 data-[state=active]:text-teal-600 data-[state=active]:shadow-none sm:px-3 sm:text-xs"
                    >
                      {tab.label}
                    </TabsTrigger>
                  ))}
              </TabsList>
            </div>

            {/* Overview */}
            <TabsContent value="overview" className="mt-0 space-y-4 focus-visible:outline-none">
              <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-50">
                      <GraduationCap className="text-slate-400" size={18} />
                    </span>
                    <span>
                      <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-widest text-slate-400">
                        Target course
                      </span>
                      <span className="block text-base font-bold text-slate-800 sm:text-lg">
                        {registration?.preferences?.[0]?.courseName || enquiry?.courseInterested || 'Not specified'}
                      </span>
                    </span>
                  </div>
                  <div className="flex flex-wrap items-start gap-x-6 gap-y-3 sm:border-l sm:border-slate-100 sm:pl-6">
                    <DetailRow
                      label="Preferred locations"
                      value={
                        enquiry?.preferredLocations?.length
                          ? enquiry.preferredLocations.join(', ')
                          : enquiry?.otherLocation
                      }
                    />
                    <DetailRow
                      label="Needs loan"
                      value={registration ? (registration.needsLoan ? 'Yes' : 'No') : null}
                    />
                    <DetailRow
                      label="College dropout"
                      value={enquiry ? (enquiry.collegeDropout ? 'Yes' : 'No') : null}
                    />
                  </div>
                </div>
              </div>

              <Card className="border border-slate-200 shadow-sm">
                <CardHeader className="border-b border-slate-100 bg-slate-50/50 px-4 py-3">
                  <SectionHeader title="Academic background" icon={FileText} />
                </CardHeader>
                <CardContent className="p-0">
                  {enquiry ? (
                    <>
                      <div className="grid grid-cols-1 divide-y divide-slate-100 md:grid-cols-2 md:divide-x md:divide-y-0">
                        <div className="space-y-4 p-5">
                          <div className="mb-2 flex items-center gap-2">
                            <span className="h-2 w-2 rounded-full bg-blue-500" />
                            <h4 className="text-sm font-bold text-slate-800">Class 12</h4>
                          </div>
                          <div className="grid grid-cols-2 gap-4">
                            <DetailRow label="School" value={enquiry.schoolName} />
                            <DetailRow label="Stream" value={enquiry.stream} />
                            <DetailRow label="Passing year" value={enquiry.class12PassingYear} />
                            <DetailRow
                              label="Gap year"
                              value={
                                enquiry.gapYear ? (
                                  <span className="inline-flex items-center gap-1 rounded border border-orange-100 bg-orange-50 px-1.5 py-0.5 text-[10px] font-bold uppercase text-orange-800">
                                    <Clock size={10} /> Yes
                                  </span>
                                ) : (
                                  'No'
                                )
                              }
                            />
                          </div>
                        </div>

                        <div className="space-y-4 p-5">
                          <div className="mb-2 flex items-center gap-2">
                            <span className="h-2 w-2 rounded-full bg-indigo-500" />
                            <h4 className="text-sm font-bold text-slate-800">Subject metrics</h4>
                          </div>
                          <div className="grid grid-cols-2 gap-4">
                            <DetailRow label="PCB %" value={enquiry.pcbPercentage} />
                            <DetailRow label="PCM %" value={enquiry.pcmPercentage} />
                          </div>
                          <div className="grid grid-cols-4 gap-2 border-t border-slate-50 pt-2">
                            {subjectMarks.map((mark) => (
                              <DetailRow key={mark.label} label={mark.label} value={mark.value} />
                            ))}
                          </div>
                        </div>
                      </div>

                      <div className="border-t border-slate-100 bg-slate-50/30 p-5">
                        <div className="mb-3 flex items-center gap-2">
                          <span className="rounded bg-amber-100 p-1 text-amber-600">
                            <GraduationCap size={12} />
                          </span>
                          <h4 className="text-xs font-bold uppercase tracking-widest text-slate-700">
                            Competitive exams
                          </h4>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <DetailRow
                            label="Previous NEET"
                            value={enquiry.previousNeetMarks}
                            className="rounded bg-white p-2"
                          />
                          <DetailRow
                            label="Present NEET"
                            value={enquiry.presentNeetMarks}
                            className="rounded border border-emerald-100/50 bg-emerald-50/50 p-2"
                          />
                        </div>
                      </div>
                    </>
                  ) : (
                    <p className="p-6 text-center text-sm text-slate-500">
                      Academic background is captured on the enquiry, and no enquiry is linked to this student.
                    </p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Journey */}
            <TabsContent value="journey" className="mt-0 focus-visible:outline-none">
              <Card className="border border-slate-200 shadow-sm">
                <CardHeader className="border-b border-slate-100 px-3 py-2.5 sm:px-4">
                  <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-0.5">
                    {journeyOptions
                      .filter((option) => option.available)
                      .map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => setJourneyView(option.value)}
                          aria-pressed={journeyView === option.value}
                          className={`rounded-md px-2.5 py-1 text-[10px] font-bold uppercase transition-all sm:px-3 ${
                            journeyView === option.value
                              ? 'bg-white text-slate-900 shadow-sm'
                              : 'text-slate-500 hover:text-slate-700'
                          }`}
                        >
                          {option.label}
                        </button>
                      ))}
                  </div>
                </CardHeader>
                <CardContent className="p-3 sm:p-5">
                  {journeyView === 'enquiry' && enquiry && (
                    <ProfileEnquiryForm
                      initialData={enquiry}
                      onSubmit={(data) => updateEnquiryMutation.mutate(data)}
                      isLoading={updateEnquiryMutation.isPending}
                    />
                  )}

                  {journeyView === 'registration' && registration && (
                    <ProfileRegistrationForm
                      initialData={registration}
                      onSubmit={(data) => updateRegistrationMutation.mutate(data)}
                      isLoading={updateRegistrationMutation.isPending}
                    />
                  )}

                  {journeyView === 'enrollment' && enrollment && (
                    <div className="space-y-6">
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                        <div className="flex items-center gap-2">
                          <span className="rounded-md bg-teal-100 p-1.5 text-teal-700">
                            <GraduationCap size={16} />
                          </span>
                          <div>
                            <h4 className="text-sm font-bold text-slate-800">Program details</h4>
                            <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                              {enrollment.enrollmentNo}
                            </p>
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-9 text-xs text-slate-500 hover:bg-teal-50 hover:text-teal-700"
                          onClick={() => setIsEditingEnrollment(true)}
                        >
                          <Pencil size={12} className="mr-1.5" /> Edit details
                        </Button>
                      </div>

                      <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-2">
                        <div className="space-y-4 rounded-lg border border-slate-100 bg-slate-50/50 p-4">
                          <h5 className="text-xs font-bold uppercase tracking-widest text-slate-400">Academic</h5>
                          <div className="grid grid-cols-2 gap-4">
                            <DetailRow label="Program" value={enrollment.programName} />
                            <DetailRow label="University" value={enrollment.university_name} />
                            <DetailRow label="Country" value={enrollment.country} />
                            <DetailRow
                              label="Start date"
                              value={enrollment.startDate ? format(new Date(enrollment.startDate), 'dd MMM yyyy') : null}
                            />
                            <DetailRow label="Duration" value={`${enrollment.durationMonths} months`} />
                            <DetailRow
                              label="Status"
                              value={
                                <span
                                  className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${
                                    enrollment.status === 'Active'
                                      ? 'bg-emerald-100 text-emerald-700'
                                      : 'bg-slate-100 text-slate-600'
                                  }`}
                                >
                                  {enrollment.status}
                                </span>
                              }
                            />
                          </div>
                        </div>

                        <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                          <h5 className="text-xs font-bold uppercase tracking-widest text-slate-400">Commercials</h5>
                          <dl className="space-y-2 text-sm">
                            <div className="flex justify-between">
                              <dt className="text-slate-500">Commission</dt>
                              <dd className="font-medium text-slate-700">
                                {formatCurrency(enrollment.commission_amount)}
                              </dd>
                            </div>
                            <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2">
                              <dt className="font-bold text-slate-800">Total fees</dt>
                              <dd className="text-lg font-bold text-teal-600">
                                {formatCurrency(enrollment.totalFees)}
                              </dd>
                            </div>
                          </dl>
                          {/* The old build broke this into service charge / school
                              fees / hostel fees. Those columns do not exist on the
                              rebuilt server, so only the real total is shown. */}
                        </div>
                      </div>

                      {enrollment.installments && enrollment.installments.length > 0 && (
                          <div className="border-t border-slate-100 pt-4">
                            <h5 className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-400">
                              Installment schedule
                            </h5>
                            <div className="overflow-x-auto rounded-lg border border-slate-200">
                              <table className="w-full min-w-[420px] text-left text-sm">
                                <thead className="bg-slate-50 text-[10px] font-bold uppercase text-slate-500">
                                  <tr>
                                    <th scope="col" className="px-3 py-2">
                                      No
                                    </th>
                                    <th scope="col" className="px-3 py-2">
                                      Due date
                                    </th>
                                    <th scope="col" className="px-3 py-2 text-right">
                                      Amount
                                    </th>
                                    <th scope="col" className="px-3 py-2 text-center">
                                      Status
                                    </th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100 bg-white">
                                  {enrollment.installments.map((installment) => (
                                    <tr key={installment.number}>
                                      <td className="px-3 py-2 font-medium text-slate-700">#{installment.number}</td>
                                      <td className="px-3 py-2 text-slate-500">
                                        {installment.due_date
                                          ? format(new Date(installment.due_date), 'dd MMM yyyy')
                                          : '—'}
                                      </td>
                                      <td className="px-3 py-2 text-right font-medium text-slate-700">
                                        {formatCurrency(installment.amount)}
                                      </td>
                                      <td className="px-3 py-2 text-center">
                                        <span
                                          className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                                            installment.status === 'Paid'
                                              ? 'bg-emerald-100 text-emerald-700'
                                              : installment.status === 'Overdue'
                                                ? 'bg-red-100 text-red-700'
                                                : 'bg-amber-50 text-amber-700'
                                          }`}
                                        >
                                          {installment.status}
                                        </span>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Documents */}
            <TabsContent value="documents" className="mt-0 focus-visible:outline-none">
              <Card className="border border-slate-200 shadow-sm">
                <CardHeader className="flex flex-col gap-2 border-b border-slate-100 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:px-4">
                  <CardTitle className="text-sm font-bold text-slate-700">Student documents</CardTitle>
                  <div className="flex rounded-lg bg-slate-100 p-0.5">
                    <button
                      type="button"
                      onClick={() => setDocumentView('digital')}
                      aria-pressed={documentView === 'digital'}
                      className={`rounded-md px-3 py-1 text-[10px] font-bold uppercase transition-all ${
                        documentView === 'digital' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500'
                      }`}
                    >
                      Digital
                    </button>
                    <button
                      type="button"
                      onClick={() => setDocumentView('physical')}
                      aria-pressed={documentView === 'physical'}
                      className={`rounded-md px-3 py-1 text-[10px] font-bold uppercase transition-all ${
                        documentView === 'physical' ? 'bg-white text-amber-700 shadow-sm' : 'text-slate-500'
                      }`}
                    >
                      Physical
                    </button>
                  </div>
                </CardHeader>
                <CardContent className="p-3 sm:p-4">
                  {documentView === 'digital' ? (
                    <DocumentList studentName={studentName} registrationNo={registration?.registrationNo} />
                  ) : registration ? (
                    <PhysicalDocumentList registrationId={registration.id} />
                  ) : (
                    <p className="py-6 text-center text-sm text-slate-500">
                      Physical document custody is tracked against a registration. This student does not have one yet.
                    </p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Payments */}
            <TabsContent value="payments" className="mt-0 focus-visible:outline-none">
              <Card className="border border-slate-200 shadow-sm">
                <CardHeader className="border-b border-slate-100 px-4 py-3">
                  <CardTitle className="text-sm font-bold">Payments</CardTitle>
                </CardHeader>
                <CardContent className="p-3 sm:p-4">
                  <PaymentHistory
                    studentName={studentName}
                    stage={PAYMENT_STAGE[type]}
                    registrationId={registration?.id ?? null}
                    enrollmentId={enrollment?.id ?? null}
                  />
                </CardContent>
              </Card>
            </TabsContent>

            {/* Refunds */}
            <TabsContent value="refunds" className="mt-0 focus-visible:outline-none">
              <Card className="border border-slate-200 shadow-sm">
                <CardHeader className="border-b border-slate-100 px-4 py-3">
                  <CardTitle className="text-sm font-bold">Refund history</CardTitle>
                </CardHeader>
                <CardContent className="p-3 sm:p-4">
                  <RefundHistory studentName={studentName} registrationId={registration?.id ?? null} />
                </CardContent>
              </Card>
            </TabsContent>

            {/* Remarks */}
            <TabsContent value="remarks" className="mt-0 focus-visible:outline-none">
              {registration && <StudentRemarkList registrationId={registration.id} />}
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {enrollment && (
        <EnrollmentEditModal
          open={isEditingEnrollment}
          onClose={() => setIsEditingEnrollment(false)}
          enrollment={enrollment}
          onSaved={() => {
            void queryClient.invalidateQueries({ queryKey: ['student-profile', type, id] });
          }}
        />
      )}
    </div>
  );
}

