'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient, fetchAllPages } from '@/lib/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ErrorState, LoadingState } from '@/components/common/states';
import { toast } from '@/store/toastStore';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts';
import { Download, TrendingUp, Calendar } from 'lucide-react';

/**
 * Reports.
 *
 * Every figure here is a TOTAL, so none of it may be reduced over a single
 * paginated page. Funnel and revenue come from the analytics endpoints (plain
 * APIViews, computed server-side over the whole collection); the monthly
 * enquiry histogram has no analytics endpoint, so it walks every page with
 * `fetchAllPages` rather than summing the first 25 rows.
 */

const TIME_RANGES = [
  { value: '30days', label: 'Last 30 Days', months: 1 },
  { value: '3months', label: 'Last 3 Months', months: 3 },
  { value: '6months', label: 'Last 6 Months', months: 6 },
  { value: '1year', label: 'Last Year', months: 12 },
] as const;

type TimeRangeValue = (typeof TIME_RANGES)[number]['value'];

interface ChartPoint {
  name: string;
  value: number;
}

interface ReportOverview {
  enquiriesPerMonth: ChartPoint[];
  conversions: ChartPoint[];
  revenue: ChartPoint[];
}

/** `YYYY-MM` key for a date, or null when the row carries no usable date. */
function monthKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}`;
}

/** The trailing `months` buckets ending with the current month, oldest first. */
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

/** Only the `date` field is needed to bucket an enquiry. */
interface EnquiryDateRow {
  date: string;
}

async function loadOverview(months: number): Promise<ReportOverview> {
  const [enquiryDates, funnel, revenueSeries] = await Promise.all([
    // Walks every page — a histogram built from one 25-row page would be wrong.
    fetchAllPages<EnquiryDateRow, string>('enquiries/', (row) => row.date, { ordering: '-created_at' }, 200, 10),
    apiClient.analytics.getFunnel(),
    apiClient.analytics.getRevenue(months),
  ]);

  const buckets = monthBuckets(months);
  const counts = new Map<string, number>(buckets.map((b) => [b.key, 0]));
  for (const date of enquiryDates) {
    const key = monthKey(date);
    if (key !== null && counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return {
    enquiriesPerMonth: buckets.map((b) => ({ name: b.label, value: counts.get(b.key) ?? 0 })),
    conversions: funnel.stages.map((stage) => ({ name: stage.stage, value: stage.count })),
    revenue: revenueSeries.slice(-months).map((point) => ({ name: point.label, value: point.revenue })),
  };
}

function toCsv(rows: string[][]): string {
  return rows
    .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
}

export default function ReportsPage() {
  const [timeRange, setTimeRange] = useState<TimeRangeValue>('6months');
  const months = TIME_RANGES.find((r) => r.value === timeRange)?.months ?? 6;

  const {
    data: reportData,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['reports', timeRange],
    queryFn: () => loadOverview(months),
  });

  const hasData = useMemo(() => {
    if (!reportData) return false;
    return (
      reportData.enquiriesPerMonth.some((p) => p.value > 0) ||
      reportData.conversions.some((p) => p.value > 0) ||
      reportData.revenue.some((p) => p.value > 0)
    );
  }, [reportData]);

  const handleExport = () => {
    if (!reportData) return;
    const rows: string[][] = [['Section', 'Label', 'Value']];
    for (const point of reportData.enquiriesPerMonth) rows.push(['Enquiries', point.name, String(point.value)]);
    for (const point of reportData.conversions) rows.push(['Funnel', point.name, String(point.value)]);
    for (const point of reportData.revenue) rows.push(['Revenue', point.name, String(point.value)]);

    const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `reports-${timeRange}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast.success('Report exported', 'The CSV has been downloaded.');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 font-heading">Reports &amp; Analytics</h1>
          <p className="text-sm text-slate-600 mt-1 font-body">Comprehensive insights into your consultancy performance</p>
        </div>
        <div className="flex gap-2">
          <Select value={timeRange} onValueChange={(value) => setTimeRange(value as TimeRangeValue)}>
            <SelectTrigger className="w-40 h-9 bg-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIME_RANGES.map((range) => (
                <SelectItem key={range.value} value={range.value}>
                  {range.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            onClick={handleExport}
            disabled={!reportData || isLoading}
          >
            <Download size={16} className="mr-2" /> Export
          </Button>
        </div>
      </div>

      {isLoading && <LoadingState rows={4} label="Loading reports…" />}

      {isError && <ErrorState error={error} onRetry={() => void refetch()} title="Could not load reports" />}

      {!isLoading && !isError && !hasData && (
        <Card className="border-slate-200">
          <CardContent className="py-16 text-center">
            <p className="text-sm font-semibold text-slate-900 font-heading">No activity in this period</p>
            <p className="mt-1 text-sm text-slate-500 font-body">
              Pick a longer time range, or start recording enquiries and payments.
            </p>
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && hasData && reportData && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="border-slate-200">
            <CardHeader className="bg-gradient-to-r from-teal-50 to-white border-b border-slate-100">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg font-semibold font-heading">Enquiries Trend</CardTitle>
                <TrendingUp className="h-5 w-5 text-teal-600" />
              </div>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="h-[280px] sm:h-[320px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={reportData.enquiriesPerMonth}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                    <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fill: '#64748b', fontSize: 12 }} />
                    <YAxis tickLine={false} axisLine={false} tick={{ fill: '#64748b', fontSize: 12 }} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#ffffff',
                        borderColor: '#e2e8f0',
                        borderRadius: '8px',
                        fontSize: '12px',
                        boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
                      }}
                    />
                    <Bar dataKey="value" fill="#0d9488" radius={[6, 6, 0, 0]} name="Enquiries" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card className="border-slate-200">
            <CardHeader className="bg-gradient-to-r from-blue-50 to-white border-b border-slate-100">
              <CardTitle className="text-lg font-semibold font-heading">Conversion Funnel</CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="h-[280px] sm:h-[320px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={reportData.conversions}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fill: '#64748b', fontSize: 12 }} />
                    <YAxis tickLine={false} axisLine={false} tick={{ fill: '#64748b', fontSize: 12 }} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#ffffff',
                        borderColor: '#e2e8f0',
                        borderRadius: '8px',
                        fontSize: '12px',
                      }}
                    />
                    <Area type="monotone" dataKey="value" stroke="#0d9488" fill="#0d9488" fillOpacity={0.2} strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2 border-slate-200">
            <CardHeader className="bg-gradient-to-r from-green-50 to-white border-b border-slate-100">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg font-semibold font-heading">Revenue Trend</CardTitle>
                <Calendar className="h-5 w-5 text-green-600" />
              </div>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="h-[280px] sm:h-[320px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={reportData.revenue}>
                    <defs>
                      <linearGradient id="colorRev" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.8} />
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0.1} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fill: '#64748b', fontSize: 12 }} />
                    <YAxis tickLine={false} axisLine={false} tick={{ fill: '#64748b', fontSize: 12 }} />
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#ffffff',
                        borderColor: '#e2e8f0',
                        borderRadius: '8px',
                        fontSize: '12px',
                      }}
                      formatter={(value: number) => [`₹${value.toLocaleString('en-IN')}`, 'Revenue']}
                    />
                    <Area type="monotone" dataKey="value" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#colorRev)" name="Revenue" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
