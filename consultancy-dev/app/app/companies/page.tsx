'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Building, CalendarClock, CreditCard, GitBranch, Pencil, Plus, Power, Search, Users } from 'lucide-react';
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
import type { Company, Subscription, SubscriptionStatus } from '@/lib/types';

const STATUS_STYLE: Record<SubscriptionStatus, string> = {
  ACTIVE: 'bg-green-100 text-green-700',
  TRIALING: 'bg-blue-100 text-blue-700',
  PAST_DUE: 'bg-amber-100 text-amber-800',
  CANCELLED: 'bg-slate-200 text-slate-600',
  EXPIRED: 'bg-red-100 text-red-700',
};

const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  ACTIVE: 'Active',
  TRIALING: 'Trial',
  PAST_DUE: 'Past due',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
};

interface CompanyForm {
  name: string;
  email: string;
  phone: string;
  address: string;
}

const EMPTY_FORM: CompanyForm = { name: '', email: '', phone: '', address: '' };

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

function SubscriptionBadge({ subscription }: { subscription: Subscription | null | undefined }) {
  if (!subscription) return <span className="text-xs text-slate-400">No subscription</span>;
  const style = STATUS_STYLE[subscription.status] ?? 'bg-slate-100 text-slate-700';
  return (
    <div>
      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${style}`}>
        {STATUS_LABEL[subscription.status] ?? subscription.status}
      </span>
      {subscription.days_remaining <= 14 && subscription.days_remaining >= 0 && (
        <p className="mt-1 text-xs text-amber-700">
          {subscription.days_remaining} day{subscription.days_remaining === 1 ? '' : 's'} left
        </p>
      )}
    </div>
  );
}

function CompaniesPage() {
  const queryClient = useQueryClient();

  const [searchInput, setSearchInput] = useState('');
  const search = useDebounce(searchInput, 300);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editing, setEditing] = useState<Company | null>(null);
  const [form, setForm] = useState<CompanyForm>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [toggleTarget, setToggleTarget] = useState<Company | null>(null);

  const companies = usePaginatedQuery<Company>(['companies'], apiClient.companies.list, {
    search,
    ordering: 'name',
  });

  const saveMutation = useMutation({
    mutationFn: (payload: CompanyForm) =>
      editing ? apiClient.companies.update(editing.id, payload) : apiClient.companies.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['companies'] });
      closeForm();
    },
    onError: (error: unknown) => setFieldErrors(getApiFieldErrors(error) ?? {}),
  });

  const toggleMutation = useMutation({
    mutationFn: (company: Company) => apiClient.companies.update(company.id, { is_active: !company.is_active }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['companies'] });
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

  const openEdit = (company: Company) => {
    setEditing(company);
    setForm({
      name: company.name,
      email: company.email,
      phone: company.phone,
      address: company.address,
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

  const totals = {
    users: companies.rows.reduce((sum, company) => sum + (company.user_count), 0),
    branches: companies.rows.reduce((sum, company) => sum + (company.branch_count), 0),
    paying: companies.rows.filter((company) => company.subscription?.status === 'ACTIVE').length,
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-900 font-heading">Companies</h1>
          <p className="mt-1 text-sm text-slate-600 font-body">
            Every consultancy on the platform and its subscription state
          </p>
        </div>
        <Button onClick={openCreate} className="h-10 w-full bg-teal-600 hover:bg-teal-700 sm:w-auto">
          <Plus className="mr-2 h-4 w-4" /> New Company
        </Button>
      </div>

      {toggleMutation.isError && <ErrorBanner error={toggleMutation.error} onDismiss={() => toggleMutation.reset()} />}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Card className="border-slate-200 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Companies</p>
          <p className="mt-1 text-xl font-bold text-slate-900 sm:text-2xl">{companies.count}</p>
        </Card>
        <Card className="border-slate-200 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Paying</p>
          <p className="mt-1 text-xl font-bold text-green-600 sm:text-2xl">{totals.paying}</p>
        </Card>
        <Card className="border-slate-200 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Branches</p>
          <p className="mt-1 text-xl font-bold text-slate-900 sm:text-2xl">{totals.branches}</p>
        </Card>
        <Card className="border-slate-200 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Users</p>
          <p className="mt-1 text-xl font-bold text-slate-900 sm:text-2xl">{totals.users}</p>
        </Card>
      </div>

      <div className="relative max-w-md">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by company name or email…"
          aria-label="Search companies"
          className="h-10 pl-9"
        />
      </div>

      {companies.isError ? (
        <ErrorState error={companies.error} onRetry={companies.refetch} />
      ) : companies.isLoading ? (
        <LoadingState rows={4} label="Loading companies" />
      ) : companies.rows.length === 0 ? (
        <EmptyState
          icon={Building}
          title={search ? 'No companies match that search' : 'No companies yet'}
          description={search ? 'Try a different name or email.' : 'Provision the first consultancy to get started.'}
          action={
            search ? (
              <Button variant="outline" onClick={() => setSearchInput('')}>
                Clear search
              </Button>
            ) : (
              <Button onClick={openCreate} className="bg-teal-600 hover:bg-teal-700">
                <Plus className="mr-2 h-4 w-4" /> New Company
              </Button>
            )
          }
        />
      ) : (
        <>
          {/* Cards on phones, table from lg up */}
          <div className="space-y-3 lg:hidden">
            {companies.rows.map((company) => (
              <Card key={company.id} className="border-slate-200 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-900">{company.name}</p>
                    <p className="truncate text-xs text-slate-500">{company.email || 'No email'}</p>
                  </div>
                  <Badge
                    className={`shrink-0 border-transparent ${
                      company.is_active ? 'bg-green-100 text-green-700' : 'bg-slate-200 text-slate-600'
                    }`}
                  >
                    {company.is_active ? 'Active' : 'Suspended'}
                  </Badge>
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 text-sm">
                  <div className="min-w-0">
                    <dt className="text-xs text-slate-500">Plan</dt>
                    <dd className="truncate font-medium text-slate-900">{company.subscription?.plan_name ?? '—'}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-slate-500">Subscription</dt>
                    <dd>
                      <SubscriptionBadge subscription={company.subscription} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Branches</dt>
                    <dd className="font-medium text-slate-900">{company.branch_count}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Users</dt>
                    <dd className="font-medium text-slate-900">{company.user_count}</dd>
                  </div>
                </dl>

                <div className="mt-4 flex gap-2">
                  <Button variant="outline" size="sm" className="h-9 flex-1" onClick={() => openEdit(company)}>
                    <Pencil size={14} className="mr-1.5" /> Edit
                  </Button>
                  <Button variant="outline" size="sm" className="h-9 flex-1" onClick={() => setToggleTarget(company)}>
                    <Power size={14} className="mr-1.5" /> {company.is_active ? 'Suspend' : 'Restore'}
                  </Button>
                </div>
              </Card>
            ))}
            <Card className="border-slate-200">
              <PaginationBar
                page={companies.page}
                pages={companies.pages}
                count={companies.count}
                pageSize={companies.pageSize}
                onPageChange={companies.setPage}
                isLoading={companies.isFetching}
              />
            </Card>
          </div>

          <Card className="hidden overflow-hidden border-slate-200 lg:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-700">Company</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-700">Plan</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-700">Subscription</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-700">Renews</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-700">Usage</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-700">Account</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase text-slate-700">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {companies.rows.map((company) => (
                    <tr key={company.id} className="hover:bg-slate-50">
                      <td className="px-4 py-4">
                        <div className="flex items-start gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-600">
                            <Building size={16} />
                          </div>
                          <div className="min-w-0">
                            <p className="truncate font-semibold text-slate-900">{company.name}</p>
                            <p className="truncate text-xs text-slate-500">{company.email || 'No email'}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <span className="inline-flex items-center gap-1.5 text-slate-700">
                          <CreditCard size={14} className="text-slate-400" />
                          {company.subscription?.plan_name ?? '—'}
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        <SubscriptionBadge subscription={company.subscription} />
                      </td>
                      <td className="px-4 py-4">
                        <span className="inline-flex items-center gap-1.5 text-slate-600">
                          <CalendarClock size={14} className="text-slate-400" />
                          {formatDate(company.subscription?.current_period_end)}
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-3 text-slate-600">
                          <span className="inline-flex items-center gap-1" title="Branches">
                            <GitBranch size={14} className="text-slate-400" /> {company.branch_count}
                          </span>
                          <span className="inline-flex items-center gap-1" title="Users">
                            <Users size={14} className="text-slate-400" /> {company.user_count}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <Badge
                          className={`border-transparent ${
                            company.is_active
                              ? 'bg-green-100 text-green-700 hover:bg-green-100'
                              : 'bg-slate-200 text-slate-600 hover:bg-slate-200'
                          }`}
                        >
                          {company.is_active ? 'Active' : 'Suspended'}
                        </Badge>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 hover:bg-teal-50 hover:text-teal-600"
                            onClick={() => openEdit(company)}
                            aria-label={`Edit ${company.name}`}
                          >
                            <Pencil size={15} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 hover:bg-amber-50 hover:text-amber-600"
                            onClick={() => setToggleTarget(company)}
                            aria-label={`${company.is_active ? 'Suspend' : 'Restore'} ${company.name}`}
                          >
                            <Power size={15} />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <PaginationBar
              page={companies.page}
              pages={companies.pages}
              count={companies.count}
              pageSize={companies.pageSize}
              onPageChange={companies.setPage}
              isLoading={companies.isFetching}
            />
          </Card>
        </>
      )}

      <Modal
        open={isFormOpen}
        onClose={closeForm}
        title={editing ? `Edit ${editing.name}` : 'New company'}
        description={
          editing
            ? 'Update the tenant’s contact details.'
            : 'Provisioning creates the company, its default branch and a trial subscription.'
        }
        footer={
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="h-11 sm:w-32" onClick={closeForm}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="company-form"
              className="h-11 bg-teal-600 hover:bg-teal-700 sm:w-44"
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending ? (
                <>
                  <InlineSpinner className="mr-2" /> Saving…
                </>
              ) : editing ? (
                'Save changes'
              ) : (
                'Create company'
              )}
            </Button>
          </div>
        }
      >
        <form
          id="company-form"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setFieldErrors({});
            saveMutation.mutate(form);
          }}
        >
          {saveMutation.isError && <ErrorBanner error={saveMutation.error} />}

          <div className="space-y-2">
            <Label htmlFor="company-name">Company name *</Label>
            <Input
              id="company-name"
              required
              className="h-11"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            {fieldErrors.name && <p className="text-xs text-red-600">{fieldErrors.name}</p>}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="company-email">Email</Label>
              <Input
                id="company-email"
                type="email"
                className="h-11"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
              {fieldErrors.email && <p className="text-xs text-red-600">{fieldErrors.email}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="company-phone">Phone</Label>
              <Input
                id="company-phone"
                type="tel"
                className="h-11"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
              {fieldErrors.phone && <p className="text-xs text-red-600">{fieldErrors.phone}</p>}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="company-address">Address</Label>
            <textarea
              id="company-address"
              rows={3}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
            />
            {fieldErrors.address && <p className="text-xs text-red-600">{fieldErrors.address}</p>}
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={toggleTarget !== null}
        onClose={() => setToggleTarget(null)}
        onConfirm={() => toggleTarget && toggleMutation.mutate(toggleTarget)}
        title={toggleTarget?.is_active ? 'Suspend this company?' : 'Restore this company?'}
        description={
          toggleTarget?.is_active
            ? `Everyone at ${toggleTarget?.name} will lose access until the company is restored. No data is deleted.`
            : `${toggleTarget?.name} will regain access immediately.`
        }
        confirmText={toggleTarget?.is_active ? 'Suspend' : 'Restore'}
        confirmVariant={toggleTarget?.is_active ? 'destructive' : 'default'}
        isLoading={toggleMutation.isPending}
      />
    </div>
  );
}

export default function CompaniesRoute() {
  return (
    <RoleRoute allow={CAN.manageCompanies}>
      <CompaniesPage />
    </RoleRoute>
  );
}
