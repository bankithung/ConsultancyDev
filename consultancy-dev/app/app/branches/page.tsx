'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, MapPin, Pencil, Plus, Power, Search, Users } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Modal } from '@/components/common/Modal';
import { PaginationBar } from '@/components/common/PaginationBar';
import { EmptyState, ErrorBanner, ErrorState, InlineSpinner, LoadingState } from '@/components/common/states';
import { RoleRoute } from '@/components/rbac/RoleGate';
import { CAN } from '@/components/rbac/roles';
import { apiClient } from '@/lib/apiClient';
import { getApiFieldErrors } from '@/lib/api';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { useDebounce } from '@/hooks/useDebounce';
import type { Branch } from '@/lib/types';

/**
 * There is no manager FK on Branch — branch managers are Users with
 * role=BRANCH_MANAGER and branch=<id>, which is why they are assigned from
 * /app/users rather than here. The serializer exposes them as `manager_names`.
 */

interface BranchForm {
  name: string;
  code: string;
  city: string;
  address: string;
  phone: string;
  is_active: boolean;
}

const EMPTY_FORM: BranchForm = {
  name: '',
  code: '',
  city: '',
  address: '',
  phone: '',
  is_active: true,
};

function BranchesPage() {
  const queryClient = useQueryClient();

  const [searchInput, setSearchInput] = useState('');
  const search = useDebounce(searchInput, 300);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editing, setEditing] = useState<Branch | null>(null);
  const [form, setForm] = useState<BranchForm>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [toggleTarget, setToggleTarget] = useState<Branch | null>(null);

  const branches = usePaginatedQuery<Branch>(['branches'], apiClient.branches.list, {
    search,
    ordering: 'name',
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['branches'] });
    queryClient.invalidateQueries({ queryKey: ['branch-options'] });
  };

  const saveMutation = useMutation({
    mutationFn: (payload: BranchForm) =>
      editing ? apiClient.branches.update(editing.id, payload) : apiClient.branches.create(payload),
    onSuccess: () => {
      invalidate();
      closeForm();
    },
    onError: (error: unknown) => setFieldErrors(getApiFieldErrors(error) ?? {}),
  });

  const toggleMutation = useMutation({
    mutationFn: (branch: Branch) => apiClient.branches.update(branch.id, { is_active: !branch.is_active }),
    onSuccess: () => {
      invalidate();
      setToggleTarget(null);
    },
  });

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFieldErrors({});
    saveMutation.reset();
    setIsFormOpen(true);
  };

  const openEdit = (branch: Branch) => {
    setEditing(branch);
    setForm({
      name: branch.name,
      code: branch.code,
      city: branch.city,
      address: branch.address,
      phone: branch.phone,
      is_active: branch.is_active,
    });
    setFieldErrors({});
    saveMutation.reset();
    setIsFormOpen(true);
  };

  const closeForm = () => {
    setIsFormOpen(false);
    setEditing(null);
    setFieldErrors({});
  };

  const activeOnPage = branches.rows.filter((branch) => branch.is_active).length;
  const staffOnPage = branches.rows.reduce((sum, branch) => sum + (branch.user_count), 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-900 font-heading">Branches</h1>
          <p className="mt-1 text-sm text-slate-600 font-body">
            Create and manage the offices your team works out of
          </p>
        </div>
        <Button onClick={openCreate} className="h-10 w-full bg-teal-600 hover:bg-teal-700 sm:w-auto">
          <Plus className="mr-2 h-4 w-4" /> New Branch
        </Button>
      </div>

      {toggleMutation.isError && <ErrorBanner error={toggleMutation.error} onDismiss={() => toggleMutation.reset()} />}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        <Card className="border-slate-200 p-4 sm:p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Total branches</p>
          <p className="mt-1 text-2xl font-bold text-slate-900">{branches.count}</p>
        </Card>
        <Card className="border-slate-200 p-4 sm:p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Active on this page</p>
          <p className="mt-1 text-2xl font-bold text-green-600">{activeOnPage}</p>
        </Card>
        <Card className="border-slate-200 p-4 sm:p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Staff on this page</p>
          <p className="mt-1 text-2xl font-bold text-slate-900">{staffOnPage}</p>
        </Card>
      </div>

      <div className="relative max-w-md">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by name, code or city…"
          aria-label="Search branches"
          className="h-10 pl-9"
        />
      </div>

      {branches.isError ? (
        <ErrorState error={branches.error} onRetry={branches.refetch} />
      ) : branches.isLoading ? (
        <LoadingState rows={4} label="Loading branches" />
      ) : branches.rows.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={search ? 'No branches match that search' : 'No branches yet'}
          description={
            search
              ? 'Try a different name, code or city.'
              : 'Add your first branch so staff and records can be assigned to a location.'
          }
          action={
            search ? (
              <Button variant="outline" onClick={() => setSearchInput('')}>
                Clear search
              </Button>
            ) : (
              <Button onClick={openCreate} className="bg-teal-600 hover:bg-teal-700">
                <Plus className="mr-2 h-4 w-4" /> New Branch
              </Button>
            )
          }
        />
      ) : (
        <Card className="overflow-hidden border-slate-200">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-700">Branch</th>
                  <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase text-slate-700 md:table-cell">
                    Managers
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-700">Staff</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-700">Status</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase text-slate-700">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {branches.rows.map((branch) => {
                  const managers = branch.manager_names;
                  return (
                    <tr key={branch.id} className="hover:bg-slate-50">
                      <td className="px-4 py-4">
                        <div className="flex items-start gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-600">
                            <Building2 size={16} />
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
                            <p className="mt-1 truncate text-xs text-slate-500 md:hidden">
                              {managers.length > 0 ? managers.join(', ') : 'No manager assigned'}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="hidden px-4 py-4 md:table-cell">
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
                      <td className="px-4 py-4">
                        <span className="inline-flex items-center gap-1.5 text-slate-700">
                          <Users size={14} className="text-slate-400" /> {branch.user_count}
                        </span>
                      </td>
                      <td className="px-4 py-4">
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
                      <td className="px-4 py-4">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 hover:bg-teal-50 hover:text-teal-600"
                            onClick={() => openEdit(branch)}
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
                            title={branch.is_default ? 'The default branch cannot be deactivated' : undefined}
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

          <PaginationBar
            page={branches.page}
            pages={branches.pages}
            count={branches.count}
            pageSize={branches.pageSize}
            onPageChange={branches.setPage}
            isLoading={branches.isFetching}
          />
        </Card>
      )}

      <Modal
        open={isFormOpen}
        onClose={closeForm}
        title={editing ? `Edit ${editing.name}` : 'New branch'}
        description={
          editing
            ? 'Update this office’s details.'
            : 'Branch managers and employees are assigned from the Users page once the branch exists.'
        }
        footer={
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="h-11 sm:w-32" onClick={closeForm}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="branch-form"
              className="h-11 bg-teal-600 hover:bg-teal-700 sm:w-40"
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending ? (
                <>
                  <InlineSpinner className="mr-2" /> Saving…
                </>
              ) : editing ? (
                'Save changes'
              ) : (
                'Create branch'
              )}
            </Button>
          </div>
        }
      >
        <form
          id="branch-form"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setFieldErrors({});
            saveMutation.mutate(form);
          }}
        >
          {saveMutation.isError && <ErrorBanner error={saveMutation.error} />}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="branch-name">Branch name *</Label>
              <Input
                id="branch-name"
                required
                className="h-11"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Kochi Main"
              />
              {fieldErrors.name && <p className="text-xs text-red-600">{fieldErrors.name}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="branch-code">Code *</Label>
              <Input
                id="branch-code"
                required
                className="h-11 uppercase"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                placeholder="KCH"
              />
              {fieldErrors.code && <p className="text-xs text-red-600">{fieldErrors.code}</p>}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="branch-city">City</Label>
              <Input
                id="branch-city"
                className="h-11"
                value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })}
              />
              {fieldErrors.city && <p className="text-xs text-red-600">{fieldErrors.city}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="branch-phone">Phone</Label>
              <Input
                id="branch-phone"
                type="tel"
                className="h-11"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
              {fieldErrors.phone && <p className="text-xs text-red-600">{fieldErrors.phone}</p>}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="branch-address">Address</Label>
            <textarea
              id="branch-address"
              rows={3}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
            />
            {fieldErrors.address && <p className="text-xs text-red-600">{fieldErrors.address}</p>}
          </div>

          <label className="flex items-start gap-3 rounded-lg border border-slate-200 p-3">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
              checked={form.is_active}
              onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
            />
            <span className="text-sm">
              <span className="font-medium text-slate-900">Active</span>
              <span className="mt-0.5 block text-xs text-slate-500">
                Inactive branches stay in reports but cannot receive new records or staff.
              </span>
            </span>
          </label>
        </form>
      </Modal>

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
