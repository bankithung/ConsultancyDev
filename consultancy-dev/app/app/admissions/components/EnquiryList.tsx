'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Edit, Eye, Filter, GraduationCap, Mail, Phone, Plus, RefreshCw, Trash2, Users, X,
} from 'lucide-react';

import { apiClient } from '@/lib/apiClient';
import type { Enquiry } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { TransferStudentModal } from '@/components/common/TransferStudentModal';
import { PaginationBar } from '@/components/common/PaginationBar';
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { useDebounce } from '@/hooks/useDebounce';
import { useCurrentRole } from '@/components/rbac/useCurrentRole';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RequestActionModal } from '@/components/ui/RequestActionModal';
import { toast } from '@/store/toastStore';
import { getAvatarColor, getInitials } from '@/lib/utils';

/** Next's router instance — `AppRouterInstance` is not exported publicly. */
type AppRouter = ReturnType<typeof useRouter>;

const STATUS_BADGE: Record<string, string> = {
  New: 'bg-blue-100 text-blue-700',
  Contacted: 'bg-amber-100 text-amber-700',
  Converted: 'bg-green-100 text-green-700',
  Closed: 'bg-slate-100 text-slate-700',
};

function statusBadge(status: string): string {
  return STATUS_BADGE[status] ?? 'bg-slate-100 text-slate-700';
}

/** Tolerates the empty/invalid dates that older imported rows carry. */
function formatDate(value: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : format(date, 'dd MMM yyyy');
}

interface EnquiryListProps {
  searchTerm?: string;
  /** Server-side filters, owned by the admissions page's filter drawer. */
  filters?: Record<string, string[]>;
  onClearFilters?: () => void;
}

/**
 * The Enquiries tab of the admissions directory.
 *
 * Search, the filter button and "New" live on the page rather than in here, so
 * all three tabs share one toolbar and switching tab does not move the controls
 * out from under the pointer.
 */
export function EnquiryList({ searchTerm = '', filters = {}, onClearFilters }: EnquiryListProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { can } = useCurrentRole();

  const search = useDebounce(searchTerm, 300);

  const [viewEnquiry, setViewEnquiry] = useState<Enquiry | null>(null);
  const [actionEnquiry, setActionEnquiry] = useState<Enquiry | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showRequest, setShowRequest] = useState(false);
  const [transferModal, setTransferModal] = useState<{
    isOpen: boolean;
    studentId: string | number;
    currentAssigneeId?: string | number | null;
    studentName: string;
  }>({ isOpen: false, studentId: '', currentAssigneeId: null, studentName: '' });

  const enquiries = usePaginatedQuery<Enquiry>(['enquiries'], apiClient.enquiries.list, {
    search: search || undefined,
    ordering: '-created_at',
    filters,
  });

  const hasActiveFilters = Object.values(filters).some((values) => values.length > 0);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiClient.enquiries.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['enquiries'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-overview'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-activity'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-trend'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-recent-enquiries'] });
      setShowConfirm(false);
      setActionEnquiry(null);
      toast.success('Enquiry deleted');
    },
    onError: () => {
      toast.error('Could not delete enquiry', 'You may not have permission to remove this record.');
    },
  });

  const requestMutation = useMutation({
    mutationFn: async (message: string) => {
      if (!actionEnquiry) return;
      await apiClient.approvalRequests.create({
        action: 'DELETE',
        entity_type: 'enquiry',
        // `entity_id` is a PositiveIntegerField server-side; enquiry ids are
        // carried as strings on the client.
        entity_id: Number(actionEnquiry.id),
        entity_name: actionEnquiry.candidateName,
        message,
      });
    },
    onSuccess: () => {
      setShowRequest(false);
      setActionEnquiry(null);
      toast.success('Delete request sent for approval');
    },
    onError: () => {
      toast.error('Could not send request', 'Please try again.');
    },
  });

  const handleDeleteClick = (enquiry: Enquiry) => {
    setActionEnquiry(enquiry);
    // `perform_destroy` rejects EMPLOYEE outright and tells them to raise an
    // approval request, so that is exactly what the UI offers them.
    if (can('deleteRecords')) setShowConfirm(true);
    else setShowRequest(true);
  };

  const rows = enquiries.rows;

  return (
    <>
      <div>
        {enquiries.isLoading ? (
          <div className="p-4">
            <LoadingState rows={6} label="Loading enquiries" />
          </div>
        ) : enquiries.isError ? (
          <div className="p-4">
            <ErrorState
              error={enquiries.error}
              onRetry={enquiries.refetch}
              title="Could not load enquiries"
            />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={GraduationCap}
              title={hasActiveFilters || searchTerm ? 'No enquiries match this search' : 'No enquiries yet'}
              description={
                hasActiveFilters || searchTerm
                  ? 'Try widening the search or clearing a filter.'
                  : 'Create your first enquiry to start tracking candidates.'
              }
              action={
                hasActiveFilters ? (
                  <Button variant="outline" size="sm" onClick={onClearFilters}>
                    Clear filters
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="bg-teal-600 hover:bg-teal-700"
                    onClick={() => router.push('/app/enquiries/new')}
                  >
                    <Plus className="mr-1 h-3 w-3" /> New Enquiry
                  </Button>
                )
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700">Candidate</th>
                  <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 md:table-cell">Contact</th>
                  <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 lg:table-cell">Academic</th>
                  <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 sm:table-cell">Date</th>
                  <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 xl:table-cell">Added by</th>
                  <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 xl:table-cell">Owner</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-700">Status</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-slate-700">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {rows.map((enquiry) => (
                  <tr key={enquiry.id} className="transition-colors hover:bg-slate-50">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <div
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${getAvatarColor(enquiry.candidateName).bg} ${getAvatarColor(enquiry.candidateName).text}`}
                        >
                          {getInitials(enquiry.candidateName)}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-slate-900">{enquiry.candidateName}</p>
                          <p className="truncate text-xs text-slate-500 sm:hidden">{enquiry.mobile}</p>
                        </div>
                      </div>
                    </td>
                    <td className="hidden px-4 py-2 md:table-cell">
                      <div className="space-y-0.5">
                        <p className="flex items-center gap-1 text-xs text-slate-700">
                          <Phone size={11} className="text-slate-400" />
                          {enquiry.mobile}
                        </p>
                        <p className="flex items-center gap-1 text-xs text-slate-500">
                          <Mail size={11} className="text-slate-400" />
                          {enquiry.email}
                        </p>
                      </div>
                    </td>
                    <td className="hidden px-4 py-2 lg:table-cell">
                      <div>
                        <p className="text-sm font-medium text-slate-900">{enquiry.courseInterested}</p>
                        <p className="text-xs text-slate-500">{enquiry.stream} • {enquiry.schoolName}</p>
                      </div>
                    </td>
                    <td className="hidden px-4 py-2 text-xs text-slate-600 sm:table-cell">
                      {formatDate(enquiry.date)}
                    </td>
                    <td className="hidden px-4 py-2 text-xs text-slate-600 xl:table-cell">
                      {enquiry.created_by_name || '—'}
                    </td>
                    <td className="hidden px-4 py-2 text-xs text-slate-600 xl:table-cell">
                      {enquiry.owner_name || 'Unassigned'}
                    </td>
                    <td className="px-4 py-2">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge(enquiry.status)}`}>
                        {enquiry.status}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 hover:bg-blue-50 hover:text-blue-600"
                          onClick={() => setViewEnquiry(enquiry)}
                          title="View details"
                        >
                          <Eye size={16} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 hover:bg-teal-50 hover:text-teal-600"
                          onClick={() => router.push(`/app/enquiries/${enquiry.id}`)}
                          title="Edit"
                        >
                          <Edit size={16} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 hover:bg-red-50 hover:text-red-600"
                          onClick={() => handleDeleteClick(enquiry)}
                          title={can('deleteRecords') ? 'Delete' : 'Request deletion'}
                        >
                          <Trash2 size={16} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 hover:bg-purple-50 hover:text-purple-600"
                          onClick={() =>
                            setTransferModal({
                              isOpen: true,
                              studentId: enquiry.id,
                              currentAssigneeId: enquiry.owner ?? null,
                              studentName: enquiry.candidateName,
                            })
                          }
                          title="Transfer ownership"
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
        )}

        <PaginationBar
          page={enquiries.page}
          pages={enquiries.pages}
          count={enquiries.count}
          pageSize={enquiries.pageSize}
          onPageChange={enquiries.setPage}
          isLoading={enquiries.isFetching}
        />
      </div>

      {/* Quick View Modal */}
      <Dialog.Root open={!!viewEnquiry} onOpenChange={() => setViewEnquiry(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed left-[50%] top-[50%] z-50 flex h-[85vh] w-[95vw] max-w-[900px] translate-x-[-50%] translate-y-[-50%] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl focus:outline-none">
            {viewEnquiry && (
              <EnquiryViewModal enquiry={viewEnquiry} onClose={() => setViewEnquiry(null)} router={router} />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Confirmation Dialog for anyone who may delete directly */}
      <ConfirmDialog
        open={showConfirm}
        onClose={() => {
          setShowConfirm(false);
          setActionEnquiry(null);
        }}
        onConfirm={() => actionEnquiry && deleteMutation.mutate(actionEnquiry.id)}
        title="Delete Enquiry"
        description={
          actionEnquiry
            ? `Are you sure you want to delete the enquiry from ${actionEnquiry.candidateName}? This action cannot be undone.`
            : 'Are you sure you want to delete this enquiry?'
        }
        confirmText="Delete"
        confirmVariant="destructive"
        isLoading={deleteMutation.isPending}
      />

      {/* Request Modal for employees */}
      <RequestActionModal
        open={showRequest}
        onClose={() => {
          setShowRequest(false);
          setActionEnquiry(null);
        }}
        onSubmit={(message) => requestMutation.mutate(message)}
        action="DELETE"
        entityType="Enquiry"
        entityName={actionEnquiry?.candidateName || ''}
        isLoading={requestMutation.isPending}
      />

      {/* Transfer ownership */}
      <TransferStudentModal
        isOpen={transferModal.isOpen}
        onClose={() => setTransferModal((prev) => ({ ...prev, isOpen: false }))}
        studentId={transferModal.studentId}
        type="enquiry"
        currentAssigneeId={transferModal.currentAssigneeId}
        studentName={transferModal.studentName}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: ['enquiries'] });
          setTransferModal((prev) => ({ ...prev, isOpen: false }));
        }}
      />
    </>
  );
}

const MODAL_TABS = [
  { id: 'personal', label: 'Personal', icon: Users },
  { id: 'family', label: 'Family & Address', icon: Users },
  { id: 'hslc', label: 'HSLC (Class 10)', icon: GraduationCap },
  { id: 'hsslc', label: 'HSSLC (Class 12)', icon: GraduationCap },
  { id: 'scores', label: 'Science & NEET', icon: GraduationCap },
  { id: 'preferences', label: 'Preferences', icon: Filter },
] as const;

type ModalTabId = (typeof MODAL_TABS)[number]['id'];

type FieldValue = string | number | null | undefined;

function EnquiryViewModal({
  enquiry,
  onClose,
  router,
}: {
  enquiry: Enquiry;
  onClose: () => void;
  router: AppRouter;
}) {
  const [activeTab, setActiveTab] = useState<ModalTabId>('personal');

  const gapYear = enquiry.gapYear
    ? [enquiry.gapYearFrom, enquiry.gapYearTo].filter(Boolean).join(' – ') || 'Yes'
    : 'No';

  const renderTabContent = () => {
    switch (activeTab) {
      case 'personal':
        return (
          <div className="space-y-6">
            <div className="rounded-lg border border-teal-200 bg-teal-50 p-4">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <div className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-2xl font-bold ${getAvatarColor(enquiry.candidateName).bg} ${getAvatarColor(enquiry.candidateName).text}`}>
                  {getInitials(enquiry.candidateName)}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-lg font-bold text-slate-900">{enquiry.candidateName}</h3>
                  <p className="text-sm text-slate-600">ID: {enquiry.id}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <span className="rounded border border-teal-200 bg-white px-2 py-1 text-xs">
                      {enquiry.branch_name || 'No branch'}
                    </span>
                    <span className="rounded border border-teal-200 bg-white px-2 py-1 text-xs">
                      Owner: {enquiry.owner_name || 'Unassigned'}
                    </span>
                  </div>
                </div>
                <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${statusBadge(enquiry.status)}`}>
                  {enquiry.status}
                </span>
              </div>
            </div>

            <div>
              <h4 className="mb-3 text-sm font-bold text-slate-700">Contact Information</h4>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <ModalField label="Mobile" value={enquiry.mobile} icon={Phone} />
                <ModalField label="Email" value={enquiry.email} icon={Mail} />
                <ModalField label="Enquiry Date" value={formatDate(enquiry.date)} />
                <ModalField label="Course Interested" value={enquiry.courseInterested} icon={GraduationCap} />
                <ModalField label="Gender" value={enquiry.gender} />
                <ModalField label="Date of Birth" value={formatDate(enquiry.dateOfBirth ?? undefined)} />
                <ModalField label="Category" value={enquiry.caste} />
                <ModalField label="Religion" value={enquiry.religion} />
              </div>
            </div>
          </div>
        );

      case 'family':
        return (
          <div className="space-y-6">
            <div>
              <h4 className="mb-3 text-sm font-bold text-slate-700">Father&apos;s Information</h4>
              <div className="rounded-lg bg-slate-50 p-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <ModalField label="Name" value={enquiry.fatherName} />
                  <ModalField label="Occupation" value={enquiry.fatherOccupation} />
                  <ModalField label="Mobile" value={enquiry.fatherMobile} icon={Phone} />
                </div>
              </div>
            </div>

            <div>
              <h4 className="mb-3 text-sm font-bold text-slate-700">Mother&apos;s Information</h4>
              <div className="rounded-lg bg-slate-50 p-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <ModalField label="Name" value={enquiry.motherName} />
                  <ModalField label="Occupation" value={enquiry.motherOccupation} />
                  <ModalField label="Mobile" value={enquiry.motherMobile} icon={Phone} />
                </div>
              </div>
            </div>

            <div>
              <h4 className="mb-3 text-sm font-bold text-slate-700">Address Details</h4>
              <div className="rounded-lg bg-slate-50 p-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <ModalField label="City/Place" value={enquiry.familyPlace} />
                  <ModalField label="State" value={enquiry.familyState} />
                  <div className="sm:col-span-2">
                    <ModalField label="Permanent Address" value={enquiry.permanentAddress} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        );

      case 'hslc':
        return (
          <div className="space-y-6">
            <div>
              <h4 className="mb-3 text-sm font-bold text-slate-700">HSLC / Class 10 Details</h4>
              <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <ModalField label="School Name" value={enquiry.class10SchoolName} />
                  <ModalField label="Board" value={enquiry.class10Board} />
                  <ModalField label="Passing Year" value={enquiry.class10PassingYear} />
                  <ModalField label="Percentage" value={enquiry.class10Percentage} />
                  <ModalField label="City/Place" value={enquiry.class10Place} />
                  <ModalField label="State" value={enquiry.class10State} />
                </div>
              </div>
            </div>
          </div>
        );

      case 'hsslc':
        return (
          <div className="space-y-6">
            <div>
              <h4 className="mb-3 text-sm font-bold text-slate-700">HSSLC / Class 12 Details</h4>
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <ModalField label="School Name" value={enquiry.schoolName} />
                  <ModalField label="Stream" value={enquiry.stream} />
                  <ModalField label="Board" value={enquiry.schoolBoard} />
                  <ModalField label="Passing Year" value={enquiry.class12PassingYear} />
                  <ModalField label="Percentage" value={enquiry.class12Percentage} />
                  <ModalField label="City/Place" value={enquiry.schoolPlace} />
                  <ModalField label="State" value={enquiry.schoolState} />
                  <ModalField label="Gap Year" value={gapYear} />
                  <ModalField label="College Dropout" value={enquiry.collegeDropout ? 'Yes' : 'No'} />
                </div>
              </div>
            </div>
          </div>
        );

      case 'scores':
        return (
          <div className="space-y-6">
            <div>
              <h4 className="mb-3 text-sm font-bold text-slate-700">Science Scorecard</h4>
              <div className="rounded-lg border border-purple-200 bg-purple-50 p-4">
                <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                  <ModalField label="Physics" value={enquiry.physicsMarks} />
                  <ModalField label="Chemistry" value={enquiry.chemistryMarks} />
                  <ModalField label="Biology" value={enquiry.biologyMarks} />
                  <ModalField label="Maths" value={enquiry.mathsMarks} />
                </div>
                <div className="mt-4 grid grid-cols-1 gap-4 border-t border-purple-200 pt-4 sm:grid-cols-2">
                  <ModalField label="PCB %" value={enquiry.pcbPercentage} />
                  <ModalField label="PCM %" value={enquiry.pcmPercentage} />
                </div>
              </div>
            </div>

            <div>
              <h4 className="mb-3 text-sm font-bold text-slate-700">NEET Scores</h4>
              <div className="rounded-lg border border-teal-200 bg-teal-50 p-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <ModalField label="Previous NEET Score" value={enquiry.previousNeetMarks} />
                  <ModalField label="Present NEET Score" value={enquiry.presentNeetMarks} />
                </div>
              </div>
            </div>
          </div>
        );

      case 'preferences':
        return (
          <div className="space-y-6">
            <div>
              <h4 className="mb-3 text-sm font-bold text-slate-700">Preferred Education Hubs</h4>
              <div className="rounded-lg border border-orange-200 bg-orange-50 p-4">
                {enquiry.preferredLocations && enquiry.preferredLocations.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {enquiry.preferredLocations.map((loc) => (
                      <span key={loc} className="rounded-lg border border-orange-200 bg-white px-3 py-1.5 text-sm text-slate-700">
                        {loc}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">No preferred locations selected</p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <ModalField label="Other Preferred Location" value={enquiry.otherLocation} />
              <ModalField label="Budget / Payment" value={enquiry.paymentAmount} />
            </div>
          </div>
        );
    }
  };

  return (
    <>
      <div className="flex items-center justify-between border-b border-slate-200 p-4">
        <Dialog.Title className="text-lg font-bold text-slate-900">Enquiry Details</Dialog.Title>
        <Dialog.Close asChild>
          <button className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close">
            <X size={20} />
          </button>
        </Dialog.Close>
      </div>

      <div className="flex flex-1 flex-col overflow-hidden sm:flex-row">
        {/* Tabs: a horizontal scroller on phones, a sidebar from `sm` up. */}
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50 p-2 sm:w-48 sm:flex-col sm:overflow-x-visible sm:border-b-0 sm:border-r">
          {MODAL_TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2.5 text-left text-sm transition-all ${isActive ? 'bg-teal-600 font-medium text-white' : 'text-slate-600 hover:bg-slate-100'}`}
              >
                <Icon size={16} className="shrink-0" />
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6">{renderTabContent()}</div>
      </div>

      <div className="flex flex-col justify-end gap-3 border-t border-slate-200 bg-slate-50 p-4 sm:flex-row">
        <Button variant="outline" className="h-10 border-slate-300 px-6 hover:bg-slate-100" onClick={onClose}>
          Close
        </Button>
        <Button
          className="h-10 bg-teal-600 px-6 hover:bg-teal-700"
          onClick={() => {
            router.push(`/app/student-profile/enquiry/${enquiry.id}`);
            onClose();
          }}
        >
          <Edit size={16} className="mr-2" /> View Full Profile
        </Button>
      </div>
    </>
  );
}

function ModalField({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: FieldValue;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
}) {
  const display = value === null || value === undefined || value === '' ? '—' : value;

  return (
    <div className="space-y-1">
      <p className="flex items-center gap-1 text-xs font-medium text-slate-500">
        {Icon && <Icon size={12} className="text-slate-400" />}
        {label}
      </p>
      <p className="break-words rounded border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900">
        {display}
      </p>
    </div>
  );
}
