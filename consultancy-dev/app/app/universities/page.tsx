'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Building2, MapPin, Star, Search, Plus, Calendar, Eye, Award, SlidersHorizontal, X } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Label } from '@/components/ui/label';
import { Drawer } from '@/components/common/Drawer';
import {
  FilterDrawer, selectionCount,
  type FilterGroup, type FilterSelection,
} from '@/components/common/FilterDrawer';
import { PaginationBar } from '@/components/common/PaginationBar';
import { ErrorState, LoadingState } from '@/components/common/states';
import { fetchPage } from '@/lib/apiClient';
import { getApiErrorMessage } from '@/lib/api';
import { useDebounce } from '@/hooks/useDebounce';
import type { University, UniversityInput } from '@/lib/types';
import { AddUniversityModal } from './components/AddUniversityModal';

/**
 * University catalogue.
 *
 * The wire shape is `University` from lib/types — snake_case, with
 * `tuition_fee_min` / `tuition_fee_max` as separate columns (there is no
 * nested `tuitionFee` object) and `programs`, never `courses`. `company` is
 * null for entries shared across all tenants; the backend already scopes what
 * this caller may see, so there is no client-side company filter.
 *
 * WHERE EACH CONTROL RUNS, and why they differ:
 *
 * SEARCH is the server's. `UniversityViewSet` (core/views.py:726) declares
 * `search_fields = ('name', 'country', 'city')`, so `?search=` is real.
 *
 * COUNTRY and PROGRAM are narrowed HERE, because that viewset declares no
 * `filterset_fields` and no `filterset_class` at all. DjangoFilterBackend is a
 * default backend (config/settings.py:206) but with no filterset attached it
 * matches nothing, so `?country=UK` would be dropped and the endpoint would
 * answer 200 with the UNFILTERED list — a wrong answer that looks right.
 *
 * Narrowing in the browser is only honest because the WHOLE catalogue is
 * walked, not one page of it: filtering a single page would hide matches
 * further down while the count reported the unfiltered total. The one case
 * where that guarantee breaks is a catalogue bigger than the walk's cap, so
 * `fetchCatalogue` returns the server's own `count` and the page says so out
 * loud rather than filtering a truncated list in silence.
 *
 * Moving both to the server is a small backend change — see the report.
 */

/** Rows per page in the table. The catalogue itself is fetched whole. */
const ROWS_PER_PAGE = 25;

/** Page size and cap for the catalogue walk. 10 × 200 = 2000 rows. */
const CATALOGUE_PAGE_SIZE = 200;
const CATALOGUE_MAX_PAGES = 10;

/**
 * Walks every page of the catalogue and reports the server's own total beside
 * the rows.
 *
 * `fetchAllPages` returns rows alone, so a catalogue past the cap comes back
 * short with no way to tell — and a silently short list means silently partial
 * country/program filtering. Returning `count` is what makes that detectable.
 */
async function fetchCatalogue(search: string): Promise<{ rows: University[]; count: number }> {
  const rows: University[] = [];
  let page = 1;
  let pages = 1;
  let count = 0;

  do {
    const envelope = await fetchPage<University>('universities/', {
      ordering: 'name',
      search: search || undefined,
      page,
      page_size: CATALOGUE_PAGE_SIZE,
    });
    rows.push(...envelope.results);
    pages = envelope.pages;
    count = envelope.count;
    page += 1;
  } while (page <= pages && page <= CATALOGUE_MAX_PAGES);

  return { rows, count };
}

const asOptions = (values: string[]) => values.map((value) => ({ value, label: value }));

/** The edit form's shape. Lists are held as ", "-joined strings, as they arrive. */
interface EditForm {
  name: string;
  country: string;
  city: string;
  ranking: string;
  rating: string;
  programs: string;
  tuitionMin: string;
  tuitionMax: string;
  deadline: string;
  requirements: string;
}

const EMPTY_EDIT: EditForm = {
  name: '', country: '', city: '', ranking: '', rating: '',
  programs: '', tuitionMin: '', tuitionMax: '', deadline: '', requirements: ''
};

function isSameEdit(a: EditForm, b: EditForm): boolean {
  return (Object.keys(a) as Array<keyof EditForm>).every((key) => a[key] === b[key]);
}

/**
 * Column counts for the checkbox grids, retuned for a panel rather than a
 * centred modal: the drawer is full-bleed below `md` and snaps to 60vw at it,
 * so the count has to step BACK there before it climbs again. See the same
 * constant in components/AddUniversityModal.tsx.
 */
const CHECKBOX_GRID = 'grid-cols-2 sm:grid-cols-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4';

export default function UniversitiesPage() {
  const [searchTerm, setSearchTerm] = useState('');
  const debouncedSearch = useDebounce(searchTerm, 300);
  const [selection, setSelection] = useState<FilterSelection>({});
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [activeParam, setActiveParam] = useState('country');
  const [page, setPage] = useState(1);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [selectedUni, setSelectedUni] = useState<University | null>(null);
  /**
   * Kept separate from `selectedUni` rather than derived from it. The panel
   * animates out, and clearing the record on close would blank its contents
   * mid-slide; the record is instead replaced on the next open.
   */
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [activeTab, setActiveTab] = useState<'basic' | 'programs' | 'requirements'>('basic');
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [editUni, setEditUni] = useState(EMPTY_EDIT);
  /** The values `startEdit` seeded, so the dirty check knows what was changed. */
  const [editBaseline, setEditBaseline] = useState(EMPTY_EDIT);
  /**
   * Which dismissal is waiting on the discard confirmation: closing the panel
   * outright, or just dropping back to view mode. One confirmation bar serves
   * both, so it has to remember which one asked.
   */
  const [pendingDiscard, setPendingDiscard] = useState<'close' | 'view' | null>(null);

  const catalogueQuery = useQuery({
    queryKey: ['universities', { search: debouncedSearch }],
    queryFn: () => fetchCatalogue(debouncedSearch),
  });

  const { isLoading, isError, error, refetch, isFetching } = catalogueQuery;
  const universities = useMemo(() => catalogueQuery.data?.rows ?? [], [catalogueQuery.data]);
  const serverCount = catalogueQuery.data?.count ?? 0;
  /** The walk hit its cap, so the rows in hand are not the whole catalogue. */
  const isTruncated = serverCount > universities.length;

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: UniversityInput }) =>
      apiClient.universities.update(id, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['universities'] });
      // Only the open flag is touched; edit mode, tab and record are reset by
      // the next open, so none of them flip visibly while the panel slides out.
      setIsPanelOpen(false);
      setPendingDiscard(null);
      toast({ title: 'University Updated', type: 'success' });
    },
    onError: (mutationError: unknown) => {
      toast({
        title: 'Failed to update university',
        description: getApiErrorMessage(mutationError),
        type: 'error',
      });
    },
  });

  const handleUpdate = () => {
    if (!editUni.name || !editUni.country || !selectedUni) {
      toast({ title: 'Validation Error', description: 'Name and Country are required', type: 'error' });
      return;
    }
    const splitList = (value: string): string[] =>
      value.split(',').map((s) => s.trim()).filter((s) => s !== '');

    updateMutation.mutate({
      id: selectedUni.id,
      // Field names mirror `UniversitySerializer`; `company` is server-set and
      // sending it would just be discarded.
      data: {
        name: editUni.name,
        country: editUni.country,
        city: editUni.city,
        ranking: editUni.ranking === '' ? null : Number(editUni.ranking),
        rating: Number(editUni.rating) || 0,
        programs: splitList(editUni.programs),
        requirements: splitList(editUni.requirements),
        tuition_fee_min: Number(editUni.tuitionMin) || 0,
        tuition_fee_max: Number(editUni.tuitionMax) || 0,
        admission_deadline: editUni.deadline,
      },
    });
  };

  const startEdit = (uni: University) => {
    const seeded: EditForm = {
      name: uni.name,
      country: uni.country,
      city: uni.city,
      ranking: uni.ranking === null ? '' : String(uni.ranking),
      rating: String(uni.rating),
      programs: uni.programs.join(', '),
      tuitionMin: String(uni.tuition_fee_min),
      tuitionMax: String(uni.tuition_fee_max),
      deadline: uni.admission_deadline,
      requirements: uni.requirements.join(', '),
    };
    setEditUni(seeded);
    setEditBaseline(seeded);
    setPendingDiscard(null);
    setIsEditMode(true);
    setActiveTab('basic');
  };

  /** Edits the user would lose. Only meaningful while the form is on screen. */
  const isEditDirty = isEditMode && !isSameEdit(editUni, editBaseline);

  const openPanel = (uni: University) => {
    setSelectedUni(uni);
    setIsEditMode(false);
    setActiveTab('basic');
    setPendingDiscard(null);
    setIsPanelOpen(true);
  };

  const closePanel = () => {
    setIsPanelOpen(false);
    setPendingDiscard(null);
  };

  /**
   * Vetoes scrim clicks, Escape and the close button while an edit is unsaved,
   * and asks instead — the same bargain the other drawers strike.
   */
  const requestClose = (): boolean => {
    // Mid-save the record may already be on its way to the server.
    if (updateMutation.isPending) return false;
    if (!isEditDirty || pendingDiscard !== null) return true;
    setPendingDiscard('close');
    return false;
  };

  /** "Cancel editing" drops back to view mode, which also throws edits away. */
  const requestExitEdit = () => {
    if (updateMutation.isPending) return;
    if (!isEditDirty) {
      setIsEditMode(false);
      return;
    }
    setPendingDiscard('view');
  };

  /** Copies a shareable summary — what "recommending" a university means in practice. */
  const handleRecommend = async (uni: University) => {
    const summary = [
      uni.name,
      `${uni.city}, ${uni.country}`,
      uni.ranking === null ? null : `World ranking: #${uni.ranking}`,
      uni.programs.length > 0 ? `Programs: ${uni.programs.join(', ')}` : null,
      `Annual tuition: ₹${uni.tuition_fee_min.toLocaleString('en-IN')} – ₹${uni.tuition_fee_max.toLocaleString('en-IN')}`,
      uni.admission_deadline ? `Admission deadline: ${uni.admission_deadline}` : 'Rolling admission',
      uni.requirements.length > 0 ? `Requirements: ${uni.requirements.join('; ')}` : null,
    ]
      .filter((line): line is string => line !== null)
      .join('\n');

    try {
      await navigator.clipboard.writeText(summary);
      toast({ title: 'Details copied', description: 'Paste them into an email or message for the student.', type: 'success' });
    } catch {
      toast({ title: 'Could not copy', description: 'Your browser blocked clipboard access.', type: 'error' });
    }
  };

  const countries = useMemo(
    () =>
      Array.from(new Set(universities.map((u) => u.country).filter((c) => c && c.trim() !== ''))).sort(
        (a, b) => a.localeCompare(b),
      ),
    [universities],
  );
  const allPrograms = useMemo(
    () => Array.from(new Set(universities.flatMap((u) => u.programs))).sort((a, b) => a.localeCompare(b)),
    [universities],
  );

  /**
   * Options come from the catalogue in hand rather than a fixed vocabulary, so
   * a country nobody has entered never appears as a filter that returns
   * nothing.
   */
  const groups = useMemo<FilterGroup[]>(
    () => [
      {
        param: 'country',
        label: 'Country',
        options: asOptions(countries),
        searchable: true,
        hint: 'Matches universities in any of the countries you pick.',
      },
      {
        param: 'program',
        label: 'Program',
        options: asOptions(allPrograms),
        searchable: true,
        hint: 'Matches a university offering any one of these programs.',
      },
    ],
    [countries, allPrograms],
  );

  const filteredUniversities = useMemo(() => {
    // Read inside the memo: `selection.country ?? []` allocates a fresh array
    // on every render, which would make the dependency change every time and
    // the memo pointless.
    const selectedCountries = selection.country ?? [];
    const selectedPrograms = selection.program ?? [];

    return universities.filter(
      (uni) =>
        (selectedCountries.length === 0 || selectedCountries.includes(uni.country)) &&
        (selectedPrograms.length === 0 ||
          uni.programs.some((program) => selectedPrograms.includes(program))),
    );
  }, [universities, selection]);

  // Reset to page 1 during render rather than in an effect: an effect runs
  // after paint, so a narrower result would flash page 4 of 1 first.
  const resetKey = `${debouncedSearch}|${JSON.stringify(selection)}`;
  const [lastResetKey, setLastResetKey] = useState(resetKey);
  if (resetKey !== lastResetKey) {
    setLastResetKey(resetKey);
    setPage(1);
  }

  const totalPages = Math.max(1, Math.ceil(filteredUniversities.length / ROWS_PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const visibleUniversities = filteredUniversities.slice(
    (currentPage - 1) * ROWS_PER_PAGE,
    currentPage * ROWS_PER_PAGE,
  );

  const filterCount = selectionCount(selection);
  const hasQuery = searchTerm !== '' || filterCount > 0;

  const openFilters = (param?: string) => {
    setActiveParam(param ?? groups[0]?.param ?? 'country');
    setIsFilterOpen(true);
  };

  /** One chip per category — six selected countries should not be six chips. */
  const chips = groups
    .filter((group) => (selection[group.param] ?? []).length > 0)
    .map((group) => {
      const values = selection[group.param] ?? [];
      return {
        param: group.param,
        label: group.label,
        detail: values.length === 1 ? values[0] : `${values.length} selected`,
      };
    });

  const removeChip = (param: string) => {
    const next = { ...selection };
    delete next[param];
    setSelection(next);
  };

  const clearAll = () => {
    setSearchTerm('');
    setSelection({});
  };

  const detailsFooter = pendingDiscard !== null ? (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm font-medium text-slate-700">
        Discard your changes to this university?
      </p>
      <div className="flex shrink-0 gap-2">
        <Button type="button" variant="outline" onClick={() => setPendingDiscard(null)} className="flex-1 sm:flex-none">
          Keep editing
        </Button>
        <Button
          type="button"
          onClick={() => {
            // The bar serves both dismissals, so it replays whichever asked.
            const target = pendingDiscard;
            setPendingDiscard(null);
            if (target === 'close') closePanel();
            else setIsEditMode(false);
          }}
          className="flex-1 bg-rose-600 hover:bg-rose-700 sm:flex-none"
        >
          Discard
        </Button>
      </div>
    </div>
  ) : isEditMode ? (
    <div className="mx-auto flex w-full max-w-3xl flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button variant="outline" onClick={requestExitEdit} disabled={updateMutation.isPending} className="w-full sm:w-auto">
        Cancel editing
      </Button>
      <Button onClick={handleUpdate} disabled={updateMutation.isPending} className="w-full bg-teal-600 hover:bg-teal-700 sm:w-auto">
        {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
      </Button>
    </div>
  ) : (
    /* "Edit Details" used to sit in the modal header; the shared drawer header
       has no room for actions, so it joins the other two here. */
    <div className="mx-auto flex w-full max-w-3xl flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button variant="outline" onClick={closePanel} className="w-full sm:w-auto">Close</Button>
      <Button
        variant="outline"
        onClick={() => selectedUni && startEdit(selectedUni)}
        disabled={!selectedUni}
        className="w-full sm:w-auto"
      >
        Edit Details
      </Button>
      <Button
        className="w-full bg-teal-600 hover:bg-teal-700 sm:w-auto"
        onClick={() => selectedUni && void handleRecommend(selectedUni)}
        disabled={!selectedUni}
      >
        Recommend to Student
      </Button>
    </div>
  );

  return (
    <div>
      {/*
        ONE panel. Toolbar, chips, table and pagination are all inside the same
        bordered box so the screen reads as a single object rather than a stack
        of cards. Matches /app/admissions and /app/engagements.
      */}
      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-2 border-b border-slate-100 p-3 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              placeholder="Search universities, cities or countries…"
              aria-label="Search universities"
              className="h-9 border-slate-200 bg-white pl-9 text-sm focus:border-teal-500 focus:ring-teal-500"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
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
              onClick={() => setIsAddOpen(true)}
              size="sm"
              className="h-9 shrink-0 bg-teal-600 text-xs hover:bg-teal-700"
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              <span className="hidden sm:inline">Add University</span>
              <span className="sm:hidden">Add</span>
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
          Said out loud rather than hidden: past the walk's cap the country and
          program filters are running over part of the catalogue, and a filter
          that quietly covers 2000 of 3000 rows is worse than one that admits it.
        */}
        {isTruncated && (
          <p className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
            Showing the first {universities.length} of {serverCount} universities. Country and program
            filters only cover these — narrow the search to bring the rest into range.
          </p>
        )}

        {isLoading ? (
          <div className="p-4">
            <LoadingState rows={4} label="Loading universities…" />
          </div>
        ) : isError ? (
          <div className="p-4">
            <ErrorState error={error} onRetry={() => void refetch()} title="Could not load universities" />
          </div>
        ) : filteredUniversities.length === 0 ? (
          <div className="px-4 py-16 text-center">
            <Building2 className="mx-auto mb-2 h-10 w-10 text-slate-300" />
            <p className="text-sm font-medium text-slate-500">
              {hasQuery
                ? 'No universities match your search and filters.'
                : 'No universities yet. Add your first one.'}
            </p>
            {hasQuery && (
              <button
                type="button"
                onClick={clearAll}
                className="mt-2 text-xs text-teal-700 underline-offset-2 hover:underline"
              >
                Clear search and filters
              </button>
            )}
          </div>
        ) : (
          <>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700 uppercase tracking-wider">University</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700 uppercase tracking-wider">Location</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-slate-700 uppercase tracking-wider">Ranking</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-slate-700 uppercase tracking-wider">Rating</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700 uppercase tracking-wider">Programs</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700 uppercase tracking-wider">Tuition Fee</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700 uppercase tracking-wider">Deadline</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-slate-700 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibleUniversities.map((uni) => (
                  <tr key={uni.id} className="hover:bg-slate-50 transition-colors">
                    {/* University Name */}
                    <td className="px-4 py-3">
                      <div className="flex items-start gap-2">
                        <div className="w-8 h-8 rounded bg-gradient-to-br from-teal-500 to-blue-500 flex items-center justify-center shrink-0">
                          <Building2 size={16} className="text-white" />
                        </div>
                        <div className="min-w-0">
                          <p className="font-semibold text-sm text-slate-900 line-clamp-1">{uni.name}</p>
                        </div>
                      </div>
                    </td>

                    {/* Location */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 text-sm text-slate-600">
                        <MapPin size={14} className="text-slate-400 shrink-0" />
                        <span className="truncate">{uni.city}, {uni.country}</span>
                      </div>
                    </td>

                    {/* Ranking */}
                    <td className="px-4 py-3 text-center">
                      <div className="inline-flex items-center gap-1 px-2 py-1 bg-slate-100 rounded text-sm font-semibold text-slate-700">
                        <Award size={12} className="text-slate-500" />
                        #{uni.ranking || 'N/A'}
                      </div>
                    </td>

                    {/* Rating */}
                    <td className="px-4 py-3 text-center">
                      <div className="inline-flex items-center gap-1 px-2 py-1 bg-yellow-50 rounded border border-yellow-200">
                        <Star size={12} className="text-yellow-600 fill-yellow-600" />
                        <span className="text-sm font-bold text-yellow-700">{uni.rating}</span>
                      </div>
                    </td>

                    {/* Programs */}
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1 max-w-[200px]">
                        {uni.programs.slice(0, 3).map((prog) => (
                          <span key={prog} className="px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded text-[10px] font-semibold border border-blue-100">
                            {prog}
                          </span>
                        ))}
                        {uni.programs.length > 3 && (
                          <span className="px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded text-[10px] font-semibold">
                            +{uni.programs.length - 3}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Tuition Fee */}
                    <td className="px-4 py-3">
                      <div className="text-sm font-semibold text-teal-600">
                        ₹{(uni.tuition_fee_min / 1000).toFixed(0)}K - ₹{(uni.tuition_fee_max / 1000).toFixed(0)}K
                      </div>
                      <div className="text-[10px] text-slate-500">per year</div>
                    </td>

                    {/* Deadline */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 text-sm text-slate-600">
                        <Calendar size={12} className="text-slate-400" />
                        <span className="text-xs">{uni.admission_deadline || 'Rolling'}</span>
                      </div>
                    </td>

                    {/* A "Students" column used to sit here. It was removed, not
                        left blank: `Enrollment` carries `programName` and no
                        university foreign key anywhere on the wire, so the count
                        could never be computed and every row rendered a dash.
                        A column that is structurally always empty reads as a
                        broken feature rather than as absent data. Restoring it
                        needs a backend FK — see the report. */}

                    {/* Actions */}
                    <td className="px-4 py-3 text-center">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-3 text-teal-600 hover:text-teal-700 hover:bg-teal-50"
                        onClick={() => openPanel(uni)}
                      >
                        <Eye size={14} className="mr-1" />
                        View
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <PaginationBar
            page={currentPage}
            pages={totalPages}
            count={filteredUniversities.length}
            pageSize={ROWS_PER_PAGE}
            onPageChange={setPage}
            isLoading={isFetching}
          />
          </>
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
        noun="university"
      />

      {/* View/Edit University panel */}
      <Drawer
        open={isPanelOpen}
        onOpenChange={(open) => {
          if (!open) closePanel();
        }}
        onRequestClose={requestClose}
        title={isEditMode ? 'Edit university' : selectedUni?.name ?? 'University'}
        description={isEditMode ? 'Update university details below' : 'View university details'}
        panelClassName="md:w-[60vw]"
        bodyClassName="bg-slate-50 px-4 py-5 sm:px-6"
        footer={detailsFooter}
      >
        <div className="mx-auto w-full max-w-3xl">
            {/* Tabs */}
            <div className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200">
              <button
                onClick={() => setActiveTab('basic')}
                className={`shrink-0 whitespace-nowrap px-4 py-3 text-sm font-medium border-b-2 transition-colors ${activeTab === 'basic' ? 'border-teal-600 text-teal-600' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
              >
                Basic Info
              </button>
              <button
                onClick={() => setActiveTab('programs')}
                className={`shrink-0 whitespace-nowrap px-4 py-3 text-sm font-medium border-b-2 transition-colors ${activeTab === 'programs' ? 'border-teal-600 text-teal-600' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
              >
                Programs & Fees
              </button>
              <button
                onClick={() => setActiveTab('requirements')}
                className={`shrink-0 whitespace-nowrap px-4 py-3 text-sm font-medium border-b-2 transition-colors ${activeTab === 'requirements' ? 'border-teal-600 text-teal-600' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
              >
                Requirements
              </button>
            </div>

            {/* Tab Content */}
            <div>
              {activeTab === 'basic' && (
                <div className="space-y-4 max-w-4xl">
                  {/* Primary Info */}
                  <div className="border border-slate-200 rounded-lg p-5 bg-white shadow-sm">
                    <h3 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
                      <div className="w-1 h-5 bg-teal-600 rounded-full"></div>
                      Primary Information
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label className="text-sm font-medium text-slate-700">University Name</Label>
                        {isEditMode ? (
                          <Input value={editUni.name} onChange={e => setEditUni({ ...editUni, name: e.target.value })} className="h-10 border-slate-300" />
                        ) : (
                          <p className="text-sm font-medium text-slate-900">{selectedUni?.name}</p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <Label className="text-sm font-medium text-slate-700">Country</Label>
                        {isEditMode ? (
                          <Select value={editUni.country} onValueChange={(val) => setEditUni({ ...editUni, country: val })}>
                            <SelectTrigger className="h-10 border-slate-300"><SelectValue placeholder="Select Country" /></SelectTrigger>
                            {/* Same countries list as Add Modal - shortened for brevity in this replace block, assume same list */}
                            <SelectContent className="max-h-60">
                              <SelectItem value="Russia">🇷🇺 Russia</SelectItem>
                              <SelectItem value="Czech Republic">🇨🇿 Czech Republic</SelectItem>
                              <SelectItem value="Poland">🇵🇱 Poland</SelectItem>
                              <SelectItem value="Ukraine">🇺🇦 Ukraine</SelectItem>
                              <SelectItem value="Philippines">🇵🇭 Philippines</SelectItem>
                              <SelectItem value="China">🇨🇳 China</SelectItem>
                              <SelectItem value="Bangladesh">🇧🇩 Bangladesh</SelectItem>
                              <SelectItem value="Nepal">🇳🇵 Nepal</SelectItem>
                              <SelectItem value="Kyrgyzstan">🇰🇬 Kyrgyzstan</SelectItem>
                              <SelectItem value="Kazakhstan">🇰🇿 Kazakhstan</SelectItem>
                              <SelectItem value="USA">🇺🇸 USA</SelectItem>
                              <SelectItem value="UK">🇬🇧 UK</SelectItem>
                              <SelectItem value="Canada">🇨🇦 Canada</SelectItem>
                              <SelectItem value="Australia">🇦🇺 Australia</SelectItem>
                              <SelectItem value="Germany">🇩🇪 Germany</SelectItem>
                              <SelectItem value="India">🇮🇳 India</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <p className="text-sm text-slate-900 flex items-center gap-2"><MapPin size={14} className="text-slate-400" /> {selectedUni?.country}</p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <Label className="text-sm font-medium text-slate-700">City</Label>
                        {isEditMode ? (
                          <Input value={editUni.city} onChange={e => setEditUni({ ...editUni, city: e.target.value })} className="h-10 border-slate-300" />
                        ) : (
                          <p className="text-sm text-slate-900">{selectedUni?.city}</p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <Label className="text-sm font-medium text-slate-700">Deadline</Label>
                        {isEditMode ? (
                          <Input type="date" value={editUni.deadline} onChange={e => setEditUni({ ...editUni, deadline: e.target.value })} className="h-10 border-slate-300" />
                        ) : (
                          <div className="flex items-center gap-2 text-sm text-slate-900">
                            <Calendar size={14} className="text-slate-400" />
                            {selectedUni?.admission_deadline || 'Rolling Admission'}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Ranking & Rating */}
                  <div className="border border-slate-200 rounded-lg p-5 bg-white shadow-sm">
                    <h3 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
                      <div className="w-1 h-5 bg-yellow-600 rounded-full"></div>
                      Rankings & Rating
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label className="text-sm font-medium text-slate-700">World Ranking</Label>
                        {isEditMode ? (
                          <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-medium">#</span>
                            <Input type="number" value={editUni.ranking} onChange={e => setEditUni({ ...editUni, ranking: e.target.value })} className="h-10 border-slate-300 pl-8" />
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-bold text-slate-900 bg-slate-100 px-2 py-1 rounded">#{selectedUni?.ranking}</span>
                            <span className="text-xs text-slate-500">Global Rank</span>
                          </div>
                        )}
                      </div>
                      <div className="space-y-2">
                        <Label className="text-sm font-medium text-slate-700">Rating</Label>
                        {isEditMode ? (
                          <Select value={editUni.rating} onValueChange={(val) => setEditUni({ ...editUni, rating: val })}>
                            <SelectTrigger className="h-10 border-slate-300"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="5.0">⭐⭐⭐⭐⭐ 5.0</SelectItem>
                              <SelectItem value="4.8">⭐⭐⭐⭐⭐ 4.8</SelectItem>
                              <SelectItem value="4.5">⭐⭐⭐⭐ 4.5</SelectItem>
                              <SelectItem value="4.0">⭐⭐⭐⭐ 4.0</SelectItem>
                              <SelectItem value="3.5">⭐⭐⭐ 3.5</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <div className="flex items-center gap-1">
                            <Star size={16} className="text-yellow-500 fill-yellow-500" />
                            <span className="text-lg font-bold text-slate-900">{selectedUni?.rating}</span>
                            <span className="text-xs text-slate-500 ml-1">Student Satisfaction</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'programs' && (
                <div className="space-y-4 max-w-4xl">
                  <div className="border border-slate-200 rounded-lg p-5 bg-white shadow-sm">
                    <Label className="text-sm font-semibold text-slate-700 mb-3 block">Programs Offered</Label>
                    {isEditMode ? (
                      <div className={`grid ${CHECKBOX_GRID} gap-2 p-3 bg-slate-50 rounded border`}>
                        {['MBBS', 'MD', 'BDS', 'BAMS', 'BHMS', 'Engineering', 'B.Tech', 'MBA', 'BBA', 'Law', 'LLB', 'Nursing', 'Pharmacy', 'B.Sc', 'M.Sc', 'Arts', 'Commerce', 'Management'].map(prog => (
                          <label key={prog} className="flex items-center gap-2 p-2 hover:bg-white rounded cursor-pointer">
                            <input type="checkbox" checked={editUni.programs.includes(prog)}
                              onChange={e => {
                                const curr = editUni.programs.split(', ').filter(Boolean);
                                if (e.target.checked) setEditUni({ ...editUni, programs: [...curr, prog].join(', ') });
                                else setEditUni({ ...editUni, programs: curr.filter(p => p !== prog).join(', ') });
                              }}
                              className="w-4 h-4 text-teal-600 rounded"
                            />
                            <span className="text-sm">{prog}</span>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {selectedUni?.programs.map(prog => (
                          <span key={prog} className="px-3 py-1.5 bg-blue-50 text-blue-700 rounded-md text-sm font-medium border border-blue-100">{prog}</span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="border border-slate-200 rounded-lg p-5 bg-white shadow-sm">
                    <Label className="text-sm font-semibold text-slate-700 mb-3 block">Annual Tuition</Label>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <span className="text-xs text-slate-500">Minimum</span>
                        {isEditMode ? (
                          <Input type="number" value={editUni.tuitionMin} onChange={e => setEditUni({ ...editUni, tuitionMin: e.target.value })} className="h-10" />
                        ) : (
                          <p className="text-xl font-bold text-teal-600">₹{selectedUni?.tuition_fee_min.toLocaleString('en-IN')}</p>
                        )}
                      </div>
                      <div className="space-y-1">
                        <span className="text-xs text-slate-500">Maximum</span>
                        {isEditMode ? (
                          <Input type="number" value={editUni.tuitionMax} onChange={e => setEditUni({ ...editUni, tuitionMax: e.target.value })} className="h-10" />
                        ) : (
                          <p className="text-xl font-bold text-teal-600">₹{selectedUni?.tuition_fee_max.toLocaleString('en-IN')}</p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'requirements' && (
                <div className="max-w-4xl">
                  <div className="border border-slate-200 rounded-lg p-5 bg-white shadow-sm">
                    <Label className="text-sm font-semibold text-slate-700 mb-3 block">Eligibility Requirements</Label>
                    {isEditMode ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-2 gap-2 p-3 bg-slate-50 rounded border">
                        {['NEET Qualified', '60% in PCB', '50% in PCB', '12th Pass', 'IELTS 6.0+', 'TOEFL 80+', 'Age 17-25', 'English Proficiency', 'Medical Fitness', 'Valid Passport'].map(req => (
                          <label key={req} className="flex items-center gap-2 p-2 hover:bg-white rounded cursor-pointer">
                            <input type="checkbox" checked={editUni.requirements.includes(req)}
                              onChange={e => {
                                const curr = editUni.requirements.split(', ').filter(Boolean);
                                if (e.target.checked) setEditUni({ ...editUni, requirements: [...curr, req].join(', ') });
                                else setEditUni({ ...editUni, requirements: curr.filter(r => r !== req).join(', ') });
                              }}
                              className="w-4 h-4 text-teal-600 rounded"
                            />
                            <span className="text-sm">{req}</span>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <ul className="space-y-3">
                        {selectedUni?.requirements.map((req, i) => (
                          <li key={i} className="flex items-start gap-3 text-sm text-slate-700 bg-slate-50 p-3 rounded-lg border border-slate-100">
                            <div className="w-5 h-5 rounded-full bg-teal-100 text-teal-600 flex items-center justify-center shrink-0 text-xs font-bold">✓</div>
                            {req}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </div>
        </div>
      </Drawer>

      {/* Add University panel */}
      <AddUniversityModal isOpen={isAddOpen} onClose={() => setIsAddOpen(false)} />
    </div>
  );
}
