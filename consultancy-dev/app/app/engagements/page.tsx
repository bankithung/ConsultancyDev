'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Bell, CalendarDays, Plus, Search, SlidersHorizontal, X } from 'lucide-react';

import { apiClient } from '@/lib/apiClient';
import { cn } from '@/lib/utils';
import { toArray } from '@/components/common/pagination';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BookmarkTabs } from '@/components/common/BookmarkTabs';
import { LoadingState } from '@/components/common/states';
import { FOLLOW_UP_OUTCOME_LABELS } from '@/components/common/followUps';
import {
  FilterDrawer, selectionCount,
  type FilterGroup, type FilterSelection,
} from '@/components/common/FilterDrawer';
import { useCurrentRole } from '@/components/rbac/useCurrentRole';
import { ROLES } from '@/components/rbac/roles';

import { ENGAGEMENTS_PATH, TAB_LABELS, resolveTab, type TabValue } from './tabs';
import {
  createInitialState,
  type AppointmentsTabState,
  type EngagementTabState,
} from './state';
import {
  APPOINTMENT_STATUSES, APPOINTMENT_TYPES, FOLLOW_UP_PRIORITIES,
  FOLLOW_UP_STATUSES, FOLLOW_UP_TYPES, LIKELIHOODS, OUTCOMES,
} from './vocabulary';
import { AppointmentsView } from './components/AppointmentsView';
import { FollowUpsView } from './components/FollowUpsView';

/**
 * Engagements — follow-ups and appointments, one screen with two views.
 *
 * SERVER-SIDE FILTERING AND SEARCH ONLY, on both tabs. `FollowUpViewSet` and
 * `AppointmentViewSet` each declare a filterset and `search_fields`, and every
 * control offered here maps to one of them. Narrowing the fetched page in the
 * browser instead would hide rows from later pages while the count kept
 * reporting the unfiltered total — and a control with no backing filter is
 * worse still, because DRF discards an unrecognised parameter and answers 200
 * with the FULL list, which reads as "everything matched".
 *
 * NEITHER original route was role-gated: both sat in the sidebar under
 * EVERYONE, neither page wrapped itself in `RoleRoute`, and `proxy.ts` lists
 * neither prefix. So this screen is not gated either — the backend scopes every
 * row to what the caller may see. The one role-dependent control is the
 * "assigned to" / "counsellor" filter, which stays supervisor-only: an employee
 * only ever sees their own rows, so a picker of colleagues would filter to
 * nothing.
 */

/** Roles that see other people's rows, and so can filter by who owns one. */
const SUPERVISOR_ROLES = [
  ROLES.DEV_ADMIN,
  ROLES.COMPANY_ADMIN,
  ROLES.HEAD_MANAGER,
  ROLES.BRANCH_MANAGER,
] as const;

const TAB_META: Record<
  TabValue,
  {
    icon: typeof Bell;
    /** What the rows are called, for the drawer's header line. */
    noun: string;
    searchPlaceholder: string;
    newLabel: string;
  }
> = {
  'follow-ups': {
    icon: Bell,
    noun: 'follow-up',
    searchPlaceholder: 'Search by student, mobile, email or notes…',
    newLabel: 'Add follow-up',
  },
  appointments: {
    icon: CalendarDays,
    noun: 'appointment',
    searchPlaceholder: 'Search by client name or email…',
    newLabel: 'New appointment',
  },
};

const asOptions = (values: readonly string[]) => values.map((value) => ({ value, label: value }));

function EngagementsScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { is } = useCurrentRole();

  const canSeeOthers = is(...SUPERVISOR_ROLES);

  /**
   * The tab lives in the URL so a link, a bookmark or the back button lands on
   * the same place — and so the two old routes can redirect straight into it.
   */
  const tab = resolveTab(searchParams.get('tab'));
  const meta = TAB_META[tab];

  const setTab = (next: TabValue) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`${ENGAGEMENTS_PATH}?${params.toString()}`, { scroll: false });
  };

  const [state, setState] = useState(createInitialState);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  /** The panel's primary action; the form itself is owned by the active view. */
  const [isFormOpen, setIsFormOpen] = useState(false);

  const current = state[tab];

  /**
   * Writes to the fields BOTH tabs have.
   *
   * Spelled out per tab rather than with a computed key so the appointment-only
   * fields stay unreachable from here: `{...live, [tab]: patch}` would type-check
   * with a `mode` in the patch and quietly put one on the follow-ups tab.
   */
  const patchShared = (target: TabValue, patch: Partial<EngagementTabState>) =>
    setState((live) =>
      target === 'follow-ups'
        ? { ...live, 'follow-ups': { ...live['follow-ups'], ...patch } }
        : { ...live, appointments: { ...live.appointments, ...patch } },
    );

  const patchFollowUps = (patch: Partial<EngagementTabState>) => patchShared('follow-ups', patch);

  const patchAppointments = (patch: Partial<AppointmentsTabState>) =>
    setState((live) => ({ ...live, appointments: { ...live.appointments, ...patch } }));

  const patchCurrent = (patch: Partial<EngagementTabState>) => patchShared(tab, patch);

  /**
   * `committed` is what the queries run with — `search`, debounced.
   *
   * The debounce lives here rather than inside a view so that resetting the
   * page can happen in the same render the term changes in; see below. It is
   * keyed by tab, so switching tabs adopts that tab's own term at once instead
   * of running the previous tab's half-typed text against the new endpoint.
   */
  const pendingSearch = current.search;
  useEffect(() => {
    const timer = setTimeout(() => {
      setState((live) => {
        if (live[tab].committed === pendingSearch) return live;
        return tab === 'follow-ups'
          ? { ...live, 'follow-ups': { ...live['follow-ups'], committed: pendingSearch } }
          : { ...live, appointments: { ...live.appointments, committed: pendingSearch } };
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [tab, pendingSearch]);

  /**
   * A dialog belongs to the tab it was opened from, not to the screen: leaving
   * one open across a switch would show the appointment form over the follow-up
   * board. Closed during render rather than in an effect, so the wrong dialog
   * never paints first.
   */
  const [dialogTab, setDialogTab] = useState(tab);
  if (dialogTab !== tab) {
    setDialogTab(tab);
    setIsFilterOpen(false);
    setIsFormOpen(false);
  }

  /*
   * A new search or filter invalidates the current cursor — page 4 of the old
   * result set is usually out of range for the new one.
   *
   * Adjusted during render rather than in an effect: React re-runs immediately
   * with the corrected page, so no request is ever issued for the stale cursor.
   * In an effect it would fire one throwaway fetch for the old page first.
   */
  const shape = JSON.stringify([current.committed, current.selection]);
  if (current.shape !== shape) {
    patchCurrent({ shape, page: 1, selectedId: null });
  }

  /* ---------------------------------------------------------------- options */

  /**
   * Both tabs filter by a member of staff, so the list is fetched once here.
   * The views run the same query for their own pickers; react-query shares the
   * key, so it is still one request.
   */
  const staffQuery = useQuery({
    queryKey: ['users', 'assignable'],
    queryFn: () =>
      apiClient.users.list({
        page_size: 200,
        ordering: 'username',
        filters: { is_active_employee: true },
      }),
    enabled: canSeeOthers,
    staleTime: 5 * 60 * 1000,
  });

  const staffOptions = useMemo(
    () =>
      toArray(staffQuery.data).map((member) => ({
        value: member.id.toString(),
        label: member.full_name || member.username,
      })),
    [staffQuery.data],
  );

  /**
   * Every group maps to a filter the SERVER applies — `FollowUpFilter` and
   * `AppointmentFilter` in backend/core/filters.py. Nothing here narrows the
   * fetched page; with eight rows a page that would hide almost everything
   * while the count kept reporting the full total.
   */
  const groups = useMemo<FilterGroup[]>(() => {
    if (tab === 'follow-ups') {
      const followUpGroups: FilterGroup[] = [
        { param: 'status', label: 'Status', options: asOptions(FOLLOW_UP_STATUSES) },
        { param: 'priority', label: 'Priority', options: asOptions(FOLLOW_UP_PRIORITIES) },
        {
          param: 'type',
          label: 'Channel',
          options: asOptions(FOLLOW_UP_TYPES),
          hint: 'How the conversation is meant to happen.',
        },
        {
          param: 'outcome_status',
          label: 'Outcome',
          options: OUTCOMES.map((value) => ({
            value,
            label: FOLLOW_UP_OUTCOME_LABELS[value] ?? value,
          })),
          hint: 'Recorded when a follow-up is completed, so pending ones match none of these.',
        },
        {
          param: 'admission_possibility',
          label: 'Admission chance',
          options: asOptions(LIKELIHOODS),
          hint: 'The counsellor’s read after the call — four steps, not a percentage.',
        },
      ];

      if (canSeeOthers) {
        followUpGroups.push({
          param: 'assigned_to',
          label: 'Assigned to',
          searchable: true,
          options: staffOptions,
          hint: 'Who is due to make the call.',
        });
      }
      return followUpGroups;
    }

    const appointmentGroups: FilterGroup[] = [
      { param: 'status', label: 'Status', options: asOptions(APPOINTMENT_STATUSES) },
      {
        param: 'type',
        label: 'Meeting type',
        options: asOptions(APPOINTMENT_TYPES),
        hint: 'Where the meeting happens.',
      },
    ];

    if (canSeeOthers) {
      appointmentGroups.push({
        param: 'counselor',
        label: 'Counsellor',
        searchable: true,
        options: staffOptions,
        hint: 'Who is taking the meeting.',
      });
    }
    return appointmentGroups;
  }, [tab, canSeeOthers, staffOptions]);

  /* ------------------------------------------------------------------ chrome */

  const filterCount = selectionCount(current.selection);

  const openFilters = (param?: string) => {
    patchCurrent({ activeParam: param ?? groups[0]?.param ?? 'status' });
    setIsFilterOpen(true);
  };

  /** One chip per category — five selected outcomes should not be five chips. */
  const chips = useMemo(
    () =>
      groups
        .filter((group) => (current.selection[group.param] ?? []).length > 0)
        .map((group) => {
          const values = current.selection[group.param] ?? [];
          const only = group.options.find((option) => option.value === values[0]);
          return {
            param: group.param,
            label: group.label,
            detail: values.length === 1 ? (only?.label ?? values[0]) : `${values.length} selected`,
          };
        }),
    [groups, current.selection],
  );

  const removeChip = (param: string) => {
    const next = { ...current.selection };
    delete next[param];
    patchCurrent({ selection: next });
  };

  const setSelection = (selection: FilterSelection) => patchCurrent({ selection });

  const tabs = (Object.keys(TAB_META) as TabValue[]).map((value) => ({
    value,
    label: TAB_LABELS[value],
    icon: TAB_META[value].icon,
  }));

  return (
    <div className="pt-1">
      <BookmarkTabs tabs={tabs} value={tab} onChange={setTab} aria-label="Engagement view" />

      {/*
        One panel. The tabs sit on its top edge and everything below — toolbar,
        workload tiles, applied filters, the board itself and its pagination —
        is inside it, so the screen reads as a single object rather than a stack
        of loose cards.
      */}
      <section
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        className="overflow-hidden rounded-lg rounded-tl-none border border-slate-200 bg-white shadow-sm"
      >
        <div className="flex flex-col gap-2 border-b border-slate-100 p-3 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={current.search}
              onChange={(event) => patchCurrent({ search: event.target.value })}
              placeholder={meta.searchPlaceholder}
              aria-label={`Search ${TAB_LABELS[tab].toLowerCase()}`}
              className="h-9 border-slate-200 bg-white pl-9 text-sm focus:border-teal-500 focus:ring-teal-500"
            />
          </div>

          <div className="flex items-center gap-2">
            {/* Calendar or list. Appointments only — a follow-up has no grid. */}
            {tab === 'appointments' && (
              <div className="flex shrink-0 rounded-lg border border-slate-200 bg-slate-100 p-0.5">
                {(['calendar', 'list'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => patchAppointments({ mode: option })}
                    aria-pressed={state.appointments.mode === option}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-all',
                      state.appointments.mode === option
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900',
                    )}
                  >
                    {option}
                  </button>
                ))}
              </div>
            )}

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
              onClick={() => setIsFormOpen(true)}
              size="sm"
              className="h-9 shrink-0 bg-teal-600 text-xs text-white hover:bg-teal-700"
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              <span className="hidden sm:inline">{meta.newLabel}</span>
              <span className="sm:hidden">New</span>
            </Button>
          </div>
        </div>

        {/* Applied filters. Pressing a chip reopens the drawer at that group. */}
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
          Only the open tab is mounted. Keeping both alive would fire every
          appointment query on a keystroke in the follow-up search box, and
          vice versa.
        */}
        {tab === 'follow-ups' ? (
          <FollowUpsView
            state={state['follow-ups']}
            onChange={patchFollowUps}
            formOpen={isFormOpen}
            onFormOpenChange={setIsFormOpen}
          />
        ) : (
          <AppointmentsView
            state={state.appointments}
            onChange={patchAppointments}
            formOpen={isFormOpen}
            onFormOpenChange={setIsFormOpen}
          />
        )}
      </section>

      <FilterDrawer
        open={isFilterOpen}
        onOpenChange={setIsFilterOpen}
        groups={groups}
        selection={current.selection}
        onChange={setSelection}
        activeParam={current.activeParam}
        onActiveParamChange={(activeParam) => patchCurrent({ activeParam })}
        noun={meta.noun}
      />
    </div>
  );
}

export default function EngagementsPage() {
  // `useSearchParams` needs a Suspense boundary to avoid opting the whole route
  // out of static rendering.
  return (
    <Suspense fallback={<LoadingState rows={4} label="Loading engagements…" />}>
      <EngagementsScreen />
    </Suspense>
  );
}
