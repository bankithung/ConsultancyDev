'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { format, isToday } from 'date-fns';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Calendar,
  CheckCircle2,
  ChevronRight,
  Clock,
  CreditCard,
  FileText,
  GraduationCap,
  Mail,
  MessageSquare,
  Phone,
  Plus,
  Star,
  Target,
  UserPlus,
  Users,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { apiClient, fetchPage } from '@/lib/apiClient';
import { toArray } from '@/components/common/pagination';
import type { ApprovalRequest, FollowUp, StudentDocument, Task } from '@/lib/types';
import { can } from '@/components/rbac/roles';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorState, LoadingState } from '@/components/common/states';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/authStore';

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

function rupees(value: number): string {
  return `₹${Math.round(value).toLocaleString('en-IN')}`;
}

/** Compact money for a stat tile, where the full figure will not fit at 375px. */
function shortRupees(value: number): string {
  if (Math.abs(value) >= 10000000) return `₹${(value / 10000000).toFixed(1)}Cr`;
  if (Math.abs(value) >= 100000) return `₹${(value / 100000).toFixed(1)}L`;
  if (Math.abs(value) >= 1000) return `₹${Math.round(value / 1000)}k`;
  return rupees(value);
}

function timestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function safeDay(value: string | null | undefined, pattern = 'MMM d, yyyy'): string {
  const ms = timestamp(value);
  return ms === 0 ? '—' : format(new Date(ms), pattern);
}

/* -------------------------------------------------------------------------- */
/* ADMIN DASHBOARD                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Shown to every role that can see aggregate analytics: DEV_ADMIN,
 * COMPANY_ADMIN, HEAD_MANAGER and BRANCH_MANAGER.
 *
 * Nothing here filters by company or branch client-side. Every endpoint below
 * is already scoped server-side by `core.permissions.scope_queryset`, so a
 * branch manager gets their branch's numbers and a company admin gets the
 * company's from the very same calls.
 */

/** Trailing windows accepted by `analytics/revenue/`, which buckets by month. */
const REVENUE_WINDOWS = [
  { months: 6, label: '6M' },
  { months: 12, label: '12M' },
  { months: 24, label: '24M' },
] as const;

type RevenueWindow = (typeof REVENUE_WINDOWS)[number]['months'];

interface UpcomingTask {
  id: number;
  task: string;
  type: string;
  overdue: boolean;
  priority: string;
  scheduledFor: string;
}

function AdminDashboard() {
  const stats = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: apiClient.dashboard.getStats,
  });

  const { data: activity = [] } = useQuery({
    queryKey: ['dashboard-activity'],
    queryFn: apiClient.dashboard.getActivity,
  });

  // `getWeeklyData` takes no arguments: the endpoint always reports the last
  // seven days. The old 7D/30D/MTD toggle passed a window the server never
  // read, so two of its three positions changed nothing.
  const { data: weeklyData = [] } = useQuery({
    queryKey: ['dashboard-weekly'],
    queryFn: apiClient.dashboard.getWeeklyData,
  });

  const [revenueWindow, setRevenueWindow] = useState<RevenueWindow>(12);

  // Revenue comes from analytics/revenue/, which aggregates in SQL across the
  // caller's whole scope. Reducing a 25-row page here would show a headline
  // figure computed from a fraction of the data. `months` is the one parameter
  // the endpoint actually honours, so the selector maps onto it directly.
  const { data: revenueData = [] } = useQuery({
    queryKey: ['dashboard-revenue', revenueWindow],
    queryFn: () => apiClient.analytics.getRevenue(revenueWindow),
  });

  // Full enquiry rows rather than `dashboard.getRecentEnquiries`, whose
  // projection drops the id — without it these rows cannot link anywhere.
  const { data: recentEnquiries = [] } = useQuery({
    queryKey: ['dashboard-recent-enquiries'],
    queryFn: async () =>
      toArray(await apiClient.enquiries.list({ page_size: 4, ordering: '-created_at' })),
  });

  const { data: upcomingTasks = [] } = useQuery({
    queryKey: ['dashboard-upcoming-tasks'],
    queryFn: async (): Promise<UpcomingTask[]> => {
      // Filter server-side: `?status=Pending` with a small page beats
      // pulling a page and discarding most of it.
      const page = await apiClient.followUps.list({
        page_size: 4,
        ordering: 'scheduled_for',
        filters: { status: 'Pending' },
      });
      const now = Date.now();
      return toArray<FollowUp>(page).map((t) => ({
        id: t.id,
        task: `Follow up with ${t.enquiry_candidate || 'student'}`,
        type: t.type,
        overdue: timestamp(t.scheduled_for) < now,
        priority: t.priority,
        scheduledFor: t.scheduled_for,
      }));
    },
  });

  // These cards want TOTALS, not "how many on the first page". Ask the
  // server for the count and no rows.
  const { data: pendingPaymentsCount = 0 } = useQuery({
    queryKey: ['dashboard-pending-payments'],
    queryFn: async () =>
      (await apiClient.payments.list({ page_size: 1, filters: { status: 'Pending' } })).count,
  });

  const { data: pendingDocTransfersCount = 0 } = useQuery({
    queryKey: ['dashboard-doc-transfers'],
    queryFn: async () =>
      (await apiClient.transfers.list({ page_size: 1, filters: { status: 'PENDING' } })).count,
  });

  const { data: pendingFollowUpsCount = 0 } = useQuery({
    queryKey: ['dashboard-follow-ups'],
    queryFn: async () =>
      (await apiClient.followUps.list({ page_size: 1, filters: { status: 'Pending' } })).count,
  });

  const { data: pendingApprovalCount = 0 } = useQuery({
    queryKey: ['approval-requests', 'pending-count'],
    queryFn: () => apiClient.approvalRequests.pendingCount(),
  });

  if (stats.isLoading) {
    return <LoadingState rows={6} label="Loading dashboard…" />;
  }

  if (stats.isError) {
    return (
      <ErrorState
        error={stats.error}
        onRetry={() => void stats.refetch()}
        title="Could not load the dashboard"
      />
    );
  }

  const figures = stats.data;

  return (
    <div className="space-y-4">
      {/* Stats Row */}
      {/*
        Four cards, not five: the "Online Now" tile was driven by the
        WebSocket presence hook, and real-time messaging was removed at
        the owner's request. A tile that always reads 0 / "Connecting…"
        is worse than no tile.

        Every trend below is computed by the backend from real prior-month
        counts. Nothing here is invented — an arrow reads as a measurement.
      */}
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <CompactStatCard
          title="Enquiries"
          value={(figures?.enquiries.value ?? 0).toLocaleString('en-IN')}
          icon={MessageSquare}
          trend={figures?.enquiries.trend ?? 0}
          color="blue"
        />
        <CompactStatCard
          title="Registrations"
          value={(figures?.registrations.value ?? 0).toLocaleString('en-IN')}
          icon={UserPlus}
          trend={figures?.registrations.trend ?? 0}
          color="emerald"
        />
        <CompactStatCard
          title="Enrollments"
          value={(figures?.enrollments.value ?? 0).toLocaleString('en-IN')}
          icon={GraduationCap}
          trend={figures?.enrollments.trend ?? 0}
          color="purple"
        />
        <CompactStatCard
          title="Earnings"
          value={shortRupees(figures?.totalEarnings.value ?? 0)}
          icon={CreditCard}
          trend={figures?.totalEarnings.trend ?? 0}
          color="amber"
        />
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        {/* Left Column - Charts */}
        <div className="space-y-4 xl:col-span-8">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card className="border-slate-200 lg:col-span-2">
              <div className="p-4">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-800">Weekly Overview</h3>
                  <span className="text-[10px] text-slate-400">Last 7 days</span>
                </div>
                <div className="h-[180px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={weeklyData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                      <XAxis dataKey="name" tickLine={false} axisLine={false} fontSize={10} tick={{ fill: '#64748b' }} />
                      <YAxis tickLine={false} axisLine={false} fontSize={10} tick={{ fill: '#64748b' }} allowDecimals={false} />
                      <Tooltip contentStyle={{ backgroundColor: '#fff', borderColor: '#e2e8f0', borderRadius: '8px', fontSize: '11px' }} />
                      <Bar dataKey="enquiries" fill="#3b82f6" radius={[3, 3, 0, 0]} name="Enquiries" />
                      <Bar dataKey="registrations" fill="#10b981" radius={[3, 3, 0, 0]} name="Registrations" />
                      <Bar dataKey="enrollments" fill="#8b5cf6" radius={[3, 3, 0, 0]} name="Enrollments" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
                  <Legend color="bg-blue-500" label="Enquiries" />
                  <Legend color="bg-emerald-500" label="Registrations" />
                  <Legend color="bg-purple-500" label="Enrollments" />
                </div>
              </div>
            </Card>

            {/* Quick Actions Card */}
            <Card className="border-slate-200">
              <div className="p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-800">Quick Actions</span>
                  <Zap size={14} className="text-amber-500" />
                </div>
                <div className="space-y-2">
                  <QuickAction href="/app/enquiries/new" icon={Plus} label="New Enquiry" tone="teal" />
                  <QuickAction href="/app/registrations/new" icon={UserPlus} label="Register Student" tone="emerald" />
                  <QuickAction href="/app/counselors" icon={Users} label="Team Members" tone="blue" />
                  <QuickAction
                    href="/app/approval-requests"
                    icon={CheckCircle2}
                    label="Approval Requests"
                    tone="purple"
                    badge={pendingApprovalCount > 0 ? pendingApprovalCount : undefined}
                  />
                </div>
              </div>
            </Card>
          </div>

          <Card className="border-slate-200">
            <div className="p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <h3 className="text-sm font-semibold text-slate-800">Revenue Trend</h3>
                  <span className="hidden text-[10px] text-slate-400 sm:inline">Monthly, settled payments</span>
                </div>
                <div className="flex shrink-0 items-center rounded-full bg-slate-100 p-0.5">
                  {REVENUE_WINDOWS.map((window) => (
                    <button
                      key={window.months}
                      type="button"
                      onClick={() => setRevenueWindow(window.months)}
                      aria-pressed={revenueWindow === window.months}
                      className={cn(
                        'rounded-full px-2.5 py-1 text-[10px] font-medium transition-all',
                        revenueWindow === window.months
                          ? 'bg-white text-teal-700 shadow-sm'
                          : 'text-slate-500 hover:text-slate-700'
                      )}
                    >
                      {window.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="h-[160px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={revenueData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#0d9488" stopOpacity={0.15} />
                        <stop offset="95%" stopColor="#0d9488" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={10} tick={{ fill: '#64748b' }} />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      fontSize={10}
                      tick={{ fill: '#64748b' }}
                      tickFormatter={(value: number) => shortRupees(value)}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#fff', borderColor: '#e2e8f0', borderRadius: '8px', fontSize: '11px' }}
                      formatter={(value: number) => [rupees(value), 'Revenue']}
                    />
                    <Area type="monotone" dataKey="revenue" stroke="#0d9488" strokeWidth={2} fillOpacity={1} fill="url(#colorRevenue)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </Card>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="border-slate-200">
              <div className="p-4">
                <PanelHeader title="Recent Enquiries" href="/app/enquiries" />
                <div className="space-y-2">
                  {recentEnquiries.length === 0 ? (
                    <p className="py-6 text-center text-xs text-slate-400">No recent enquiries</p>
                  ) : (
                    recentEnquiries.map((enq) => (
                      <Link
                        key={enq.id}
                        href={`/app/enquiries/${enq.id}`}
                        className="group flex items-center justify-between gap-2 rounded-lg p-2 transition-colors hover:bg-slate-50"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-slate-100 to-slate-200 text-xs font-semibold text-slate-600">
                            {enq.candidateName?.charAt(0)?.toUpperCase() || '?'}
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-xs font-medium text-slate-800">{enq.candidateName}</p>
                            <p className="truncate text-[10px] text-slate-500">{enq.courseInterested || '—'}</p>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span
                            className={cn(
                              'rounded-full px-1.5 py-0.5 text-[9px] font-medium',
                              enq.status === 'New'
                                ? 'bg-blue-100 text-blue-700'
                                : enq.status === 'Converted'
                                  ? 'bg-emerald-100 text-emerald-700'
                                  : 'bg-slate-100 text-slate-600'
                            )}
                          >
                            {enq.status}
                          </span>
                          <ChevronRight size={12} className="text-slate-300 group-hover:text-slate-500" />
                        </div>
                      </Link>
                    ))
                  )}
                </div>
              </div>
            </Card>

            <Card className="border-slate-200">
              <div className="p-4">
                <PanelHeader title="Upcoming Follow-ups" href="/app/follow-ups" />
                <div className="space-y-2">
                  {upcomingTasks.length === 0 ? (
                    <p className="py-6 text-center text-xs text-slate-400">No pending follow-ups</p>
                  ) : (
                    upcomingTasks.map((task) => (
                      <Link
                        key={task.id}
                        href={`/app/follow-ups/${task.id}`}
                        className="group flex items-center justify-between gap-2 rounded-lg p-2 transition-colors hover:bg-slate-50"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <ChannelIcon type={task.type} />
                          <div className="min-w-0">
                            <p className="truncate text-xs font-medium text-slate-800">{task.task}</p>
                            <p
                              className={cn(
                                'flex items-center gap-1 text-[10px]',
                                task.overdue ? 'text-red-600' : 'text-slate-500'
                              )}
                            >
                              <Clock size={10} />
                              {task.overdue ? 'Overdue · ' : ''}
                              {safeDay(task.scheduledFor, 'MMM d, h:mm a')}
                            </p>
                          </div>
                        </div>
                        <PriorityDot priority={task.priority} />
                      </Link>
                    ))
                  )}
                </div>
              </div>
            </Card>
          </div>
        </div>

        {/* Right Sidebar */}
        <div className="space-y-4 xl:col-span-4">
          <Card className="border-slate-200">
            <div className="p-4">
              <h3 className="mb-3 text-sm font-semibold text-slate-800">Action Required</h3>
              <div className="space-y-2">
                <ActionItem
                  href="/app/payments"
                  icon={CreditCard}
                  label="Pending Payments"
                  count={pendingPaymentsCount}
                  note={figures ? rupees(figures.pendingPaymentsAmount) : undefined}
                  color="amber"
                />
                <ActionItem
                  href="/app/transfers"
                  icon={FileText}
                  label="Record Transfers"
                  count={pendingDocTransfersCount}
                  color="purple"
                />
                <ActionItem
                  href="/app/follow-ups"
                  icon={MessageSquare}
                  label="Follow-ups"
                  count={pendingFollowUpsCount}
                  color="blue"
                />
              </div>
            </div>
          </Card>

          <Card className="border-slate-200">
            <div className="p-4">
              <h3 className="mb-3 text-sm font-semibold text-slate-800">Recent Activity</h3>
              <div className="max-h-[280px] space-y-3 overflow-y-auto">
                {activity.length === 0 ? (
                  <p className="py-4 text-center text-xs text-slate-400">No recent activity</p>
                ) : (
                  activity.slice(0, 6).map((item) => (
                    <div
                      key={item.id}
                      className="flex items-start gap-2.5 border-b border-slate-100 pb-3 last:border-0 last:pb-0"
                    >
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-600">
                        <Activity size={12} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2 text-xs leading-relaxed text-slate-700">{item.text}</p>
                        <p className="mt-0.5 text-[10px] text-slate-400">{item.time}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </Card>

          <Card className="border-slate-200 bg-gradient-to-br from-teal-600 to-teal-700">
            <div className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-white/90">At a Glance</h3>
                <Calendar size={14} className="text-white/60" />
              </div>
              <div className="grid grid-cols-2 gap-2 sm:gap-3">
                <GlanceTile label="Registrations" value={(figures?.registrations.value ?? 0).toLocaleString('en-IN')} />
                <GlanceTile label="Total Revenue" value={shortRupees(figures?.totalEarnings.value ?? 0)} />
                <GlanceTile label="Conversion" value={`${figures?.conversionRate ?? 0}%`} />
                <GlanceTile label="Transfers In" value={(figures?.pendingTransfers ?? 0).toLocaleString('en-IN')} />
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* EMPLOYEE DASHBOARD                                                         */
/* -------------------------------------------------------------------------- */

/**
 * An employee sees only their own records — and they see them because the
 * backend says so, not because this page filters.
 *
 * `scope_queryset` narrows every list to `owner=user` (plus anything
 * transferred to them), and `analytics/overview/` runs its aggregates over that
 * same scope. The previous version fetched whole collections and filtered by
 * `created_by === userId` in the browser, which was wrong twice over: it kept
 * only what happened to land on page one, and `created_by` is an audit trail
 * rather than a grant, so a record transferred away still counted.
 */

/** One page of pending follow-ups, sorted earliest-first. */
const FOLLOWUP_SCAN = 100;

interface RecentStudent {
  key: string;
  kind: 'enquiry' | 'registration' | 'enrollment';
  id: string;
  name: string;
  subtitle: string;
  at: number;
}

/** A pending follow-up already classified against the clock at fetch time. */
interface DueFollowUp {
  id: number;
  candidate: string;
  type: string;
  scheduledFor: string;
  overdue: boolean;
  dueToday: boolean;
}

interface DueFollowUps {
  rows: DueFollowUp[];
  /** Server total for all pending follow-ups assigned to this user. */
  count: number;
  overdue: number;
  dueToday: number;
  /** False when the scanned page was full and entirely overdue, making `overdue` a floor. */
  overdueExact: boolean;
}

function EmployeeDashboard() {
  const user = useAuthStore((state) => state.user);
  const userId = user?.id;

  // Totals, this-month counts and conversion, all computed in SQL over exactly
  // the records this employee owns.
  const overview = useQuery({
    queryKey: ['employee-overview'],
    queryFn: apiClient.analytics.getOverview,
  });

  /*
   * "Overdue" and "due today" are decided here, at fetch time, rather than in
   * render: the clock is not a pure input, and a component that re-renders for
   * an unrelated reason would otherwise silently reclassify rows.
   */
  const followUps = useQuery({
    queryKey: ['employee-followups', userId],
    queryFn: async (): Promise<DueFollowUps> => {
      if (userId === undefined) return { rows: [], count: 0, overdue: 0, dueToday: 0, overdueExact: true };

      const page = await apiClient.followUps.list({
        page_size: FOLLOWUP_SCAN,
        ordering: 'scheduled_for',
        filters: { assigned_to: userId, status: 'Pending' },
      });

      const now = Date.now();
      const rows: DueFollowUp[] = page.results.map((f) => {
        const due = timestamp(f.scheduled_for);
        return {
          id: f.id,
          candidate: f.enquiry_candidate || 'Student',
          type: f.type,
          scheduledFor: f.scheduled_for,
          overdue: due > 0 && due < now,
          dueToday: due > 0 && isToday(new Date(due)),
        };
      });

      const overdue = rows.filter((r) => r.overdue).length;
      return {
        rows,
        count: page.count,
        overdue,
        dueToday: rows.filter((r) => r.dueToday).length,
        // Rows arrive earliest-first, so overdue ones are a prefix of the page.
        // The count is exact unless the page filled up and every row was overdue.
        overdueExact: !(rows.length === FOLLOWUP_SCAN && overdue === FOLLOWUP_SCAN),
      };
    },
    enabled: userId !== undefined,
  });

  // `status` has no "not done" operator in the filterset, so the two open
  // states are queried separately and their envelope counts added — both are
  // true totals rather than page lengths.
  const tasks = useQuery({
    queryKey: ['employee-tasks', userId],
    queryFn: async (): Promise<{ rows: Task[]; count: number }> => {
      if (userId === undefined) return { rows: [], count: 0 };
      const [todo, active] = await Promise.all([
        apiClient.tasks.list({
          page_size: 5,
          ordering: 'due_date',
          filters: { assigned_to: userId, status: 'Todo' },
        }),
        apiClient.tasks.list({
          page_size: 5,
          ordering: 'due_date',
          filters: { assigned_to: userId, status: 'In Progress' },
        }),
      ]);
      const rows = [...todo.results, ...active.results]
        .sort((a, b) => timestamp(a.dueDate) - timestamp(b.dueDate))
        .slice(0, 5);
      return { rows, count: todo.count + active.count };
    },
    enabled: userId !== undefined,
  });

  // `approval-requests/my-requests/` separates requests the caller RAISED from
  // ones awaiting their review; the plain list mixes both for a manager.
  const myRequests = useQuery({
    queryKey: ['employee-my-requests'],
    queryFn: () =>
      fetchPage<ApprovalRequest>('approval-requests/my-requests/', {
        page_size: 5,
        ordering: '-created_at',
      }),
  });

  // For an EMPLOYEE the approval queryset is already `requested_by=user`, so
  // this is "my pending requests" rather than a review queue.
  const { data: myPendingRequests = 0 } = useQuery({
    queryKey: ['employee-pending-requests'],
    queryFn: () => apiClient.approvalRequests.pendingCount(),
  });

  // The top few of each collection, merged. Taking the newest 6 from each and
  // then the newest 6 overall is exact: nothing outside those pages can be
  // newer than what is in them.
  const recentStudents = useQuery({
    queryKey: ['employee-recent-students'],
    queryFn: async (): Promise<RecentStudent[]> => {
      const [enquiries, registrations, enrollments] = await Promise.all([
        apiClient.enquiries.list({ page_size: 6, ordering: '-created_at' }),
        apiClient.registrations.list({ page_size: 6, ordering: '-created_at' }),
        apiClient.enrollments.list({ page_size: 6, ordering: '-created_at' }),
      ]);

      const merged: RecentStudent[] = [
        ...enquiries.results.map((e) => ({
          key: `enquiry-${e.id}`,
          kind: 'enquiry' as const,
          id: e.id,
          name: e.candidateName,
          subtitle: e.mobile || e.email || e.courseInterested || '',
          at: timestamp(e.date),
        })),
        ...registrations.results.map((r) => ({
          key: `registration-${r.id}`,
          kind: 'registration' as const,
          id: r.id,
          name: r.studentName,
          subtitle: r.registrationNo || r.mobile || r.email || '',
          at: timestamp(r.created_at ?? r.registrationDate),
        })),
        ...enrollments.results.map((e) => ({
          key: `enrollment-${e.id}`,
          kind: 'enrollment' as const,
          id: e.id,
          name: e.studentName,
          subtitle: e.enrollmentNo || e.programName || '',
          at: timestamp(e.created_at ?? e.startDate),
        })),
      ];

      return merged.sort((a, b) => b.at - a.at).slice(0, 6);
    },
  });

  // `current_holder` is a real filterset field on student-documents, which is
  // what actually answers "who is holding the passport". The old card filtered
  // uploaded scans on a `current_holder` property that does not exist on them.
  const heldDocuments = useQuery({
    queryKey: ['employee-held-documents', userId],
    queryFn: async (): Promise<{ count: number; rows: StudentDocument[] }> => {
      if (userId === undefined) return { count: 0, rows: [] };
      const page = await apiClient.studentDocuments.list(undefined, {
        page_size: 4,
        ordering: '-received_at',
        filters: { current_holder: userId },
      });
      return { count: page.count, rows: page.results };
    },
    enabled: userId !== undefined,
  });

  if (overview.isLoading) {
    return <LoadingState rows={6} label="Loading your dashboard…" />;
  }

  if (overview.isError) {
    return (
      <ErrorState
        error={overview.error}
        onRetry={() => void overview.refetch()}
        title="Could not load your dashboard"
      />
    );
  }

  const figures = overview.data;

  const pendingFollowUps = followUps.data?.rows ?? [];
  const pendingFollowUpCount = followUps.data?.count ?? 0;
  const overdueCount = followUps.data?.overdue ?? 0;
  const dueTodayCount = followUps.data?.dueToday ?? 0;
  const overdueLabel = followUps.data?.overdueExact === false ? `${overdueCount}+` : `${overdueCount}`;

  const requestRows = myRequests.data?.results ?? [];

  return (
    <div className="space-y-4">
      {/* Urgent alerts */}
      {overdueCount > 0 && (
        <Card className="border-red-200 bg-gradient-to-r from-red-50 to-red-100 shadow-sm">
          <Link href="/app/follow-ups" className="block p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-red-100">
                  <AlertTriangle size={22} className="text-red-600" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-red-800">
                    {overdueLabel} overdue follow-up{overdueCount === 1 ? '' : 's'}
                  </p>
                  <p className="text-xs text-red-600">Needs immediate attention — tap to view</p>
                </div>
              </div>
              <ChevronRight size={20} className="shrink-0 text-red-400" />
            </div>
          </Link>
        </Card>
      )}

      {dueTodayCount > 0 && overdueCount === 0 && (
        <Card className="border-amber-200 bg-gradient-to-r from-amber-50 to-amber-100">
          <Link href="/app/follow-ups" className="block p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-100">
                  <Clock size={18} className="text-amber-600" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-amber-800">
                    {dueTodayCount} follow-up{dueTodayCount === 1 ? '' : 's'} today
                  </p>
                  <p className="text-xs text-amber-600">Scheduled for today</p>
                </div>
              </div>
              <ChevronRight size={16} className="shrink-0 text-amber-400" />
            </div>
          </Link>
        </Card>
      )}

      {/* My stats */}
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <EmployeeStatCard
          title="My Enquiries"
          value={(figures?.enquiries ?? 0).toLocaleString('en-IN')}
          thisMonth={figures?.enquiriesThisMonth}
          icon={MessageSquare}
          color="blue"
        />
        <EmployeeStatCard
          title="My Registrations"
          value={(figures?.registrations ?? 0).toLocaleString('en-IN')}
          thisMonth={figures?.registrationsThisMonth}
          icon={UserPlus}
          color="emerald"
        />
        <EmployeeStatCard
          title="My Enrollments"
          value={(figures?.enrollments ?? 0).toLocaleString('en-IN')}
          thisMonth={figures?.enrollmentsThisMonth}
          icon={GraduationCap}
          color="purple"
        />
        <EmployeeStatCard
          title="Conversion Rate"
          value={`${figures?.conversionRate ?? 0}%`}
          icon={Target}
          color="teal"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="space-y-4 xl:col-span-8">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* Pending follow-ups */}
            <Card className="border-slate-200">
              <div className="p-4">
                <PanelHeader title="Follow-ups" href="/app/follow-ups" badge={pendingFollowUpCount} badgeTone="blue" />
                <div className="max-h-[220px] space-y-2 overflow-y-auto">
                  {followUps.isLoading ? (
                    <LoadingState rows={3} label="Loading follow-ups…" />
                  ) : pendingFollowUps.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-6 text-slate-400">
                      <CheckCircle2 size={24} className="mb-2 text-emerald-500" />
                      <p className="text-xs">All caught up!</p>
                    </div>
                  ) : (
                    pendingFollowUps.slice(0, 5).map((followUp) => (
                      <Link
                        key={followUp.id}
                        href={`/app/follow-ups/${followUp.id}`}
                        className="group flex items-center justify-between gap-2 rounded-lg p-2 transition-colors hover:bg-slate-50"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <ChannelIcon type={followUp.type} />
                          <div className="min-w-0">
                            <p className="truncate text-xs font-medium text-slate-800">{followUp.candidate}</p>
                            <p
                              className={cn(
                                'text-[10px]',
                                followUp.overdue
                                  ? 'font-medium text-red-600'
                                  : followUp.dueToday
                                    ? 'text-amber-600'
                                    : 'text-slate-500'
                              )}
                            >
                              {safeDay(followUp.scheduledFor, 'MMM d, h:mm a')}
                            </p>
                          </div>
                        </div>
                        <ChevronRight size={12} className="shrink-0 text-slate-300 group-hover:text-slate-500" />
                      </Link>
                    ))
                  )}
                </div>
              </div>
            </Card>

            {/* My tasks */}
            <Card className="border-slate-200">
              <div className="p-4">
                <PanelHeader title="My Tasks" href="/app/tasks" badge={tasks.data?.count ?? 0} badgeTone="purple" />
                <div className="max-h-[220px] space-y-2 overflow-y-auto">
                  {tasks.isLoading ? (
                    <LoadingState rows={3} label="Loading tasks…" />
                  ) : (tasks.data?.rows.length ?? 0) === 0 ? (
                    <div className="flex flex-col items-center justify-center py-6 text-slate-400">
                      <CheckCircle2 size={24} className="mb-2 text-emerald-500" />
                      <p className="text-xs">No open tasks!</p>
                    </div>
                  ) : (
                    tasks.data?.rows.map((task) => (
                      <Link
                        key={task.id}
                        href="/app/tasks"
                        className="group flex items-center justify-between gap-2 rounded-lg p-2 transition-colors hover:bg-slate-50"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <div
                            className={cn(
                              'h-8 w-1.5 shrink-0 rounded-full',
                              task.status === 'In Progress' ? 'bg-blue-500' : 'bg-slate-300'
                            )}
                          />
                          <div className="min-w-0">
                            <p className="truncate text-xs font-medium text-slate-800">{task.title}</p>
                            <p className="flex items-center gap-1 text-[10px] text-slate-500">
                              <Clock size={10} /> {task.dueDate ? safeDay(task.dueDate, 'MMM d') : 'No due date'}
                            </p>
                          </div>
                        </div>
                        <span
                          className={cn(
                            'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium',
                            task.status === 'In Progress'
                              ? 'bg-blue-100 text-blue-700'
                              : 'bg-slate-100 text-slate-600'
                          )}
                        >
                          {task.status}
                        </span>
                      </Link>
                    ))
                  )}
                </div>
              </div>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* Recent students */}
            <Card className="border-slate-200">
              <div className="p-4">
                <PanelHeader title="My Recent Students" href="/app/my-students" />
                <div className="max-h-[220px] space-y-2 overflow-y-auto">
                  {recentStudents.isLoading ? (
                    <LoadingState rows={3} label="Loading students…" />
                  ) : (recentStudents.data?.length ?? 0) === 0 ? (
                    <p className="py-6 text-center text-xs text-slate-400">No students yet</p>
                  ) : (
                    recentStudents.data?.slice(0, 5).map((student) => {
                      const tone =
                        student.kind === 'enquiry'
                          ? { badge: 'bg-blue-100 text-blue-700', avatar: 'from-blue-400 to-blue-600', label: 'Enquiry' }
                          : student.kind === 'enrollment'
                            ? { badge: 'bg-purple-100 text-purple-700', avatar: 'from-purple-400 to-purple-600', label: 'Enrolled' }
                            : { badge: 'bg-emerald-100 text-emerald-700', avatar: 'from-teal-400 to-teal-600', label: 'Registered' };

                      return (
                        <Link
                          key={student.key}
                          href={`/app/student-profile/${student.kind}/${student.id}`}
                          className="group flex items-center justify-between gap-2 rounded-lg p-2 transition-colors hover:bg-slate-50"
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <div
                              className={cn(
                                'flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-[10px] font-semibold text-white',
                                tone.avatar
                              )}
                            >
                              {student.name?.charAt(0)?.toUpperCase() || '?'}
                            </div>
                            <div className="min-w-0">
                              <p className="truncate text-xs font-medium text-slate-800">{student.name || 'Unknown'}</p>
                              <p className="truncate text-[10px] text-slate-500">{student.subtitle}</p>
                            </div>
                          </div>
                          <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium', tone.badge)}>
                            {tone.label}
                          </span>
                        </Link>
                      );
                    })
                  )}
                </div>
              </div>
            </Card>

            {/* My requests */}
            <Card className="border-slate-200">
              <div className="p-4">
                <PanelHeader title="My Requests" href="/app/my-requests" badge={myPendingRequests} badgeTone="purple" />
                <div className="max-h-[220px] space-y-2 overflow-y-auto">
                  {myRequests.isLoading ? (
                    <LoadingState rows={3} label="Loading requests…" />
                  ) : requestRows.length === 0 ? (
                    <p className="py-6 text-center text-xs text-slate-400">No recent requests</p>
                  ) : (
                    requestRows.map((req) => (
                      <div key={req.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 p-2">
                        <div className="flex min-w-0 items-center gap-2.5">
                          {/* Status is Title case on the wire: Pending | Approved | Rejected. */}
                          <div
                            className={cn(
                              'h-8 w-1.5 shrink-0 rounded-full',
                              req.status === 'Pending'
                                ? 'bg-amber-500'
                                : req.status === 'Approved'
                                  ? 'bg-emerald-500'
                                  : 'bg-red-500'
                            )}
                          />
                          <div className="min-w-0">
                            <p className="truncate text-xs font-medium text-slate-700">
                              {req.action} · {req.entity_name || req.entity_type}
                            </p>
                            <p className="text-[10px] text-slate-500">{safeDay(req.created_at)}</p>
                          </div>
                        </div>
                        <span
                          className={cn(
                            'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium',
                            req.status === 'Pending'
                              ? 'bg-amber-100 text-amber-700'
                              : req.status === 'Approved'
                                ? 'bg-emerald-100 text-emerald-700'
                                : 'bg-red-100 text-red-700'
                          )}
                        >
                          {req.status}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </Card>
          </div>
        </div>

        {/* Right sidebar */}
        <div className="space-y-4 xl:col-span-4">
          <Card className="border-slate-200">
            <div className="p-4">
              <h3 className="mb-3 text-sm font-semibold text-slate-800">Quick Actions</h3>
              <div className="grid grid-cols-2 gap-2">
                <TileAction href="/app/enquiries/new" icon={MessageSquare} label="Add Enquiry" tone="blue" />
                <TileAction href="/app/registrations/new" icon={UserPlus} label="Register" tone="emerald" />
                <TileAction href="/app/follow-ups" icon={Phone} label="Follow-ups" tone="purple" />
                <TileAction href="/app/tasks" icon={CheckCircle2} label="Tasks" tone="amber" />
              </div>
            </div>
          </Card>

          {(heldDocuments.data?.count ?? 0) > 0 && (
            <Card className="border-slate-200">
              <div className="p-4">
                <PanelHeader
                  title="Originals I Hold"
                  href="/app/documents"
                  badge={heldDocuments.data?.count ?? 0}
                  badgeTone="slate"
                />
                <div className="max-h-[150px] space-y-2 overflow-y-auto">
                  {heldDocuments.data?.rows.map((doc) => (
                    <div key={doc.id} className="flex items-center gap-2.5 rounded-lg bg-slate-50 p-2">
                      <FileText size={14} className="shrink-0 text-slate-500" />
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-slate-700">{doc.name}</p>
                        <p className="truncate text-[10px] text-slate-500">{doc.student_name || 'Unknown'}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          )}

          {/* Performance */}
          <Card className="border-slate-200 bg-gradient-to-br from-slate-800 to-slate-900">
            <div className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-white/90">My Performance</h3>
                <Star size={14} className="text-amber-400" />
              </div>
              <div className="space-y-3">
                <PerformanceRow label="Total Enquiries" value={(figures?.enquiries ?? 0).toLocaleString('en-IN')} />
                <PerformanceRow
                  label="Conversions"
                  value={(figures?.converted ?? 0).toLocaleString('en-IN')}
                  valueClass="text-emerald-400"
                />
                <PerformanceRow
                  label="This Month"
                  value={(figures?.enquiriesThisMonth ?? 0).toLocaleString('en-IN')}
                  valueClass="text-blue-400"
                />
                <div className="border-t border-white/10 pt-2">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] text-white/60">Conversion Rate</span>
                    <span className="text-sm font-bold text-white">{figures?.conversionRate ?? 0}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-teal-400"
                      style={{ width: `${Math.min(Math.max(figures?.conversionRate ?? 0, 0), 100)}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* MAIN PAGE COMPONENT                                                        */
/* -------------------------------------------------------------------------- */

export default function DashboardPage() {
  const user = useAuthStore((state) => state.user);

  /*
   * Five roles, not the old three. `MANAGER` no longer exists — it became
   * BRANCH_MANAGER — so the previous `user.role === 'MANAGER'` test could never
   * be true and every manager silently got the employee dashboard.
   *
   * `viewAnalytics` is exactly the set that gets aggregate figures
   * (DEV_ADMIN, COMPANY_ADMIN, HEAD_MANAGER, BRANCH_MANAGER); an EMPLOYEE gets
   * the personal view. Both read from role-scoped endpoints, so the split is
   * about which questions the page asks, not about hiding rows after the fact.
   */
  return can('viewAnalytics', user?.role) ? <AdminDashboard /> : <EmployeeDashboard />;
}

/* -------------------------------------------------------------------------- */
/* SHARED COMPONENTS                                                          */
/* -------------------------------------------------------------------------- */

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className={cn('h-2 w-2 rounded-sm', color)} />
      <span className="text-[10px] text-slate-500">{label}</span>
    </div>
  );
}

function PanelHeader({
  title,
  href,
  badge,
  badgeTone = 'blue',
}: {
  title: string;
  href: string;
  badge?: number;
  badgeTone?: 'blue' | 'purple' | 'slate';
}) {
  const tones = {
    blue: 'bg-blue-100 text-blue-700',
    purple: 'bg-purple-100 text-purple-700',
    slate: 'bg-slate-100 text-slate-600',
  };
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <h3 className="truncate text-sm font-semibold text-slate-800">{title}</h3>
        {badge !== undefined && badge > 0 && (
          <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-bold', tones[badgeTone])}>
            {badge.toLocaleString('en-IN')}
          </span>
        )}
      </div>
      <Link
        href={href}
        className="flex shrink-0 items-center gap-0.5 text-[10px] font-medium text-teal-600 hover:text-teal-700"
      >
        View all <ChevronRight size={12} />
      </Link>
    </div>
  );
}

/** Follow-up channel. `type` is a free CharField server-side, so this defaults. */
function ChannelIcon({ type }: { type: string }) {
  const isCall = type === 'Call';
  const isEmail = type === 'Email';
  return (
    <div
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
        isCall ? 'bg-blue-50 text-blue-600' : isEmail ? 'bg-purple-50 text-purple-600' : 'bg-green-50 text-green-600'
      )}
    >
      {isCall ? <Phone size={14} /> : isEmail ? <Mail size={14} /> : <MessageSquare size={14} />}
    </div>
  );
}

function PriorityDot({ priority }: { priority: string }) {
  return (
    <span
      title={`${priority} priority`}
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        priority === 'High' ? 'bg-red-500' : priority === 'Medium' ? 'bg-amber-500' : 'bg-slate-300'
      )}
    />
  );
}

function GlanceTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/10 p-2.5">
      <p className="mb-0.5 text-[10px] text-white/60">{label}</p>
      <p className="text-base font-bold text-white sm:text-lg">{value}</p>
    </div>
  );
}

function PerformanceRow({
  label,
  value,
  valueClass = 'text-white',
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-white/60">{label}</span>
      <span className={cn('text-sm font-bold', valueClass)}>{value}</span>
    </div>
  );
}

const ACTION_TONES = {
  teal: 'bg-teal-50 border-teal-200 hover:bg-teal-100 text-teal-600',
  emerald: 'bg-emerald-50 border-emerald-200 hover:bg-emerald-100 text-emerald-600',
  blue: 'bg-blue-50 border-blue-200 hover:bg-blue-100 text-blue-600',
  purple: 'bg-purple-50 border-purple-200 hover:bg-purple-100 text-purple-600',
  amber: 'bg-amber-50 border-amber-200 hover:bg-amber-100 text-amber-600',
} as const;

type ActionTone = keyof typeof ACTION_TONES;

function QuickAction({
  href,
  icon: Icon,
  label,
  tone,
  badge,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  tone: ActionTone;
  badge?: number;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'group flex items-center justify-between gap-2 rounded-lg border p-2.5 transition-colors',
        ACTION_TONES[tone]
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <Icon size={16} className="shrink-0" />
        <span className="truncate text-xs font-medium text-slate-700">{label}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {badge !== undefined && (
          <span className="rounded-full bg-purple-600 px-1.5 py-0.5 text-xs font-bold text-white">{badge}</span>
        )}
        <ChevronRight size={12} className="text-slate-400 group-hover:text-slate-600" />
      </div>
    </Link>
  );
}

function TileAction({
  href,
  icon: Icon,
  label,
  tone,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  tone: ActionTone;
}) {
  return (
    <Link
      href={href}
      className={cn('flex flex-col items-center justify-center rounded-lg border p-3 transition-colors', ACTION_TONES[tone])}
    >
      <Icon size={18} className="mb-1" />
      <span className="text-center text-[10px] font-medium">{label}</span>
    </Link>
  );
}

function CompactStatCard({
  title,
  value,
  icon: Icon,
  trend,
  color,
}: {
  title: string;
  value: string;
  icon: LucideIcon;
  trend: number;
  color: 'blue' | 'emerald' | 'purple' | 'amber';
}) {
  const colorStyles = {
    blue: { bg: 'bg-blue-50', icon: 'text-blue-600' },
    emerald: { bg: 'bg-emerald-50', icon: 'text-emerald-600' },
    purple: { bg: 'bg-purple-50', icon: 'text-purple-600' },
    amber: { bg: 'bg-amber-50', icon: 'text-amber-600' },
  };
  const styles = colorStyles[color];
  const rising = trend >= 0;

  return (
    <Card className="border-slate-200 transition-shadow hover:shadow-md">
      <CardContent className="p-3 sm:p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="mb-1 truncate text-[11px] font-medium text-slate-500">{title}</p>
            <h3 className="text-lg font-bold text-slate-900 sm:text-xl">{value}</h3>
          </div>
          <div className={cn('shrink-0 rounded-lg p-2', styles.bg)}>
            <Icon size={18} className={styles.icon} />
          </div>
        </div>
        {/* Computed by the backend from real prior-month counts. */}
        <div className="mt-2 flex items-center gap-1.5">
          {rising ? (
            <ArrowUpRight size={12} className="shrink-0 text-emerald-500" />
          ) : (
            <ArrowDownRight size={12} className="shrink-0 text-red-500" />
          )}
          <span className={cn('text-[10px] font-semibold', rising ? 'text-emerald-600' : 'text-red-500')}>
            {rising ? '+' : ''}
            {trend}%
          </span>
          <span className="truncate text-[10px] text-slate-400">vs last month</span>
        </div>
      </CardContent>
    </Card>
  );
}

function EmployeeStatCard({
  title,
  value,
  thisMonth,
  icon: Icon,
  color,
}: {
  title: string;
  value: string;
  thisMonth?: number;
  icon: LucideIcon;
  color: 'blue' | 'emerald' | 'purple' | 'teal';
}) {
  const colorStyles = {
    blue: { bg: 'bg-blue-50', icon: 'text-blue-600' },
    emerald: { bg: 'bg-emerald-50', icon: 'text-emerald-600' },
    purple: { bg: 'bg-purple-50', icon: 'text-purple-600' },
    teal: { bg: 'bg-teal-50', icon: 'text-teal-600' },
  };
  const styles = colorStyles[color];

  return (
    <Card className="border-slate-200 transition-shadow hover:shadow-md">
      <CardContent className="p-3 sm:p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="mb-1 truncate text-[11px] font-medium text-slate-500">{title}</p>
            <h3 className="text-lg font-bold text-slate-900 sm:text-xl">{value}</h3>
          </div>
          <div className={cn('shrink-0 rounded-lg p-2', styles.bg)}>
            <Icon size={18} className={styles.icon} />
          </div>
        </div>
        {thisMonth !== undefined && (
          <div className="mt-2 flex items-center gap-1.5">
            <span className="text-[10px] font-medium text-teal-600">+{thisMonth} this month</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ActionItem({
  href,
  icon: Icon,
  label,
  count,
  note,
  color,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  count: number;
  note?: string;
  color: 'amber' | 'purple' | 'blue';
}) {
  const colorStyles = {
    amber: 'bg-amber-50 border-amber-200 hover:bg-amber-100',
    purple: 'bg-purple-50 border-purple-200 hover:bg-purple-100',
    blue: 'bg-blue-50 border-blue-200 hover:bg-blue-100',
  };
  const iconColors = { amber: 'text-amber-600', purple: 'text-purple-600', blue: 'text-blue-600' };
  const badgeColors = { amber: 'bg-amber-600', purple: 'bg-purple-600', blue: 'bg-blue-600' };

  return (
    <Link
      href={href}
      className={cn(
        'group flex items-center justify-between gap-2 rounded-lg border p-2.5 transition-colors',
        colorStyles[color]
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <Icon size={16} className={cn('shrink-0', iconColors[color])} />
        <div className="min-w-0">
          <span className="block truncate text-xs font-medium text-slate-700">{label}</span>
          {note && <span className="block truncate text-[10px] text-slate-500">{note}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <span
          className={cn(
            'rounded-full px-1.5 py-0.5 text-xs font-bold',
            count > 0 ? cn(badgeColors[color], 'text-white') : 'bg-slate-200 text-slate-500'
          )}
        >
          {count.toLocaleString('en-IN')}
        </span>
        <ChevronRight size={12} className="text-slate-400 group-hover:text-slate-600" />
      </div>
    </Link>
  );
}
