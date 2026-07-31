'use client';

import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { format } from 'date-fns';
import { ArrowRightLeft, ExternalLink, Mail, Phone, Search, UserCircle, Users, X } from 'lucide-react';

import { apiClient } from '@/lib/apiClient';
import type { Enquiry, Enrollment, Registration } from '@/lib/types';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { useDebounce } from '@/hooks/useDebounce';
import { useAuth } from '@/hooks/useAuth';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PaginationBar } from '@/components/common/PaginationBar';
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states';
import { useCurrentRole } from '@/components/rbac/useCurrentRole';
import { ROLES } from '@/components/rbac/roles';
import { cn } from '@/lib/utils';
import { ENQUIRY_STATUSES, PAYMENT_STATUSES } from '../student-profile/constants';
import { TransferStudentModal, type TransferTarget } from './components/TransferStudentModal';
import { BookmarkTabs } from '@/components/common/BookmarkTabs';
import { StageSegments } from './components/StageSegments';

/**
 * Roles that supervise other people's students and may see the full directory.
 *
 * An employee is not shown the "All students" tab at all — the endpoint would
 * scope the result to their own records anyway, so the tab would look like a
 * broader view while returning exactly the same rows.
 */
const SUPERVISOR_ROLES = [
  ROLES.DEV_ADMIN,
  ROLES.COMPANY_ADMIN,
  ROLES.HEAD_MANAGER,
  ROLES.BRANCH_MANAGER,
] as const;

type View = 'mine' | 'all';
type Stage = 'enquiry' | 'registration' | 'enrollment';

const STAGE_ACCENT: Record<Stage, string> = {
  enquiry: 'text-blue-600',
  registration: 'text-purple-600',
  enrollment: 'text-emerald-600',
};

const AVATAR_STYLE: Record<Stage, string> = {
  enquiry: 'bg-blue-100 text-blue-600',
  registration: 'bg-purple-100 text-purple-600',
  enrollment: 'bg-emerald-100 text-emerald-600',
};

const STATUS_STYLE: Record<string, string> = {
  New: 'bg-blue-50 text-blue-700 border-blue-100',
  Contacted: 'bg-sky-50 text-sky-700 border-sky-100',
  Converted: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  Closed: 'bg-slate-100 text-slate-600 border-slate-200',
  Paid: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  Pending: 'bg-amber-50 text-amber-700 border-amber-100',
  Partial: 'bg-purple-50 text-purple-700 border-purple-100',
  Active: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  Completed: 'bg-blue-50 text-blue-700 border-blue-100',
  Dropped: 'bg-red-50 text-red-700 border-red-100',
};

interface StudentRow {
  stage: Stage;
  id: string;
  name: string;
  email: string;
  mobile: string;
  date: string | null;
  status: string;
  program: string;
  addedBy: string;
}

const fromEnquiry = (row: Enquiry): StudentRow => ({
  stage: 'enquiry',
  id: row.id,
  name: row.candidateName,
  email: row.email,
  mobile: row.mobile,
  date: row.date,
  status: row.status,
  program: row.courseInterested,
  addedBy: row.created_by_name ?? '—',
});

const fromRegistration = (row: Registration): StudentRow => ({
  stage: 'registration',
  id: row.id,
  name: row.studentName,
  email: row.email,
  mobile: row.mobile,
  date: row.registrationDate,
  status: row.paymentStatus,
  program: row.preferences?.[0]?.courseName ?? '—',
  addedBy: row.created_by_name ?? '—',
});

const fromEnrollment = (row: Enrollment): StudentRow => ({
  stage: 'enrollment',
  id: row.id,
  // Contact details live on the registration; an enrollment carries only the
  // student's name, so those columns stay empty rather than guessing.
  name: row.studentName,
  email: '',
  mobile: '',
  date: row.startDate,
  status: row.status,
  program: row.programName,
  addedBy: row.created_by_name ?? '—',
});

const selectionKey = (stage: Stage, id: string) => `${stage}-${id}`;

function StudentsDirectory() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const { is } = useCurrentRole();

  const canSeeEveryone = is(...SUPERVISOR_ROLES);
  const ownerId = user?.id ?? null;

  /**
   * The tab lives in the URL so a link, a bookmark or a back-button press lands
   * on the same view. An employee has no "all students" to show — the endpoint
   * would scope it to their own records anyway — so the param is pinned.
   */
  const requestedView = searchParams.get('view');
  const view: View = !canSeeEveryone ? 'mine' : requestedView === 'all' ? 'all' : 'mine';

  const setView = (next: View) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('view', next);
    router.replace(`/app/students?${params.toString()}`, { scroll: false });
  };

  const [stage, setStage] = useState<Stage>('enquiry');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [enquiryStatus, setEnquiryStatus] = useState('all');
  const [paymentStatus, setPaymentStatus] = useState('all');
  const [enrollmentStatus, setEnrollmentStatus] = useState('all');

  const [selected, setSelected] = useState<Record<string, TransferTarget>>({});
  const [isTransferOpen, setIsTransferOpen] = useState(false);

  /**
   * "Mine" is resolved SERVER-SIDE via the `owner` filter, not by comparing
   * rows on the client. Against a paginated API, filtering the page you happen
   * to have would quietly hide everything past row 20.
   *
   * All three endpoints support `owner`, so both tabs offer the same three
   * stages — the tab changes the scope, never which stages exist.
   */
  const mineFilter: Record<string, string | number | boolean> =
    view === 'mine' && ownerId !== null ? { owner: ownerId } : {};

  const enquiries = usePaginatedQuery<Enquiry>(
    ['enquiries', 'directory', view, ownerId],
    apiClient.enquiries.list,
    {
      search: debouncedSearch,
      ordering: '-created_at',
      pageSize: 20,
      enabled: view === 'all' || ownerId !== null,
      filters: {
        ...mineFilter,
        ...(enquiryStatus === 'all' ? {} : { status: enquiryStatus }),
      },
    },
  );

  const registrations = usePaginatedQuery<Registration>(
    ['registrations', 'directory', view, ownerId],
    apiClient.registrations.list,
    {
      search: debouncedSearch,
      ordering: '-registration_date',
      pageSize: 20,
      enabled: view === 'all' || ownerId !== null,
      filters: {
        ...mineFilter,
        ...(paymentStatus === 'all' ? {} : { payment_status: paymentStatus }),
      },
    },
  );

  const enrollments = usePaginatedQuery<Enrollment>(
    ['enrollments', 'directory', view, ownerId],
    apiClient.enrollments.list,
    {
      search: debouncedSearch,
      ordering: '-created_at',
      pageSize: 20,
      enabled: view === 'all' || ownerId !== null,
      filters: {
        ...mineFilter,
        ...(enrollmentStatus === 'all' ? {} : { status: enrollmentStatus }),
      },
    },
  );

  /**
   * The same three stages in both tabs. The tab decides WHOSE records are
   * counted, never which stages are on offer — a stage that appears in one tab
   * and vanishes in the other reads as a missing feature.
   */
  const stages = useMemo(
    () =>
      (
        [
          { value: 'enquiry' as const, label: 'Enquiries', shortLabel: 'Enq', query: enquiries },
          { value: 'registration' as const, label: 'Registrations', shortLabel: 'Reg', query: registrations },
          { value: 'enrollment' as const, label: 'Enrollments', shortLabel: 'Enr', query: enrollments },
        ] as const
      ).map((item) => ({
        value: item.value,
        label: item.label,
        shortLabel: item.shortLabel,
        count: item.query.count,
        isLoading: item.query.isLoading,
        accent: STAGE_ACCENT[item.value],
      })),
    [enquiries, registrations, enrollments],
  );

  const active =
    stage === 'enquiry' ? enquiries : stage === 'registration' ? registrations : enrollments;

  const rows = useMemo<StudentRow[]>(() => {
    if (stage === 'enquiry') return enquiries.rows.map(fromEnquiry);
    if (stage === 'registration') return registrations.rows.map(fromRegistration);
    return enrollments.rows.map(fromEnrollment);
  }, [stage, enquiries.rows, registrations.rows, enrollments.rows]);

  const selectedTargets = useMemo(() => Object.values(selected), [selected]);
  const pageKeys = rows.map((row) => selectionKey(row.stage, row.id));
  const allOnPageSelected = pageKeys.length > 0 && pageKeys.every((key) => key in selected);

  const toggleRow = (row: StudentRow, checked: boolean) => {
    const key = selectionKey(row.stage, row.id);
    setSelected((current) => {
      const next = { ...current };
      if (checked) {
        next[key] = { entityType: row.stage, entityId: row.id, label: row.name };
      } else {
        delete next[key];
      }
      return next;
    });
  };

  const togglePage = (checked: boolean) => {
    setSelected((current) => {
      const next = { ...current };
      rows.forEach((row) => {
        const key = selectionKey(row.stage, row.id);
        if (checked) {
          next[key] = { entityType: row.stage, entityId: row.id, label: row.name };
        } else {
          delete next[key];
        }
      });
      return next;
    });
  };

  const clearFilters = () => {
    setSearch('');
    setEnquiryStatus('all');
    setPaymentStatus('all');
    setEnrollmentStatus('all');
  };

  const hasFilters =
    search !== '' || enquiryStatus !== 'all' || paymentStatus !== 'all' || enrollmentStatus !== 'all';

  const tabs = canSeeEveryone
    ? ([
        { value: 'mine' as const, label: 'My students' },
        { value: 'all' as const, label: 'All students' },
      ] as const)
    : ([{ value: 'mine' as const, label: 'My students' }] as const);

  return (
    <div className="pt-1">
      <BookmarkTabs
        tabs={tabs}
        value={view}
        onChange={setView}
        aria-label="Student directory scope"
      />

      {/*
        One panel. The tabs sit on its top edge, and everything below — toolbar,
        table, pagination — is inside it, so the page reads as a single object
        rather than four stacked cards.
      */}
      <section
        role="tabpanel"
        id={`panel-${view}`}
        aria-labelledby={`tab-${view}`}
        className="overflow-hidden rounded-lg rounded-tl-none border border-slate-200 bg-white shadow-sm"
      >
        {/* Toolbar: search, stage, filter and actions on one row. */}
        <div className="flex flex-col gap-2 border-b border-slate-100 p-3 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name, email or mobile…"
              aria-label="Search students"
              className="h-9 border-slate-200 bg-white pl-9 text-sm focus:border-teal-500 focus:ring-teal-500"
            />
          </div>

          <StageSegments segments={stages} value={stage} onChange={setStage} />

          <div className="flex items-center gap-2">
            {stage === 'enquiry' && (
              <Select value={enquiryStatus} onValueChange={setEnquiryStatus}>
                <SelectTrigger className="h-9 w-full bg-white text-xs sm:w-36">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {ENQUIRY_STATUSES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {stage === 'registration' && (
              <Select value={paymentStatus} onValueChange={setPaymentStatus}>
                <SelectTrigger className="h-9 w-full bg-white text-xs sm:w-40">
                  <SelectValue placeholder="Payment" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All payments</SelectItem>
                  {PAYMENT_STATUSES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {stage === 'enrollment' && (
              <Select value={enrollmentStatus} onValueChange={setEnrollmentStatus}>
                <SelectTrigger className="h-9 w-full bg-white text-xs sm:w-36">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="Active">Active</SelectItem>
                  <SelectItem value="Completed">Completed</SelectItem>
                  <SelectItem value="Dropped">Dropped</SelectItem>
                </SelectContent>
              </Select>
            )}

            {hasFilters && (
              <Button
                size="sm"
                variant="ghost"
                className="h-9 shrink-0 px-2 text-xs text-slate-500 hover:text-slate-900"
                onClick={clearFilters}
              >
                <X size={14} className="mr-1" /> Clear
              </Button>
            )}
          </div>
        </div>

        {/* Selection bar: appears only when something is selected. */}
        {selectedTargets.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-teal-100 bg-teal-50/60 px-3 py-2">
            <span className="text-xs font-medium text-teal-900">
              {selectedTargets.length} selected
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-xs text-teal-800 hover:bg-teal-100"
                onClick={() => setSelected({})}
              >
                Clear selection
              </Button>
              <Button
                size="sm"
                className="h-8 bg-teal-600 text-xs hover:bg-teal-700"
                onClick={() => setIsTransferOpen(true)}
              >
                <ArrowRightLeft size={14} className="mr-1.5" /> Transfer
              </Button>
            </div>
          </div>
        )}

        {active.isLoading && <LoadingState rows={5} label="Loading students" />}

        {active.isError && (
          <ErrorState error={active.error} onRetry={active.refetch} title="Could not load students" />
        )}

        {!active.isLoading && !active.isError && rows.length === 0 && (
          <EmptyState
            title={view === 'mine' ? 'Nothing assigned to you here' : 'No students found'}
            description={
              hasFilters
                ? 'Nothing matches the current search and filters.'
                : view === 'mine'
                  ? 'Students you own will appear here as soon as they are assigned.'
                  : 'Nothing recorded at this stage yet.'
            }
            icon={Users}
            action={
              hasFilters ? (
                <Button size="sm" variant="outline" className="h-9" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        )}

        {!active.isError && rows.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-left text-sm">
                <thead className="border-b border-slate-200 bg-slate-50/80">
                  <tr>
                    <th scope="col" className="w-10 px-3 py-2">
                      <Checkbox
                        checked={allOnPageSelected}
                        onCheckedChange={(checked) => togglePage(checked === true)}
                        aria-label="Select all on this page"
                      />
                    </th>
                    <th scope="col" className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-600">
                      Student
                    </th>
                    <th scope="col" className="hidden px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-600 md:table-cell">
                      Contact
                    </th>
                    <th scope="col" className="hidden px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-600 lg:table-cell">
                      Program
                    </th>
                    <th scope="col" className="hidden px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-600 xl:table-cell">
                      Date
                    </th>
                    {view === 'all' && (
                      <th scope="col" className="hidden px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-600 xl:table-cell">
                        Added by
                      </th>
                    )}
                    <th scope="col" className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-600">
                      Status
                    </th>
                    <th scope="col" className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wider text-slate-600">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((row) => {
                    const key = selectionKey(row.stage, row.id);
                    const isSelected = key in selected;
                    return (
                      <tr
                        key={key}
                        className={cn('transition-colors', isSelected ? 'bg-teal-50/40' : 'hover:bg-slate-50')}
                      >
                        <td className="px-3 py-2.5">
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={(checked) => toggleRow(row, checked === true)}
                            aria-label={`Select ${row.name}`}
                          />
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2.5">
                            <span
                              className={cn(
                                'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                                AVATAR_STYLE[row.stage],
                              )}
                            >
                              {row.name.charAt(0).toUpperCase()}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate font-medium text-slate-900">{row.name}</span>
                              <span className="block truncate text-xs text-slate-500 lg:hidden">{row.program}</span>
                            </span>
                          </div>
                        </td>
                        <td className="hidden px-3 py-2.5 md:table-cell">
                          {row.mobile || row.email ? (
                            <div className="space-y-0.5">
                              {row.mobile && (
                                <span className="flex items-center gap-1 text-xs text-slate-600">
                                  <Phone size={11} className="text-slate-400" /> {row.mobile}
                                </span>
                              )}
                              {row.email && (
                                <span className="flex items-center gap-1 truncate text-xs text-slate-600">
                                  <Mail size={11} className="shrink-0 text-slate-400" /> {row.email}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs italic text-slate-400">On the registration</span>
                          )}
                        </td>
                        <td className="hidden px-3 py-2.5 text-xs font-medium text-slate-600 lg:table-cell">
                          {row.program || '—'}
                        </td>
                        <td className="hidden px-3 py-2.5 text-xs text-slate-600 xl:table-cell">
                          {row.date ? format(new Date(row.date), 'dd MMM yyyy') : '—'}
                        </td>
                        {view === 'all' && (
                          <td className="hidden px-3 py-2.5 text-xs text-slate-600 xl:table-cell">
                            <span className="flex items-center gap-1.5">
                              <UserCircle className="h-3.5 w-3.5 text-slate-400" />
                              {row.addedBy}
                            </span>
                          </td>
                        )}
                        <td className="px-3 py-2.5">
                          <span
                            className={cn(
                              'inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium',
                              STATUS_STYLE[row.status] ?? 'bg-slate-100 text-slate-600 border-slate-200',
                            )}
                          >
                            {row.status}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <Link
                            href={`/app/student-profile/${row.stage}/${row.id}`}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-teal-700 transition-colors hover:bg-teal-50"
                          >
                            Open <ExternalLink size={12} />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="border-t border-slate-100 px-3 py-2">
              <PaginationBar
                page={active.page}
                pages={Math.max(1, Math.ceil(active.count / 20))}
                count={active.count}
                pageSize={20}
                onPageChange={active.setPage}
                isLoading={active.isFetching}
              />
            </div>
          </>
        )}
      </section>

      <TransferStudentModal
        open={isTransferOpen}
        onClose={() => setIsTransferOpen(false)}
        targets={selectedTargets}
        onTransferred={() => {
          setSelected({});
          enquiries.refetch();
          registrations.refetch();
          enrollments.refetch();
        }}
      />
    </div>
  );
}

export default function StudentsPage() {
  // `useSearchParams` needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<LoadingState rows={5} label="Loading students" />}>
      <StudentsDirectory />
    </Suspense>
  );
}

