'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import * as Dialog from '@radix-ui/react-dialog';
import { format } from 'date-fns';
import {
  Building2,
  Edit,
  Eye,
  FileText,
  GraduationCap,
  Info,
  Mail,
  MessageSquare,
  Phone,
  Plus,
  RefreshCw,
  Trash2,
  UserCircle,
  X,
} from 'lucide-react';

import { apiClient } from '@/lib/apiClient';
import { getApiErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RequestActionModal } from '@/components/ui/RequestActionModal';
import { PaginationBar, toArray } from '@/components/common/pagination';
import { EmptyState, ErrorBanner, ErrorState, InlineSpinner, LoadingState } from '@/components/common/states';
import { DocumentUpload } from '@/components/common/DocumentUpload';
import { ExistingDocumentsList } from '@/components/common/ExistingDocumentsList';
import { TransferStudentModal } from '@/components/common/TransferStudentModal';
import { RegistrationReceipt } from '@/components/receipts/RegistrationReceipt';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { useDebounce } from '@/hooks/useDebounce';
import { useAuthStore } from '@/store/authStore';
import { toast } from '@/store/toastStore';
import { can } from '@/components/rbac/roles';
import { getAvatarColor, getInitials } from '@/lib/utils';
import type { Registration, StudentDocument } from '@/lib/types';
import {
  enrolledRegistrationIds,
  listPaymentsFor,
  updateRegistration,
  type RegistrationRecord,
} from './wire';

const PAGE_SIZE = 25;

interface RegistrationListProps {
  searchTerm?: string;
  /**
   * Server-side filters, owned by the admissions page's filter drawer.
   *
   * `course` and `location` are in here too now. They used to be applied in
   * the browser against `preferences`, which meant they narrowed the 25 rows
   * on screen while the pagination bar kept reporting the unfiltered total --
   * a consultancy with 200 registrations could filter to Kota and be told
   * there were none. Both are real query parameters now (core/filters.py).
   */
  filters?: Record<string, string[]>;
  onClearFilters?: () => void;
}

/* -------------------------------------------------------------------------- */
/* List                                                                        */
/* -------------------------------------------------------------------------- */

export function RegistrationList({
  searchTerm = '',
  filters = {},
  onClearFilters,
}: RegistrationListProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuthStore();

  const [viewReg, setViewReg] = useState<RegistrationRecord | null>(null);
  const [editReg, setEditReg] = useState<RegistrationRecord | null>(null);
  const [actionReg, setActionReg] = useState<RegistrationRecord | null>(null);
  const [receiptReg, setReceiptReg] = useState<RegistrationRecord | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showRequest, setShowRequest] = useState(false);
  const [transferReg, setTransferReg] = useState<RegistrationRecord | null>(null);

  const debouncedSearch = useDebounce(searchTerm, 300);
  const mayDeleteDirectly = can('deleteRecords', user?.role);

  const registrations = usePaginatedQuery<Registration>(
    ['registrations'],
    apiClient.registrations.list,
    {
      pageSize: PAGE_SIZE,
      search: debouncedSearch,
      ordering: '-created_at',
      filters,
    },
  );

  // Every page, not just the first: a single page would report everyone past
  // row 25 as unenrolled and re-offer students who are already placed.
  const { data: enrolledIds } = useQuery({
    queryKey: ['enrollments', 'student-ids'],
    queryFn: enrolledRegistrationIds,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiClient.registrations.delete(id),
    onSuccess: () => {
      invalidateRegistrationViews(queryClient);
      setShowConfirm(false);
      setActionReg(null);
      toast.success('Registration deleted');
    },
    onError: (error) => toast.error('Could not delete', getApiErrorMessage(error)),
  });

  const requestDeleteMutation = useMutation({
    mutationFn: async (message: string) => {
      if (!actionReg) return;
      await apiClient.approvalRequests.create({
        action: 'DELETE',
        entity_type: 'registration',
        // `entity_id` is a PositiveIntegerField on the wire; list ids are strings.
        entity_id: Number(actionReg.id),
        entity_name: actionReg.studentName,
        message,
      });
    },
    onSuccess: () => {
      setShowRequest(false);
      setActionReg(null);
      toast.success('Delete request sent for approval');
    },
    onError: (error) => toast.error('Could not send the request', getApiErrorMessage(error)),
  });

  /**
   * Students who already have an enrollment are dropped: this list exists to
   * find who still needs one. That is the one narrowing left on the client,
   * and it is honest about it below, because the row count comes from the
   * server and cannot know about it.
   */
  const rows = useMemo(() => {
    const enrolled = enrolledIds ?? new Set<string>();
    return registrations.rows.filter((reg) => !enrolled.has(String(reg.id)));
  }, [registrations.rows, enrolledIds]);

  const hiddenAsEnrolled = registrations.rows.length - rows.length;

  const handleDeleteClick = (reg: RegistrationRecord) => {
    setActionReg(reg);
    if (mayDeleteDirectly) setShowConfirm(true);
    else setShowRequest(true);
  };

  return (
    <>
      {/* Table --------------------------------------------------------- */}
      <div>
        {registrations.isError ? (
          <div className="p-4">
            <ErrorState error={registrations.error} onRetry={registrations.refetch} />
          </div>
        ) : registrations.isLoading ? (
          <div className="p-4">
            <LoadingState rows={5} label="Loading registrations" />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={GraduationCap}
              title="No registrations found"
              description={
                registrations.count > 0
                  ? 'Every student matching this search is already enrolled.'
                  : 'New registrations will appear here once they are created.'
              }
              action={
                onClearFilters && registrations.count > 0 ? (
                  <Button variant="outline" onClick={onClearFilters}>
                    Clear filters
                  </Button>
                ) : (
                  <Button
                    className="bg-teal-600 hover:bg-teal-700"
                    onClick={() => router.push('/app/registrations/new')}
                  >
                    <Plus size={16} className="mr-2" /> New Registration
                  </Button>
                )
              }
            />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700">Student</th>
                    <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 md:table-cell">Contact</th>
                    <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 lg:table-cell">Reg. No</th>
                    <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 sm:table-cell">Date</th>
                    <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 lg:table-cell">Added By</th>
                    <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 sm:table-cell">Assigned To</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700">Payment</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-slate-700">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {rows.map((reg) => (
                    <tr key={reg.id} className="transition-colors hover:bg-slate-50">
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <div
                            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${getAvatarColor(reg.studentName).bg} ${getAvatarColor(reg.studentName).text}`}
                          >
                            {getInitials(reg.studentName)}
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-slate-900">{reg.studentName}</p>
                            <code className="text-xs text-slate-500 lg:hidden">{reg.registrationNo}</code>
                            {reg.needsLoan && (
                              <span className="ml-1 inline-flex items-center rounded bg-yellow-100 px-1.5 py-0.5 text-xs font-medium text-yellow-700">
                                Loan
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="hidden px-4 py-2 md:table-cell">
                        <div className="space-y-0.5">
                          <p className="flex items-center gap-1 text-xs text-slate-700">
                            <Phone size={11} className="text-slate-400" />
                            {reg.mobile}
                          </p>
                          <p className="flex items-center gap-1 text-xs text-slate-500">
                            <Mail size={11} className="text-slate-400" />
                            {reg.email}
                          </p>
                        </div>
                      </td>
                      <td className="hidden px-4 py-2 lg:table-cell">
                        <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">
                          {reg.registrationNo}
                        </code>
                      </td>
                      <td className="hidden px-4 py-2 text-xs text-slate-600 sm:table-cell">
                        {formatDate(reg.registrationDate)}
                      </td>
                      <td className="hidden px-4 py-2 text-xs text-slate-600 lg:table-cell">
                        {reg.created_by_name || '—'}
                      </td>
                      <td className="hidden px-4 py-2 text-xs text-slate-600 sm:table-cell">
                        {reg.owner_name || 'Unassigned'}
                      </td>
                      <td className="px-4 py-2">
                        <PaymentStatusBadge status={reg.paymentStatus} />
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 hover:bg-blue-50 hover:text-blue-600"
                            onClick={() => setViewReg(reg)}
                            aria-label={`View ${reg.studentName}`}
                          >
                            <Eye size={16} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 hover:bg-teal-50 hover:text-teal-600"
                            onClick={() => setEditReg(reg)}
                            aria-label={`Edit ${reg.studentName}`}
                          >
                            <Edit size={16} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 hover:bg-red-50 hover:text-red-600"
                            onClick={() => handleDeleteClick(reg)}
                            aria-label={
                              mayDeleteDirectly
                                ? `Delete ${reg.studentName}`
                                : `Request deletion of ${reg.studentName}`
                            }
                          >
                            <Trash2 size={16} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 hover:bg-purple-50 hover:text-purple-600"
                            onClick={() => setTransferReg(reg)}
                            aria-label={`Transfer ${reg.studentName}`}
                          >
                            <RefreshCw size={16} />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {hiddenAsEnrolled > 0 && (
              <p className="border-t border-slate-100 px-4 py-2 text-[11px] text-slate-500">
                {hiddenAsEnrolled} student{hiddenAsEnrolled === 1 ? '' : 's'} on this page
                {hiddenAsEnrolled === 1 ? ' is' : ' are'} already enrolled and hidden.
              </p>
            )}

            <PaginationBar
              page={registrations.page}
              pages={registrations.pages}
              count={registrations.count}
              pageSize={registrations.pageSize}
              onPageChange={registrations.setPage}
              isLoading={registrations.isFetching}
            />
          </>
        )}
      </div>

      {/* View ---------------------------------------------------------- */}
      <Dialog.Root open={!!viewReg} onOpenChange={(open) => !open && setViewReg(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed left-[50%] top-[50%] z-50 flex h-[90vh] w-[95vw] max-w-[900px] translate-x-[-50%] translate-y-[-50%] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl focus:outline-none sm:h-[85vh] sm:w-[90vw]">
            {viewReg && (
              <RegistrationViewModal
                registration={viewReg}
                onClose={() => setViewReg(null)}
                onPrintReceipt={() => {
                  setReceiptReg(viewReg);
                  setViewReg(null);
                }}
                onOpenProfile={() => {
                  router.push(`/app/student-profile/registration/${viewReg.id}`);
                  setViewReg(null);
                }}
              />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Edit ---------------------------------------------------------- */}
      <Dialog.Root open={!!editReg} onOpenChange={(open) => !open && setEditReg(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed left-[50%] top-[50%] z-50 flex h-[90vh] w-[95vw] max-w-[900px] translate-x-[-50%] translate-y-[-50%] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl focus:outline-none sm:h-[85vh] sm:w-[90vw]">
            {editReg && (
              <RegistrationEditModal
                registration={editReg}
                canEditDirectly={mayDeleteDirectly}
                onClose={() => setEditReg(null)}
                onSaved={() => {
                  invalidateRegistrationViews(queryClient);
                  setEditReg(null);
                }}
              />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={showConfirm}
        onClose={() => {
          setShowConfirm(false);
          setActionReg(null);
        }}
        onConfirm={() => actionReg && deleteMutation.mutate(actionReg.id)}
        title="Delete Registration"
        description={
          actionReg
            ? `Delete the registration for ${actionReg.studentName}? This cannot be undone.`
            : 'Delete this registration?'
        }
        confirmText="Delete"
        confirmVariant="destructive"
        isLoading={deleteMutation.isPending}
      />

      <RequestActionModal
        open={showRequest}
        onClose={() => {
          setShowRequest(false);
          setActionReg(null);
        }}
        onSubmit={(message) => requestDeleteMutation.mutate(message)}
        action="DELETE"
        entityType="Registration"
        entityName={actionReg?.studentName || ''}
        isLoading={requestDeleteMutation.isPending}
      />

      <TransferStudentModal
        isOpen={!!transferReg}
        onClose={() => setTransferReg(null)}
        studentId={transferReg?.id ?? ''}
        type="registration"
        currentAssigneeId={transferReg?.owner ?? null}
        studentName={transferReg?.studentName}
        onSuccess={() => {
          invalidateRegistrationViews(queryClient);
          setTransferReg(null);
        }}
      />

      {receiptReg && (
        <RegistrationReceipt
          data={{
            registrationNo: receiptReg.registrationNo,
            studentName: receiptReg.studentName,
            email: receiptReg.email,
            mobile: receiptReg.mobile,
            dateOfBirth: receiptReg.date_of_birth ?? undefined,
            fatherName: receiptReg.fatherName,
            motherName: receiptReg.motherName,
            permanentAddress: receiptReg.permanentAddress,
            registrationFee: receiptReg.registrationFee,
            paymentMethod: receiptReg.paymentMethod,
            paymentStatus: receiptReg.paymentStatus,
            preferences: receiptReg.preferences,
            createdAt: receiptReg.registrationDate,
          }}
          onClose={() => setReceiptReg(null)}
        />
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Shared bits                                                                 */
/* -------------------------------------------------------------------------- */

type QueryClient = ReturnType<typeof useQueryClient>;

function invalidateRegistrationViews(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: ['registrations'] });
  queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
  queryClient.invalidateQueries({ queryKey: ['dashboard-activity'] });
  queryClient.invalidateQueries({ queryKey: ['dashboard-weekly'] });
}

function formatDate(value: string | undefined | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : format(parsed, 'dd MMM yyyy');
}

function money(value: number | string | undefined | null): string {
  const amount = Number(value ?? 0);
  return `₹${(Number.isFinite(amount) ? amount : 0).toLocaleString('en-IN')}`;
}

function PaymentStatusBadge({ status }: { status: string }) {
  const tone =
    status === 'Paid'
      ? 'bg-green-100 text-green-700'
      : status === 'Partial'
        ? 'bg-yellow-100 text-yellow-700'
        : 'bg-red-100 text-red-700';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {status}
    </span>
  );
}

/** Custody status is server vocabulary; the colour is ours. */
function CustodyBadge({ status }: { status: StudentDocument['status'] }) {
  const tone =
    status === 'Returned'
      ? 'bg-green-100 text-green-700'
      : status === 'Lost'
        ? 'bg-red-100 text-red-700'
        : 'bg-amber-100 text-amber-700';
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}>{status}</span>
  );
}

function ModalField({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: React.ReactNode;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="flex items-center gap-1 text-xs font-medium text-slate-500">
        {Icon && <Icon size={12} className="text-slate-400" />}
        {label}
      </p>
      <p className="break-words rounded border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900">
        {value === '' || value === null || value === undefined ? '—' : value}
      </p>
    </div>
  );
}

function EditableField({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  icon: Icon,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="flex items-center gap-1 text-xs font-medium text-slate-500">
        {Icon && <Icon size={12} className="text-slate-400" />}
        {label}
      </p>
      <Input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-9 border-slate-200 bg-white text-sm focus:border-teal-500 focus:ring-teal-500"
      />
    </div>
  );
}

function TabSidebar<T extends string>({
  tabs,
  active,
  onSelect,
  accent,
}: {
  tabs: ReadonlyArray<{ id: T; label: string; icon: React.ComponentType<{ size?: number }> }>;
  active: T;
  onSelect: (id: T) => void;
  accent: 'teal' | 'purple';
}) {
  const activeClass = accent === 'teal' ? 'bg-teal-600 text-white' : 'bg-purple-600 text-white';
  return (
    <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50 p-2 sm:w-48 sm:flex-col sm:overflow-x-visible sm:border-b-0 sm:border-r">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onSelect(tab.id)}
            className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2.5 text-left text-sm transition-all ${
              active === tab.id ? `${activeClass} font-medium` : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Icon size={16} />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Remarks (append-only)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The student's note history, plus a composer.
 *
 * `student-remarks/` rejects PATCH -- a remark records what was believed at the
 * time -- so there is no edit affordance here by design.
 */
function RemarksPanel({
  registrationId,
  readOnly = false,
}: {
  registrationId: string;
  readOnly?: boolean;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');

  const remarks = useQuery({
    queryKey: ['student-remarks', registrationId],
    queryFn: () => apiClient.studentRemarks.list(registrationId, { page_size: 50, ordering: '-created_at' }),
  });

  const addRemark = useMutation({
    mutationFn: (remark: string) => apiClient.studentRemarks.create({ registration: registrationId, remark }),
    onSuccess: () => {
      setDraft('');
      queryClient.invalidateQueries({ queryKey: ['student-remarks', registrationId] });
      toast.success('Note added');
    },
    onError: (error) => toast.error('Could not add the note', getApiErrorMessage(error)),
  });

  const rows = toArray(remarks.data);

  return (
    <div className="space-y-4">
      {!readOnly && (
        <div className="space-y-2">
          <Label htmlFor="new-remark" className="text-sm font-bold text-slate-700">Add a note</Label>
          <Textarea
            id="new-remark"
            rows={3}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Academic detail, a call summary, anything worth keeping on file…"
            className="text-sm"
          />
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              className="bg-teal-600 hover:bg-teal-700"
              disabled={draft.trim() === '' || addRemark.isPending}
              onClick={() => addRemark.mutate(draft.trim())}
            >
              {addRemark.isPending ? <InlineSpinner className="mr-2" /> : <MessageSquare size={14} className="mr-2" />}
              Add note
            </Button>
          </div>
          {addRemark.isError && <ErrorBanner error={addRemark.error} onDismiss={() => addRemark.reset()} />}
        </div>
      )}

      {remarks.isError ? (
        <ErrorState error={remarks.error} onRetry={() => remarks.refetch()} title="Could not load notes" />
      ) : remarks.isLoading ? (
        <LoadingState rows={2} label="Loading notes" />
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
          No notes on this student yet.
        </p>
      ) : (
        <ol className="space-y-3">
          {rows.map((remark) => (
            <li key={remark.id} className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-xs font-semibold text-slate-700">{remark.user_name || 'Unknown'}</span>
                <span className="text-[11px] text-slate-400">{formatDate(remark.created_at)}</span>
              </div>
              <p className="whitespace-pre-wrap break-words text-sm text-slate-700">{remark.remark}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Physical documents (custody of originals)                                   */
/* -------------------------------------------------------------------------- */

function PhysicalDocumentsPanel({
  registrationId,
  studentName,
  readOnly = false,
}: {
  registrationId: string;
  studentName: string;
  readOnly?: boolean;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [newDoc, setNewDoc] = useState({ name: '', document_number: '', remarks: '' });

  const documents = useQuery({
    queryKey: ['student-documents', registrationId],
    queryFn: () => apiClient.studentDocuments.list(registrationId, { page_size: 100 }),
  });

  const rows = toArray(documents.data);
  const returnable = rows.filter((row) => row.status !== 'Returned');

  const addDocument = useMutation({
    mutationFn: () =>
      apiClient.studentDocuments.create({
        registration: registrationId,
        name: newDoc.name.trim(),
        document_number: newDoc.document_number.trim(),
        remarks: newDoc.remarks.trim(),
      }),
    onSuccess: () => {
      setNewDoc({ name: '', document_number: '', remarks: '' });
      queryClient.invalidateQueries({ queryKey: ['student-documents', registrationId] });
      toast.success('Original recorded');
    },
    onError: (error) => toast.error('Could not record it', getApiErrorMessage(error)),
  });

  const returnDocuments = useMutation({
    mutationFn: () => apiClient.studentDocuments.returnDocs([...selected]),
    onSuccess: (result) => {
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ['student-documents', registrationId] });
      // `returned` is the count the API actually changed; `requested` includes
      // ids that were out of scope or already returned. Reporting `requested`
      // would claim work that did not happen.
      toast.success(
        `Returned ${result.returned} of ${result.requested} document${result.requested === 1 ? '' : 's'}`,
        result.returned < result.requested
          ? 'Some were already returned or outside your access.'
          : undefined,
      );
    },
    onError: (error) => toast.error('Could not return them', getApiErrorMessage(error)),
  });

  const toggle = (id: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="rounded-lg bg-amber-100 p-2 text-amber-600">
            <FileText size={18} />
          </div>
          <div>
            <h4 className="text-sm font-bold text-slate-700">Original papers</h4>
            <p className="text-xs text-slate-500">What the office is physically holding for {studentName}</p>
          </div>
        </div>
        {!readOnly && returnable.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 border-teal-200 text-xs text-teal-700 hover:bg-teal-50"
            disabled={selected.size === 0 || returnDocuments.isPending}
            onClick={() => returnDocuments.mutate()}
          >
            {returnDocuments.isPending ? <InlineSpinner className="mr-2" /> : null}
            Return {selected.size > 0 ? selected.size : ''} selected
          </Button>
        )}
      </div>

      {documents.isError ? (
        <ErrorState error={documents.error} onRetry={() => documents.refetch()} title="Could not load originals" />
      ) : documents.isLoading ? (
        <LoadingState rows={2} label="Loading originals" />
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
          No originals on record.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((doc) => (
            <li
              key={doc.id}
              className="flex flex-col gap-2 rounded-lg border border-amber-100 bg-amber-50 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 items-start gap-3">
                {!readOnly && doc.status !== 'Returned' && (
                  <Checkbox
                    checked={selected.has(doc.id)}
                    onCheckedChange={() => toggle(doc.id)}
                    aria-label={`Select ${doc.name}`}
                    className="mt-0.5"
                  />
                )}
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium text-slate-900">{doc.name}</p>
                  <div className="flex flex-wrap gap-x-3 text-xs text-slate-500">
                    {doc.document_number && <span>#{doc.document_number}</span>}
                    {doc.current_holder_name && <span>Held by {doc.current_holder_name}</span>}
                    {doc.remarks && <span className="italic">{doc.remarks}</span>}
                  </div>
                </div>
              </div>
              <CustodyBadge status={doc.status} />
            </li>
          ))}
        </ul>
      )}

      {!readOnly && (
        <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Record another original</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Input
              value={newDoc.name}
              onChange={(event) => setNewDoc({ ...newDoc, name: event.target.value })}
              placeholder="e.g. Class 10 Marksheet"
              aria-label="Document name"
              className="h-9 bg-white text-sm"
            />
            <Input
              value={newDoc.document_number}
              onChange={(event) => setNewDoc({ ...newDoc, document_number: event.target.value })}
              placeholder="ID / number"
              aria-label="Document number"
              className="h-9 bg-white text-sm"
            />
            <Input
              value={newDoc.remarks}
              onChange={(event) => setNewDoc({ ...newDoc, remarks: event.target.value })}
              placeholder="Condition, copies handed back…"
              aria-label="Remarks"
              className="h-9 bg-white text-sm"
            />
          </div>
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 border-teal-200 text-xs text-teal-700 hover:bg-teal-50"
              disabled={newDoc.name.trim() === '' || addDocument.isPending}
              onClick={() => addDocument.mutate()}
            >
              {addDocument.isPending ? <InlineSpinner className="mr-2" /> : <Plus size={14} className="mr-1" />}
              Add document
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* View modal                                                                  */
/* -------------------------------------------------------------------------- */

const VIEW_TABS = [
  { id: 'personal', label: 'Personal', icon: UserCircle },
  { id: 'family', label: 'Family & Address', icon: Phone },
  { id: 'profile', label: 'Profile & Notes', icon: MessageSquare },
  { id: 'payment', label: 'Payment', icon: FileText },
  { id: 'documents', label: 'Documents', icon: FileText },
] as const;

type ViewTab = (typeof VIEW_TABS)[number]['id'];

function RegistrationViewModal({
  registration,
  onClose,
  onPrintReceipt,
  onOpenProfile,
}: {
  registration: RegistrationRecord;
  onClose: () => void;
  onPrintReceipt: () => void;
  onOpenProfile: () => void;
}) {
  const [activeTab, setActiveTab] = useState<ViewTab>('personal');
  const [documentTab, setDocumentTab] = useState<'digital' | 'physical'>('digital');

  // The enquiry this was converted from carries the parent occupations and
  // mobiles, which Registration itself has no columns for.
  const enquiry = useQuery({
    queryKey: ['enquiry', registration.enquiry],
    queryFn: () => apiClient.enquiries.get(String(registration.enquiry)),
    enabled: Boolean(registration.enquiry),
  });

  const payments = useQuery({
    queryKey: ['payments', 'registration', registration.id],
    queryFn: () =>
      listPaymentsFor({ studentName: registration.studentName, registrationId: registration.id }),
  });

  const source = enquiry.data;

  const renderTab = () => {
    switch (activeTab) {
      case 'personal':
        return (
          <div className="space-y-6">
            <div className="rounded-lg border border-teal-200 bg-teal-50 p-4">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <div
                  className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-2xl font-bold ${getAvatarColor(registration.studentName).bg} ${getAvatarColor(registration.studentName).text}`}
                >
                  {getInitials(registration.studentName)}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="break-words text-lg font-bold text-slate-900">{registration.studentName}</h3>
                  <p className="text-sm text-slate-600">
                    Reg No: <span className="font-mono">{registration.registrationNo}</span>
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <span className="rounded border border-teal-200 bg-white px-2 py-1 text-xs">
                      DOB: {formatDate(registration.date_of_birth)}
                    </span>
                    {registration.branch_name && (
                      <span className="rounded border border-teal-200 bg-white px-2 py-1 text-xs">
                        {registration.branch_name}
                      </span>
                    )}
                    {registration.needsLoan && (
                      <span className="rounded border border-yellow-200 bg-yellow-50 px-2 py-1 text-xs text-yellow-800">
                        Needs loan support
                      </span>
                    )}
                  </div>
                </div>
                <PaymentStatusBadge status={registration.paymentStatus} />
              </div>
            </div>

            <div>
              <h4 className="mb-3 text-sm font-bold text-slate-700">Contact Information</h4>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <ModalField label="Mobile" value={registration.mobile} icon={Phone} />
                <ModalField label="Email" value={registration.email} icon={Mail} />
                <ModalField label="Registration Date" value={formatDate(registration.registrationDate)} />
                <ModalField label="Added By" value={registration.created_by_name} icon={UserCircle} />
                <ModalField label="Assigned To" value={registration.owner_name} icon={UserCircle} />
                <ModalField label="Branch" value={registration.branch_name} icon={Building2} />
              </div>
            </div>

            {registration.preferences.length > 0 && (
              <div>
                <h4 className="mb-3 text-sm font-bold text-slate-700">Study Preferences</h4>
                <div className="rounded-lg border border-orange-200 bg-orange-50 p-4">
                  <ol className="flex flex-wrap gap-2">
                    {registration.preferences.map((preference, index) => (
                      <li
                        key={`${preference.courseName}-${preference.location}-${index}`}
                        className="flex items-center gap-2 rounded-lg border border-orange-200 bg-white px-3 py-2"
                      >
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-teal-600 text-xs font-bold text-white">
                          {preference.priority || index + 1}
                        </span>
                        <span className="text-sm font-medium text-slate-800">
                          {preference.courseName}
                          {preference.location ? ` · ${preference.location}` : ''}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            )}
          </div>
        );

      case 'family':
        return (
          <div className="space-y-6">
            {registration.enquiry ? null : (
              <p className="flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                <Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                Occupations and parent mobiles are only shown for students converted from an
                enquiry, which is the one record that stores them. For everyone else they are in
                the notes on the Profile tab.
              </p>
            )}

            <div>
              <h4 className="mb-3 text-sm font-bold text-slate-700">Father&rsquo;s Information</h4>
              <div className="grid grid-cols-1 gap-4 rounded-lg bg-slate-50 p-4 sm:grid-cols-3">
                <ModalField label="Name" value={registration.fatherName} />
                <ModalField label="Occupation" value={source?.fatherOccupation} />
                <ModalField label="Mobile" value={source?.fatherMobile} icon={Phone} />
              </div>
            </div>

            <div>
              <h4 className="mb-3 text-sm font-bold text-slate-700">Mother&rsquo;s Information</h4>
              <div className="grid grid-cols-1 gap-4 rounded-lg bg-slate-50 p-4 sm:grid-cols-3">
                <ModalField label="Name" value={registration.motherName} />
                <ModalField label="Occupation" value={source?.motherOccupation} />
                <ModalField label="Mobile" value={source?.motherMobile} icon={Phone} />
              </div>
            </div>

            <div>
              <h4 className="mb-3 text-sm font-bold text-slate-700">Address</h4>
              <div className="rounded-lg bg-slate-50 p-4">
                <ModalField label="Permanent Address" value={registration.permanentAddress} />
              </div>
            </div>
          </div>
        );

      case 'profile':
        return (
          <div className="space-y-6">
            {source && (
              <div>
                <h4 className="mb-3 text-sm font-bold text-slate-700">From the original enquiry</h4>
                <div className="grid grid-cols-1 gap-4 rounded-lg border border-blue-200 bg-blue-50 p-4 sm:grid-cols-2">
                  <ModalField label="School" value={source.schoolName} />
                  <ModalField label="Stream" value={source.stream} />
                  <ModalField label="Course interested" value={source.courseInterested} />
                  <ModalField label="Class 12 passing year" value={source.class12PassingYear} />
                  <ModalField label="Gap year" value={source.gapYear ? 'Yes' : 'No'} />
                  <ModalField label="College dropout" value={source.collegeDropout ? 'Yes' : 'No'} />
                </div>
              </div>
            )}

            <div>
              <h4 className="mb-1 text-sm font-bold text-slate-700">Notes</h4>
              <p className="mb-3 text-xs text-slate-500">
                Academic and personal detail lives here: the student record has no columns for
                marks, boards, caste or religion. Notes are append-only.
              </p>
              <RemarksPanel registrationId={registration.id} readOnly />
            </div>
          </div>
        );

      case 'payment':
        return (
          <div className="space-y-6">
            <div className="rounded-xl border border-teal-100 bg-gradient-to-br from-teal-50 to-blue-50 py-6 text-center">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                Registration Fee
              </p>
              <p className="text-2xl font-bold text-teal-600">
                {money(registration.registrationFee)}
              </p>
              <span className="mt-3 inline-flex">
                <PaymentStatusBadge status={registration.paymentStatus} />
              </span>
            </div>

            <div>
              <h4 className="mb-3 text-sm font-bold text-slate-700">Payment Information</h4>
              <div className="grid grid-cols-1 gap-4 rounded-lg bg-slate-50 p-4 sm:grid-cols-2">
                <ModalField label="Payment Method" value={registration.paymentMethod} />
                <ModalField label="Needs Loan" value={registration.needsLoan ? 'Yes' : 'No'} />
              </div>
            </div>

            <div>
              <h4 className="mb-3 text-sm font-bold text-slate-700">Booked payments</h4>
              {payments.isError ? (
                <ErrorState error={payments.error} onRetry={() => payments.refetch()} title="Could not load payments" />
              ) : payments.isLoading ? (
                <LoadingState rows={2} label="Loading payments" />
              ) : (payments.data ?? []).length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                  No payment rows against this registration yet.
                </p>
              ) : (
                <ul className="space-y-2">
                  {(payments.data ?? []).map((payment) => (
                    <li
                      key={payment.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white p-3"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-900">{money(payment.amount)}</p>
                        <p className="text-xs text-slate-500">
                          {payment.type} · {payment.method} · {formatDate(payment.date)}
                          {payment.reference ? ` · ${payment.reference}` : ''}
                        </p>
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          payment.status === 'Success'
                            ? 'bg-green-100 text-green-700'
                            : payment.status === 'Failed'
                              ? 'bg-red-100 text-red-700'
                              : payment.status === 'Refunded'
                                ? 'bg-slate-200 text-slate-700'
                                : 'bg-yellow-100 text-yellow-700'
                        }`}
                      >
                        {payment.status}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        );

      case 'documents':
        return (
          <div className="space-y-6">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setDocumentTab('digital')}
                className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                  documentTab === 'digital'
                    ? 'bg-blue-600 text-white'
                    : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-100'
                }`}
              >
                Digital Documents
              </button>
              <button
                type="button"
                onClick={() => setDocumentTab('physical')}
                className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                  documentTab === 'physical'
                    ? 'bg-amber-500 text-white'
                    : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-100'
                }`}
              >
                Physical Documents
              </button>
            </div>

            {documentTab === 'digital' ? (
              <ExistingDocumentsList
                studentName={registration.studentName}
                emptyMessage="No scans uploaded for this student."
              />
            ) : (
              <PhysicalDocumentsPanel
                registrationId={registration.id}
                studentName={registration.studentName}
                readOnly
              />
            )}
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <>
      <div className="flex shrink-0 items-center justify-between border-b border-slate-200 p-4">
        <Dialog.Title className="text-base font-bold text-slate-900 sm:text-lg">
          Registration Details
        </Dialog.Title>
        <Dialog.Close asChild>
          <button type="button" aria-label="Close" className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <X size={20} />
          </button>
        </Dialog.Close>
      </div>

      <div className="flex flex-1 flex-col overflow-hidden sm:flex-row">
        <TabSidebar tabs={VIEW_TABS} active={activeTab} onSelect={setActiveTab} accent="teal" />
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">{renderTab()}</div>
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-slate-200 bg-slate-50 p-4 sm:flex-row sm:justify-end sm:gap-3">
        <Button variant="outline" className="h-10 border-slate-300 px-6 hover:bg-slate-100" onClick={onClose}>
          Close
        </Button>
        <Button
          variant="outline"
          className="h-10 border-teal-300 px-6 text-teal-700 hover:bg-teal-50"
          onClick={onPrintReceipt}
        >
          <FileText size={16} className="mr-2" /> Print Receipt
        </Button>
        <Button className="h-10 bg-teal-600 px-6 hover:bg-teal-700" onClick={onOpenProfile}>
          <Edit size={16} className="mr-2" /> View Full Profile
        </Button>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Edit modal                                                                  */
/* -------------------------------------------------------------------------- */

const EDIT_TABS = [
  { id: 'personal', label: 'Personal', icon: UserCircle },
  { id: 'family', label: 'Family & Address', icon: Phone },
  { id: 'payment', label: 'Payment', icon: FileText },
  { id: 'notes', label: 'Profile & Notes', icon: MessageSquare },
  { id: 'digital-docs', label: 'Digital Docs', icon: FileText },
  { id: 'physical-docs', label: 'Physical Docs', icon: FileText },
] as const;

type EditTab = (typeof EDIT_TABS)[number]['id'];

interface EditDraft {
  studentName: string;
  mobile: string;
  email: string;
  dateOfBirth: string;
  fatherName: string;
  motherName: string;
  permanentAddress: string;
  registrationFee: string;
  paymentMethod: Registration['paymentMethod'];
  paymentStatus: Registration['paymentStatus'];
  needsLoan: boolean;
}

function toDraft(registration: RegistrationRecord): EditDraft {
  return {
    studentName: registration.studentName,
    mobile: registration.mobile,
    email: registration.email,
    dateOfBirth: (registration.date_of_birth ?? '').split('T')[0],
    fatherName: registration.fatherName,
    motherName: registration.motherName,
    permanentAddress: registration.permanentAddress,
    registrationFee: String(registration.registrationFee ?? ''),
    paymentMethod: registration.paymentMethod,
    paymentStatus: registration.paymentStatus,
    needsLoan: registration.needsLoan,
  };
}

function RegistrationEditModal({
  registration,
  canEditDirectly,
  onClose,
  onSaved,
}: {
  registration: RegistrationRecord;
  /** Employees route the change through an approval request instead. */
  canEditDirectly: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [activeTab, setActiveTab] = useState<EditTab>('personal');
  const [draft, setDraft] = useState<EditDraft>(() => toDraft(registration));
  const [hasChanges, setHasChanges] = useState(false);

  const update = (patch: Partial<EditDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setHasChanges(true);
  };

  const save = useMutation({
    mutationFn: async () => {
      const fee = Number(draft.registrationFee);
      const payload = {
        student_name: draft.studentName.trim(),
        mobile: draft.mobile.trim(),
        email: draft.email.trim(),
        date_of_birth: draft.dateOfBirth || null,
        father_name: draft.fatherName.trim(),
        mother_name: draft.motherName.trim(),
        permanent_address: draft.permanentAddress.trim(),
        registration_fee: Number.isFinite(fee) ? fee : registration.registrationFee,
        payment_method: draft.paymentMethod,
        payment_status: draft.paymentStatus,
        needs_loan: draft.needsLoan,
      };

      if (canEditDirectly) {
        await updateRegistration(registration.id, payload);
        return 'saved' as const;
      }

      // Employees cannot PATCH the record; the change is queued for review.
      await apiClient.approvalRequests.create({
        action: 'UPDATE',
        entity_type: 'registration',
        entity_id: Number(registration.id),
        entity_name: registration.studentName,
        message: 'Request to update registration details',
      });
      return 'requested' as const;
    },
    onSuccess: (result) => {
      toast.success(
        result === 'saved' ? 'Registration updated' : 'Update request sent for approval',
      );
      onSaved();
    },
    onError: (error) => toast.error('Could not save', getApiErrorMessage(error)),
  });

  const renderTab = () => {
    switch (activeTab) {
      case 'personal':
        return (
          <div className="space-y-6">
            <div className="rounded-lg border border-teal-200 bg-teal-50 p-4">
              <div className="flex items-center gap-4">
                <div
                  className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-xl font-bold ${getAvatarColor(draft.studentName).bg} ${getAvatarColor(draft.studentName).text}`}
                >
                  {getInitials(draft.studentName)}
                </div>
                <div className="min-w-0 flex-1">
                  <Input
                    value={draft.studentName}
                    onChange={(event) => update({ studentName: event.target.value })}
                    className="h-auto border-none bg-transparent p-0 text-lg font-bold text-slate-900 focus:ring-0 focus:ring-offset-0"
                    placeholder="Student Name"
                    aria-label="Student name"
                  />
                  <p className="text-sm text-slate-600">
                    Reg No: <span className="font-mono">{registration.registrationNo}</span>
                  </p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <EditableField label="Mobile" value={draft.mobile} onChange={(v) => update({ mobile: v })} icon={Phone} placeholder="Phone number" />
              <EditableField label="Email" value={draft.email} onChange={(v) => update({ email: v })} icon={Mail} placeholder="Email address" />
              <EditableField label="Date of Birth" value={draft.dateOfBirth} onChange={(v) => update({ dateOfBirth: v })} type="date" />
            </div>

            <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              Gender, caste and religion are not columns on this record. Record them as a note on
              the Profile &amp; Notes tab.
            </p>
          </div>
        );

      case 'family':
        return (
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-4 rounded-lg bg-slate-50 p-4 sm:grid-cols-2">
              <EditableField label="Father's Name" value={draft.fatherName} onChange={(v) => update({ fatherName: v })} placeholder="Father's name" />
              <EditableField label="Mother's Name" value={draft.motherName} onChange={(v) => update({ motherName: v })} placeholder="Mother's name" />
              <div className="space-y-1 sm:col-span-2">
                <p className="text-xs font-medium text-slate-500">Permanent Address</p>
                <Textarea
                  rows={3}
                  value={draft.permanentAddress}
                  onChange={(event) => update({ permanentAddress: event.target.value })}
                  placeholder="Full address"
                  className="text-sm"
                />
              </div>
            </div>

            <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              Occupations, parent mobiles and the family city/state have no fields here. Add them
              as a note on the Profile &amp; Notes tab.
            </p>
          </div>
        );

      case 'payment':
        return (
          <div className="space-y-6">
            <div className="rounded-xl border border-teal-100 bg-gradient-to-br from-teal-50 to-blue-50 py-6 text-center">
              <Label htmlFor="edit-fee" className="mb-2 block text-xs font-semibold uppercase tracking-wider text-slate-500">
                Registration Fee
              </Label>
              <Input
                id="edit-fee"
                type="number"
                value={draft.registrationFee}
                onChange={(event) => update({ registrationFee: event.target.value })}
                className="mx-auto w-40 border-none bg-transparent text-center text-2xl font-bold text-teal-600 focus:ring-0"
                placeholder="0"
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <p className="text-xs font-medium text-slate-500">Payment Method</p>
                <Select
                  value={draft.paymentMethod}
                  onValueChange={(value) => update({ paymentMethod: value as Registration['paymentMethod'] })}
                >
                  <SelectTrigger className="h-9 bg-white text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Cash">Cash</SelectItem>
                    <SelectItem value="Card">Card</SelectItem>
                    <SelectItem value="UPI">UPI</SelectItem>
                    <SelectItem value="Other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium text-slate-500">Payment Status</p>
                <Select
                  value={draft.paymentStatus}
                  onValueChange={(value) => update({ paymentStatus: value as Registration['paymentStatus'] })}
                >
                  <SelectTrigger className="h-9 bg-white text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Paid">Paid</SelectItem>
                    <SelectItem value="Partial">Partial</SelectItem>
                    <SelectItem value="Pending">Pending</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2 sm:col-span-2">
                <Checkbox
                  id="edit-needs-loan"
                  checked={draft.needsLoan}
                  onCheckedChange={(checked) => update({ needsLoan: checked === true })}
                />
                <Label htmlFor="edit-needs-loan" className="cursor-pointer text-sm font-medium">
                  Student needs edu loan support
                </Label>
              </div>
            </div>

            {/* The fee's Payment row is created once, at registration time. */}
            <p className="flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              <Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              Changing the status here updates the registration. The payment row booked when this
              student registered is not rewritten — record a new payment instead.
            </p>
          </div>
        );

      case 'notes':
        return <RemarksPanel registrationId={registration.id} />;

      case 'digital-docs':
        return (
          <div className="space-y-6">
            <DocumentUpload
              variant="minimal"
              studentName={registration.studentName}
            />
            <div className="border-t border-slate-100 pt-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Already on file
              </p>
              <ExistingDocumentsList
                studentName={registration.studentName}
              />
            </div>
          </div>
        );

      case 'physical-docs':
        return (
          <PhysicalDocumentsPanel
            registrationId={registration.id}
            studentName={registration.studentName}
          />
        );

      default:
        return null;
    }
  };

  // Documents and notes are written through their own endpoints as they are
  // entered, so Save only concerns the registration's own columns.
  const savesOnThisTab = activeTab === 'personal' || activeTab === 'family' || activeTab === 'payment';

  return (
    <>
      <div className="flex shrink-0 items-center justify-between border-b border-slate-200 p-4">
        <Dialog.Title className="text-base font-bold text-slate-900 sm:text-lg">Edit Registration</Dialog.Title>
        <Dialog.Close asChild>
          <button type="button" aria-label="Close" className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <X size={20} />
          </button>
        </Dialog.Close>
      </div>

      <div className="flex flex-1 flex-col overflow-hidden sm:flex-row">
        <TabSidebar tabs={EDIT_TABS} active={activeTab} onSelect={setActiveTab} accent="teal" />
        <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
          {save.isError && <ErrorBanner error={save.error} onDismiss={() => save.reset()} />}
          {renderTab()}
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
        {!savesOnThisTab && (
          <p className="mr-auto text-xs text-slate-500">Changes on this tab save as you make them.</p>
        )}
        <Button variant="outline" className="h-10 border-slate-300 px-6 hover:bg-slate-100" onClick={onClose}>
          {savesOnThisTab ? 'Cancel' : 'Close'}
        </Button>
        <Button
          className="h-10 bg-teal-600 px-6 hover:bg-teal-700 disabled:bg-slate-300"
          onClick={() => save.mutate()}
          disabled={!hasChanges || save.isPending}
        >
          {save.isPending ? (
            <>
              <InlineSpinner className="mr-2" /> Saving…
            </>
          ) : canEditDirectly ? (
            'Save Changes'
          ) : (
            'Request Changes'
          )}
        </Button>
      </div>
    </>
  );
}
