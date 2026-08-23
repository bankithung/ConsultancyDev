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
  borderRadius: '6px',
  fontSize: '11px',
  padding: '6px 8px',
  boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)',
} as const;

/** Axis labels. 11px — the floor for a readable tick, and far under the 30px ceiling. */
const AXIS_TICK = { fill: '#64748b', fontSize: 11 } as const;

/**
 * Every region inside the panel is separated by a hairline rather than a gap.
 * `gap-px` over a slate background paints the 1px rules in BOTH axes, so the
 * same class works whether the grid is one column on a phone or two on a wide
 * screen — a `divide-x`/`divide-y` pair would draw a stray horizontal rule
 * between side-by-side cells, because it splits on child order, not position.
 */
const DIVIDED_GRID = 'grid gap-px bg-slate-100';

/** Numbers this page prints in columns; `tabular-nums` stops them jittering. */
const NUM = 'text-right tabular-nums';

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

/**
 * One KPI cell of the strip.
 *
 * No card of its own — the strip's hairlines already separate the four. The
 * value keeps `text-2xl` while the label drops to 11px, so the number stays
 * visually dominant even though the cell is barely half its old height.
 */
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
    <div className="flex items-start justify-between gap-2 bg-white p-3">
      <div className="min-w-0">
        <p className="truncate text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
        <p className="mt-0.5 truncate text-xl font-bold tabular-nums text-slate-900 sm:text-2xl">{value}</p>
        {hint && <p className="truncate text-[11px] text-slate-500">{hint}</p>}
      </div>
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${accent}`}>
        <Icon className="h-4 w-4" />
      </div>
    </div>
  );
}

/** Lets a recharts chart shrink below its intrinsic width on small screens. */
function ChartFrame({ children, height = 220 }: { children: React.ReactElement; height?: number }) {
  return (
    <div className="w-full min-w-0" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

/**
 * A region of the single panel: a tinted title bar and a body.
 *
 * Was a `<Card>`. Cards brought their own border, radius and shadow, which is
 * exactly what has to disappear for five blocks to read as one object — so the
 * region is now a plain column whose only edge is the hairline the parent grid
 * paints around it.
 */
function Region({
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
    <section className="flex min-w-0 flex-col bg-white">
      <div className={`flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 ${gradient}`}>
        <h2 className="truncate font-heading text-sm font-semibold text-slate-900">{title}</h2>
        <Icon className={`h-4 w-4 shrink-0 ${iconClass}`} />
      </div>
      <div className="min-w-0 flex-1 p-3">{children}</div>
    </section>
  );
}

function AnalyticsPage() {
  const [months, setMonths] = useState(6);

  const [overviewQuery, funnelQuery, revenueQuery, branchesQuery, visaQuery, sourcesQuery] = useQueries({
    queries: [
      { queryKey: ['analytics', 'overview'], queryFn: apiClient.analytics.getOverview, staleTime: 60_000 },
      { queryKey: ['analytics', 'funnel'], queryFn: apiClient.analytics.getFunnel, staleTime: 60_000 },
      /*
       * ONLY this query takes the range. `request.query_params` appears exactly
       * once in backend/core/analytics.py — `months` in `RevenueAnalytics`.
       * `OverviewAnalytics`, `FunnelAnalytics`, `BranchAnalytics`,
       * `VisaPipelineAnalytics` and `SourceAnalytics` read no query parameters
       * at all, and DRF discards unrecognised ones silently and answers 200, so
       * sending `?months=` to them would change nothing while the UI implied it
       * had. That is why the header control names the one series it drives
       * rather than presenting itself as a section-wide range.
       */
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

  /**
   * The panel's header row.
   *
   * No visible page title: the app shell's Topbar already prints "Analytics"
   * for this route (components/layout/Topbar.tsx — no PAGE_TITLES entry, so its
   * last-path-segment fallback produces it) and the sidebar marks the entry as
   * current. A third copy cost a block of vertical space and said nothing. The
   * `sr-only` h1 stays because that Topbar label is a <span>, not a heading —
   * without this the page would have NO heading for a screen reader to
   * navigate by, and it is invisible so nothing is duplicated on screen.
   *
   * The range control is labelled "Revenue range", not left bare. A naked
   * control in a panel header claims to govern the whole panel, and this one
   * does not: `months` is read by exactly ONE endpoint. See the note on the
   * revenue query.
   */
  const header = (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-slate-100 px-3 py-2">
      <h1 className="sr-only">Analytics</h1>
      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        Revenue range
      </span>
      <Select value={String(months)} onValueChange={(value) => setMonths(Number(value))}>
        <SelectTrigger className="h-8 w-full bg-white text-xs sm:w-40" aria-label="Revenue range">
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

  const shell = (children: React.ReactNode) => (
    <section className="overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
      {header}
      {children}
    </section>
  );

  if (firstError) {
    return shell(
      <div className="p-3">
        <ErrorState error={firstError} onRetry={refetchAll} />
      </div>,
    );
  }

  if (isLoading) {
    return shell(
      <div className="p-3">
        <LoadingState rows={6} label="Loading analytics" />
      </div>,
    );
  }

  const revenueTotal = revenue.reduce((sum, point) => sum + point.revenue, 0);
  const funnelStages = funnel?.stages ?? [];
  const visaStages = visa?.pipeline ?? [];

  return shell(
    <>
      {/* KPI strip */}
      <div className={`${DIVIDED_GRID} grid-cols-2 border-b border-slate-100 lg:grid-cols-4`}>
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

      {/* Funnel · Revenue */}
      <div className={`${DIVIDED_GRID} grid-cols-1 border-b border-slate-100 xl:grid-cols-2`}>
        <Region
          title="Conversion funnel"
          icon={TrendingUp}
          iconClass="text-teal-600"
          gradient="bg-gradient-to-r from-teal-50 to-white"
        >
          {funnelStages.length === 0 ? (
            <EmptyState title="No enquiries yet" description="The funnel fills in once enquiries are logged." />
          ) : (
            <>
              {/*
                Four categories at ~40px a row plus the axis. Shorter than this
                and the bars collide with their own labels.
              */}
              <ChartFrame height={190}>
                <BarChart data={funnelStages} layout="vertical" margin={{ left: 4, right: 12 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
                  <XAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
                  <YAxis
                    type="category"
                    dataKey="stage"
                    width={92}
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value: number) => [value, 'Records']} />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={26}>
                    {funnelStages.map((entry, index) => (
                      <Cell key={entry.stage} fill={FUNNEL_COLORS[index % FUNNEL_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ChartFrame>

              {funnel && (
                <dl className="mt-2 grid grid-cols-3 gap-2 border-t border-slate-100 pt-2">
                  <div className="min-w-0">
                    <dt className="truncate text-[11px] text-slate-500">Enquiry → reg.</dt>
                    <dd className="text-base font-bold tabular-nums text-slate-900">
                      {funnel.dropOff.enquiryToRegistration}%
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="truncate text-[11px] text-slate-500">Reg. → enrol.</dt>
                    <dd className="text-base font-bold tabular-nums text-slate-900">
                      {funnel.dropOff.registrationToEnrollment}%
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="truncate text-[11px] text-slate-500">Enrol. → visa</dt>
                    <dd className="text-base font-bold tabular-nums text-slate-900">
                      {funnel.dropOff.enrollmentToVisa}%
                    </dd>
                  </div>
                </dl>
              )}
            </>
          )}
        </Region>

        <Region
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
              <ChartFrame height={200}>
                <AreaChart data={revenue} margin={{ left: -14, right: 6, top: 4 }}>
                  <defs>
                    <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.7} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                  <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} />
                  <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={formatCompact} width={48} />
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
              <p className="mt-2 border-t border-slate-100 pt-2 text-xs text-slate-600">
                Total over {months} months:{' '}
                <span className="font-semibold tabular-nums text-slate-900">{formatCurrency(revenueTotal)}</span>
              </p>
            </>
          )}
        </Region>
      </div>

      {/* Branch comparison — full width, it carries a six-column table */}
      <div className="border-b border-slate-100">
        <Region
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
              {/*
                Kept taller than the other charts on purpose: the x-axis alone
                reserves 48px for angled branch names, so a 200px frame would
                leave the bars under 100px and make three series indistinguishable.
              */}
              <ChartFrame height={240}>
                <BarChart data={branches} margin={{ left: -14, right: 6, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                  <XAxis
                    dataKey="name"
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                    interval={0}
                    height={48}
                    angle={-25}
                    textAnchor="end"
                  />
                  <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ fontSize: 11 }} height={24} />
                  <Bar dataKey="enquiries" name="Enquiries" fill="#0d9488" radius={[3, 3, 0, 0]} maxBarSize={24} />
                  <Bar dataKey="registrations" name="Registrations" fill="#60a5fa" radius={[3, 3, 0, 0]} maxBarSize={24} />
                  <Bar dataKey="enrollments" name="Enrollments" fill="#a78bfa" radius={[3, 3, 0, 0]} maxBarSize={24} />
                </BarChart>
              </ChartFrame>

              <div className="mt-3 overflow-x-auto rounded-md border border-slate-200">
                <table className="w-full min-w-[600px] text-[13px]">
                  <thead className="border-b border-slate-200 bg-slate-50">
                    <tr>
                      <th className="px-2.5 py-1.5 text-left text-[11px] font-semibold uppercase text-slate-700">Branch</th>
                      <th className={`px-2.5 py-1.5 text-[11px] font-semibold uppercase text-slate-700 ${NUM}`}>Staff</th>
                      <th className={`px-2.5 py-1.5 text-[11px] font-semibold uppercase text-slate-700 ${NUM}`}>Enquiries</th>
                      <th className={`px-2.5 py-1.5 text-[11px] font-semibold uppercase text-slate-700 ${NUM}`}>Enrolled</th>
                      <th className={`px-2.5 py-1.5 text-[11px] font-semibold uppercase text-slate-700 ${NUM}`}>Rate</th>
                      <th className={`px-2.5 py-1.5 text-[11px] font-semibold uppercase text-slate-700 ${NUM}`}>Revenue</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {branches.map((branch) => (
                      <tr key={branch.id} className="hover:bg-slate-50">
                        <td className="px-2.5 py-1.5">
                          <p className="font-medium leading-tight text-slate-900">{branch.name}</p>
                          {branch.city && <p className="text-[11px] leading-tight text-slate-500">{branch.city}</p>}
                        </td>
                        <td className={`px-2.5 py-1.5 text-slate-600 ${NUM}`}>{branch.staff}</td>
                        <td className={`px-2.5 py-1.5 text-slate-600 ${NUM}`}>{branch.enquiries}</td>
                        <td className={`px-2.5 py-1.5 text-slate-600 ${NUM}`}>{branch.enrollments}</td>
                        <td className={`px-2.5 py-1.5 font-semibold text-teal-700 ${NUM}`}>{branch.conversionRate}%</td>
                        <td className={`px-2.5 py-1.5 font-medium text-slate-900 ${NUM}`}>
                          {formatCurrency(branch.revenue)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Region>
      </div>

      {/* Visa · Sources */}
      <div className={`${DIVIDED_GRID} grid-cols-1 xl:grid-cols-2`}>
        <Region
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
            /*
              Seven stages, so this one is sized off its data: ~28px a row plus
              the axis. Squeezing it to the funnel's height would overlap the
              stage names.
            */
            <ChartFrame height={Math.max(190, visaStages.length * 28 + 30)}>
              <BarChart data={visaStages} layout="vertical" margin={{ left: 4, right: 12 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
                <XAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
                <YAxis type="category" dataKey="stage" width={84} tick={AXIS_TICK} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value: number) => [value, 'Applications']} />
                <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={20}>
                  {visaStages.map((entry) => (
                    <Cell key={entry.stage} fill={VISA_STAGE_COLORS[entry.stage] ?? '#94a3b8'} />
                  ))}
                </Bar>
              </BarChart>
            </ChartFrame>
          )}
        </Region>

        <Region
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
            <div className="overflow-x-auto rounded-md border border-slate-200">
              <table className="w-full min-w-[340px] text-[13px]">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr>
                    <th className="px-2.5 py-1.5 text-left text-[11px] font-semibold uppercase text-slate-700">Source</th>
                    <th className={`px-2.5 py-1.5 text-[11px] font-semibold uppercase text-slate-700 ${NUM}`}>Leads</th>
                    <th className={`px-2.5 py-1.5 text-[11px] font-semibold uppercase text-slate-700 ${NUM}`}>Converted</th>
                    <th className={`px-2.5 py-1.5 text-[11px] font-semibold uppercase text-slate-700 ${NUM}`}>Rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {[...sources]
                    .sort((a, b) => b.conversionRate - a.conversionRate)
                    .map((source) => (
                      <tr key={source.source} className="hover:bg-slate-50">
                        <td className="px-2.5 py-1.5 font-medium text-slate-900">{source.source}</td>
                        <td className={`px-2.5 py-1.5 text-slate-600 ${NUM}`}>{source.total}</td>
                        <td className={`px-2.5 py-1.5 text-slate-600 ${NUM}`}>{source.converted}</td>
                        <td className={`px-2.5 py-1.5 font-semibold text-teal-700 ${NUM}`}>{source.conversionRate}%</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Region>
      </div>
    </>,
  );
}

export default function AnalyticsRoute() {
  return (
    <RoleRoute allow={CAN.viewAnalytics}>
      <AnalyticsPage />
    </RoleRoute>
  );
}
