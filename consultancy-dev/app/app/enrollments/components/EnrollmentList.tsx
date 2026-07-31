'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import * as Dialog from '@radix-ui/react-dialog';
import {
  CreditCard,
  Edit,
  Eye,
  FileText,
  GraduationCap,
  Loader2,
  Mail,
  Phone,
  Plus,
  RefreshCw,
  Trash2,
  UserCircle,
  X,
} from 'lucide-react';

import { apiClient } from '@/lib/apiClient';
import { getApiErrorMessage } from '@/lib/api';
import type {
  Enrollment,
  EnrollmentInput,
  Registration,
  RegistrationInput,
  StudentDocument,
  StudentDocumentInput,
  University,
} from '@/lib/types';
import { toArray } from '@/components/common/pagination';
import { PaginationBar } from '@/components/common/PaginationBar';
import { EmptyState, ErrorBanner, ErrorState, InlineSpinner, LoadingState } from '@/components/common/states';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { useDebounce } from '@/hooks/useDebounce';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RequestActionModal } from '@/components/ui/RequestActionModal';
import { DocumentUpload } from '@/components/common/DocumentUpload';
import { ExistingDocumentsList } from '@/components/common/ExistingDocumentsList';
import { TransferStudentModal } from '@/components/common/TransferStudentModal';
import { useCurrentRole } from '@/components/rbac/useCurrentRole';
import { toast } from '@/store/toastStore';
import { getAvatarColor, getInitials } from '@/lib/utils';

/**
 * Enrollment register.
 *
 * Every list response is the `{count, pages, page, page_size, results}`
 * envelope, so paging, searching and filtering all happen server-side through
 * `usePaginatedQuery` — a client-side `.filter()` over one page of 25 would
 * silently hide rows and report the wrong totals.
 *
 * FILTERS: `EnrollmentViewSet.filterset_fields` is (`status`, `branch`,
 * `country`) and nothing else. The old build also offered payment type,
 * program, gender, state and board; none of them exist server-side (the last
 * three are not even fields on an enrollment), so each one matched everything
 * and quietly lied about it. They are gone rather than reimplemented on a
 * single page of rows.
 */

const STATUS_OPTIONS = ['Active', 'Completed', 'Dropped'] as const;


/** Sentinel for "not in the catalogue" — reveals the free-text name field. */
const OTHER_UNIVERSITY = 'other';

/** `₹1,20,000` — Indian digit grouping, no decimals. */
function formatCurrency(value: number | null | undefined): string {
  return `₹${Number(value ?? 0).toLocaleString('en-IN')}`;
}

/** Renders a number into a text field without turning 0 into ''. */
function fromNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

function toNumber(value: string, fallback = 0): number {
  const trimmed = value.trim();
  if (trimmed === '') return fallback;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** `2026-07-30T00:00:00Z` -> `2026-07-30`, for `<input type="date">`. */
function toDateInput(value: string | null | undefined): string {
  if (!value) return '';
  return value.split('T')[0] ?? '';
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : format(parsed, 'dd MMM yyyy');
}

const STATUS_BADGE: Record<string, string> = {
  Active: 'bg-green-100 text-green-700',
  Completed: 'bg-blue-100 text-blue-700',
  Dropped: 'bg-red-100 text-red-700',
};

function statusBadgeClass(status: string): string {
  return STATUS_BADGE[status] ?? 'bg-slate-100 text-slate-700';
}

/**
 * How the fee was arranged, derived rather than stored.
 *
 * There is no `payment_type` column any more; the schedule itself is the fact.
 * More than one installment row means the total was split.
 */
function paymentArrangement(enrollment: Enrollment): 'Full payment' | 'Installments' {
  return (enrollment.installments?.length ?? 0) > 1 ? 'Installments' : 'Full payment';
}

interface EnrollmentListProps {
  searchTerm?: string;
  /**
   * Server-side filters, owned by the admissions page's filter drawer.
   *
   * The controls used to live in this component. They moved out so all three
   * tabs share one filter surface -- and so the same drawer can promise
   * multi-select, which a row of single-value <Select>s could not express.
   */
  filters?: Record<string, string[]>;
  onClearFilters?: () => void;
}

export function EnrollmentList({
  searchTerm = '',
  filters = {},
  onClearFilters,
}: EnrollmentListProps) {
  const queryClient = useQueryClient();
  const { can } = useCurrentRole();
  const debouncedSearch = useDebounce(searchTerm, 300);

  const [viewEnroll, setViewEnroll] = useState<Enrollment | null>(null);
  const [editEnroll, setEditEnroll] = useState<Enrollment | null>(null);
  const [actionEnroll, setActionEnroll] = useState<Enrollment | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showRequest, setShowRequest] = useState(false);
  const [transferEnroll, setTransferEnroll] = useState<Enrollment | null>(null);

  const enrollments = usePaginatedQuery<Enrollment>(['enrollments'], apiClient.enrollments.list, {
    search: debouncedSearch,
    ordering: '-start_date',
    filters,
  });

  const hasActiveFilters = Object.values(filters).some((values) => values.length > 0);

  const invalidateEnrollmentViews = () => {
    void queryClient.invalidateQueries({ queryKey: ['enrollments'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard-activity'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard-revenue'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard-weekly'] });
  };

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiClient.enrollments.delete(id),
    onSuccess: () => {
      invalidateEnrollmentViews();
      setShowConfirm(false);
      setActionEnroll(null);
      toast.success('Enrollment deleted');
    },
    onError: (error: unknown) => {
      toast.error('Could not delete enrollment', getApiErrorMessage(error));
    },
  });

  const requestMutation = useMutation({
    mutationFn: (message: string) => {
      if (!actionEnroll) throw new Error('No enrollment selected');
      return apiClient.approvalRequests.create({
        action: 'DELETE',
        entity_type: 'enrollment',
        entity_id: Number(actionEnroll.id),
        entity_name: actionEnroll.studentName,
        message,
      });
    },
    onSuccess: () => {
      setShowRequest(false);
      setActionEnroll(null);
      toast.success('Delete request sent', 'An admin will review it.');
    },
    onError: (error: unknown) => {
      toast.error('Could not send the request', getApiErrorMessage(error));
    },
  });

  const handleDeleteClick = (enrollment: Enrollment) => {
    setActionEnroll(enrollment);
    // Presentation only — the backend is the authority. Roles that would be
    // refused a DELETE raise an approval request instead of seeing a 403.
    if (can('deleteRecords')) {
      setShowConfirm(true);
    } else {
      setShowRequest(true);
    }
  };

  const activeEnrollment = viewEnroll ?? editEnroll;

  return (
    <>
      <div>
        {enrollments.isLoading ? (
          <div className="p-4">
            <LoadingState rows={5} label="Loading enrollments…" />
          </div>
        ) : enrollments.isError ? (
          <div className="p-4">
            <ErrorState
              error={enrollments.error}
              onRetry={enrollments.refetch}
              title="Could not load enrollments"
            />
          </div>
        ) : enrollments.isEmpty ? (
          <div className="p-4">
            <EmptyState
              icon={GraduationCap}
              title="No enrollments found"
              description={
                debouncedSearch || hasActiveFilters
                  ? 'No enrollment matches the current search and filters.'
                  : 'Enrollments you create will appear here.'
              }
              action={
                hasActiveFilters ? (
                  <Button variant="outline" onClick={onClearFilters}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr>
                    <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 sm:px-4">
                      Student
                    </th>
                    <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 lg:table-cell">
                      Program
                    </th>
                    <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 md:table-cell">
                      Start date
                    </th>
                    <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 xl:table-cell">
                      Added by
                    </th>
                    <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 sm:table-cell">
                      Assigned to
                    </th>
                    <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 sm:px-4">
                      Fees
                    </th>
                    <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 sm:table-cell">
                      Status
                    </th>
                    <th className="px-3 py-3 text-right text-xs font-semibold uppercase tracking-wider text-slate-700 sm:px-4">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {enrollments.rows.map((enrollment) => {
                    const avatar = getAvatarColor(enrollment.studentName);
                    return (
                      <tr key={enrollment.id} className="transition-colors hover:bg-slate-50">
                        <td className="px-3 py-2 sm:px-4">
                          <div className="flex items-center gap-2">
                            <div
                              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${avatar.bg} ${avatar.text}`}
                            >
                              {getInitials(enrollment.studentName)}
                            </div>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-slate-900">
                                {enrollment.studentName}
                              </p>
                              <code className="font-mono text-xs text-slate-500">
                                {enrollment.enrollmentNo}
                              </code>
                              <span
                                className={`ml-2 inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium sm:hidden ${statusBadgeClass(enrollment.status)}`}
                              >
                                {enrollment.status}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td className="hidden px-4 py-2 lg:table-cell">
                          <p className="text-sm font-medium text-slate-900">{enrollment.programName}</p>
                          <p className="text-xs text-slate-500">
                            {enrollment.university_name || enrollment.country || '—'}
                            {enrollment.durationMonths ? ` · ${enrollment.durationMonths} months` : ''}
                          </p>
                        </td>
                        <td className="hidden px-4 py-2 text-sm text-slate-600 md:table-cell">
                          {formatDate(enrollment.startDate)}
                        </td>
                        <td className="hidden px-4 py-2 text-sm text-slate-600 xl:table-cell">
                          {enrollment.created_by_name || '—'}
                        </td>
                        <td className="hidden px-4 py-2 text-sm text-slate-600 sm:table-cell">
                          <p>{enrollment.owner_name || 'Unassigned'}</p>
                          {enrollment.branch_name && (
                            <p className="text-xs text-slate-400">{enrollment.branch_name}</p>
                          )}
                        </td>
                        <td className="px-3 py-2 sm:px-4">
                          <p className="text-sm font-bold text-slate-900">
                            {formatCurrency(enrollment.totalFees)}
                          </p>
                          <p className="text-xs text-slate-500">{paymentArrangement(enrollment)}</p>
                        </td>
                        <td className="hidden px-4 py-2 sm:table-cell">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(enrollment.status)}`}
                          >
                            {enrollment.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 sm:px-4">
                          <div className="flex items-center justify-end gap-0.5">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 hover:bg-blue-50 hover:text-blue-600"
                              onClick={() => setViewEnroll(enrollment)}
                              aria-label={`View ${enrollment.studentName}`}
                              title="View"
                            >
                              <Eye size={16} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 hover:bg-teal-50 hover:text-teal-600"
                              onClick={() => setEditEnroll(enrollment)}
                              aria-label={`Edit ${enrollment.studentName}`}
                              title="Edit"
                            >
                              <Edit size={16} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 hover:bg-purple-50 hover:text-purple-600"
                              onClick={() => setTransferEnroll(enrollment)}
                              aria-label={`Transfer ${enrollment.studentName}`}
                              title="Transfer"
                            >
                              <RefreshCw size={16} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 hover:bg-red-50 hover:text-red-600"
                              onClick={() => handleDeleteClick(enrollment)}
                              aria-label={`Delete ${enrollment.studentName}`}
                              title={can('deleteRecords') ? 'Delete' : 'Request deletion'}
                            >
                              <Trash2 size={16} />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <PaginationBar
              page={enrollments.page}
              pages={enrollments.pages}
              count={enrollments.count}
              pageSize={enrollments.pageSize}
              onPageChange={enrollments.setPage}
              isLoading={enrollments.isFetching}
            />
          </>
        )}
      </div>

      {activeEnrollment && (
        <EnrollmentDetailModal
          key={`${activeEnrollment.id}-${editEnroll ? 'edit' : 'view'}`}
          enrollment={activeEnrollment}
          isEditMode={Boolean(editEnroll)}
          onClose={() => {
            setViewEnroll(null);
            setEditEnroll(null);
          }}
          onSaved={invalidateEnrollmentViews}
        />
      )}

      <ConfirmDialog
        open={showConfirm}
        onClose={() => {
          setShowConfirm(false);
          setActionEnroll(null);
        }}
        onConfirm={() => actionEnroll && deleteMutation.mutate(actionEnroll.id)}
        title="Delete enrollment"
        description={
          actionEnroll
            ? `Delete the enrollment for ${actionEnroll.studentName} (${actionEnroll.enrollmentNo})? Its payment schedule goes with it, and this cannot be undone.`
            : 'Delete this enrollment?'
        }
        confirmText="Delete"
        confirmVariant="destructive"
        isLoading={deleteMutation.isPending}
      />

      <RequestActionModal
        open={showRequest}
        onClose={() => {
          setShowRequest(false);
          setActionEnroll(null);
        }}
        onSubmit={(message) => requestMutation.mutate(message)}
        action="DELETE"
        entityType="Enrollment"
        entityName={actionEnroll?.studentName ?? ''}
        isLoading={requestMutation.isPending}
      />

      {transferEnroll && (
        <TransferStudentModal
          isOpen
          onClose={() => setTransferEnroll(null)}
          studentId={transferEnroll.id}
          type="enrollment"
          studentName={transferEnroll.studentName}
          currentAssigneeId={transferEnroll.owner ?? null}
          onSuccess={() => {
            invalidateEnrollmentViews();
            setTransferEnroll(null);
          }}
        />
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Detail / edit modal                                                        */
/* -------------------------------------------------------------------------- */

const MODAL_TABS = [
  { id: 'student', label: 'Student', icon: UserCircle },
  { id: 'program', label: 'Program', icon: GraduationCap },
  { id: 'financials', label: 'Financials', icon: CreditCard },
  { id: 'digital-docs', label: 'Digital docs', icon: FileText },
  { id: 'physical-docs', label: 'Physical docs', icon: FileText },
] as const;

type TabId = (typeof MODAL_TABS)[number]['id'];

interface EnrollmentDraft {
  programName: string;
  /** '' for none, a university id, or `OTHER_UNIVERSITY`. */
  university: string;
  universityName: string;
  country: string;
  startDate: string;
  durationMonths: string;
  totalFees: string;
  commissionAmount: string;
  status: string;
}

interface RegistrationDraft {
  mobile: string;
  email: string;
  permanentAddress: string;
  fatherName: string;
  motherName: string;
}

function toEnrollmentDraft(enrollment: Enrollment): EnrollmentDraft {
  const hasCatalogueUniversity = enrollment.university !== null && enrollment.university !== undefined;
  return {
    programName: enrollment.programName ?? '',
    university: hasCatalogueUniversity
      ? String(enrollment.university)
      : enrollment.university_name
        ? OTHER_UNIVERSITY
        : '',
    universityName: enrollment.university_name ?? '',
    country: enrollment.country ?? '',
    startDate: toDateInput(enrollment.startDate),
    durationMonths: fromNumber(enrollment.durationMonths),
    totalFees: fromNumber(enrollment.totalFees),
    commissionAmount: fromNumber(enrollment.commission_amount),
    status: enrollment.status || 'Active',
  };
}

function toRegistrationDraft(registration: Registration | undefined): RegistrationDraft {
  return {
    mobile: registration?.mobile ?? '',
    email: registration?.email ?? '',
    permanentAddress: registration?.permanentAddress ?? '',
    fatherName: registration?.fatherName ?? '',
    motherName: registration?.motherName ?? '',
  };
}

interface EnrollmentDetailModalProps {
  enrollment: Enrollment;
  isEditMode: boolean;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Read and edit one enrollment plus the student details that hang off its
 * registration.
 *
 * Two writes, two resources: the enrollment goes to `enrollments/{id}/` and the
 * contact/parent details to `registrations/{student}/`. `student` is carried
 * through untouched — the update is a PUT, and omitting it would detach the
 * enrollment from its registration.
 *
 * `installments_count` / `installment_amount` are deliberately NOT editable
 * here: they regenerate the payment schedule, which would quietly destroy a
 * part-paid plan. The schedule is shown read-only instead.
 */
function EnrollmentDetailModal({ enrollment, isEditMode, onClose, onSaved }: EnrollmentDetailModalProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabId>('student');
  const [draft, setDraft] = useState<EnrollmentDraft>(() => toEnrollmentDraft(enrollment));
  const [registrationDraft, setRegistrationDraft] = useState<RegistrationDraft>(() =>
    toRegistrationDraft(undefined),
  );

  const registrationId = String(enrollment.student);

  const registrationQuery = useQuery({
    queryKey: ['registration', registrationId],
    queryFn: () => apiClient.registrations.get(registrationId),
    enabled: Number.isFinite(enrollment.student),
  });
  const registration = registrationQuery.data;

  // Seeded during render rather than in an effect: an effect runs after paint,
  // so the edit fields would flash empty for a frame once the fetch resolves.
  // react-query hands back the same object reference until the data changes, so
  // this runs once per load.
  const [seededFrom, setSeededFrom] = useState<Registration | undefined>(undefined);
  if (registration && registration !== seededFrom) {
    setSeededFrom(registration);
    setRegistrationDraft(toRegistrationDraft(registration));
  }

  const universitiesQuery = useQuery({
    queryKey: ['universities', 'enrollment-picker'],
    queryFn: () => apiClient.universities.list({ page_size: 200, ordering: 'name' }),
    enabled: isEditMode,
  });
  const universities: University[] = toArray(universitiesQuery.data);

  const setField = <K extends keyof EnrollmentDraft>(field: K, value: EnrollmentDraft[K]) => {
    setDraft((previous) => ({ ...previous, [field]: value }));
  };

  const setRegistrationField = <K extends keyof RegistrationDraft>(
    field: K,
    value: RegistrationDraft[K],
  ) => {
    setRegistrationDraft((previous) => ({ ...previous, [field]: value }));
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const isOther = draft.university === OTHER_UNIVERSITY;
      const catalogueId = isOther || draft.university === '' ? null : Number(draft.university);
      const catalogueName = universities.find((entry) => String(entry.id) === draft.university)?.name;

      const payload: EnrollmentInput = {
        // `enrollment_no` is already allocated; a PUT that omitted it would ask
        // the server to reassign a reference the office has already quoted.
        enrollment_no: enrollment.enrollmentNo,
        student: enrollment.student,
        program_name: draft.programName.trim(),
        university: catalogueId,
        university_name: isOther ? draft.universityName.trim() : (catalogueName ?? ''),
        country: draft.country.trim(),
        start_date: draft.startDate,
        duration_months: toNumber(draft.durationMonths, 12),
        total_fees: toNumber(draft.totalFees),
        commission_amount: toNumber(draft.commissionAmount),
        status: draft.status,
      };

      await apiClient.enrollments.update(enrollment.id, payload);

      // Only touch the registration when it loaded — sending a half-built
      // payload would blank the student's contact details.
      if (registration) {
        const registrationPayload: RegistrationInput = {
          registration_no: registration.registrationNo,
          student_name: registration.studentName,
          mobile: registrationDraft.mobile.trim(),
          email: registrationDraft.email.trim(),
          registration_fee: registration.registrationFee,
          father_name: registrationDraft.fatherName.trim(),
          mother_name: registrationDraft.motherName.trim(),
          permanent_address: registrationDraft.permanentAddress.trim(),
        };
        await apiClient.registrations.update(registrationId, registrationPayload);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['registration', registrationId] });
      onSaved();
      toast.success('Enrollment updated');
      onClose();
    },
  });

  const avatar = getAvatarColor(enrollment.studentName);
  const installments = enrollment.installments ?? [];

  const renderStudentTab = () => (
    <div className="space-y-6">
      <div className="rounded-lg border border-purple-200 bg-purple-50 p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div
            className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-xl font-bold ${avatar.bg} ${avatar.text}`}
          >
            {getInitials(enrollment.studentName)}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-lg font-bold text-slate-900">{enrollment.studentName}</h3>
            <p className="text-sm text-slate-600">
              Enrollment no: <span className="font-mono">{enrollment.enrollmentNo}</span>
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Registration: {registration?.registrationNo ?? '—'}
            </p>
          </div>
          <span
            className={`shrink-0 self-start rounded-full px-3 py-1 text-xs font-semibold ${statusBadgeClass(enrollment.status)}`}
          >
            {enrollment.status}
          </span>
        </div>
      </div>

      {registrationQuery.isLoading ? (
        <LoadingState rows={2} label="Loading student details…" />
      ) : registrationQuery.isError ? (
        <ErrorState
          error={registrationQuery.error}
          onRetry={() => void registrationQuery.refetch()}
          title="Could not load the student's registration"
        />
      ) : (
        <>
          <section>
            <h4 className="mb-3 text-sm font-bold text-slate-700">Contact</h4>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <ModalField
                label="Mobile"
                icon={Phone}
                value={registrationDraft.mobile}
                isEditable={isEditMode}
                onChange={(value) => setRegistrationField('mobile', value)}
              />
              <ModalField
                label="Email"
                icon={Mail}
                value={registrationDraft.email}
                isEditable={isEditMode}
                onChange={(value) => setRegistrationField('email', value)}
              />
            </div>
          </section>

          <section>
            <h4 className="mb-3 text-sm font-bold text-slate-700">Address</h4>
            <ModalField
              label="Permanent address"
              value={registrationDraft.permanentAddress}
              isEditable={isEditMode}
              onChange={(value) => setRegistrationField('permanentAddress', value)}
            />
          </section>

          <section>
            <h4 className="mb-3 text-sm font-bold text-slate-700">Parents</h4>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <ModalField
                label="Father's name"
                value={registrationDraft.fatherName}
                isEditable={isEditMode}
                onChange={(value) => setRegistrationField('fatherName', value)}
              />
              <ModalField
                label="Mother's name"
                value={registrationDraft.motherName}
                isEditable={isEditMode}
                onChange={(value) => setRegistrationField('motherName', value)}
              />
            </div>
          </section>

          {registration?.needsLoan && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
              <h4 className="text-sm font-bold text-amber-800">Loan requested</h4>
              <p className="mt-1 text-xs text-amber-700">
                Recorded on the student&apos;s registration. Loan amounts are not tracked on the
                enrollment.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );

  const renderProgramTab = () => (
    <div className="space-y-6">
      <div className="rounded-xl border border-purple-100 bg-gradient-to-br from-purple-50 to-blue-50 px-4 py-6 text-center">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Program</p>
        <p className="break-words text-2xl font-bold text-purple-600">{enrollment.programName}</p>
        {enrollment.university_name && (
          <p className="mt-1 text-sm text-slate-600">{enrollment.university_name}</p>
        )}
      </div>

      <section>
        <h4 className="mb-3 text-sm font-bold text-slate-700">Enrollment</h4>
        <div className="grid grid-cols-1 gap-4 rounded-lg bg-slate-50 p-4 sm:grid-cols-2">
          {/* Server-assigned per-company reference — never editable. */}
          <ModalField label="Enrollment no" value={enrollment.enrollmentNo} />
          <ModalField
            label="Program name"
            value={draft.programName}
            isEditable={isEditMode}
            onChange={(value) => setField('programName', value)}
          />

          {isEditMode ? (
            <div className="space-y-1">
              <p className="text-xs font-medium text-slate-500">University</p>
              <Select
                value={draft.university === '' ? 'none' : draft.university}
                onValueChange={(next) => {
                  const value = next === 'none' ? '' : next;
                  setField('university', value);
                  const picked = universities.find((entry) => String(entry.id) === value);
                  if (picked) {
                    setField('universityName', picked.name);
                    setField('country', picked.country);
                  }
                }}
              >
                <SelectTrigger className="h-9 w-full bg-white">
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
              {universitiesQuery.isError && (
                <p className="text-xs text-amber-700">
                  Could not load the catalogue — choose “Other” and type the name.
                </p>
              )}
            </div>
          ) : (
            <ModalField label="University" value={enrollment.university_name || '—'} />
          )}

          {isEditMode && draft.university === OTHER_UNIVERSITY && (
            <ModalField
              label="University name"
              value={draft.universityName}
              isEditable
              onChange={(value) => setField('universityName', value)}
            />
          )}

          <ModalField
            label="Country"
            value={draft.country}
            isEditable={isEditMode}
            onChange={(value) => setField('country', value)}
          />
          <ModalField
            label="Start date"
            type="date"
            value={draft.startDate}
            isEditable={isEditMode}
            onChange={(value) => setField('startDate', value)}
          />
          <ModalField
            label="Duration (months)"
            type="number"
            value={draft.durationMonths}
            isEditable={isEditMode}
            onChange={(value) => setField('durationMonths', value)}
          />
          {isEditMode ? (
            <div className="space-y-1">
              <p className="text-xs font-medium text-slate-500">Status</p>
              <Select value={draft.status} onValueChange={(value) => setField('status', value)}>
                <SelectTrigger className="h-9 w-full bg-white">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((status) => (
                    <SelectItem key={status} value={status}>
                      {status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <ModalField label="Status" value={enrollment.status} />
          )}
        </div>
      </section>

      <section>
        <h4 className="mb-3 text-sm font-bold text-slate-700">Ownership</h4>
        <div className="grid grid-cols-1 gap-4 rounded-lg bg-slate-50 p-4 sm:grid-cols-2">
          <ModalField label="Added by" icon={UserCircle} value={enrollment.created_by_name || '—'} />
          <ModalField label="Assigned to" icon={UserCircle} value={enrollment.owner_name || 'Unassigned'} />
          <ModalField label="Branch" value={enrollment.branch_name || '—'} />
          <ModalField label="Created" value={formatDate(enrollment.created_at)} />
        </div>
      </section>
    </div>
  );

  const renderFinancialsTab = () => (
    <div className="space-y-6">
      <div className="rounded-xl border border-teal-100 bg-gradient-to-br from-teal-50 to-blue-50 px-4 py-6 text-center">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Total fees</p>
        <p className="break-words text-2xl font-bold text-teal-600">
          {formatCurrency(isEditMode ? toNumber(draft.totalFees) : enrollment.totalFees)}
        </p>
        <p className="mt-1 text-xs text-slate-500">{paymentArrangement(enrollment)}</p>
      </div>

      <section>
        <h4 className="mb-3 text-sm font-bold text-slate-700">Commercials</h4>
        <div className="grid grid-cols-1 gap-4 rounded-lg bg-slate-50 p-4 sm:grid-cols-2">
          <ModalField
            label="Total fees"
            type="number"
            value={draft.totalFees}
            isEditable={isEditMode}
            onChange={(value) => setField('totalFees', value)}
          />
          {/* Formerly labelled "service charge" — the same live field, renamed. */}
          <ModalField
            label="Service charge (commission)"
            type="number"
            value={draft.commissionAmount}
            isEditable={isEditMode}
            onChange={(value) => setField('commissionAmount', value)}
          />
        </div>
      </section>

      <section>
        <h4 className="mb-3 text-sm font-bold text-slate-700">
          Payment schedule{installments.length > 0 ? ` (${installments.length})` : ''}
        </h4>
        {installments.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
            <p className="text-sm text-slate-500">
              No schedule — the fee was recorded as a single payment.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full min-w-[420px] text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase text-slate-500">#</th>
                  <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase text-slate-500">
                    Due date
                  </th>
                  <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase text-slate-500">
                    Amount
                  </th>
                  <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase text-slate-500">
                    Status
                  </th>
                  <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase text-slate-500">
                    Paid on
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {installments.map((installment) => (
                  <tr key={installment.id ?? installment.number}>
                    <td className="px-3 py-2 text-slate-600">{installment.number}</td>
                    <td className="px-3 py-2 text-slate-600">{formatDate(installment.due_date)}</td>
                    <td className="px-3 py-2 text-right font-medium text-slate-900">
                      {formatCurrency(Number(installment.amount))}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          installment.status === 'Paid'
                            ? 'bg-green-100 text-green-700'
                            : installment.status === 'Overdue'
                              ? 'bg-red-100 text-red-700'
                              : 'bg-amber-100 text-amber-700'
                        }`}
                      >
                        {installment.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-600">{formatDate(installment.paid_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {isEditMode && installments.length > 0 && (
          <p className="mt-2 text-xs text-slate-500">
            The schedule is generated when the enrollment is created and is read-only here — editing
            the count would rebuild it and discard what has already been paid.
          </p>
        )}
      </section>
    </div>
  );

  const renderDigitalDocsTab = () => (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-bold text-slate-700">Uploaded scans</h4>
        <p className="mt-0.5 text-xs text-slate-500">
          Files stored against this student&apos;s name.
        </p>
      </div>
      {isEditMode ? (
        <DocumentUpload
          studentName={enrollment.studentName}
          variant="minimal"
          onUploaded={() => {
            void queryClient.invalidateQueries({ queryKey: ['documents'] });
          }}
        />
      ) : (
        <ExistingDocumentsList studentName={enrollment.studentName} />
      )}
    </div>
  );

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-[900px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl focus:outline-none sm:h-[85vh]">
          <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-base font-bold text-slate-900 sm:text-lg">
                {isEditMode ? 'Edit enrollment' : 'Enrollment details'}
              </Dialog.Title>
              <Dialog.Description className="truncate text-xs text-slate-500">
                {enrollment.studentName} · {enrollment.enrollmentNo}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close dialog"
                className="shrink-0 rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <X size={20} />
              </button>
            </Dialog.Close>
          </div>

          {/* Horizontal tab strip on phones, sidebar from md up. */}
          <div className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50 p-2 md:hidden">
            {MODAL_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`shrink-0 rounded-lg px-3 py-2 text-xs transition-all ${
                  activeTab === tab.id
                    ? 'bg-purple-600 font-medium text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex flex-1 overflow-hidden">
            <div className="hidden w-48 shrink-0 flex-col gap-1 border-r border-slate-200 bg-slate-50 p-2 md:flex">
              {MODAL_TABS.map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm transition-all ${
                      activeTab === tab.id
                        ? 'bg-purple-600 font-medium text-white'
                        : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    <Icon size={16} />
                    {tab.label}
                  </button>
                );
              })}
            </div>

            <div className="flex-1 overflow-y-auto p-4 sm:p-6">
              {saveMutation.isError && (
                <div className="mb-4">
                  <ErrorBanner error={saveMutation.error} />
                </div>
              )}
              {activeTab === 'student' && renderStudentTab()}
              {activeTab === 'program' && renderProgramTab()}
              {activeTab === 'financials' && renderFinancialsTab()}
              {activeTab === 'digital-docs' && renderDigitalDocsTab()}
              {activeTab === 'physical-docs' && (
                <PhysicalDocumentsPanel
                  registrationId={enrollment.student}
                  studentName={enrollment.studentName}
                  isEditMode={isEditMode}
                />
              )}
            </div>
          </div>

          <div className="flex flex-col-reverse gap-2 border-t border-slate-200 bg-slate-50 p-4 sm:flex-row sm:justify-end">
            <Button variant="outline" className="h-10 px-6" onClick={onClose}>
              {isEditMode ? 'Cancel' : 'Close'}
            </Button>
            {isEditMode ? (
              <Button
                className="h-10 bg-teal-600 px-6 hover:bg-teal-700"
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
              >
                {saveMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…
                  </>
                ) : (
                  'Save changes'
                )}
              </Button>
            ) : (
              <Button
                className="h-10 bg-purple-600 px-6 hover:bg-purple-700"
                onClick={() => {
                  // `[type]` is one of PROFILE_TYPES — 'enrollment' here.
                  router.push(`/app/student-profile/enrollment/${enrollment.id}`);
                  onClose();
                }}
              >
                <UserCircle size={16} className="mr-2" /> View full profile
              </Button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* -------------------------------------------------------------------------- */
/* Physical documents                                                         */
/* -------------------------------------------------------------------------- */

interface PhysicalDocumentsPanelProps {
  /** Registration primary key — physical custody hangs off the student, not the enrollment. */
  registrationId: number;
  studentName: string;
  isEditMode: boolean;
}

interface PhysicalDocDraft {
  name: string;
  documentNumber: string;
  remarks: string;
}

const EMPTY_DOC: PhysicalDocDraft = { name: '', documentNumber: '', remarks: '' };

/**
 * Custody of the student's ORIGINAL paper documents.
 *
 * These are their own resource (`student-documents/`), not a JSON blob on the
 * registration — the old build edited `registration.student_documents`, a field
 * the API has never returned, so nothing typed there was ever saved.
 */
function PhysicalDocumentsPanel({ registrationId, studentName, isEditMode }: PhysicalDocumentsPanelProps) {
  const queryClient = useQueryClient();
  const [newDoc, setNewDoc] = useState<PhysicalDocDraft>(EMPTY_DOC);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [rowDraft, setRowDraft] = useState<PhysicalDocDraft>(EMPTY_DOC);

  const documentsQuery = useQuery({
    queryKey: ['student-documents', registrationId],
    queryFn: () => apiClient.studentDocuments.list(registrationId, { page_size: 100 }),
    enabled: Number.isFinite(registrationId),
  });
  const documents: StudentDocument[] = toArray(documentsQuery.data);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['student-documents', registrationId] });
  };

  const createMutation = useMutation({
    mutationFn: (draft: PhysicalDocDraft) => {
      const payload: StudentDocumentInput = {
        registration: registrationId,
        name: draft.name.trim(),
        document_number: draft.documentNumber.trim(),
        remarks: draft.remarks.trim(),
        status: 'Received',
      };
      return apiClient.studentDocuments.create(payload);
    },
    onSuccess: () => {
      invalidate();
      setNewDoc(EMPTY_DOC);
      toast.success('Document recorded');
    },
    onError: (error: unknown) => toast.error('Could not record the document', getApiErrorMessage(error)),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, draft }: { id: number; draft: PhysicalDocDraft }) =>
      apiClient.studentDocuments.update(id, {
        name: draft.name.trim(),
        document_number: draft.documentNumber.trim(),
        remarks: draft.remarks.trim(),
      }),
    onSuccess: () => {
      invalidate();
      setEditingId(null);
      toast.success('Document updated');
    },
    onError: (error: unknown) => toast.error('Could not update the document', getApiErrorMessage(error)),
  });

  const returnMutation = useMutation({
    mutationFn: (id: number) => apiClient.studentDocuments.returnDocs([id]),
    onSuccess: (result) => {
      invalidate();
      // `returned` and `requested` differ when the row was out of scope or
      // already returned — report what actually happened.
      if (result.returned > 0) {
        toast.success('Document returned to the student');
      } else {
        toast.warning('Nothing was returned', 'It may already be marked as returned.');
      }
    },
    onError: (error: unknown) => toast.error('Could not return the document', getApiErrorMessage(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiClient.studentDocuments.delete(id),
    onSuccess: () => {
      invalidate();
      toast.success('Document removed');
    },
    onError: (error: unknown) => toast.error('Could not remove the document', getApiErrorMessage(error)),
  });

  const startEditing = (document: StudentDocument) => {
    setEditingId(document.id);
    setRowDraft({
      name: document.name,
      documentNumber: document.document_number,
      remarks: document.remarks,
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-bold text-slate-700">Physical documents held</h4>
        <p className="mt-0.5 text-xs text-slate-500">
          Originals the office is holding for {studentName}.
        </p>
      </div>

      {isEditMode && (
        <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <label className="text-[10px] font-semibold uppercase text-slate-500" htmlFor="new-doc-name">
                Document name
              </label>
              <Input
                id="new-doc-name"
                value={newDoc.name}
                onChange={(event) => setNewDoc((previous) => ({ ...previous, name: event.target.value }))}
                placeholder="e.g. Class 10 marksheet"
                className="h-9 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-semibold uppercase text-slate-500" htmlFor="new-doc-number">
                Document no
              </label>
              <Input
                id="new-doc-number"
                value={newDoc.documentNumber}
                onChange={(event) =>
                  setNewDoc((previous) => ({ ...previous, documentNumber: event.target.value }))
                }
                placeholder="Optional"
                className="h-9 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-semibold uppercase text-slate-500" htmlFor="new-doc-remarks">
                Remarks
              </label>
              <Input
                id="new-doc-remarks"
                value={newDoc.remarks}
                onChange={(event) => setNewDoc((previous) => ({ ...previous, remarks: event.target.value }))}
                placeholder="Condition or notes"
                className="h-9 text-sm"
              />
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => createMutation.mutate(newDoc)}
            disabled={newDoc.name.trim() === '' || createMutation.isPending}
          >
            {createMutation.isPending ? <InlineSpinner className="mr-2" /> : <Plus size={14} className="mr-1" />}
            Add document
          </Button>
        </div>
      )}

      {documentsQuery.isLoading ? (
        <LoadingState rows={2} label="Loading physical documents…" />
      ) : documentsQuery.isError ? (
        <ErrorState
          error={documentsQuery.error}
          onRetry={() => void documentsQuery.refetch()}
          title="Could not load physical documents"
        />
      ) : documents.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
          <FileText className="mx-auto mb-2 h-8 w-8 text-slate-300" />
          <p className="text-sm text-slate-500">No physical documents recorded</p>
        </div>
      ) : (
        <div className="space-y-3">
          {documents.map((document) => (
            <div key={document.id} className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
              {editingId === document.id ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <Input
                      value={rowDraft.name}
                      onChange={(event) => setRowDraft((prev) => ({ ...prev, name: event.target.value }))}
                      placeholder="Document name"
                      className="h-9 text-sm"
                      aria-label="Document name"
                    />
                    <Input
                      value={rowDraft.documentNumber}
                      onChange={(event) =>
                        setRowDraft((prev) => ({ ...prev, documentNumber: event.target.value }))
                      }
                      placeholder="Document no"
                      className="h-9 text-sm"
                      aria-label="Document number"
                    />
                    <Input
                      value={rowDraft.remarks}
                      onChange={(event) => setRowDraft((prev) => ({ ...prev, remarks: event.target.value }))}
                      placeholder="Remarks"
                      className="h-9 text-sm"
                      aria-label="Remarks"
                    />
                  </div>
                  <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <Button variant="outline" size="sm" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => updateMutation.mutate({ id: document.id, draft: rowDraft })}
                      disabled={rowDraft.name.trim() === '' || updateMutation.isPending}
                    >
                      {updateMutation.isPending && <InlineSpinner className="mr-2" />}
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="grid min-w-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-3">
                    <div className="min-w-0">
                      <p className="text-[10px] font-semibold uppercase text-slate-500">Document</p>
                      <p className="truncate text-sm font-medium text-slate-900">{document.name}</p>
                    </div>
                    <div className="min-w-0">
                      <p className="text-[10px] font-semibold uppercase text-slate-500">Number</p>
                      <p className="truncate font-mono text-sm text-slate-600">
                        {document.document_number || '—'}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <p className="text-[10px] font-semibold uppercase text-slate-500">Remarks</p>
                      <p className="truncate text-sm text-slate-600">{document.remarks || '—'}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        document.status === 'Returned'
                          ? 'bg-green-100 text-green-700'
                          : document.status === 'Lost'
                            ? 'bg-red-100 text-red-700'
                            : 'bg-amber-100 text-amber-700'
                      }`}
                    >
                      {document.status}
                    </span>
                    {document.current_holder_name && document.status !== 'Returned' && (
                      <span className="text-[10px] text-slate-500">with {document.current_holder_name}</span>
                    )}
                    {isEditMode && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 hover:bg-teal-50 hover:text-teal-600"
                          onClick={() => startEditing(document)}
                          aria-label={`Edit ${document.name}`}
                          title="Edit"
                        >
                          <Edit size={14} />
                        </Button>
                        {document.status !== 'Returned' && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 text-xs"
                            onClick={() => returnMutation.mutate(document.id)}
                            disabled={returnMutation.isPending}
                          >
                            Mark returned
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-slate-400 hover:bg-red-50 hover:text-red-600"
                          onClick={() => deleteMutation.mutate(document.id)}
                          disabled={deleteMutation.isPending}
                          aria-label={`Remove ${document.name}`}
                          title="Remove"
                        >
                          <Trash2 size={14} />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Field                                                                      */
/* -------------------------------------------------------------------------- */

interface ModalFieldProps {
  label: string;
  value: string;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  isEditable?: boolean;
  onChange?: (value: string) => void;
  type?: 'text' | 'number' | 'date';
}

function ModalField({ label, value, icon: Icon, isEditable = false, onChange, type = 'text' }: ModalFieldProps) {
  const inputId = `field-${label.replace(/\W+/g, '-').toLowerCase()}`;

  return (
    <div className="min-w-0 space-y-1">
      <label className="flex items-center gap-1 text-xs font-medium text-slate-500" htmlFor={inputId}>
        {Icon && <Icon size={12} className="text-slate-400" />}
        {label}
      </label>
      {isEditable && onChange ? (
        <Input
          id={inputId}
          type={type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 border-slate-200 bg-white"
        />
      ) : (
        <p className="break-words rounded border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900">
          {value || '—'}
        </p>
      )}
    </div>
  );
}
