'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Edit, Plus, Target, TrendingUp, Trash2, Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Modal } from '@/components/common/Modal';
import { PaginationBar } from '@/components/common/PaginationBar';
import { EmptyState, ErrorBanner, ErrorState, InlineSpinner, LoadingState } from '@/components/common/states';
import { RoleRoute } from '@/components/rbac/RoleGate';
import { CAN } from '@/components/rbac/roles';
import { apiClient } from '@/lib/apiClient';
import { getApiFieldErrors } from '@/lib/api';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import type { LeadSource } from '@/lib/types';

const COLORS = ['#0d9488', '#10b981', '#8b5cf6', '#f59e0b', '#ef4444', '#3b82f6'];

const SOURCE_TYPES = ['Organic', 'Paid', 'Referral', 'Partner', 'Event', 'Other'] as const;

const TYPE_STYLE: Record<string, string> = {
  Paid: 'bg-orange-100 text-orange-700',
  Organic: 'bg-green-100 text-green-700',
  Referral: 'bg-blue-100 text-blue-700',
  Partner: 'bg-purple-100 text-purple-700',
  Event: 'bg-teal-100 text-teal-700',
};

interface SourceForm {
  name: string;
  type: string;
  isActive: boolean;
}

const EMPTY_FORM: SourceForm = { name: '', type: 'Organic', isActive: true };

function LeadSourcesPage() {
  const queryClient = useQueryClient();

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editing, setEditing] = useState<LeadSource | null>(null);
  const [form, setForm] = useState<SourceForm>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<LeadSource | null>(null);

  const sources = usePaginatedQuery<LeadSource>(['leadSources'], apiClient.leadSources.list, {
    ordering: '-total_leads',
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['leadSources'] });

  const saveMutation = useMutation({
    mutationFn: (payload: SourceForm) => {
      if (editing) {
        return apiClient.leadSources.update(editing.id, payload);
      }
      // Counters are derived server-side; a new source starts at zero.
      return apiClient.leadSources.create({ ...payload, totalLeads: 0, conversionRate: 0 });
    },
    onSuccess: () => {
      invalidate();
      closeForm();
    },
    onError: (error: unknown) => setFieldErrors(getApiFieldErrors(error) ?? {}),
  });

  const deleteMutation = useMutation({
    mutationFn: (source: LeadSource) => apiClient.leadSources.delete(source.id),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
    },
  });

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFieldErrors({});
    saveMutation.reset();
    setIsFormOpen(true);
  };

  const openEdit = (source: LeadSource) => {
    setEditing(source);
    setForm({ name: source.name, type: source.type, isActive: source.isActive });
    setFieldErrors({});
    saveMutation.reset();
    setIsFormOpen(true);
  };

  const closeForm = () => {
    setIsFormOpen(false);
    setEditing(null);
    setFieldErrors({});
  };

  const rows = sources.rows;
  const pieData = rows.filter((source) => source.totalLeads > 0).map((source) => ({
    name: source.name,
    value: source.totalLeads,
  }));
  const barData = rows.map((source) => ({ name: source.name, rate: source.conversionRate }));

  const totalLeads = rows.reduce((sum, source) => sum + source.totalLeads, 0);
  const averageConversion =
    rows.length > 0 ? (rows.reduce((sum, source) => sum + source.conversionRate, 0) / rows.length).toFixed(1) : '0.0';
  const bestSource = rows.reduce<LeadSource | null>(
    (best, source) => (best === null || source.conversionRate > best.conversionRate ? source : best),
    null,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-900 font-heading">Lead Sources</h1>
          <p className="mt-1 text-sm text-slate-600 font-body">Analyze where your best students come from</p>
        </div>
        <Button onClick={openCreate} className="h-10 w-full bg-teal-600 font-body hover:bg-teal-700 sm:w-auto">
          <Plus className="mr-2 h-4 w-4" /> Add Source
        </Button>
      </div>

      {deleteMutation.isError && <ErrorBanner error={deleteMutation.error} onDismiss={() => deleteMutation.reset()} />}

      {sources.isError ? (
        <ErrorState error={sources.error} onRetry={sources.refetch} />
      ) : sources.isLoading ? (
        <LoadingState rows={5} label="Loading lead sources" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={TrendingUp}
          title="No lead sources yet"
          description="Add the channels you get enquiries from to see which ones convert best."
          action={
            <Button onClick={openCreate} className="bg-teal-600 hover:bg-teal-700">
              <Plus className="mr-2 h-4 w-4" /> Add Source
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card className="border-slate-200 bg-gradient-to-br from-teal-50 to-white">
              <CardContent className="p-5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-600 font-body">Total leads</p>
                    <h3 className="text-2xl font-bold text-slate-900 font-heading">{totalLeads}</h3>
                  </div>
                  <Users className="h-8 w-8 shrink-0 text-teal-600 sm:h-10 sm:w-10" />
                </div>
              </CardContent>
            </Card>

            <Card className="border-slate-200 bg-gradient-to-br from-green-50 to-white">
              <CardContent className="p-5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-600 font-body">Avg. conversion</p>
                    <h3 className="text-2xl font-bold text-slate-900 font-heading">{averageConversion}%</h3>
                  </div>
                  <Target className="h-8 w-8 shrink-0 text-green-600 sm:h-10 sm:w-10" />
                </div>
              </CardContent>
            </Card>

            <Card className="border-slate-200 bg-gradient-to-br from-blue-50 to-white">
              <CardContent className="p-5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-600 font-body">Best converting</p>
                    <h3 className="truncate text-lg font-bold text-slate-900 font-heading">
                      {bestSource ? bestSource.name : '—'}
                    </h3>
                    {bestSource && <p className="text-xs text-slate-500">{bestSource.conversionRate}% conversion</p>}
                  </div>
                  <TrendingUp className="h-8 w-8 shrink-0 text-blue-600 sm:h-10 sm:w-10" />
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card className="border-slate-200">
              <CardHeader className="border-b border-slate-100 bg-gradient-to-r from-teal-50 to-white">
                <CardTitle className="text-base sm:text-lg font-heading">Lead distribution</CardTitle>
              </CardHeader>
              <CardContent className="pt-6">
                {pieData.length === 0 ? (
                  <p className="py-16 text-center text-sm text-slate-500">No leads recorded yet.</p>
                ) : (
                  <div className="h-[280px] w-full min-w-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={pieData} cx="50%" cy="50%" outerRadius="75%" dataKey="value" nameKey="name">
                          {pieData.map((entry, index) => (
                            <Cell key={entry.name} fill={COLORS[index % COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{ backgroundColor: '#fff', borderColor: '#e2e8f0', borderRadius: 8, fontSize: 12 }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-slate-200">
              <CardHeader className="border-b border-slate-100 bg-gradient-to-r from-blue-50 to-white">
                <CardTitle className="text-base sm:text-lg font-heading">Conversion rates</CardTitle>
              </CardHeader>
              <CardContent className="pt-6">
                <div className="h-[280px] w-full min-w-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={barData} margin={{ left: -12, right: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                      <XAxis dataKey="name" tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} axisLine={false} />
                      <YAxis
                        tick={{ fill: '#64748b', fontSize: 11 }}
                        tickLine={false}
                        axisLine={false}
                        width={44}
                        tickFormatter={(value: number) => `${value}%`}
                      />
                      <Tooltip
                        contentStyle={{ backgroundColor: '#fff', borderColor: '#e2e8f0', borderRadius: 8, fontSize: 12 }}
                        formatter={(value: number) => [`${value}%`, 'Conversion']}
                      />
                      <Bar dataKey="rate" fill="#0d9488" radius={[6, 6, 0, 0]} maxBarSize={44} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card className="overflow-hidden border-slate-200">
            <CardHeader className="border-b border-slate-100 bg-gradient-to-r from-purple-50 to-white">
              <CardTitle className="text-base sm:text-lg font-heading">All lead sources</CardTitle>
            </CardHeader>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-700">Source</th>
                    <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase text-slate-700 md:table-cell">
                      Type
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase text-slate-700">Leads</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase text-slate-700">Conversion</th>
                    <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase text-slate-700 sm:table-cell">
                      Status
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase text-slate-700">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {rows.map((source) => (
                    <tr key={source.id} className="hover:bg-slate-50">
                      <td className="px-4 py-4">
                        <p className="text-sm font-semibold text-slate-900 font-body">{source.name}</p>
                        <span
                          className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-xs font-semibold md:hidden ${
                            TYPE_STYLE[source.type] ?? 'bg-slate-100 text-slate-700'
                          }`}
                        >
                          {source.type}
                        </span>
                      </td>
                      <td className="hidden px-4 py-4 md:table-cell">
                        <span
                          className={`rounded-full px-2 py-1 text-xs font-semibold ${
                            TYPE_STYLE[source.type] ?? 'bg-slate-100 text-slate-700'
                          }`}
                        >
                          {source.type}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-right text-sm font-semibold text-slate-900 font-body">
                        {source.totalLeads}
                      </td>
                      <td className="px-4 py-4 text-right text-sm font-bold text-teal-600 font-body">
                        {source.conversionRate}%
                      </td>
                      <td className="hidden px-4 py-4 sm:table-cell">
                        <Badge
                          className={
                            source.isActive
                              ? 'border-transparent bg-green-100 text-green-700 hover:bg-green-100'
                              : 'border-transparent bg-slate-200 text-slate-600 hover:bg-slate-200'
                          }
                        >
                          {source.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 hover:bg-teal-50 hover:text-teal-600"
                            onClick={() => openEdit(source)}
                            aria-label={`Edit ${source.name}`}
                          >
                            <Edit size={14} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 hover:bg-red-50 hover:text-red-600"
                            onClick={() => setDeleteTarget(source)}
                            aria-label={`Delete ${source.name}`}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <PaginationBar
              page={sources.page}
              pages={sources.pages}
              count={sources.count}
              pageSize={sources.pageSize}
              onPageChange={sources.setPage}
              isLoading={sources.isFetching}
            />
          </Card>
        </>
      )}

      <Modal
        open={isFormOpen}
        onClose={closeForm}
        title={editing ? `Edit ${editing.name}` : 'Add lead source'}
        description="Lead and conversion counts are calculated from enquiries tagged with this source."
        footer={
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="h-11 sm:w-32" onClick={closeForm}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="source-form"
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
                'Add source'
              )}
            </Button>
          </div>
        }
      >
        <form
          id="source-form"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setFieldErrors({});
            saveMutation.mutate(form);
          }}
        >
          {saveMutation.isError && <ErrorBanner error={saveMutation.error} />}

          <div className="space-y-2">
            <Label htmlFor="source-name">Source name *</Label>
            <Input
              id="source-name"
              required
              className="h-11"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Instagram campaign"
            />
            {fieldErrors.name && <p className="text-xs text-red-600">{fieldErrors.name}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="source-type">Type *</Label>
            <Select value={form.type} onValueChange={(value) => setForm({ ...form, type: value })}>
              <SelectTrigger id="source-type" className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOURCE_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {fieldErrors.type && <p className="text-xs text-red-600">{fieldErrors.type}</p>}
          </div>

          <label className="flex items-start gap-3 rounded-lg border border-slate-200 p-3">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
              checked={form.isActive}
              onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
            />
            <span className="text-sm">
              <span className="font-medium text-slate-900">Active</span>
              <span className="mt-0.5 block text-xs text-slate-500">
                Inactive sources stay in reports but are not offered when logging a new enquiry.
              </span>
            </span>
          </label>
        </form>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
        title="Delete lead source?"
        description={`${deleteTarget?.name} will be removed. Enquiries already tagged with it keep their history.`}
        confirmText="Delete"
        confirmVariant="destructive"
        isLoading={deleteMutation.isPending}
      />
    </div>
  );
}

export default function LeadSourcesRoute() {
  return (
    <RoleRoute allow={CAN.manageLeadSources}>
      <LeadSourcesPage />
    </RoleRoute>
  );
}
