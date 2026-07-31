'use client';

import { Suspense, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { GraduationCap, Plus, Search, SlidersHorizontal, UserPlus, X } from 'lucide-react';

import { apiClient } from '@/lib/apiClient';
import { fetchAllPages } from '@/lib/apiClient';
import type { Branch, University, User as StaffUser } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BookmarkTabs } from '@/components/common/BookmarkTabs';
import {
  FilterDrawer, selectionCount,
  type FilterGroup, type FilterSelection,
} from '@/components/common/FilterDrawer';
import { useCurrentRole } from '@/components/rbac/useCurrentRole';
import { ROLES } from '@/components/rbac/roles';
import {
  CASTES, COURSES, GENDERS, INDIAN_STATES, PREFERRED_LOCATIONS, SCHOOL_BOARDS,
} from '@/lib/utils';
import { EnquiryList } from './components/EnquiryList';
import { RegistrationList } from '../registrations/components/RegistrationList';
import { EnrollmentList } from '../enrollments/components/EnrollmentList';

/** Roles that see other people's records, and so can filter by who owns one. */
const SUPERVISOR_ROLES = [
  ROLES.DEV_ADMIN,
  ROLES.COMPANY_ADMIN,
  ROLES.HEAD_MANAGER,
  ROLES.BRANCH_MANAGER,
] as const;

type Stage = 'enquiries' | 'registrations' | 'enrollments';

const STAGES: ReadonlyArray<{
  value: Stage;
  label: string;
  /** Spelled out rather than derived: trimming an "s" off "Enquiries" gives
   *  "enquirie". Three words are cheaper than a pluralisation rule. */
  noun: string;
  newHref: string;
  newLabel: string;
  searchPlaceholder: string;
}> = [
  {
    value: 'enquiries',
    label: 'Enquiries',
    noun: 'enquiry',
    newHref: '/app/enquiries/new',
    newLabel: 'New Enquiry',
    searchPlaceholder: 'Search by name, school, mobile or email…',
  },
  {
    value: 'registrations',
    label: 'Registrations',
    noun: 'registration',
    newHref: '/app/registrations/new',
    newLabel: 'New Registration',
    searchPlaceholder: 'Search by name, registration no, mobile or email…',
  },
  {
    value: 'enrollments',
    label: 'Enrollments',
    noun: 'enrollment',
    newHref: '/app/enrollments/new',
    newLabel: 'New Enrollment',
    searchPlaceholder: 'Search students, programs or enrollment numbers…',
  },
];

const asOptions = (values: readonly string[]) => values.map((value) => ({ value, label: value }));

function staffName(user: StaffUser): string {
  const full = `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim();
  return full || user.username;
}

function AdmissionsDirectory() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { is } = useCurrentRole();

  const canSeeOthers = is(...SUPERVISOR_ROLES);

  /**
   * The tab lives in the URL so a link, a bookmark or the back button lands on
   * the same place — and so the three old routes can redirect straight into it.
   */
  const requested = searchParams.get('tab');
  const stage: Stage =
    requested === 'registrations' || requested === 'enrollments' ? requested : 'enquiries';
  const active = STAGES.find((item) => item.value === stage) ?? STAGES[0];

  const setStage = (next: Stage) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`/app/admissions?${params.toString()}`, { scroll: false });
  };

  const [search, setSearch] = useState('');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [activeParam, setActiveParam] = useState<string>('status');

  /**
   * Filters are kept PER TAB.
   *
   * The three stages share almost no parameters — an enquiry has a status, a
   * registration has a payment status — so one shared bag would silently send
   * `payment_status` to the enquiries endpoint, where DRF drops unknown keys
   * and hands back an unfiltered list that looks filtered.
   */
  const [selections, setSelections] = useState<Record<Stage, FilterSelection>>({
    enquiries: {},
    registrations: {},
    enrollments: {},
  });

  const selection = selections[stage];
  const setSelection = (next: FilterSelection) =>
    setSelections((current) => ({ ...current, [stage]: next }));

  /* ---------------------------------------------------------------- options */

  const staff = useQuery({
    queryKey: ['users', 'filter-options'],
    queryFn: () => apiClient.users.list({ page_size: 200, ordering: 'username' }),
    enabled: canSeeOthers,
    staleTime: 5 * 60 * 1000,
  });

  const branches = useQuery({
    queryKey: ['branches', 'filter-options'],
    queryFn: () => apiClient.branches.list({ page_size: 200, ordering: 'name' }),
    enabled: canSeeOthers,
    staleTime: 5 * 60 * 1000,
  });

  /*
   * An enrollment's `country` is copied from the university it was created
   * against, so the catalogue is the source of the option list. Every page of
   * it, not just the first: a list built from page one would omit countries
   * that do have matching enrollments.
   */
  const universities = useQuery({
    queryKey: ['universities', 'filter-options'],
    queryFn: () => fetchAllPages<University, University>('universities/', (u) => u, { ordering: 'name' }, 200, 5),
    enabled: stage === 'enrollments',
    staleTime: 5 * 60 * 1000,
  });

  const ownerGroup = useMemo<FilterGroup>(
    () => ({
      param: 'owner',
      label: 'Assigned to',
      searchable: true,
      options: (staff.data?.results ?? []).map((user) => ({
        value: String(user.id),
        label: staffName(user),
      })),
      hint: 'Who currently owns the record.',
    }),
    [staff.data],
  );

  const branchGroup = useMemo<FilterGroup>(
    () => ({
      param: 'branch',
      label: 'Branch',
      options: (branches.data?.results ?? []).map((branch: Branch) => ({
        value: String(branch.id),
        label: branch.name,
      })),
    }),
    [branches.data],
  );

  /**
   * Every group below maps to a filter the SERVER applies (core/filters.py).
   *
   * That is what lets the drawer promise "matches any of them": a multi-select
   * narrowed in the browser could only ever narrow the rows on the current
   * page, hiding matches further down while the count reported the unfiltered
   * total.
   */
  const groups = useMemo<FilterGroup[]>(() => {
    const supervisorGroups = canSeeOthers ? [ownerGroup, branchGroup] : [];

    if (stage === 'enquiries') {
      return [
        {
          param: 'status',
          label: 'Status',
          options: asOptions(['New', 'Contacted', 'Converted', 'Closed']),
          hint: 'Where the enquiry has got to. Converted ones have a registration.',
        },
        { param: 'stream', label: 'Stream', options: asOptions(['Science', 'Commerce', 'Arts']) },
        {
          param: 'course_interested',
          label: 'Course',
          options: asOptions(COURSES),
          searchable: true,
          hint: 'The course the candidate asked about.',
        },
        {
          param: 'preferred_locations',
          label: 'Preferred location',
          options: asOptions(PREFERRED_LOCATIONS),
          searchable: true,
          hint: 'Matches candidates who listed any of these hubs.',
        },
        { param: 'school_board', label: 'Class 12 board', options: asOptions(SCHOOL_BOARDS), searchable: true },
        {
          param: 'family_state',
          label: 'Home state',
          options: asOptions(INDIAN_STATES),
          searchable: true,
          hint: 'The family’s state, not the school’s.',
        },
        { param: 'gender', label: 'Gender', options: asOptions(GENDERS) },
        {
          param: 'caste',
          label: 'Category',
          options: asOptions(CASTES),
          hint: 'Reservation category, as recorded on the enquiry.',
        },
        ...supervisorGroups,
      ];
    }

    if (stage === 'registrations') {
      return [
        { param: 'payment_status', label: 'Payment status', options: asOptions(['Paid', 'Partial', 'Pending']) },
        {
          param: 'payment_method',
          label: 'Payment method',
          options: asOptions(['Cash', 'Card', 'UPI', 'Bank Transfer', 'Cheque', 'Other']),
        },
        {
          param: 'course',
          label: 'Course',
          options: asOptions(COURSES),
          searchable: true,
          hint: 'Matches any of the student’s study preferences.',
        },
        {
          param: 'location',
          label: 'Preferred location',
          options: asOptions(PREFERRED_LOCATIONS),
          searchable: true,
          hint: 'Matches any of the student’s study preferences.',
        },
        { param: 'stream', label: 'Stream', options: asOptions(['Science', 'Commerce', 'Arts']) },
        { param: 'school_board', label: 'Class 12 board', options: asOptions(SCHOOL_BOARDS), searchable: true },
        { param: 'family_state', label: 'Home state', options: asOptions(INDIAN_STATES), searchable: true },
        { param: 'gender', label: 'Gender', options: asOptions(GENDERS) },
        { param: 'caste', label: 'Category', options: asOptions(CASTES) },
        ...supervisorGroups,
      ];
    }

    const catalogue = universities.data ?? [];
    const countries = [...new Set(catalogue.map((u) => u.country).filter((c) => c && c.trim() !== ''))].sort(
      (a, b) => a.localeCompare(b),
    );

    return [
      { param: 'status', label: 'Status', options: asOptions(['Active', 'Completed', 'Dropped']) },
      {
        param: 'country',
        label: 'Country',
        options: asOptions(countries),
        searchable: true,
        hint: 'Copied from the university when the enrollment was created.',
      },
      {
        param: 'university',
        label: 'University',
        searchable: true,
        options: catalogue.map((university) => ({
          value: String(university.id),
          label: university.name,
        })),
      },
      ...supervisorGroups,
    ];
  }, [stage, canSeeOthers, ownerGroup, branchGroup, universities.data]);

  const filterCount = selectionCount(selection);

  const openFilters = (param?: string) => {
    setActiveParam(param ?? groups[0]?.param ?? 'status');
    setIsFilterOpen(true);
  };

  /** One chip per category — eight selected courses should not be eight chips. */
  const chips = useMemo(
    () =>
      groups
        .filter((group) => (selection[group.param] ?? []).length > 0)
        .map((group) => {
          const values = selection[group.param] ?? [];
          const only = group.options.find((option) => option.value === values[0]);
          return {
            param: group.param,
            label: group.label,
            detail: values.length === 1 ? (only?.label ?? values[0]) : `${values.length} selected`,
          };
        }),
    [groups, selection],
  );

  const removeChip = (param: string) => {
    const next = { ...selection };
    delete next[param];
    setSelection(next);
  };

  const tabs = STAGES.map((item) => ({ value: item.value, label: item.label }));

  return (
    <div className="pt-1">
      <BookmarkTabs
        tabs={tabs}
        value={stage}
        onChange={setStage}
        aria-label="Admissions stage"
      />

      {/*
        One panel. The tabs sit on its top edge and everything below — toolbar,
        chips, table, pagination — is inside it, so the screen reads as a single
        object rather than a stack of cards.
      */}
      <section
        role="tabpanel"
        id={`panel-${stage}`}
        aria-labelledby={`tab-${stage}`}
        className="overflow-hidden rounded-lg rounded-tl-none border border-slate-200 bg-white shadow-sm"
      >
        <div className="flex flex-col gap-2 border-b border-slate-100 p-3 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={active.searchPlaceholder}
              aria-label={`Search ${active.label.toLowerCase()}`}
              className="h-9 border-slate-200 bg-white pl-9 text-sm focus:border-teal-500 focus:ring-teal-500"
            />
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => openFilters()}
              aria-haspopup="dialog"
              aria-expanded={isFilterOpen}
              className={
                filterCount > 0
                  ? 'h-9 shrink-0 border-teal-200 bg-teal-50 text-xs text-teal-700 hover:bg-teal-100'
                  : 'h-9 shrink-0 border-slate-200 text-xs'
              }
            >
              <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" />
              Filter
              {filterCount > 0 && (
                <span className="ml-1.5 rounded-full bg-teal-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                  {filterCount}
                </span>
              )}
            </Button>

            <Button
              onClick={() => router.push(active.newHref)}
              size="sm"
              className="h-9 shrink-0 bg-teal-600 text-xs hover:bg-teal-700"
            >
              {stage === 'enquiries' ? (
                <Plus className="mr-1 h-3.5 w-3.5" />
              ) : stage === 'registrations' ? (
                <UserPlus className="mr-1 h-3.5 w-3.5" />
              ) : (
                <GraduationCap className="mr-1 h-3.5 w-3.5" />
              )}
              <span className="hidden sm:inline">{active.newLabel}</span>
              <span className="sm:hidden">New</span>
            </Button>
          </div>
        </div>

        {/* Applied filters. Clicking a chip reopens the drawer at that group. */}
        {chips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 bg-slate-50/70 px-3 py-2">
            {chips.map((chip) => (
              <span
                key={chip.param}
                className="inline-flex items-center overflow-hidden rounded-full border border-teal-200 bg-white text-xs text-teal-800"
              >
                <button
                  type="button"
                  onClick={() => openFilters(chip.param)}
                  className="py-1 pl-2.5 pr-1.5 transition-colors hover:bg-teal-50"
                >
                  <span className="text-slate-500">{chip.label}:</span>{' '}
                  <span className="font-medium">{chip.detail}</span>
                </button>
                <button
                  type="button"
                  onClick={() => removeChip(chip.param)}
                  aria-label={`Remove ${chip.label} filter`}
                  className="py-1 pl-0.5 pr-2 text-teal-500 transition-colors hover:text-teal-800"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={() => setSelection({})}
              className="ml-1 text-xs text-slate-500 underline-offset-2 hover:text-slate-900 hover:underline"
            >
              Clear filters
            </button>
          </div>
        )}

        {/*
          Each list is mounted only while its tab is open. Keeping all three
          alive would fire three paginated requests on every keystroke in a
          search box that only one of them is using.
        */}
        {stage === 'enquiries' && (
          <EnquiryList
            searchTerm={search}
            filters={selection}
            onClearFilters={() => setSelection({})}
          />
        )}
        {stage === 'registrations' && (
          <RegistrationList
            searchTerm={search}
            filters={selection}
            onClearFilters={() => setSelection({})}
          />
        )}
        {stage === 'enrollments' && (
          <EnrollmentList
            searchTerm={search}
            filters={selection}
            onClearFilters={() => setSelection({})}
          />
        )}
      </section>

      <FilterDrawer
        open={isFilterOpen}
        onOpenChange={setIsFilterOpen}
        groups={groups}
        selection={selection}
        onChange={setSelection}
        activeParam={activeParam}
        onActiveParamChange={setActiveParam}
        noun={active.noun}
      />
    </div>
  );
}

export default function AdmissionsPage() {
  // useSearchParams needs a Suspense boundary to keep this route static.
  return (
    <Suspense fallback={null}>
      <AdmissionsDirectory />
    </Suspense>
  );
}
