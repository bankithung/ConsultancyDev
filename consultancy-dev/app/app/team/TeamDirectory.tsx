'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpDown,
  Building2,
  Download,
  KeyRound,
  Pencil,
  Plus,
  Power,
  Search,
  Trash2,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Modal } from '@/components/common/Modal';
import { PaginationBar } from '@/components/common/PaginationBar';
import { EmptyState, ErrorBanner, ErrorState, InlineSpinner, LoadingState } from '@/components/common/states';
import { ALL_ROLES, ROLE_LABELS } from '@/components/rbac/roles';
import { useCurrentRole } from '@/components/rbac/useCurrentRole';
import { apiClient } from '@/lib/apiClient';
import { getApiFieldErrors } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { useDebounce } from '@/hooks/useDebounce';
import { loadAllPages } from '@/app/app/student-profile/aggregate';
import { toast } from '@/store/toastStore';
import {
  isRole,
  type Branch,
  type CounselorPerformance,
  type Role,
  type User,
  type UserAdminInput,
} from '@/lib/types';

/**
 * Staff directory and the hierarchy control surface.
 *
 * Two backend facts shape this page:
 *
 * 1. `role` and `branch` are writable only through `UserAdminSerializer`, which
 *    the API hands out to DEV_ADMIN and COMPANY_ADMIN. Everyone else gets them
 *    read-only, so those controls are hidden rather than offered-and-403'd.
 * 2. Changing a role or branch, or deactivating an account, revokes that user's
 *    outstanding refresh tokens — they are signed out immediately. Every such
 *    control says so before it fires.
 */

/**
 * Roles the previous build offered, mapped onto the five the backend now
 * defines.
 *
 * `MANAGER` became `BRANCH_MANAGER`. The rest were job titles rather than
 * permission levels and have NO equivalent, so each maps to the closest level:
 * `TEAM_LEADER` supervised a branch team, so it lands on BRANCH_MANAGER; HR,
 * SALES, ACCOUNTS, COUNSELOR, OPERATIONS and IT_SUPPORT were individual
 * contributors and land on EMPLOYEE. If the business needs those distinctions
 * back they belong in a separate `job_title` column, not in `role`.
 */
const LEGACY_ROLE_MAP: Record<string, Role> = {
  MANAGER: 'BRANCH_MANAGER',
  TEAM_LEADER: 'BRANCH_MANAGER',
  HR: 'EMPLOYEE',
  SALES: 'EMPLOYEE',
  ACCOUNTS: 'EMPLOYEE',
  COUNSELOR: 'EMPLOYEE',
  OPERATIONS: 'EMPLOYEE',
  IT_SUPPORT: 'EMPLOYEE',
};

/** Normalises a role that may still carry a pre-migration value. */
function toRole(value: unknown): Role {
  if (isRole(value)) return value;
  return LEGACY_ROLE_MAP[String(value)] ?? 'EMPLOYEE';
}

/** The serializer requires a branch for these roles; the others are unscoped. */
function branchIsRequired(role: Role): boolean {
  return role === 'BRANCH_MANAGER' || role === 'EMPLOYEE';
}

/** A platform admin belongs to no company, so no branch can be picked. */
function branchApplies(role: Role): boolean {
  return role !== 'DEV_ADMIN';
}

/** Radix Select forbids an empty item value, so "no branch" needs a sentinel. */
const NO_BRANCH = '__none__';

/** Every sortable column. Keep in step with the headers in the table below. */
type SortKey =
  | 'name' | 'role' | 'branch' | 'manager' | 'status' | 'lastActive'
  | 'enquiries' | 'converted' | 'registrations' | 'conversion';

/** Seniority, so sorting by Role reads as a hierarchy rather than alphabetically. */
const ROLE_ORDER: readonly Role[] = [
  'DEV_ADMIN', 'COMPANY_ADMIN', 'HEAD_MANAGER', 'BRANCH_MANAGER', 'EMPLOYEE',
];

const ROLE_BADGE: Record<Role, string> = {
  DEV_ADMIN: 'border-transparent bg-purple-100 text-purple-700 hover:bg-purple-100',
  COMPANY_ADMIN: 'border-transparent bg-teal-100 text-teal-700 hover:bg-teal-100',
  HEAD_MANAGER: 'border-transparent bg-indigo-100 text-indigo-700 hover:bg-indigo-100',
  BRANCH_MANAGER: 'border-transparent bg-blue-100 text-blue-700 hover:bg-blue-100',
  EMPLOYEE: 'border-transparent bg-slate-100 text-slate-700 hover:bg-slate-100',
};

/** Roles that appear in the counselor performance view. */

interface UserForm {
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  phone: string;
  password: string;
  confirmPassword: string;
  role: Role;
  /** Branch id as a string, or `NO_BRANCH`. */
  branch: string;
  managedManagers: number[];
}

const EMPTY_FORM: UserForm = {
  username: '',
  email: '',
  first_name: '',
  last_name: '',
  phone: '',
  password: '',
  confirmPassword: '',
  role: 'EMPLOYEE',
  branch: NO_BRANCH,
  managedManagers: [],
};

function initialsOf(user: User): string {
  const source = user.full_name.trim() || user.username;
  const letters = source
    .split(/\s+/)
    .map((part) => part.charAt(0))
    .join('')
    .toUpperCase()
    .slice(0, 2);
  return letters || '?';
}

/**
 * A column heading that sorts. Kept as a real <button> inside the <th> so the
 * whole grid stays reachable from the keyboard, and `aria-sort` tells a screen
 * reader which column is ordering the table.
 */
function SortHeader({
  label, sortKey, active, dir, onSort, numeric = false, className = '', title,
}: {
  label: string;
  sortKey: SortKey;
  active: SortKey;
  dir: 'asc' | 'desc';
  onSort: (key: SortKey) => void;
  numeric?: boolean;
  className?: string;
  title?: string;
}) {
  const isActive = active === sortKey;
  return (
    <th
      scope="col"
      title={title}
      aria-sort={isActive ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`px-3 py-2.5 text-xs font-semibold uppercase text-slate-700 ${numeric ? 'text-right' : 'text-left'} ${className}`}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 uppercase hover:text-teal-700 ${numeric ? 'flex-row-reverse' : ''} ${isActive ? 'text-teal-700' : ''}`}
      >
        {label}
        <ArrowUpDown size={12} className={isActive ? 'opacity-100' : 'opacity-30'} />
      </button>
    </th>
  );
}

export function TeamDirectory() {
  const queryClient = useQueryClient();
  const { user: me } = useAuth();
  const { can } = useCurrentRole();

  /** DEV_ADMIN / COMPANY_ADMIN — the callers the API gives the admin serializer. */
  const canManage = can('manageUsers');

  const [searchInput, setSearchInput] = useState('');
  const search = useDebounce(searchInput, 300);

  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [branchFilter, setBranchFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [form, setForm] = useState<UserForm>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [toggleTarget, setToggleTarget] = useState<User | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);

  /*
   * The whole roster is loaded once and filtered, sorted and paged in the
   * browser.
   *
   * Server-side paging cannot work here: half the columns come from
   * `users/counselors/`, a separate endpoint, so sorting by Enquiries across a
   * server-paged list would only ever order the rows that happened to be on
   * the current page. Loading the roster makes every column sort the same way
   * and lets Export CSV cover the whole filtered set rather than one page.
   *
   * A company's staff list is the right size for this; the cap below is a
   * backstop, and `truncated` says so out loud rather than silently dropping
   * people.
   */
  const ROSTER_CAP_PAGES = 10;
  const ROSTER_PAGE_SIZE = 200;

  const rosterQuery = useQuery({
    queryKey: ['users', 'roster'],
    queryFn: () =>
      loadAllPages<User>(
        (params) => apiClient.users.list(params),
        { ordering: 'username' },
        ROSTER_PAGE_SIZE,
        ROSTER_CAP_PAGES,
      ),
  });
  const roster = useMemo(() => rosterQuery.data ?? [], [rosterQuery.data]);
  const truncated = roster.length >= ROSTER_PAGE_SIZE * ROSTER_CAP_PAGES;

  /*
   * Performance figures. The endpoint covers active EMPLOYEE and
   * BRANCH_MANAGER only, so admins and head managers legitimately have no row
   * and render as em-dashes -- they are not counselors.
   */
  const metricsQuery = useQuery({
    queryKey: ['team', 'counselor-metrics'],
    queryFn: () => apiClient.dashboard.getCounselorAnalytics(),
  });
  const metricsById = useMemo(() => {
    const map = new Map<number, CounselorPerformance>();
    for (const row of metricsQuery.data ?? []) map.set(row.id, row);
    return map;
  }, [metricsQuery.data]);

  /*
   * Who each person reports to.
   *
   * A head manager leads every branch in the company. Employees report to a
   * branch manager in their assigned branch.
   */
  const managerOf = useMemo(() => {
    const headManagerByCompany = new Map<number, User>();
    const managerOfBranch = new Map<string, User>();
    for (const u of roster) {
      if (u.role === 'HEAD_MANAGER' && u.company && !headManagerByCompany.has(u.company)) {
        headManagerByCompany.set(u.company, u);
      }
      if (u.role === 'BRANCH_MANAGER' && u.branch) managerOfBranch.set(String(u.branch), u);
    }
    return (row: User): string => {
      if (row.role === 'BRANCH_MANAGER') {
        const headManager = row.company ? headManagerByCompany.get(row.company) : undefined;
        return headManager ? headManager.full_name || headManager.username : '—';
      }
      if (row.role === 'EMPLOYEE' && row.branch) {
        const mgr = managerOfBranch.get(String(row.branch));
        if (mgr && mgr.id !== row.id) return mgr.full_name || mgr.username;
      }
      return '—';
    };
  }, [roster]);

  /* ---------------------------------------------------------------- sort */

  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 25;

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
    setPage(1);
  };

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return roster.filter((u) => {
      if (roleFilter !== 'all' && u.role !== roleFilter) return false;
      if (branchFilter !== 'all' && String(u.branch ?? '') !== branchFilter) return false;
      if (statusFilter !== 'all' && u.is_active_employee !== (statusFilter === 'active')) return false;
      if (!needle) return true;
      return [u.full_name, u.username, u.email, u.branch_name, u.role_display]
        .some((field) => (field ?? '').toLowerCase().includes(needle));
    });
  }, [roster, search, roleFilter, branchFilter, statusFilter]);

  const sorted = useMemo(() => {
    const metric = (u: User, pick: (m: CounselorPerformance) => number) => {
      const m = metricsById.get(Number(u.id));
      return m ? pick(m) : null;
    };
    const value = (u: User): string | number | null => {
      switch (sortKey) {
        case 'name': return (u.full_name || u.username).toLowerCase();
        case 'role': return ROLE_ORDER.indexOf(u.role);
        case 'branch': return (u.branch_name ?? '').toLowerCase();
        case 'manager': return managerOf(u).toLowerCase();
        case 'status': return u.is_active_employee ? 0 : 1;
        case 'lastActive': return u.last_login ? new Date(u.last_login).getTime() : 0;
        case 'enquiries': return metric(u, (m) => m.totalEnquiries);
        case 'converted': return metric(u, (m) => m.converted);
        case 'registrations': return metric(u, (m) => m.registrations);
        case 'conversion': return metric(u, (m) => m.conversionRate);
        default: return 0;
      }
    };
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      /*
       * A person with no metrics has no position on a metric column, so they
       * sink to the bottom whichever way the arrow points. Folding them in as
       * a number would either claim they scored zero (ascending) or float
       * them above the top performer (descending).
       */
      if (av === null || bv === null) {
        if (av === bv) return (a.full_name || a.username).localeCompare(b.full_name || b.username);
        return av === null ? 1 : -1;
      }
      if (av === bv) return (a.full_name || a.username).localeCompare(b.full_name || b.username);
      return av > bv ? dir : -dir;
    });
  }, [filtered, sortKey, sortDir, metricsById, managerOf]);

  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const pageRows = useMemo(
    () => sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [sorted, safePage],
  );

  /**
   * Same shape the paginated hook returned, so the rest of this screen did not
   * have to change when paging moved into the browser.
   */
  const users = {
    rows: pageRows,
    count: sorted.length,
    page: safePage,
    pages,
    pageSize: PAGE_SIZE,
    setPage,
    isLoading: rosterQuery.isLoading,
    isFetching: rosterQuery.isFetching,
    isError: rosterQuery.isError,
    error: rosterQuery.error,
    refetch: rosterQuery.refetch,
  };

  const exportCsv = () => {
    const header = [
      'Name', 'Username', 'Email', 'Role', 'Branch', 'Reporting manager',
      'Status', 'Last active', 'Enquiries', 'Converted', 'Registrations',
      'Enrollments', 'Conversion %',
    ];
    // Exports what the filters currently select, in the order on screen -- not
    // just the visible page.
    const body = sorted.map((u) => {
      const m = metricsById.get(Number(u.id));
      return [
        u.full_name || u.username, u.username, u.email,
        ROLE_LABELS[u.role] ?? u.role, u.branch_name ?? '', managerOf(u),
        u.is_active_employee ? 'Active' : 'Inactive',
        u.last_login ? new Date(u.last_login).toISOString().slice(0, 10) : '',
        m?.totalEnquiries ?? '', m?.converted ?? '', m?.registrations ?? '',
        m?.enrollments ?? '', m?.conversionRate ?? '',
      ];
    });
    const escape = (cell: string | number) => {
      const text = String(cell ?? '');
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const csv = [header, ...body].map((r) => r.map(escape).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const link = window.document.createElement('a');
    link.href = url;
    link.download = `team-${new Date().toISOString().slice(0, 10)}.csv`;
    window.document.body.appendChild(link);
    link.click();
    window.document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const branchQuery = useQuery({
    queryKey: ['branch-options'],
    queryFn: () => loadAllPages<Branch>(apiClient.branches.list, { ordering: 'name' }),
  });
  const branches = branchQuery.data ?? [];

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['users'] });
    queryClient.invalidateQueries({ queryKey: ['branch-options'] });
    queryClient.invalidateQueries({ queryKey: ['branches'] });
    queryClient.invalidateQueries({ queryKey: ['user'] });
  };

  const isCreating = editing === null;

  const saveMutation = useMutation({
    mutationFn: (payload: UserForm) => {
      const branchId = branchApplies(payload.role) && payload.branch !== NO_BRANCH
        ? Number(payload.branch)
        : null;

      if (isCreating) {
        // `company` is never sent: it is read-only for everyone and stamped
        // from the caller, so staff cannot be moved between tenants.
        const body: UserAdminInput = {
          username: payload.username.trim(),
          email: payload.email.trim(),
          first_name: payload.first_name.trim(),
          last_name: payload.last_name.trim(),
          password: payload.password,
          role: payload.role,
          branch: branchId,
          phone: payload.phone.trim(),
        };
        if (payload.role === 'HEAD_MANAGER') {
          body.managed_managers = payload.managedManagers;
        }
        return apiClient.users.create(body);
      }

      const body: Partial<UserAdminInput> = {
        username: payload.username.trim(),
        email: payload.email.trim(),
        first_name: payload.first_name.trim(),
        last_name: payload.last_name.trim(),
        phone: payload.phone.trim(),
      };
      if (payload.password) {
        body.password = payload.password;
      }
      return apiClient.users.update(editing.id, body);
    },
    onSuccess: (saved) => {
      invalidate();
      const scopeChanged =
        editing !== null && (editing.role !== saved.role || editing.branch !== saved.branch);
      closeForm();
      if (isCreating) {
        toast.success('Account created', `${saved.full_name || saved.username} can sign in now.`);
      } else if (scopeChanged) {
        toast.warning(
          'Saved — this person was signed out',
          'Changing a role or branch revokes their tokens, so they need to sign in again.'
        );
      } else {
        toast.success('Changes saved');
      }
    },
    onError: (error: unknown) => setFieldErrors(getApiFieldErrors(error) ?? {}),
  });

  const toggleMutation = useMutation({
    mutationFn: (target: User) => apiClient.users.setActive(target.id, !target.is_active_employee),
    onSuccess: (saved) => {
      invalidate();
      setToggleTarget(null);
      if (saved.is_active_employee) {
        toast.success('Account reactivated', `${saved.full_name || saved.username} can sign in again.`);
      } else {
        toast.warning(
          'Account deactivated',
          `${saved.full_name || saved.username} has been signed out and cannot sign in until reactivated.`
        );
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (target: User) => apiClient.users.delete(target.id),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
      toast.success('Account deleted');
    },
  });

  const openCreate = () => {
    setEditing(null);
    const initialBranch = branches.find((branch) => branch.is_active && branch.is_default) ?? branches.find((branch) => branch.is_active);
    setForm({ ...EMPTY_FORM, role: 'EMPLOYEE', branch: initialBranch ? String(initialBranch.id) : NO_BRANCH });
    setFieldErrors({});
    setFormError(null);
    saveMutation.reset();
    setIsFormOpen(true);
  };

  const openEdit = (target: User) => {
    setEditing(target);
    setForm({
      username: target.username,
      email: target.email,
      first_name: target.first_name,
      last_name: target.last_name,
      phone: target.phone ?? '',
      password: '',
      confirmPassword: '',
      role: toRole(target.role),
      branch: target.branch === null ? NO_BRANCH : String(target.branch),
      managedManagers: target.managed_managers ?? [],
    });
    setFieldErrors({});
    setFormError(null);
    saveMutation.reset();
    setIsFormOpen(true);
  };

  const closeForm = () => {
    setIsFormOpen(false);
    setEditing(null);
    setFieldErrors({});
    setFormError(null);
  };

  /** Client-side guards that mirror the serializer, so the round trip is spared. */
  const validate = (candidate: UserForm): string | null => {
    if (!candidate.username.trim()) return 'A username is required.';
    if (!candidate.email.trim()) return 'An email address is required.';
    if (isCreating && !candidate.password) return 'Set a password for the new account.';
    if (candidate.password && candidate.password !== candidate.confirmPassword) {
      return 'The two passwords do not match.';
    }
    if (
      isCreating && canManage &&
      branchIsRequired(candidate.role) &&
      candidate.branch === NO_BRANCH
    ) {
      return `A ${ROLE_LABELS[candidate.role].toLowerCase()} must be assigned to a branch.`;
    }
    return null;
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const problem = validate(form);
    setFieldErrors({});
    if (problem) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    saveMutation.mutate(form);
  };

  const hasFilters =
    searchInput !== '' || roleFilter !== 'all' || branchFilter !== 'all' || statusFilter !== 'all';

  /**
   * Any change to the selection invalidates the current page number: page 3 of
   * the old set is not page 3 of the new one. `safePage` would clamp it, but
   * landing on the last page of a fresh filter reads as a bug.
   */
  const applyFilter = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setPage(1);
  };

  const clearFilters = () => {
    setSearchInput('');
    setRoleFilter('all');
    setBranchFilter('all');
    setStatusFilter('all');
    setPage(1);
  };

  // Counts the whole filtered set, not the visible page: paging is a browser
  // concern here and a stat that changed as you paged would be noise.
  const activeCount = sorted.filter((row) => row.is_active_employee).length;
  return (
    <div>
      <div className="flex flex-col gap-3 border-b border-slate-100 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">Members</p>
          <p className="mt-0.5 text-xs text-slate-500">View profiles and manage accounts.</p>
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          <Button
            variant="outline"
            onClick={exportCsv}
            disabled={sorted.length === 0}
            className="h-9 text-xs flex-1 sm:flex-none"
          >
            <Download className="mr-2 h-4 w-4" /> Export CSV
          </Button>
          {/*
            Writes need `manageUsers`, which is floored at company admin, so a
            head manager reads this screen and changes nothing on it.
          */}
          {canManage && (
            <Button onClick={openCreate} className="h-9 text-xs flex-1 bg-teal-600 hover:bg-teal-700 sm:flex-none">
              <Plus className="mr-2 h-4 w-4" /> Add member
            </Button>
          )}
        </div>
      </div>

      {truncated && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Showing the first {users.count} accounts. Narrow the filters to be sure
          you are seeing everyone.
        </p>
      )}

      {toggleMutation.isError && (
        <ErrorBanner error={toggleMutation.error} onDismiss={() => toggleMutation.reset()} />
      )}
      {deleteMutation.isError && (
        <ErrorBanner error={deleteMutation.error} onDismiss={() => deleteMutation.reset()} />
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-slate-100 bg-slate-50/70 px-3 py-2 text-xs text-slate-600">
        <span><strong className="text-slate-900">{users.count}</strong> {hasFilters ? 'matching members' : 'members'}</span>
        <span><strong className="text-slate-900">{activeCount}</strong> active</span>
        <span><strong className="text-slate-900">{branches.length}</strong> branches</span>
      </div>

      {/* Filtering, sorting and paging all happen over the loaded roster. */}
      <div className="flex flex-col gap-2 border-b border-slate-100 p-3 xl:flex-row">
        <div className="relative min-w-0 flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input
            value={searchInput}
            onChange={(e) => applyFilter(setSearchInput)(e.target.value)}
            placeholder="Search by name, username or email…"
            aria-label="Search users"
            className="h-9 pl-9"
          />
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 xl:w-[440px]">
          <Select value={roleFilter} onValueChange={applyFilter(setRoleFilter)}>
            <SelectTrigger className="h-9 text-xs" aria-label="Filter by role">
              <SelectValue placeholder="All roles" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All roles</SelectItem>
              {ALL_ROLES.map((value) => (
                <SelectItem key={value} value={value}>
                  {ROLE_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={branchFilter} onValueChange={applyFilter(setBranchFilter)}>
            <SelectTrigger className="h-9 text-xs" aria-label="Filter by branch">
              <SelectValue placeholder="All branches" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All branches</SelectItem>
              {branches.map((branch) => (
                <SelectItem key={branch.id} value={String(branch.id)}>
                  {branch.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={statusFilter} onValueChange={applyFilter(setStatusFilter)}>
            <SelectTrigger className="h-9 text-xs" aria-label="Filter by status">
              <SelectValue placeholder="Any status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Deactivated</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {hasFilters && (
          <div>
            <Button variant="outline" size="sm" className="h-9" onClick={clearFilters}>
              Clear filters
            </Button>
          </div>
        )}
      </div>

      {users.isError ? (
        <ErrorState error={users.error} onRetry={users.refetch} />
      ) : users.isLoading ? (
        <LoadingState rows={5} label="Loading users" />
      ) : users.rows.length === 0 ? (
        <EmptyState
          icon={Users}
          title={hasFilters ? 'No users match those filters' : 'No users yet'}
          description={
            hasFilters
              ? 'Try a different search term, role, branch or status.'
              : 'Add your first team member so they can sign in and own records.'
          }
          action={
            hasFilters ? (
              <Button variant="outline" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : canManage ? (
              <Button onClick={openCreate} className="bg-teal-600 hover:bg-teal-700">
                <Plus className="mr-2 h-4 w-4" /> Add member
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              {/*
                Sticky header: the roster is paged at 25, which is tall enough
                that the column names leave the viewport while you read a row.
              */}
              <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50">
                <tr>
                  <SortHeader label="Person" sortKey="name" active={sortKey} dir={sortDir} onSort={toggleSort} />
                  <SortHeader label="Role" sortKey="role" active={sortKey} dir={sortDir} onSort={toggleSort} />
                  <SortHeader label="Branch" sortKey="branch" active={sortKey} dir={sortDir} onSort={toggleSort} className="hidden md:table-cell" />
                  <SortHeader label="Manager" sortKey="manager" active={sortKey} dir={sortDir} onSort={toggleSort} className="hidden lg:table-cell" />
                  <SortHeader label="Status" sortKey="status" active={sortKey} dir={sortDir} onSort={toggleSort} />
                  <SortHeader label="Last active" sortKey="lastActive" active={sortKey} dir={sortDir} onSort={toggleSort} className="hidden xl:table-cell" />
                  <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase text-slate-700">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {users.rows.map((row) => {
                  const isSelf = me?.id === row.id;
                  /*
                   * Editing needs `manageUsers`, full stop.
                   *
                   * This used to fall back to `outranks`, which was harmless while
                   * the screen was admin-only. This page is open to head managers,
                   * and `manageUsers` is floored at company admin, so that fallback
                   * would render a pencil that always 403s on save.
                   */
                  const mayEdit = canManage;
                  return (
                    <tr key={row.id} className="hover:bg-slate-50">
                      <td className="px-4 py-4">
                        <div className="flex items-start gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-teal-50 text-xs font-bold text-teal-700">
                            {initialsOf(row)}
                          </div>
                          <div className="min-w-0">
                            <Link
                              href={`/app/team/${row.id}`}
                              className="max-w-full truncate text-left font-semibold text-slate-900 hover:text-teal-700 hover:underline"
                            >
                              {row.full_name || row.username}
                            </Link>
                            <p className="mt-0.5 truncate text-xs text-slate-500">{row.email}</p>
                            <p className="mt-0.5 truncate text-xs text-slate-500 md:hidden">
                              {row.branch_name ?? 'No branch'}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge className={ROLE_BADGE[toRole(row.role)]}>{ROLE_LABELS[toRole(row.role)]}</Badge>
                      </td>
                      <td className="hidden px-3 py-2.5 md:table-cell">
                        {row.branch_name ? (
                          <span className="inline-flex items-center gap-1.5 text-slate-700">
                            <Building2 size={14} className="text-slate-400" /> {row.branch_name}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-400">Not assigned</span>
                        )}
                      </td>
                      <td className="hidden px-3 py-2.5 text-slate-700 lg:table-cell">
                        {managerOf(row)}
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge
                          className={
                            row.is_active_employee
                              ? 'border-transparent bg-green-100 text-green-700 hover:bg-green-100'
                              : 'border-transparent bg-slate-200 text-slate-600 hover:bg-slate-200'
                          }
                        >
                          {row.is_active_employee ? 'Active' : 'Deactivated'}
                        </Badge>
                      </td>
                      <td className="hidden px-3 py-2.5 text-xs text-slate-600 xl:table-cell">
                        {row.last_login ? format(new Date(row.last_login), 'd MMM yyyy') : 'Never'}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex justify-end gap-1">
                          <Button asChild variant="ghost" size="sm" className="h-8 text-xs text-teal-700">
                            <Link href={`/app/team/${row.id}`} aria-label={`View profile for ${row.full_name || row.username}`}>View profile</Link>
                          </Button>
                          {mayEdit && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 hover:bg-teal-50 hover:text-teal-600"
                              onClick={() => openEdit(row)}
                              aria-label={`Edit ${row.full_name || row.username}`}
                            >
                              <Pencil size={15} />
                            </Button>
                          )}
                          {canManage && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 hover:bg-amber-50 hover:text-amber-600 disabled:opacity-40"
                              onClick={() => setToggleTarget(row)}
                              disabled={isSelf}
                              title={isSelf ? 'You cannot deactivate your own account' : undefined}
                              aria-label={`${row.is_active_employee ? 'Deactivate' : 'Activate'} ${row.username}`}
                            >
                              <Power size={15} />
                            </Button>
                          )}
                          {canManage && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                              onClick={() => setDeleteTarget(row)}
                              disabled={isSelf}
                              title={isSelf ? 'You cannot delete your own account' : undefined}
                              aria-label={`Delete ${row.username}`}
                            >
                              <Trash2 size={15} />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <PaginationBar
            page={users.page}
            pages={users.pages}
            count={users.count}
            pageSize={users.pageSize}
            onPageChange={users.setPage}
            isLoading={users.isFetching}
          />
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Create / edit                                                     */}
      {/* ---------------------------------------------------------------- */}
      <Modal
        open={isFormOpen}
        onClose={closeForm}
        size="lg"
        title={editing ? `Edit ${editing.full_name || editing.username}` : 'Add a team member'}
        description={
          editing
            ? 'Update contact details or reset their password.'
            : 'They will be able to sign in as soon as the account exists.'
        }
        footer={
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="h-11 sm:w-32" onClick={closeForm}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="user-form"
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
                'Create account'
              )}
            </Button>
          </div>
        }
      >
        <form id="user-form" className="space-y-5" onSubmit={handleSubmit}>
          {formError && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">{formError}</p>
          )}
          {saveMutation.isError && <ErrorBanner error={saveMutation.error} />}

          <section className="space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Identity</h3>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="user-username">Username *</Label>
                <Input
                  id="user-username"
                  required
                  autoComplete="off"
                  className="h-11"
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  placeholder="jdoe"
                />
                {fieldErrors.username && <p className="text-xs text-red-600">{fieldErrors.username}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="user-email">Email *</Label>
                <Input
                  id="user-email"
                  required
                  type="email"
                  autoComplete="off"
                  className="h-11"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="jane@company.com"
                />
                {fieldErrors.email && <p className="text-xs text-red-600">{fieldErrors.email}</p>}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="user-first-name">First name</Label>
                <Input
                  id="user-first-name"
                  className="h-11"
                  value={form.first_name}
                  onChange={(e) => setForm({ ...form, first_name: e.target.value })}
                />
                {fieldErrors.first_name && <p className="text-xs text-red-600">{fieldErrors.first_name}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="user-last-name">Last name</Label>
                <Input
                  id="user-last-name"
                  className="h-11"
                  value={form.last_name}
                  onChange={(e) => setForm({ ...form, last_name: e.target.value })}
                />
                {fieldErrors.last_name && <p className="text-xs text-red-600">{fieldErrors.last_name}</p>}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="user-phone">Phone</Label>
              <Input
                id="user-phone"
                type="tel"
                className="h-11"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="+91 98765 43210"
              />
              {fieldErrors.phone && <p className="text-xs text-red-600">{fieldErrors.phone}</p>}
            </div>
          </section>

          {isCreating && canManage ? (
            <section className="space-y-2 border-t border-slate-100 pt-5">
              <Label htmlFor="user-branch">Initial branch *</Label>
              <Select value={form.branch} onValueChange={(branch) => setForm({ ...form, branch })}>
                <SelectTrigger id="user-branch"><SelectValue placeholder="Choose a branch" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_BRANCH} disabled>Choose a branch</SelectItem>
                  {branches.filter((branch) => branch.is_active).map((branch) => <SelectItem key={branch.id} value={String(branch.id)}>{branch.name}</SelectItem>)}
                </SelectContent>
              </Select>
              {branchQuery.isError && <ErrorBanner error={branchQuery.error} />}
              {fieldErrors.branch && <p className="text-xs text-red-600">{fieldErrors.branch}</p>}
              <p className="text-xs text-slate-500">New members start as employees. Set roles and reporting lines in <Link className="text-teal-700 underline" href="/app/team?tab=branches">Branches</Link>.</p>
            </section>
          ) : (
            <p className="border-t border-slate-100 pt-4 text-xs text-slate-500">Manage roles and assignments in <Link className="text-teal-700 underline" href="/app/team?tab=branches">Branches</Link>.</p>
          )}

          {/*
            Admin-only: setting someone else's password through a plain PATCH is
            refused for non-admins, who change their own from /app/profile.
          */}
          {canManage && (
          <section className="space-y-4 border-t border-slate-100 pt-5">
            <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <KeyRound size={13} /> {editing ? 'Reset password' : 'Password'}
            </h3>
            {editing && (
              <p className="text-xs text-slate-500">
                Leave both boxes empty to keep their current password.
              </p>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="user-password">{editing ? 'New password' : 'Password *'}</Label>
                <Input
                  id="user-password"
                  type="password"
                  autoComplete="new-password"
                  className="h-11"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
                {fieldErrors.password && <p className="text-xs text-red-600">{fieldErrors.password}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="user-confirm-password">Confirm password</Label>
                <Input
                  id="user-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  className="h-11"
                  value={form.confirmPassword}
                  onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
                />
              </div>
            </div>
          </section>
          )}
        </form>
      </Modal>

      {/* ---------------------------------------------------------------- */}
      {/* Detail                                                            */}
      {/* ---------------------------------------------------------------- */}
      <ConfirmDialog
        open={toggleTarget !== null}
        onClose={() => setToggleTarget(null)}
        onConfirm={() => toggleTarget && toggleMutation.mutate(toggleTarget)}
        title={toggleTarget?.is_active_employee ? 'Deactivate this account?' : 'Reactivate this account?'}
        description={
          toggleTarget?.is_active_employee
            ? `${toggleTarget?.full_name || toggleTarget?.username} will be signed out immediately and blocked from signing in. Their records are kept and can be reassigned.`
            : `${toggleTarget?.full_name || toggleTarget?.username} will be able to sign in again.`
        }
        confirmText={toggleTarget?.is_active_employee ? 'Deactivate' : 'Reactivate'}
        confirmVariant={toggleTarget?.is_active_employee ? 'destructive' : 'default'}
        isLoading={toggleMutation.isPending}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
        title="Delete this account?"
        description={`${deleteTarget?.full_name || deleteTarget?.username} will be removed permanently. Deactivating instead keeps their history intact — prefer that unless the account was created by mistake.`}
        confirmText="Delete"
        confirmVariant="destructive"
        isLoading={deleteMutation.isPending}
      />
    </div>
  );
}
