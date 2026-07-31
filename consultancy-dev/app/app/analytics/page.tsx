'use client';

import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Building2, GraduationCap, Plane, TrendingUp, UserPlus, Users, Wallet } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states';
import { RoleRoute } from '@/components/rbac/RoleGate';
import { CAN } from '@/components/rbac/roles';
import { apiClient } from '@/lib/apiClient';
import type {
  AnalyticsFunnel,
  AnalyticsOverview,
  BranchAnalyticsRow,
  RevenuePoint,
  SourceAnalyticsRow,
  VisaPipeline,
} from '@/lib/apiClient';

const FUNNEL_COLORS = ['#0d9488', '#14b8a6', '#2dd4bf', '#5eead4'];

const VISA_STAGE_COLORS: Record<string, string> = {
  Documents: '#94a3b8',
  Applied: '#60a5fa',
  Biometrics: '#818cf8',
  Interview: '#a78bfa',
  Decision: '#fbbf24',
  Approved: '#34d399',
  Rejected: '#f87171',
};

const TOOLTIP_STYLE = {
  backgroundColor: '#ffffff',
  borderColor: '#e2e8f0',
  borderRadius: '8px',
  fontSize: '12px',
  boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)',
} as const;

const AXIS_TICK = { fill: '#64748b', fontSize: 11 } as const;

function formatCurrency(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value);
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function Kpi({
  label,
  value,
  icon: Icon,
  accent,
  hint,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
  hint?: string;
}) {
  return (
    <Card className="border-slate-200">
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-1 truncate text-xl font-bold text-slate-900 sm:text-2xl">{value}</p>
            {hint && <p className="mt-0.5 truncate text-xs text-slate-500">{hint}</p>}
          </div>
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${accent}`}>
            <Icon className="h-4 w-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Lets a recharts chart shrink below its intrinsic width on small screens. */
function ChartFrame({ children, height = 280 }: { children: React.ReactElement; height?: number }) {
  return (
    <div className="w-full min-w-0" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

function SectionCard({
  title,
  icon: Icon,
  iconClass,
  gradient,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  iconClass: string;
  gradient: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="border-slate-200">
      <CardHeader className={`border-b border-slate-100 ${gradient}`}>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base font-semibold sm:text-lg font-heading">{title}</CardTitle>
          <Icon className={`h-5 w-5 shrink-0 ${iconClass}`} />
        </div>
      </CardHeader>
      <CardContent className="pt-6">{children}</CardContent>
    </Card>
  );
}

function AnalyticsPage() {
  const [months, setMonths] = useState(6);

  const [overviewQuery, funnelQuery, revenueQuery, branchesQuery, visaQuery, sourcesQuery] = useQueries({
    queries: [
      { queryKey: ['analytics', 'overview'], queryFn: apiClient.analytics.getOverview, staleTime: 60_000 },
      { queryKey: ['analytics', 'funnel'], queryFn: apiClient.analytics.getFunnel, staleTime: 60_000 },
      {
        queryKey: ['analytics', 'revenue', months],
        queryFn: () => apiClient.analytics.getRevenue(months),
        staleTime: 60_000,
      },
      { queryKey: ['analytics', 'branches'], queryFn: apiClient.analytics.getBranches, staleTime: 60_000 },
      { queryKey: ['analytics', 'visa'], queryFn: apiClient.analytics.getVisaPipeline, staleTime: 60_000 },
      { queryKey: ['analytics', 'sources'], queryFn: apiClient.analytics.getSources, staleTime: 60_000 },
    ],
  });

  const overview = overviewQuery.data as AnalyticsOverview | undefined;
  const funnel = funnelQuery.data as AnalyticsFunnel | undefined;
  const revenue = (revenueQuery.data ?? []) as RevenuePoint[];
  const branches = (branchesQuery.data ?? []) as BranchAnalyticsRow[];
  const visa = visaQuery.data as VisaPipeline | undefined;
  const sources = (sourcesQuery.data ?? []) as SourceAnalyticsRow[];

  const allQueries = [overviewQuery, funnelQuery, revenueQuery, branchesQuery, visaQuery, sourcesQuery];
  const isLoading = allQueries.some((query) => query.isLoading);
  const firstError = allQueries.find((query) => query.isError)?.error;
  const refetchAll = () => allQueries.forEach((query) => void query.refetch());

  const header = (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-slate-900 font-heading">Analytics</h1>
        <p className="mt-1 text-sm text-slate-600 font-body">
          Conversion, revenue, branch and counselor performance
        </p>
      </div>
      <Select value={String(months)} onValueChange={(value) => setMonths(Number(value))}>
        <SelectTrigger className="h-10 w-full bg-white sm:w-44" aria-label="Revenue period">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="3">Last 3 months</SelectItem>
          <SelectItem value="6">Last 6 months</SelectItem>
          <SelectItem value="12">Last 12 months</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );

  if (firstError) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState error={firstError} onRetry={refetchAll} />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        {header}
        <LoadingState rows={6} label="Loading analytics" />
      </div>
    );
  }

  const revenueTotal = revenue.reduce((sum, point) => sum + point.revenue, 0);
  const funnelStages = funnel?.stages ?? [];
  const visaStages = visa?.pipeline ?? [];

  return (
    <div className="space-y-6">
      {header}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Kpi
          label="Enquiries"
          value={formatCompact(overview?.enquiries ?? 0)}
          icon={Users}
          accent="bg-blue-50 text-blue-600"
          hint={`${overview?.enquiriesThisMonth ?? 0} this month`}
        />
        <Kpi
          label="Registrations"
          value={formatCompact(overview?.registrations ?? 0)}
          icon={UserPlus}
          accent="bg-green-50 text-green-600"
        />
        <Kpi
          label="Enrollments"
          value={formatCompact(overview?.enrollments ?? 0)}
          icon={GraduationCap}
          accent="bg-purple-50 text-purple-600"
          hint={`${overview?.conversionRate ?? 0}% conversion`}
        />
        <Kpi
          label="Revenue this month"
          value={formatCurrency(overview?.revenueThisMonth ?? 0)}
          icon={Wallet}
          accent="bg-teal-50 text-teal-600"
          hint={
            overview && overview.revenueGrowth !== 0
              ? `${overview.revenueGrowth > 0 ? '+' : ''}${overview.revenueGrowth}% vs last month`
              : undefined
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <SectionCard
          title="Conversion funnel"
          icon={TrendingUp}
          iconClass="text-teal-600"
          gradient="bg-gradient-to-r from-teal-50 to-white"
        >
          {funnelStages.length === 0 ? (
            <EmptyState title="No enquiries yet" description="The funnel fills in once enquiries are logged." />
          ) : (
            <>
              <ChartFrame height={260}>
                <BarChart data={funnelStages} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
                  <XAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
                  <YAxis
                    type="category"
                    dataKey="stage"
                    width={96}
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value: number) => [value, 'Records']} />
                  <Bar dataKey="count" radius={[0, 6, 6, 0]} maxBarSize={34}>
                    {funnelStages.map((entry, index) => (
                      <Cell key={entry.stage} fill={FUNNEL_COLORS[index % FUNNEL_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ChartFrame>

              {funnel && (
                <dl className="mt-4 grid grid-cols-1 gap-3 border-t border-slate-100 pt-4 sm:grid-cols-3">
                  <div>
                    <dt className="truncate text-xs text-slate-500">Enquiry → registration</dt>
                    <dd className="text-lg font-bold text-slate-900">{funnel.dropOff.enquiryToRegistration}%</dd>
                  </div>
                  <div>
                    <dt className="truncate text-xs text-slate-500">Registration → enrollment</dt>
                    <dd className="text-lg font-bold text-slate-900">{funnel.dropOff.registrationToEnrollment}%</dd>
                  </div>
                  <div>
                    <dt className="truncate text-xs text-slate-500">Enrollment → visa</dt>
                    <dd className="text-lg font-bold text-slate-900">{funnel.dropOff.enrollmentToVisa}%</dd>
                  </div>
                </dl>
              )}
            </>
          )}
        </SectionCard>

        <SectionCard
          title="Revenue over time"
          icon={Wallet}
          iconClass="text-green-600"
          gradient="bg-gradient-to-r from-green-50 to-white"
        >
          {revenueTotal === 0 ? (
            <EmptyState
              title="No revenue in this period"
              description="Successful payments appear here once they are recorded."
            />
          ) : (
            <>
              <ChartFrame height={300}>
                <AreaChart data={revenue} margin={{ left: -12, right: 8 }}>
                  <defs>
                    <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.7} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                  <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} />
                  <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={formatCompact} width={52} />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(value: number) => [formatCurrency(value), 'Revenue']}
                  />
                  <Area
                    type="monotone"
                    dataKey="revenue"
                    stroke="#10b981"
                    strokeWidth={2}
                    fill="url(#revenueFill)"
                    name="Revenue"
                  />
                </AreaChart>
              </ChartFrame>
              <p className="mt-3 border-t border-slate-100 pt-3 text-sm text-slate-600">
                Total over {months} months:{' '}
                <span className="font-semibold text-slate-900">{formatCurrency(revenueTotal)}</span>
              </p>
            </>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="Branch comparison"
        icon={Building2}
        iconClass="text-blue-600"
        gradient="bg-gradient-to-r from-blue-50 to-white"
      >
        {branches.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="No branches to compare"
            description="Create branches and assign records to them to see this breakdown."
          />
        ) : (
          <>
            <ChartFrame height={300}>
              <BarChart data={branches} margin={{ left: -12, right: 8, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis
                  dataKey="name"
                  tick={AXIS_TICK}
                  tickLine={false}
                  axisLine={false}
                  interval={0}
                  height={52}
                  angle={-25}
                  textAnchor="end"
                />
                <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="enquiries" name="Enquiries" fill="#0d9488" radius={[4, 4, 0, 0]} maxBarSize={28} />
                <Bar dataKey="registrations" name="Registrations" fill="#60a5fa" radius={[4, 4, 0, 0]} maxBarSize={28} />
                <Bar dataKey="enrollments" name="Enrollments" fill="#a78bfa" radius={[4, 4, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ChartFrame>

            <div className="mt-6 overflow-x-auto">
              <table className="w-full min-w-[600px] text-sm">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase text-slate-700">Branch</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase text-slate-700">Staff</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase text-slate-700">Enquiries</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase text-slate-700">Enrolled</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase text-slate-700">Rate</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase text-slate-700">Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {branches.map((branch) => (
                    <tr key={branch.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2.5">
                        <p className="font-medium text-slate-900">{branch.name}</p>
                        {branch.city && <p className="text-xs text-slate-500">{branch.city}</p>}
                      </td>
                      <td className="px-3 py-2.5 text-right text-slate-600">{branch.staff}</td>
                      <td className="px-3 py-2.5 text-right text-slate-600">{branch.enquiries}</td>
                      <td className="px-3 py-2.5 text-right text-slate-600">{branch.enrollments}</td>
                      <td className="px-3 py-2.5 text-right font-semibold text-teal-700">{branch.conversionRate}%</td>
                      <td className="px-3 py-2.5 text-right font-medium text-slate-900">
                        {formatCurrency(branch.revenue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </SectionCard>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <SectionCard
          title="Visa pipeline"
          icon={Plane}
          iconClass="text-amber-600"
          gradient="bg-gradient-to-r from-amber-50 to-white"
        >
          {visaStages.length === 0 || (visa?.total ?? 0) === 0 ? (
            <EmptyState
              icon={Plane}
              title="No visa applications tracked"
              description="Applications appear here as they move through the pipeline."
            />
          ) : (
            <ChartFrame height={300}>
              <BarChart data={visaStages} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
                <XAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
                <YAxis type="category" dataKey="stage" width={88} tick={AXIS_TICK} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value: number) => [value, 'Applications']} />
                <Bar dataKey="count" radius={[0, 6, 6, 0]} maxBarSize={26}>
                  {visaStages.map((entry) => (
                    <Cell key={entry.stage} fill={VISA_STAGE_COLORS[entry.stage] ?? '#94a3b8'} />
                  ))}
                </Bar>
              </BarChart>
            </ChartFrame>
          )}
        </SectionCard>

        <SectionCard
          title="Lead sources"
          icon={TrendingUp}
          iconClass="text-purple-600"
          gradient="bg-gradient-to-r from-purple-50 to-white"
        >
          {sources.length === 0 ? (
            <EmptyState
              icon={TrendingUp}
              title="No lead source data"
              description="Tag enquiries with a source to compare where your best leads come from."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[380px] text-sm">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase text-slate-700">Source</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase text-slate-700">Leads</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase text-slate-700">Converted</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase text-slate-700">Rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {[...sources]
                    .sort((a, b) => b.conversionRate - a.conversionRate)
                    .map((source) => (
                      <tr key={source.source} className="hover:bg-slate-50">
                        <td className="px-3 py-2.5 font-medium text-slate-900">{source.source}</td>
                        <td className="px-3 py-2.5 text-right text-slate-600">{source.total}</td>
                        <td className="px-3 py-2.5 text-right text-slate-600">{source.converted}</td>
                        <td className="px-3 py-2.5 text-right font-semibold text-teal-700">
                          {source.conversionRate}%
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

export default function AnalyticsRoute() {
  return (
    <RoleRoute allow={CAN.viewAnalytics}>
      <AnalyticsPage />
    </RoleRoute>
  );
}
