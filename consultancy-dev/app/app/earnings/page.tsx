'use client';

import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/store/authStore';
import { apiClient, fetchAllPages, type RevenuePoint } from '@/lib/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState, LoadingState } from '@/components/common/states';
import { TrendingUp, DollarSign, Users, Calendar, ArrowUpRight, ArrowDownRight, Building, CreditCard } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell, Legend } from 'recharts';
import { cn } from '@/lib/utils';
import type { Company, Plan, Subscription, SubscriptionStatus } from '@/lib/types';

/**
 * Earnings.
 *
 * MONEY IS NEVER SUMMED OVER ONE PAGE. The company view reads
 * `analytics/overview/` and `analytics/revenue/`, which the backend computes
 * over the whole collection. The platform view has no analytics endpoint for
 * subscription revenue, so it walks every page of `subscriptions/`, `plans/`
 * and `companies/` with `fetchAllPages` — a total from 25 of 200 rows is a
 * wrong number that looks right.
 */

const PLAN_COLORS = ['#0d9488', '#10b981', '#8b5cf6', '#f59e0b', '#3b82f6', '#ec4899'];
const SOURCE_COLORS = ['#0d9488', '#10b981', '#8b5cf6', '#f59e0b'];

export default function EarningsPage() {
  const { user } = useAuthStore();
  const isDevAdmin = user?.role === 'DEV_ADMIN';
  return isDevAdmin ? <DevAdminEarnings /> : <CompanyAdminEarnings />;
}

/* -------------------------------------------------------------------------- */
/* Shared month helpers                                                        */
/* -------------------------------------------------------------------------- */

/** `YYYY-MM` for a date string, or null when unparseable. */
function monthKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}`;
}

/** Trailing `months` buckets ending with the current month, oldest first. */
function monthBuckets(months: number): Array<{ key: string; label: string }> {
  const now = new Date();
  return Array.from({ length: months }, (_, index) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (months - 1 - index), 1);
    return {
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }),
    };
  });
}

function percentChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/* -------------------------------------------------------------------------- */
/* Platform (DEV_ADMIN) — subscription revenue                                 */
/* -------------------------------------------------------------------------- */

/**
 * A subscription bills while it is ACTIVE or PAST_DUE. A TRIALING company is a
 * live subscription but is not paying yet, so it counts in the seat pie and
 * NOT in revenue.
 */
function isBilling(status: SubscriptionStatus): boolean {
  return status === 'ACTIVE' || status === 'PAST_DUE';
}

function isLive(status: SubscriptionStatus): boolean {
  return status === 'ACTIVE' || status === 'PAST_DUE' || status === 'TRIALING';
}

interface PlanSlice {
  name: string;
  /** Live subscriptions on this plan. */
  value: number;
  /** Monthly recurring revenue from billing subscriptions on this plan. */
  revenue: number;
  color: string;
  /** Recharts' `ChartDataInput` requires rows to be indexable. */
  [key: string]: string | number;
}

/** One stacked bar: `month` plus one numeric key per plan name. */
type MonthlyPlanRow = Record<string, string | number>;

interface PlatformEarnings {
  subscriptionsByPlan: PlanSlice[];
  monthlyRevenue: MonthlyPlanRow[];
  planNames: string[];
  currentMonth: {
    growthRate: number;
    activeCompanies: number;
    newSignups: number;
    churnRate: number;
    churnImprovement: number;
  };
}

async function loadPlatformEarnings(): Promise<PlatformEarnings> {
  const [subscriptions, plans, companies] = await Promise.all([
    fetchAllPages<Subscription, Subscription>('subscriptions/', (s) => s, {}, 200, 20),
    fetchAllPages<Plan, Plan>('plans/', (p) => p, { ordering: 'sort_order' }, 200, 5),
    fetchAllPages<Company, Company>('companies/', (c) => c, {}, 200, 20),
  ]);

  const priceByPlan = new Map<number, number>(plans.map((p) => [p.id, Number(p.price_monthly) || 0]));
  const nameByPlan = new Map<number, string>(plans.map((p) => [p.id, p.name]));
  const planNames = plans.map((p) => p.name);

  const subscriptionsByPlan: PlanSlice[] = plans.map((plan, index) => {
    const onPlan = subscriptions.filter((s) => s.plan === plan.id);
    return {
      name: plan.name,
      value: onPlan.filter((s) => isLive(s.status)).length,
      revenue: onPlan.filter((s) => isBilling(s.status)).length * (priceByPlan.get(plan.id) ?? 0),
      color: PLAN_COLORS[index % PLAN_COLORS.length],
    };
  });

  // Historical MRR. The wire carries only the CURRENT status, so a month is
  // credited when the subscription had started and had not yet been cancelled;
  // past status transitions are not recoverable from this API.
  const buckets = monthBuckets(12);
  const monthlyRevenue: MonthlyPlanRow[] = buckets.map((bucket) => {
    const row: MonthlyPlanRow = { month: bucket.label };
    for (const name of planNames) row[name] = 0;

    for (const sub of subscriptions) {
      const started = monthKey(sub.current_period_start);
      if (started === null || started > bucket.key) continue;
      const cancelled = monthKey(sub.cancelled_at);
      if (cancelled !== null && cancelled <= bucket.key) continue;

      const planName = nameByPlan.get(sub.plan);
      if (planName === undefined) continue;
      row[planName] = (Number(row[planName]) || 0) + (priceByPlan.get(sub.plan) ?? 0);
    }
    return row;
  });

  const sumRow = (row: MonthlyPlanRow | undefined): number =>
    row === undefined ? 0 : planNames.reduce((total, name) => total + (Number(row[name]) || 0), 0);

  const thisMonthKey = buckets[buckets.length - 1].key;
  const previousMonthKey = buckets[buckets.length - 2]?.key ?? thisMonthKey;

  const cancelledThisMonth = subscriptions.filter((s) => monthKey(s.cancelled_at) === thisMonthKey).length;
  const cancelledLastMonth = subscriptions.filter((s) => monthKey(s.cancelled_at) === previousMonthKey).length;
  const liveCount = subscriptions.filter((s) => isLive(s.status)).length;
  const churnBase = liveCount + cancelledThisMonth;
  const churnRate = churnBase === 0 ? 0 : Math.round((cancelledThisMonth / churnBase) * 1000) / 10;
  const previousChurnBase = liveCount + cancelledThisMonth + cancelledLastMonth;
  const previousChurnRate =
    previousChurnBase === 0 ? 0 : Math.round((cancelledLastMonth / previousChurnBase) * 1000) / 10;

  return {
    subscriptionsByPlan,
    monthlyRevenue,
    planNames,
    currentMonth: {
      growthRate: percentChange(sumRow(monthlyRevenue.at(-1)), sumRow(monthlyRevenue.at(-2))),
      activeCompanies: companies.filter((c) => c.is_active).length,
      newSignups: companies.filter((c) => monthKey(c.created_at) === thisMonthKey).length,
      churnRate,
      churnImprovement: Math.round((previousChurnRate - churnRate) * 10) / 10,
    },
  };
}

function DevAdminEarnings() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['earnings-subscriptions'],
    queryFn: () => loadPlatformEarnings(),
  });

  if (isLoading) return <LoadingState rows={5} label="Loading earnings data…" />;
  if (isError || !data) {
    return <ErrorState error={error} onRetry={() => void refetch()} title="Could not load platform earnings" />;
  }

  const totalRevenue = data.subscriptionsByPlan.reduce((sum, plan) => sum + plan.revenue, 0);
  const totalSubscriptions = data.subscriptionsByPlan.reduce((sum, plan) => sum + plan.value, 0);

  return (
    <div className="space-y-6 lg:space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 font-heading">Platform Earnings</h1>
        <p className="text-sm text-slate-600 mt-1 font-body">Subscription revenue from all companies</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <Card className="border-slate-200 bg-gradient-to-br from-teal-50 to-white">
          <CardContent className="p-6">
            <div className="flex items-start justify-between mb-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-600 mb-1 font-body">Monthly Revenue</p>
                <h3 className="text-2xl font-bold text-slate-900 font-heading">₹{(totalRevenue / 1000).toFixed(0)}K</h3>
              </div>
              <div className="bg-teal-100 p-3 rounded-xl shrink-0">
                <DollarSign size={24} className="text-teal-600" />
              </div>
            </div>
            <div className="flex flex-wrap items-center text-xs font-body">
              <span
                className={cn(
                  'font-semibold flex items-center gap-1',
                  data.currentMonth.growthRate >= 0 ? 'text-green-600' : 'text-red-600'
                )}
              >
                {data.currentMonth.growthRate >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                {Math.abs(data.currentMonth.growthRate)}%
              </span>
              <span className="text-slate-400 ml-2">vs last month</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 bg-gradient-to-br from-blue-50 to-white">
          <CardContent className="p-6">
            <div className="flex items-start justify-between mb-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-600 mb-1 font-body">Active Companies</p>
                <h3 className="text-2xl font-bold text-slate-900 font-heading">{data.currentMonth.activeCompanies}</h3>
              </div>
              <div className="bg-blue-100 p-3 rounded-xl shrink-0">
                <Building size={24} className="text-blue-600" />
              </div>
            </div>
            <div className="flex flex-wrap items-center text-xs font-body">
              <span className="text-green-600 font-semibold flex items-center gap-1">
                <ArrowUpRight size={14} /> +{data.currentMonth.newSignups} new
              </span>
              <span className="text-slate-400 ml-2">this month</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 bg-gradient-to-br from-purple-50 to-white">
          <CardContent className="p-6">
            <div className="flex items-start justify-between mb-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-600 mb-1 font-body">Total Subscriptions</p>
                <h3 className="text-2xl font-bold text-slate-900 font-heading">{totalSubscriptions}</h3>
              </div>
              <div className="bg-purple-100 p-3 rounded-xl shrink-0">
                <CreditCard size={24} className="text-purple-600" />
              </div>
            </div>
            <div className="flex items-center text-xs font-body">
              <span className="text-slate-600">Across all plans</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 bg-gradient-to-br from-orange-50 to-white">
          <CardContent className="p-6">
            <div className="flex items-start justify-between mb-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-600 mb-1 font-body">Churn Rate</p>
                <h3 className="text-2xl font-bold text-slate-900 font-heading">{data.currentMonth.churnRate}%</h3>
              </div>
              <div className="bg-orange-100 p-3 rounded-xl shrink-0">
                <TrendingUp size={24} className="text-orange-600" />
              </div>
            </div>
            <div className="flex flex-wrap items-center text-xs font-body">
              <span
                className={cn(
                  'font-semibold flex items-center gap-1',
                  data.currentMonth.churnImprovement >= 0 ? 'text-green-600' : 'text-red-600'
                )}
              >
                {data.currentMonth.churnImprovement >= 0 ? <ArrowDownRight size={14} /> : <ArrowUpRight size={14} />}
                {Math.abs(data.currentMonth.churnImprovement)}%
              </span>
              <span className="text-slate-400 ml-2">vs last month</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2 border-slate-200">
          <CardHeader className="bg-gradient-to-r from-teal-50 to-white border-b border-slate-100">
            <CardTitle className="text-lg font-semibold font-heading">Subscription Revenue by Plan</CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            {data.planNames.length === 0 ? (
              <p className="py-16 text-center text-sm text-slate-500 font-body">No plans configured yet.</p>
            ) : (
              <div className="h-[320px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.monthlyRevenue}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                    <XAxis dataKey="month" tick={{ fill: '#64748b', fontSize: 12 }} tickLine={false} axisLine={false} />
                    <YAxis
                      tick={{ fill: '#64748b', fontSize: 12 }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(value: number) => `₹${value / 1000}K`}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#ffffff', borderColor: '#e2e8f0', borderRadius: '8px', fontSize: '12px' }}
                      formatter={(value: number) => `₹${value.toLocaleString('en-IN')}`}
                    />
                    <Legend />
                    {data.planNames.map((name, index) => (
                      <Bar
                        key={name}
                        dataKey={name}
                        stackId="mrr"
                        fill={PLAN_COLORS[index % PLAN_COLORS.length]}
                        radius={index === data.planNames.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                        name={name}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-slate-200">
          <CardHeader className="bg-gradient-to-r from-purple-50 to-white border-b border-slate-100">
            <CardTitle className="text-lg font-semibold font-heading">Active Subscriptions</CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            {totalSubscriptions === 0 ? (
              <p className="py-16 text-center text-sm text-slate-500 font-body">No live subscriptions yet.</p>
            ) : (
              <div className="flex flex-col justify-center">
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie
                      data={data.subscriptionsByPlan}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={80}
                      paddingAngle={5}
                      dataKey="value"
                    >
                      {data.subscriptionsByPlan.map((entry) => (
                        <Cell key={entry.name} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value: number) => [`${value} companies`, '']} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="mt-4 space-y-2 font-body">
                  {data.subscriptionsByPlan.map((plan) => (
                    <div key={plan.name} className="flex items-center justify-between gap-2 text-xs">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: plan.color }} />
                        <span className="truncate text-slate-600">{plan.name}</span>
                      </div>
                      <div className="shrink-0 text-right">
                        <span className="font-semibold text-slate-900">{plan.value}</span>
                        <span className="ml-1 text-slate-400">
                          ({totalSubscriptions > 0 ? ((plan.value / totalSubscriptions) * 100).toFixed(0) : 0}%)
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Company view — business revenue                                             */
/* -------------------------------------------------------------------------- */

interface RevenueSourceSlice {
  name: string;
  value: number;
  color: string;
  /** Recharts' `ChartDataInput` requires rows to be indexable. */
  [key: string]: string | number;
}

interface MonthlyEarningsRow {
  month: string;
  revenue: number;
  /** Revenue less agent commissions — the only cost the API exposes. */
  profit: number;
}

interface BusinessEarnings {
  monthlyEarnings: MonthlyEarningsRow[];
  revenueBySource: RevenueSourceSlice[];
  currentMonth: {
    revenue: number;
    revenueGrowth: number;
    profit: number;
    profitGrowth: number;
    registrations: number;
    studentGrowth: number;
    avgDealSize: number;
    dealSizeChange: number;
  };
}

/** Only the registration date is needed to bucket a registration by month. */
interface RegistrationDateRow {
  registration_date: string;
}

const profitOf = (point: RevenuePoint | undefined): number =>
  point === undefined ? 0 : point.revenue - point.commissions;

async function loadBusinessEarnings(): Promise<BusinessEarnings> {
  const [overview, series, registrationDates] = await Promise.all([
    apiClient.analytics.getOverview(),
    apiClient.analytics.getRevenue(12),
    // No per-month registration analytics endpoint exists, so walk every page
    // rather than counting one page of 25.
    fetchAllPages<RegistrationDateRow, string>(
      'registrations/',
      (row) => row.registration_date,
      { ordering: '-created_at' },
      200,
      10
    ),
  ]);

  const thisMonth = series.at(-1);
  const lastMonth = series.at(-2);

  const buckets = monthBuckets(2);
  const registrationsThisMonth = registrationDates.filter((d) => monthKey(d) === buckets[1].key).length;
  const registrationsLastMonth = registrationDates.filter((d) => monthKey(d) === buckets[0].key).length;

  const avgDealSize =
    thisMonth && thisMonth.transactions > 0 ? Math.round(thisMonth.revenue / thisMonth.transactions) : 0;
  const previousAvgDealSize =
    lastMonth && lastMonth.transactions > 0 ? Math.round(lastMonth.revenue / lastMonth.transactions) : 0;

  const totals = series.reduce(
    (acc, point) => ({
      registrationFees: acc.registrationFees + point.registrationFees,
      enrollmentFees: acc.enrollmentFees + point.enrollmentFees,
      otherFees: acc.otherFees + point.otherFees,
      commissions: acc.commissions + point.commissions,
    }),
    { registrationFees: 0, enrollmentFees: 0, otherFees: 0, commissions: 0 }
  );

  return {
    monthlyEarnings: series.map((point) => ({
      month: point.label,
      revenue: point.revenue,
      profit: point.revenue - point.commissions,
    })),
    revenueBySource: [
      { name: 'Registration Fees', value: totals.registrationFees, color: SOURCE_COLORS[0] },
      { name: 'Enrollment Fees', value: totals.enrollmentFees, color: SOURCE_COLORS[1] },
      { name: 'Other Fees', value: totals.otherFees, color: SOURCE_COLORS[2] },
      { name: 'Commissions', value: totals.commissions, color: SOURCE_COLORS[3] },
    ].filter((slice) => slice.value > 0),
    currentMonth: {
      // `analytics/overview/` is authoritative for this month vs last month.
      revenue: overview.revenueThisMonth,
      revenueGrowth: overview.revenueGrowth,
      profit: profitOf(thisMonth),
      profitGrowth: percentChange(profitOf(thisMonth), profitOf(lastMonth)),
      registrations: registrationsThisMonth,
      studentGrowth: percentChange(registrationsThisMonth, registrationsLastMonth),
      avgDealSize,
      dealSizeChange: percentChange(avgDealSize, previousAvgDealSize),
    },
  };
}

function CompanyAdminEarnings() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['earnings-business'],
    queryFn: () => loadBusinessEarnings(),
  });

  if (isLoading) return <LoadingState rows={5} label="Loading earnings data…" />;
  if (isError || !data) {
    return <ErrorState error={error} onRetry={() => void refetch()} title="Could not load earnings" />;
  }

  const { currentMonth } = data;

  return (
    <div className="space-y-6 lg:space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 font-heading">Earnings &amp; Statistics</h1>
        <p className="text-sm text-slate-600 mt-1 font-body">Comprehensive financial overview and performance metrics</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <Card className="border-slate-200 bg-gradient-to-br from-teal-50 to-white">
          <CardContent className="p-6">
            <div className="flex items-start justify-between mb-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-600 mb-1 font-body">Revenue This Month</p>
                <h3 className="text-2xl font-bold text-slate-900 font-heading">₹{(currentMonth.revenue / 1000).toFixed(0)}K</h3>
              </div>
              <div className="bg-teal-100 p-3 rounded-xl shrink-0">
                <DollarSign size={24} className="text-teal-600" />
              </div>
            </div>
            <div className="flex flex-wrap items-center text-xs font-body">
              <span
                className={cn(
                  'font-semibold flex items-center gap-1',
                  currentMonth.revenueGrowth >= 0 ? 'text-green-600' : 'text-red-600'
                )}
              >
                {currentMonth.revenueGrowth >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                {Math.abs(currentMonth.revenueGrowth)}%
              </span>
              <span className="text-slate-400 ml-2">vs last month</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 bg-gradient-to-br from-green-50 to-white">
          <CardContent className="p-6">
            <div className="flex items-start justify-between mb-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-600 mb-1 font-body">Net of Commissions</p>
                <h3 className="text-2xl font-bold text-slate-900 font-heading">₹{(currentMonth.profit / 1000).toFixed(0)}K</h3>
              </div>
              <div className="bg-green-100 p-3 rounded-xl shrink-0">
                <TrendingUp size={24} className="text-green-600" />
              </div>
            </div>
            <div className="flex flex-wrap items-center text-xs font-body">
              <span
                className={cn(
                  'font-semibold flex items-center gap-1',
                  currentMonth.profitGrowth >= 0 ? 'text-green-600' : 'text-red-600'
                )}
              >
                {currentMonth.profitGrowth >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                {Math.abs(currentMonth.profitGrowth)}%
              </span>
              <span className="text-slate-400 ml-2">vs last month</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 bg-gradient-to-br from-purple-50 to-white">
          <CardContent className="p-6">
            <div className="flex items-start justify-between mb-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-600 mb-1 font-body">New Registrations</p>
                <h3 className="text-2xl font-bold text-slate-900 font-heading">{currentMonth.registrations}</h3>
              </div>
              <div className="bg-purple-100 p-3 rounded-xl shrink-0">
                <Users size={24} className="text-purple-600" />
              </div>
            </div>
            <div className="flex flex-wrap items-center text-xs font-body">
              <span
                className={cn(
                  'font-semibold flex items-center gap-1',
                  currentMonth.studentGrowth >= 0 ? 'text-green-600' : 'text-red-600'
                )}
              >
                {currentMonth.studentGrowth >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                {Math.abs(currentMonth.studentGrowth)}%
              </span>
              <span className="text-slate-400 ml-2">vs last month</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 bg-gradient-to-br from-blue-50 to-white">
          <CardContent className="p-6">
            <div className="flex items-start justify-between mb-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-600 mb-1 font-body">Avg. Deal Size</p>
                <h3 className="text-2xl font-bold text-slate-900 font-heading">
                  ₹{currentMonth.avgDealSize.toLocaleString('en-IN')}
                </h3>
              </div>
              <div className="bg-blue-100 p-3 rounded-xl shrink-0">
                <Calendar size={24} className="text-blue-600" />
              </div>
            </div>
            <div className="flex flex-wrap items-center text-xs font-body">
              <span
                className={cn(
                  'font-semibold flex items-center gap-1',
                  currentMonth.dealSizeChange >= 0 ? 'text-green-600' : 'text-red-600'
                )}
              >
                {currentMonth.dealSizeChange >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                {Math.abs(currentMonth.dealSizeChange)}%
              </span>
              <span className="text-slate-400 ml-2">vs last month</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2 border-slate-200">
          <CardHeader className="bg-gradient-to-r from-teal-50 to-white border-b border-slate-100">
            <CardTitle className="text-lg font-semibold font-heading">Revenue vs Commission-Adjusted Trend</CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            {data.monthlyEarnings.length === 0 ? (
              <p className="py-16 text-center text-sm text-slate-500 font-body">No revenue recorded yet.</p>
            ) : (
              <div className="h-[320px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.monthlyEarnings}>
                    <defs>
                      <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#0d9488" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#0d9488" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="colorProfit" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                    <XAxis dataKey="month" tick={{ fill: '#64748b', fontSize: 12 }} tickLine={false} axisLine={false} />
                    <YAxis
                      tick={{ fill: '#64748b', fontSize: 12 }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(value: number) => `₹${value / 1000}K`}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#ffffff', borderColor: '#e2e8f0', borderRadius: '8px', fontSize: '12px' }}
                      formatter={(value: number) => `₹${value.toLocaleString('en-IN')}`}
                    />
                    <Legend />
                    <Area type="monotone" dataKey="revenue" stroke="#0d9488" strokeWidth={2} fillOpacity={1} fill="url(#colorRevenue)" name="Revenue" />
                    <Area type="monotone" dataKey="profit" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#colorProfit)" name="Net of commissions" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-slate-200">
          <CardHeader className="bg-gradient-to-r from-blue-50 to-white border-b border-slate-100">
            <CardTitle className="text-lg font-semibold font-heading">Revenue Sources</CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            {data.revenueBySource.length === 0 ? (
              <p className="py-16 text-center text-sm text-slate-500 font-body">No revenue recorded yet.</p>
            ) : (
              <div className="flex flex-col justify-center">
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie
                      data={data.revenueBySource}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={80}
                      paddingAngle={5}
                      dataKey="value"
                    >
                      {data.revenueBySource.map((entry) => (
                        <Cell key={entry.name} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value: number) => `₹${value.toLocaleString('en-IN')}`} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="mt-4 space-y-2 font-body">
                  {data.revenueBySource.map((source) => (
                    <div key={source.name} className="flex items-center justify-between gap-2 text-xs">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: source.color }} />
                        <span className="truncate text-slate-600">{source.name}</span>
                      </div>
                      <span className="shrink-0 font-semibold text-slate-900">₹{(source.value / 1000).toFixed(0)}K</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
