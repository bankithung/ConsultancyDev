'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUpDown, Building2, MapPin, Pencil, Plus, Power, Search, Users } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { PaginationBar } from '@/components/common/PaginationBar';
import { EmptyState, ErrorBanner, ErrorState, LoadingState } from '@/components/common/states';
import { RoleRoute } from '@/components/rbac/RoleGate';
import { CAN } from '@/components/rbac/roles';
import { apiClient } from '@/lib/apiClient';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { useDebounce } from '@/hooks/useDebounce';
import type { Branch } from '@/lib/types';

import { BranchFormDrawer } from './BranchFormDrawer';

/**
 * Branches — one panel: toolbar, a summary strip, the table, pagination.
 *
 * There is no manager FK on Branch — branch managers are Users with
 * role=BRANCH_MANAGER and branch=<id>, which is why they are assigned from
 * /app/users rather than here. The serializer exposes them as `manager_names`.
 *
 * WHAT THE SERVER ACTUALLY SUPPORTS. `BranchViewSet` (backend/core/views.py)
 * declares `search_fields = ('name', 'code', 'city')` and NOTHING else — no
 * `filterset_class`, no `filterset_fields`. Probed against the running API:
 * `?is_active=true`, `?is_active=false` and a nonsense `?zzz_nonsense=1` all
 * return the SAME count as the bare list, because DRF discards a parameter it
 * does not recognise and answers 200 with the full set. So this screen offers
 * search and sort and no filter control at all; a Filter button here would
 * change the URL, change nothing else, and look like it had worked.
 *
 * Ordering IS live (the global `OrderingFilter`), and every option in the sort
 * menu was checked against the API to confirm it genuinely reorders rows.
 * `ordering=bogusfield` is likewise dropped in silence, so only verified
 * fields are offered.
 */

/** Every value here was confirmed to reorder rows on the live endpoint. */
const SORT_OPTIONS = [
  { value: 'name', label: 'Name (A–Z)' },
  { value: '-name', label: 'Name (Z–A)' },
  { value: 'city', label: 'City' },
  { value: '-user_count', label: 'Most staff' },
] as const;

function BranchesPage() {
  const queryClient = useQueryClient();

  const [searchInput, setSearchInput] = useState('');
  const search = useDebounce(searchInput, 300);
  const [ordering, setOrdering] = useState<string>('name');

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editing, setEditing] = useState<Branch | null>(null);
  /** Bumped on every open so the drawer remounts with a clean form. */
  const [formSession, setFormSession] = useState(0);
  const [toggleTarget, setToggleTarget] = useState<Branch | null>(null);

  const branches = usePaginatedQuery<Branch>(['branches'], apiClient.branches.list, {
    search,
    ordering,
  });

  const toggleMutation = useMutation({
    mutationFn: (branch: Branch) =>
      apiClient.branches.update(branch.id, { is_active: !branch.is_active }),
    onSuccess: () => {
      // Deactivating a branch changes seat counting and who can reach what, so
      // both the list and the shared branch picker must refetch.
      queryClient.invalidateQueries({ queryKey: ['branches'] });
      queryClient.invalidateQueries({ queryKey: ['branch-options'] });
      setToggleTarget(null);
    },
  });

  const openForm = (branch: Branch | null) => {
    setEditing(branch);
    setFormSession((n) => n + 1);
    setIsFormOpen(true);
  };

  /*
   * Page-scoped, and labelled as such where they are shown.
   *
   * These used to sit in KPI cards beside the server's `count` reading "Active"
   * and "Staff", as though all three were totals. They are not: they reduce
   * over whatever rows this page happens to hold. There is no honest total to
   * put in their place — the endpoint has no `is_active` filter to take a
   * filtered `count` from and no staff aggregate — so the wording carries the
   * scope instead of the number pretending to a reach it does not have.
   */
  const activeOnPage = branches.rows.filter((branch) => branch.is_active).length;
  const staffOnPage = branches.rows.reduce((sum, branch) => sum + branch.user_count, 0);

  const isSearching = search.trim() !== '';

  return (
    <div className="pt-1">
      {/*
        No visible title. `AppShell` already puts "Branches" in the topbar —
        Topbar.tsx has no entry for this route, so its fallback derives the name
        from the last path segment — and the sidebar highlights the same word,
        so printing it a third time cost a block of vertical space to say
        nothing new.

        The heading survives as screen-reader-only because what the topbar
        renders is a `<span>`, not a heading element: with this removed
        outright the document would have no `h1` at all and heading navigation
        would land nowhere.
      */}
      <h1 className="sr-only">Branches</h1>

      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-2 border-b border-slate-100 p-3 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search by name, code or city…"
              aria-label="Search branches"
              className="h-9 border-slate-200 bg-white pl-9 text-sm focus:border-teal-500 focus:ring-teal-500"
            />
          </div>

          <div className="flex items-center gap-2">
            <Select value={ordering} onValueChange={setOrdering}>
              <SelectTrigger
                aria-label="Sort branches"
                className="h-9 w-[9.5rem] shrink-0 border-slate-200 text-xs"
              >
                <ArrowUpDown className="mr-1.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value} className="text-xs">
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              onClick={() => openForm(null)}
              size="sm"
              className="h-9 shrink-0 bg-teal-600 text-xs text-white hover:bg-teal-700"
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              <span className="hidden sm:inline">New branch</span>
              <span className="sm:hidden">New</span>
            </Button>
          </div>
        </div>

        {toggleMutation.isError && (
          <div className="border-b border-slate-100 p-3">
            <ErrorBanner error={toggleMutation.error} onDismiss={() => toggleMutation.reset()} />
          </div>
        )}

        {/*
          The only total here is the server's own `count`. The other two figures
          say "on this page" because that is all they are — see the note above
          `activeOnPage`.
        */}
        {branches.rows.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-100 bg-slate-50/70 px-3 py-2 text-xs text-slate-600">
            <span>
              <span className="font-semibold text-slate-900">{branches.count}</span>{' '}
              {branches.count === 1 ? 'branch' : 'branches'}
              {isSearching && ' matching'}
            </span>
            <span aria-hidden className="text-slate-300">
              |
            </span>
            <span>
              <span className="font-semibold text-slate-900">{activeOnPage}</span> of{' '}
              {branches.rows.length} active on this page
            </span>
            <span aria-hidden className="text-slate-300">
              |
            </span>
            <span>
              <span className="font-semibold text-slate-900">{staffOnPage}</span> staff on this page
            </span>
          </div>
        )}

        {branches.isError ? (
          <div className="p-4">
            <ErrorState error={branches.error} onRetry={branches.refetch} />
          </div>
        ) : branches.isLoading ? (
          <div className="p-4">
            <LoadingState rows={4} label="Loading branches" />
          </div>
        ) : branches.rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={Building2}
              title={isSearching ? 'No branches match that search' : 'No branches yet'}
              description={
                isSearching
                  ? 'Try a different name, code or city.'
                  : 'Add your first branch so staff and records can be assigned to a location.'
              }
              action={
                isSearching ? (
                  <Button variant="outline" onClick={() => setSearchInput('')}>
                    Clear search
                  </Button>
                ) : (
                  <Button onClick={() => openForm(null)} className="bg-teal-600 hover:bg-teal-700">
                    <Plus className="mr-2 h-4 w-4" /> New branch
                  </Button>
                )
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-slate-700">
                    Branch
                  </th>
                  <th className="hidden px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 md:table-cell">
                    Managers
                  </th>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-slate-700">
                    Staff
                  </th>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-slate-700">
                    Status
                  </th>
                  <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-slate-700">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {branches.rows.map((branch) => {
                  const managers = branch.manager_names;
                  return (
                    <tr key={branch.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2.5">
                        <div className="flex items-start gap-2.5">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-600">
                            <Building2 size={15} />
                          </div>
                          <div className="min-w-0">
                            <p className="truncate font-semibold text-slate-900">{branch.name}</p>
                            <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-slate-500">
                              <span className="font-mono">{branch.code}</span>
                              {branch.city && (
                                <>
                                  <span aria-hidden>·</span>
                                  <MapPin size={11} /> {branch.city}
                                </>
                              )}
                            </p>
                            <p className="mt-0.5 truncate text-xs text-slate-500 md:hidden">
                              {managers.length > 0 ? managers.join(', ') : 'No manager assigned'}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="hidden px-3 py-2.5 md:table-cell">
                        {managers.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {managers.map((name) => (
                              <span
                                key={name}
                                className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700"
                              >
                                {name}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-slate-400">Not assigned</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="inline-flex items-center gap-1.5 text-slate-700">
                          <Users size={14} className="text-slate-400" /> {branch.user_count}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          <Badge
                            className={
                              branch.is_active
                                ? 'border-transparent bg-green-100 text-green-700 hover:bg-green-100'
                                : 'border-transparent bg-slate-200 text-slate-600 hover:bg-slate-200'
                            }
                          >
                            {branch.is_active ? 'Active' : 'Inactive'}
                          </Badge>
                          {branch.is_default && (
                            <Badge className="border-transparent bg-blue-100 text-blue-700 hover:bg-blue-100">
                              Default
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 hover:bg-teal-50 hover:text-teal-600"
                            onClick={() => openForm(branch)}
                            aria-label={`Edit ${branch.name}`}
                          >
                            <Pencil size={15} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 hover:bg-amber-50 hover:text-amber-600 disabled:opacity-40"
                            onClick={() => setToggleTarget(branch)}
                            disabled={branch.is_default}
                            title={
                              branch.is_default ? 'The default branch cannot be deactivated' : undefined
                            }
                            aria-label={`${branch.is_active ? 'Deactivate' : 'Activate'} ${branch.name}`}
                          >
                            <Power size={15} />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <PaginationBar
          page={branches.page}
          pages={branches.pages}
          count={branches.count}
          pageSize={branches.pageSize}
          onPageChange={branches.setPage}
          isLoading={branches.isFetching}
        />
      </section>

      <BranchFormDrawer
        key={formSession}
        open={isFormOpen}
        branch={editing}
        onClose={() => setIsFormOpen(false)}
      />

      <ConfirmDialog
        open={toggleTarget !== null}
        onClose={() => setToggleTarget(null)}
        onConfirm={() => toggleTarget && toggleMutation.mutate(toggleTarget)}
        title={toggleTarget?.is_active ? 'Deactivate branch?' : 'Activate branch?'}
        description={
          toggleTarget?.is_active
            ? `${toggleTarget?.name} will stop accepting new records and staff assignments. Existing data is kept.`
            : `${toggleTarget?.name} will be able to receive records and staff again.`
        }
        confirmText={toggleTarget?.is_active ? 'Deactivate' : 'Activate'}
        confirmVariant={toggleTarget?.is_active ? 'destructive' : 'default'}
        isLoading={toggleMutation.isPending}
      />
    </div>
  );
}

export default function BranchesRoute() {
  return (
    <RoleRoute allow={CAN.manageBranches}>
      <BranchesPage />
    </RoleRoute>
  );
}
