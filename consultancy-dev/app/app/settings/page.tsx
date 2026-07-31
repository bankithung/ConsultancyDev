'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Bell,
  BellOff,
  Building2,
  Calendar,
  CalendarClock,
  Check,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  FileText,
  GitBranch,
  Mail,
  MapPin,
  Phone,
  Plus,
  Save,
  UserPlus,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/common/Modal';
import { PaginationBar } from '@/components/common/PaginationBar';
import { EmptyState, ErrorBanner, ErrorState, InlineSpinner, LoadingState } from '@/components/common/states';
import { RoleRoute } from '@/components/rbac/RoleGate';
import { CAN } from '@/components/rbac/roles';
import { apiClient } from '@/lib/apiClient';
import { getApiFieldErrors } from '@/lib/api';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { useAuth } from '@/hooks/useAuth';
import { toast } from '@/store/toastStore';
import { cn } from '@/lib/utils';
import type {
  Branch,
  CompanyInput,
  Notification as AppNotification,
  SubscriptionStatus,
} from '@/lib/types';

/**
 * Company, branch and subscription settings.
 *
 * Deliberately narrow, because the backend is: `CompanySerializer` accepts only
 * name/email/phone/address/is_active. There is no `website`, `currency` or
 * `timezone` column on Company — the previous build's inputs for those were
 * discarded on every save, so they are gone rather than typed-and-dropped.
 *
 * Plan limits (`max_branches`, `max_users`) are enforced server-side; creating
 * past one returns a 400 whose message is surfaced verbatim.
 */

type TabId = 'company' | 'branches' | 'subscription' | 'notifications';

const STATUS_STYLE: Record<SubscriptionStatus, string> = {
  ACTIVE: 'border-transparent bg-green-100 text-green-700 hover:bg-green-100',
  TRIALING: 'border-transparent bg-blue-100 text-blue-700 hover:bg-blue-100',
  PAST_DUE: 'border-transparent bg-amber-100 text-amber-800 hover:bg-amber-100',
  CANCELLED: 'border-transparent bg-slate-200 text-slate-600 hover:bg-slate-200',
  EXPIRED: 'border-transparent bg-red-100 text-red-700 hover:bg-red-100',
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

const EMPTY_COMPANY_FORM: CompanyForm = { name: '', email: '', phone: '', address: '' };

interface BranchForm {
  name: string;
  code: string;
  city: string;
}

const EMPTY_BRANCH_FORM: BranchForm = { name: '', code: '', city: '' };

function formatDate(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleDateString();
}

function formatDateTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString();
}

/** `0` means unlimited on the Plan model. */
function limitLabel(limit: number | undefined): string {
  if (limit === undefined) return '—';
  return limit === 0 ? 'Unlimited' : String(limit);
}

function usagePercent(used: number, limit: number | undefined): number | null {
  if (limit === undefined || limit === 0) return null;
  return Math.min(100, Math.round((used / limit) * 100));
}

function notificationIcon(type: string) {
  switch (type) {
    case 'payment':
      return <CreditCard size={14} className="text-green-600" />;
    case 'document':
      return <FileText size={14} className="text-blue-600" />;
    case 'follow-up':
      return <Bell size={14} className="text-amber-600" />;
    case 'enrollment':
      return <UserPlus size={14} className="text-purple-600" />;
    case 'appointment':
      return <Calendar size={14} className="text-teal-600" />;
    case 'Success':
      return <CheckCircle2 size={14} className="text-green-600" />;
    case 'Warning':
      return <AlertCircle size={14} className="text-amber-600" />;
    case 'Error':
      return <AlertCircle size={14} className="text-red-600" />;
    default:
      return <Bell size={14} className="text-slate-400" />;
  }
}

/** Meter shown for each plan limit. Renders nothing measurable when unlimited. */
function UsageMeter({ label, used, limit }: { label: string; used: number; limit: number | undefined }) {
  const percent = usagePercent(used, limit);
  const atLimit = percent !== null && percent >= 100;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-slate-600">{label}</span>
        <span className={cn('text-xs font-semibold', atLimit ? 'text-red-600' : 'text-slate-900')}>
          {used} / {limitLabel(limit)}
        </span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100">
        <div
          className={cn('h-full rounded-full transition-all', atLimit ? 'bg-red-500' : 'bg-teal-500')}
          style={{ width: percent === null ? '100%' : `${Math.max(percent, 2)}%` }}
        />
      </div>
      {percent === null && <p className="mt-1 text-[10px] text-slate-400">No limit on this plan</p>}
    </div>
  );
}

function SettingsPage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [activeTab, setActiveTab] = useState<TabId>('company');

  const [companyForm, setCompanyForm] = useState<CompanyForm>(EMPTY_COMPANY_FORM);
  const [companyFieldErrors, setCompanyFieldErrors] = useState<Record<string, string>>({});

  const [isBranchOpen, setIsBranchOpen] = useState(false);
  const [branchForm, setBranchForm] = useState<BranchForm>(EMPTY_BRANCH_FORM);
  const [branchFieldErrors, setBranchFieldErrors] = useState<Record<string, string>>({});

  const companyQuery = useQuery({
    queryKey: ['company', 'current'],
    queryFn: () => apiClient.companies.getCurrent(),
    enabled: Boolean(user),
  });
  const company = companyQuery.data ?? null;

  const subscriptionQuery = useQuery({
    queryKey: ['subscription', 'mine'],
    queryFn: () => apiClient.subscriptions.mine(),
    enabled: Boolean(user),
  });
  const subscription = subscriptionQuery.data ?? null;

  // Limits live on the Plan, not on the Subscription envelope.
  const planId = subscription?.plan;
  const planQuery = useQuery({
    queryKey: ['plan', planId],
    queryFn: async () => (planId === undefined ? null : apiClient.plans.get(planId)),
    enabled: planId !== undefined,
  });
  const plan = planQuery.data ?? null;

  const branches = usePaginatedQuery<Branch>(['branches'], apiClient.branches.list, {
    pageSize: 10,
    ordering: 'name',
  });

  const userCountQuery = useQuery({
    queryKey: ['users', 'count'],
    queryFn: () => apiClient.users.list({ page_size: 1 }),
    enabled: Boolean(user),
  });
  const userCount = userCountQuery.data?.count ?? 0;

  const notifications = usePaginatedQuery<AppNotification>(
    ['notifications'],
    apiClient.notifications.list,
    { pageSize: 10 }
  );

  const unreadQuery = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => apiClient.notifications.unreadCount(),
    enabled: Boolean(user),
  });
  const unreadCount = unreadQuery.data ?? 0;

  // Seeds the form from the fetched company, re-seeding only when the server's
  // values actually change (a save, or another admin's edit arriving on a
  // refetch) — so a background refresh never overwrites what is being typed.
  //
  // Adjusted during render rather than in an effect: React re-runs this
  // component immediately with the corrected state, so no render is painted
  // from stale values, and the project's lint rules reject setState in effects.
  const companySignature = company
    ? `${company.id}|${company.name}|${company.email}|${company.phone}|${company.address}`
    : '';
  const [seededCompany, setSeededCompany] = useState<string | null>(null);
  if (company && seededCompany !== companySignature) {
    setSeededCompany(companySignature);
    setCompanyForm({
      name: company.name,
      email: company.email,
      phone: company.phone,
      address: company.address,
    });
  }

  const saveCompany = useMutation({
    mutationFn: (payload: CompanyForm) => {
      if (!company) throw new Error('No company is associated with your account.');
      const body: CompanyInput = {
        name: payload.name.trim(),
        email: payload.email.trim(),
        phone: payload.phone.trim(),
        address: payload.address.trim(),
      };
      return apiClient.companies.update(company.id, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['company'] });
      setCompanyFieldErrors({});
      toast.success('Company details saved');
    },
    onError: (error: unknown) => setCompanyFieldErrors(getApiFieldErrors(error) ?? {}),
  });

  const createBranch = useMutation({
    mutationFn: (payload: BranchForm) =>
      apiClient.branches.create({
        name: payload.name.trim(),
        code: payload.code.trim().toUpperCase(),
        city: payload.city.trim(),
      }),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['branches'] });
      queryClient.invalidateQueries({ queryKey: ['branch-options'] });
      setIsBranchOpen(false);
      setBranchForm(EMPTY_BRANCH_FORM);
      setBranchFieldErrors({});
      toast.success('Branch created', `${created.name} is ready for staff and records.`);
    },
    // A plan-limit refusal arrives as a 400 with a readable message; ErrorBanner
    // renders it verbatim rather than replacing it with a generic failure.
    onError: (error: unknown) => setBranchFieldErrors(getApiFieldErrors(error) ?? {}),
  });

  const markRead = useMutation({
    mutationFn: (id: string) => apiClient.notifications.markAsRead(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const markAllRead = useMutation({
    mutationFn: () => apiClient.notifications.markAllAsRead(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      toast.success('All notifications marked as read');
    },
  });

  const openBranchModal = () => {
    setBranchForm(EMPTY_BRANCH_FORM);
    setBranchFieldErrors({});
    createBranch.reset();
    setIsBranchOpen(true);
  };

  const branchLimitReached =
    plan !== null && plan.max_branches > 0 && branches.count >= plan.max_branches;
  const userLimitReached = plan !== null && plan.max_users > 0 && userCount >= plan.max_users;

  const TABS: { id: TabId; label: string; icon: React.ComponentType<{ size?: number }>; badge?: number }[] = [
    { id: 'company', label: 'Company profile', icon: Building2 },
    { id: 'branches', label: 'Branches', icon: GitBranch, badge: branches.count },
    { id: 'subscription', label: 'Subscription', icon: CreditCard },
    { id: 'notifications', label: 'Notifications', icon: Bell, badge: unreadCount },
  ];

  return (
    <div className="space-y-5">
      <div className="min-w-0">
        <h1 className="font-heading text-2xl font-bold text-slate-900">Settings</h1>
        <p className="mt-1 font-body text-sm text-slate-600">
          Your company profile, branches and plan
        </p>
      </div>

      {subscription && !subscription.is_usable && (
        <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
          <div className="min-w-0 text-sm text-red-800">
            <p className="font-semibold">This subscription is not active</p>
            <p className="mt-0.5">
              {STATUS_LABEL[subscription.status]} — writing new records is blocked until billing is
              sorted out.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <Card className="h-fit border-slate-200 lg:col-span-1">
          <CardContent className="p-2">
            <nav className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  aria-current={activeTab === tab.id ? 'page' : undefined}
                  className={cn(
                    'flex w-full shrink-0 items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors lg:shrink',
                    activeTab === tab.id ? 'bg-teal-50 text-teal-700' : 'text-slate-600 hover:bg-slate-50'
                  )}
                >
                  <span className="flex items-center gap-2.5 whitespace-nowrap">
                    <tab.icon size={16} />
                    {tab.label}
                  </span>
                  {tab.badge !== undefined && tab.badge > 0 && (
                    <span
                      className={cn(
                        'rounded-full px-1.5 py-0.5 text-[10px] font-bold',
                        tab.id === 'notifications' ? 'bg-red-500 text-white' : 'bg-slate-200 text-slate-700'
                      )}
                    >
                      {tab.badge}
                    </span>
                  )}
                </button>
              ))}
            </nav>
          </CardContent>
        </Card>

        <div className="space-y-4 lg:col-span-3">
          {/* ------------------------------------------------------------ */}
          {/* Company                                                       */}
          {/* ------------------------------------------------------------ */}
          {activeTab === 'company' &&
            (companyQuery.isError ? (
              <ErrorState error={companyQuery.error} onRetry={() => companyQuery.refetch()} />
            ) : companyQuery.isLoading ? (
              <LoadingState rows={3} label="Loading company details" />
            ) : !company ? (
              <EmptyState
                icon={Building2}
                title="No company is linked to your account"
                description="Platform admins manage tenants from the Companies page."
                action={
                  <Button asChild className="bg-teal-600 hover:bg-teal-700">
                    <Link href="/app/companies">Open companies</Link>
                  </Button>
                }
              />
            ) : (
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  setCompanyFieldErrors({});
                  saveCompany.mutate(companyForm);
                }}
              >
                <Card className="border-slate-200">
                  <CardContent className="p-4">
                    <div className="mb-4 flex items-center gap-2">
                      <div className="rounded-lg bg-teal-50 p-2">
                        <Building2 size={16} className="text-teal-600" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-slate-900">Company information</h3>
                        <p className="text-[11px] text-slate-500">
                          Shown on documents and used as the default contact
                        </p>
                      </div>
                    </div>

                    {saveCompany.isError && (
                      <div className="mb-4">
                        <ErrorBanner error={saveCompany.error} onDismiss={() => saveCompany.reset()} />
                      </div>
                    )}

                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="company-name">Company name *</Label>
                        <div className="relative">
                          <Building2
                            size={14}
                            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                          />
                          <Input
                            id="company-name"
                            required
                            value={companyForm.name}
                            onChange={(e) => setCompanyForm({ ...companyForm, name: e.target.value })}
                            className="h-11 pl-9"
                            placeholder="Acme Overseas Education"
                          />
                        </div>
                        {companyFieldErrors.name && (
                          <p className="text-xs text-red-600">{companyFieldErrors.name}</p>
                        )}
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="company-email">Contact email</Label>
                        <div className="relative">
                          <Mail
                            size={14}
                            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                          />
                          <Input
                            id="company-email"
                            type="email"
                            value={companyForm.email}
                            onChange={(e) => setCompanyForm({ ...companyForm, email: e.target.value })}
                            className="h-11 pl-9"
                            placeholder="contact@company.com"
                          />
                        </div>
                        {companyFieldErrors.email && (
                          <p className="text-xs text-red-600">{companyFieldErrors.email}</p>
                        )}
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="company-phone">Phone</Label>
                        <div className="relative">
                          <Phone
                            size={14}
                            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                          />
                          <Input
                            id="company-phone"
                            type="tel"
                            value={companyForm.phone}
                            onChange={(e) => setCompanyForm({ ...companyForm, phone: e.target.value })}
                            className="h-11 pl-9"
                            placeholder="+91 12345 67890"
                          />
                        </div>
                        {companyFieldErrors.phone && (
                          <p className="text-xs text-red-600">{companyFieldErrors.phone}</p>
                        )}
                      </div>

                      <div className="space-y-2">
                        <Label>Reference</Label>
                        <p className="flex h-11 items-center rounded-md border border-slate-200 bg-slate-50 px-3 font-mono text-sm text-slate-600">
                          {company.slug}
                        </p>
                      </div>

                      <div className="col-span-full space-y-2">
                        <Label htmlFor="company-address">Address</Label>
                        <div className="relative">
                          <MapPin size={14} className="pointer-events-none absolute left-3 top-3 text-slate-400" />
                          <textarea
                            id="company-address"
                            value={companyForm.address}
                            onChange={(e) => setCompanyForm({ ...companyForm, address: e.target.value })}
                            className="min-h-[80px] w-full resize-none rounded-md border border-slate-200 py-2 pl-9 pr-3 text-sm outline-none focus:border-teal-400 focus:ring-1 focus:ring-teal-200"
                            placeholder="Street, city, state, PIN"
                          />
                        </div>
                        {companyFieldErrors.address && (
                          <p className="text-xs text-red-600">{companyFieldErrors.address}</p>
                        )}
                      </div>
                    </div>

                    <div className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-100 pt-4 sm:grid-cols-4">
                      <div>
                        <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Branches</p>
                        <p className="text-lg font-bold text-slate-900">{company.branch_count}</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Staff</p>
                        <p className="text-lg font-bold text-slate-900">{company.user_count}</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Status</p>
                        <p className="text-lg font-bold text-slate-900">
                          {company.is_active ? 'Active' : 'Suspended'}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Since</p>
                        <p className="text-lg font-bold text-slate-900">{formatDate(company.created_at)}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 sm:w-32"
                    onClick={() =>
                      setCompanyForm({
                        name: company.name,
                        email: company.email,
                        phone: company.phone,
                        address: company.address,
                      })
                    }
                  >
                    Reset
                  </Button>
                  <Button
                    type="submit"
                    disabled={saveCompany.isPending}
                    className="h-11 bg-teal-600 hover:bg-teal-700 sm:w-40"
                  >
                    {saveCompany.isPending ? (
                      <>
                        <InlineSpinner className="mr-2" /> Saving…
                      </>
                    ) : (
                      <>
                        <Save className="mr-2 h-4 w-4" /> Save changes
                      </>
                    )}
                  </Button>
                </div>
              </form>
            ))}

          {/* ------------------------------------------------------------ */}
          {/* Branches                                                      */}
          {/* ------------------------------------------------------------ */}
          {activeTab === 'branches' && (
            <div className="space-y-4">
              <Card className="border-slate-200">
                <CardContent className="p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex items-center gap-2">
                      <div className="rounded-lg bg-blue-50 p-2">
                        <GitBranch size={16} className="text-blue-600" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-slate-900">Branches</h3>
                        <p className="text-[11px] text-slate-500">
                          Offices your team works from. Staff are assigned to one from the Team page.
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button asChild variant="outline" className="h-10 gap-1.5">
                        <Link href="/app/branches">
                          Manage <ExternalLink size={13} />
                        </Link>
                      </Button>
                      <Button
                        onClick={openBranchModal}
                        disabled={branchLimitReached}
                        title={
                          branchLimitReached
                            ? 'Your plan’s branch limit has been reached'
                            : undefined
                        }
                        className="h-10 bg-teal-600 hover:bg-teal-700 disabled:opacity-50"
                      >
                        <Plus className="mr-1.5 h-4 w-4" /> Add
                      </Button>
                    </div>
                  </div>

                  {plan && (
                    <div className="mt-4 border-t border-slate-100 pt-4">
                      <UsageMeter label="Branches used" used={branches.count} limit={plan.max_branches} />
                      {branchLimitReached && (
                        <p className="mt-2 text-xs text-red-600">
                          You are at your plan limit. Upgrade the plan to add more branches.
                        </p>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>

              {branches.isError ? (
                <ErrorState error={branches.error} onRetry={branches.refetch} />
              ) : branches.isLoading ? (
                <LoadingState rows={3} label="Loading branches" />
              ) : branches.rows.length === 0 ? (
                <EmptyState
                  icon={GitBranch}
                  title="No branches yet"
                  description="Add your first branch so staff and records can be scoped to a location."
                  action={
                    <Button onClick={openBranchModal} className="bg-teal-600 hover:bg-teal-700">
                      <Plus className="mr-2 h-4 w-4" /> Add branch
                    </Button>
                  }
                />
              ) : (
                <Card className="overflow-hidden border-slate-200">
                  <ul className="divide-y divide-slate-100">
                    {branches.rows.map((branch) => (
                      <li key={branch.id} className="flex items-start gap-3 p-4">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                          <Building2 size={16} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-semibold text-slate-900">{branch.name}</p>
                          <p className="mt-0.5 truncate text-xs text-slate-500">
                            <span className="font-mono">{branch.code}</span>
                            {branch.city ? ` · ${branch.city}` : ''}
                          </p>
                          <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                            <Users size={12} className="text-slate-400" /> {branch.user_count} staff
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
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
                      </li>
                    ))}
                  </ul>
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
            </div>
          )}

          {/* ------------------------------------------------------------ */}
          {/* Subscription                                                  */}
          {/* ------------------------------------------------------------ */}
          {activeTab === 'subscription' &&
            (subscriptionQuery.isError ? (
              <ErrorState error={subscriptionQuery.error} onRetry={() => subscriptionQuery.refetch()} />
            ) : subscriptionQuery.isLoading ? (
              <LoadingState rows={2} label="Loading subscription" />
            ) : !subscription ? (
              <EmptyState
                icon={CreditCard}
                title="No subscription on this account"
                description="A subscription is created when the company is provisioned. Contact support if this looks wrong."
              />
            ) : (
              <div className="space-y-4">
                <Card className="border-slate-200">
                  <CardContent className="p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex items-center gap-2">
                        <div className="rounded-lg bg-purple-50 p-2">
                          <CreditCard size={16} className="text-purple-600" />
                        </div>
                        <div className="min-w-0">
                          <h3 className="text-sm font-semibold text-slate-900">
                            {subscription.plan_name}
                          </h3>
                          <p className="text-[11px] text-slate-500">
                            {subscription.is_usable
                              ? 'Your team can create and edit records'
                              : 'Writing new records is currently blocked'}
                          </p>
                        </div>
                      </div>
                      <Badge className={STATUS_STYLE[subscription.status]}>
                        {STATUS_LABEL[subscription.status]}
                      </Badge>
                    </div>

                    <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-slate-100 pt-4 sm:grid-cols-4">
                      <div>
                        <dt className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
                          Days remaining
                        </dt>
                        <dd
                          className={cn(
                            'text-lg font-bold',
                            subscription.days_remaining <= 7 ? 'text-amber-600' : 'text-slate-900'
                          )}
                        >
                          {subscription.days_remaining}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
                          Trial ends
                        </dt>
                        <dd className="text-sm font-semibold text-slate-900">
                          {formatDate(subscription.trial_ends_at)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
                          Period ends
                        </dt>
                        <dd className="text-sm font-semibold text-slate-900">
                          {formatDate(subscription.current_period_end)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
                          Price
                        </dt>
                        <dd className="text-sm font-semibold text-slate-900">
                          {plan ? `${plan.currency} ${plan.price_monthly}/mo` : '—'}
                        </dd>
                      </div>
                    </dl>
                  </CardContent>
                </Card>

                <Card className="border-slate-200">
                  <CardContent className="space-y-4 p-4">
                    <div className="flex items-center gap-2">
                      <div className="rounded-lg bg-teal-50 p-2">
                        <CalendarClock size={16} className="text-teal-600" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-slate-900">Plan limits</h3>
                        <p className="text-[11px] text-slate-500">
                          Enforced by the server — creating past a limit is refused with a message.
                        </p>
                      </div>
                    </div>

                    {planQuery.isLoading ? (
                      <LoadingState rows={2} label="Loading plan limits" />
                    ) : !plan ? (
                      <p className="text-sm text-slate-500">
                        Plan details are not available for this subscription.
                      </p>
                    ) : (
                      <div className="space-y-4">
                        <UsageMeter label="Branches" used={branches.count} limit={plan.max_branches} />
                        <UsageMeter label="Staff accounts" used={userCount} limit={plan.max_users} />
                        {(branchLimitReached || userLimitReached) && (
                          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
                            You have reached{' '}
                            {branchLimitReached && userLimitReached
                              ? 'your branch and staff limits'
                              : branchLimitReached
                                ? 'your branch limit'
                                : 'your staff limit'}
                            . Further creates will be refused until the plan is upgraded.
                          </p>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            ))}

          {/* ------------------------------------------------------------ */}
          {/* Notifications                                                 */}
          {/* ------------------------------------------------------------ */}
          {activeTab === 'notifications' && (
            <div className="space-y-4">
              <Card className="border-slate-200">
                <CardContent className="p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-2">
                      <div className="rounded-lg bg-amber-50 p-2">
                        <Bell size={16} className="text-amber-600" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-slate-900">Recent notifications</h3>
                        <p className="text-[11px] text-slate-500">
                          {unreadCount > 0 ? `${unreadCount} unread` : 'All caught up'} ·{' '}
                          {notifications.count} total
                        </p>
                      </div>
                    </div>
                    {unreadCount > 0 && (
                      <Button
                        onClick={() => markAllRead.mutate()}
                        variant="outline"
                        className="h-10 gap-1.5"
                        disabled={markAllRead.isPending}
                      >
                        {markAllRead.isPending ? <InlineSpinner /> : <Check size={13} />} Mark all read
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>

              {markRead.isError && (
                <ErrorBanner error={markRead.error} onDismiss={() => markRead.reset()} />
              )}

              {notifications.isError ? (
                <ErrorState error={notifications.error} onRetry={notifications.refetch} />
              ) : notifications.isLoading ? (
                <LoadingState rows={4} label="Loading notifications" />
              ) : notifications.rows.length === 0 ? (
                <EmptyState
                  icon={BellOff}
                  title="No notifications"
                  description="You are all caught up."
                />
              ) : (
                <div className="space-y-2">
                  {notifications.rows.map((item) => (
                    <Card
                      key={item.id}
                      className={cn(
                        'border transition-all',
                        item.read ? 'border-slate-200 bg-white' : 'border-teal-200 bg-teal-50/30'
                      )}
                    >
                      <CardContent className="p-3">
                        <div className="flex items-start gap-3">
                          <div
                            className={cn(
                              'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                              item.read ? 'bg-slate-100' : 'bg-teal-100'
                            )}
                          >
                            {notificationIcon(item.type)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-col gap-0.5 sm:flex-row sm:items-start sm:justify-between sm:gap-2">
                              <h4 className="break-words text-sm font-medium text-slate-900">
                                {item.title}
                              </h4>
                              <span className="shrink-0 text-[10px] text-slate-400">
                                {formatDateTime(item.created_at)}
                              </span>
                            </div>
                            <p className="mt-0.5 break-words text-xs text-slate-600">{item.message}</p>
                            <div className="mt-2 flex flex-wrap items-center gap-3">
                              {!item.read && (
                                <button
                                  type="button"
                                  onClick={() => markRead.mutate(item.id)}
                                  disabled={markRead.isPending}
                                  className="flex items-center gap-1 text-[11px] font-medium text-teal-600 hover:text-teal-700 disabled:opacity-50"
                                >
                                  <Check size={11} /> Mark read
                                </button>
                              )}
                              {item.actionUrl && (
                                <Link
                                  href={item.actionUrl}
                                  className="flex items-center gap-1 text-[11px] font-medium text-slate-600 hover:text-slate-900"
                                >
                                  Open <ExternalLink size={11} />
                                </Link>
                              )}
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}

                  <PaginationBar
                    page={notifications.page}
                    pages={notifications.pages}
                    count={notifications.count}
                    pageSize={notifications.pageSize}
                    onPageChange={notifications.setPage}
                    isLoading={notifications.isFetching}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <Modal
        open={isBranchOpen}
        onClose={() => setIsBranchOpen(false)}
        title="Add a branch"
        description="Name and code are required. Everything else can be filled in later from the Branches page."
        footer={
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="h-11 sm:w-32"
              onClick={() => setIsBranchOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="settings-branch-form"
              className="h-11 bg-teal-600 hover:bg-teal-700 sm:w-40"
              disabled={createBranch.isPending}
            >
              {createBranch.isPending ? (
                <>
                  <InlineSpinner className="mr-2" /> Creating…
                </>
              ) : (
                'Create branch'
              )}
            </Button>
          </div>
        }
      >
        <form
          id="settings-branch-form"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setBranchFieldErrors({});
            createBranch.mutate(branchForm);
          }}
        >
          {createBranch.isError && <ErrorBanner error={createBranch.error} />}

          <div className="space-y-2">
            <Label htmlFor="settings-branch-name">Branch name *</Label>
            <Input
              id="settings-branch-name"
              required
              className="h-11"
              value={branchForm.name}
              onChange={(e) => setBranchForm({ ...branchForm, name: e.target.value })}
              placeholder="Kochi Main"
            />
            {branchFieldErrors.name && <p className="text-xs text-red-600">{branchFieldErrors.name}</p>}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="settings-branch-code">Code *</Label>
              <Input
                id="settings-branch-code"
                required
                className="h-11 uppercase"
                value={branchForm.code}
                onChange={(e) => setBranchForm({ ...branchForm, code: e.target.value.toUpperCase() })}
                placeholder="KCH"
              />
              {branchFieldErrors.code && <p className="text-xs text-red-600">{branchFieldErrors.code}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="settings-branch-city">City</Label>
              <Input
                id="settings-branch-city"
                className="h-11"
                value={branchForm.city}
                onChange={(e) => setBranchForm({ ...branchForm, city: e.target.value })}
                placeholder="Kochi"
              />
              {branchFieldErrors.city && <p className="text-xs text-red-600">{branchFieldErrors.city}</p>}
            </div>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export default function SettingsRoute() {
  return (
    <RoleRoute allow={CAN.manageSettings}>
      <SettingsPage />
    </RoleRoute>
  );
}
