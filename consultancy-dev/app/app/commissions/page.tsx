'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DollarSign, Users, TrendingUp, Download, Plus, Eye, X, CheckCircle } from 'lucide-react';
import { format } from 'date-fns';
import * as Dialog from '@radix-ui/react-dialog';
import { toArray } from '@/components/common/pagination';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/store/toastStore';
import { fetchAllPages } from '@/lib/apiClient';
import type { Agent, Commission } from '@/lib/types';

// Types come from lib/types so the page and the API client cannot drift. The
// local duplicates that used to live here had already diverged — they declared
// commissionType as 'Flat' where the API uses 'Fixed'.

export default function CommissionsPage() {
  const [isAddAgentOpen, setIsAddAgentOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);

  // Form State
  const [agentName, setAgentName] = useState('');
  const [agentEmail, setAgentEmail] = useState('');
  const [commissionType, setCommissionType] = useState<'Percentage' | 'Fixed'>('Percentage');
  const [commissionValue, setCommissionValue] = useState('');
  const [payTarget, setPayTarget] = useState<string | null>(null);

  const queryClient = useQueryClient();

  // queryFn must be a thunk: react-query calls it with its own context object,
  // not the PageParams these client methods expect.
  const { data: agentsPage, isLoading: agentsLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: () => apiClient.agents.list(),
  });

  const { data: commissionsPage, isLoading: commissionsLoading } = useQuery({
    queryKey: ['commissions'],
    queryFn: () => apiClient.commissions.list(),
  });

  const agents = toArray<Agent>(agentsPage);
  const commissions = toArray<Commission>(commissionsPage);

  // The cards below are money and headcount, so they must cover every row in
  // the caller's scope — reducing over the 25-row page would understate a
  // payout figure without looking wrong. `fetchAllPages` is bounded internally.
  const { data: allCommissions = [], isLoading: totalsLoading } = useQuery({
    queryKey: ['commissions', 'all'],
    queryFn: () => fetchAllPages<Commission, Commission>('commissions/', (row) => row),
    staleTime: 60_000,
  });

  const { data: allAgents = [] } = useQuery({
    queryKey: ['agents', 'all'],
    queryFn: () => fetchAllPages<Agent, Agent>('agents/', (row) => row),
    staleTime: 60_000,
  });

  const createAgentMutation = useMutation({
    mutationFn: apiClient.agents.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      setIsAddAgentOpen(false);
      resetForm();
      toast.success('Agent added');
    },
  });

  const updateCommissionMutation = useMutation({
    mutationFn: ({ id, data }: { id: string, data: any }) => apiClient.commissions.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['commissions'] });
    },
  });

  const resetForm = () => {
    setAgentName('');
    setAgentEmail('');
    setCommissionType('Percentage');
    setCommissionValue('');
  };

  const handleAddAgent = (e: React.FormEvent) => {
    e.preventDefault();
    createAgentMutation.mutate({
      name: agentName,
      email: agentEmail,
      commissionType,
      commissionValue: parseFloat(commissionValue),
      status: 'Active',
      totalEarned: 0,
      pendingAmount: 0,
      studentsReferred: 0,
    });
  };

  const handlePayCommission = (id: string) => {
    setPayTarget(id);
  };

  if (agentsLoading || commissionsLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-pulse text-slate-500">Loading commissions...</div>
      </div>
    );
  }

  const totalPending = allCommissions
    .filter((c) => c.status === 'Pending')
    .reduce((sum, c) => sum + c.commissionAmount, 0);
  const totalPaid = allCommissions
    .filter((c) => c.status === 'Paid')
    .reduce((sum, c) => sum + c.commissionAmount, 0);
  const activeAgentCount = allAgents.filter((a) => a.status === 'Active').length;

  const formatMoney = (value: number) =>
    new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    }).format(value);

  /** Exports every commission in scope as CSV. */
  const handleExport = () => {
    const header = ['Agent', 'Student', 'Enrollment', 'Enrollment fee', 'Commission', 'Status', 'Date'];
    const escape = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
    const rows = allCommissions.map((c) =>
      [c.agentName, c.studentName, c.enrollmentNo, c.enrollmentFee, c.commissionAmount, c.status, c.enrollmentDate]
        .map(escape)
        .join(','),
    );
    const blob = new Blob([[header.map(escape).join(','), ...rows].join('\n')], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `commissions-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 font-heading">Commission Management</h1>
          <p className="text-sm text-slate-600 mt-1 font-body">Track and manage partner/agent commissions</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-9 font-body"
            onClick={handleExport}
            disabled={totalsLoading || allCommissions.length === 0}
          >
            <Download size={16} className="mr-2" /> Export CSV
          </Button>
          <Button onClick={() => setIsAddAgentOpen(true)} className="h-9 bg-teal-600 hover:bg-teal-700 font-body">
            <Plus className="mr-2 h-4 w-4" /> Add Agent
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="border-slate-200 bg-gradient-to-br from-yellow-50 to-white">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-600 font-body">Pending Payout</p>
                <h3 className="text-2xl font-bold text-yellow-600 font-heading">{formatMoney(totalPending)}</h3>
              </div>
              <DollarSign className="h-10 w-10 text-yellow-600" />
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 bg-gradient-to-br from-green-50 to-white">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-600 font-body">Total Paid</p>
                <h3 className="text-2xl font-bold text-green-600 font-heading">{formatMoney(totalPaid)}</h3>
              </div>
              <CheckCircle className="h-10 w-10 text-green-600" />
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 bg-gradient-to-br from-blue-50 to-white">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-600 font-body">Active Agents</p>
                <h3 className="text-2xl font-bold text-blue-600 font-heading">{activeAgentCount}</h3>
              </div>
              <Users className="h-10 w-10 text-blue-600" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Agents List */}
      <Card className="border-slate-200">
        <CardHeader className="bg-gradient-to-r from-teal-50 to-white border-b border-slate-100">
          <CardTitle className="text-lg font-semibold font-heading">Partners & Agents</CardTitle>
        </CardHeader>
        <CardContent className="pt-6">
          <div className="space-y-4">
            {agents.map((agent: Agent) => (
              <div key={agent.id} className="flex flex-col lg:flex-row items-start lg:items-center justify-between p-4 bg-slate-50 rounded-lg border border-slate-200 hover:bg-white transition-colors gap-4">
                <div className="flex items-center gap-4 flex-1">
                  <div className="w-12 h-12 rounded-full bg-teal-100 flex items-center justify-center text-teal-600 font-bold text-lg">
                    {agent.name.charAt(0)}
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900 font-heading">{agent.name}</h3>
                    <p className="text-sm text-slate-500 font-body">{agent.email}</p>
                    <div className="flex items-center gap-4 mt-1 text-xs text-slate-600 font-body">
                      <span>{agent.studentsReferred} students</span>
                      <span>•</span>
                      <span>{agent.commissionType === 'Percentage' ? `${agent.commissionValue}%` : `₹${agent.commissionValue}`} per enrollment</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-6">
                  <div className="text-right">
                    <p className="text-xs text-slate-500 font-body">Pending</p>
                    <p className="text-lg font-bold text-yellow-600 font-heading">₹{agent.pendingAmount.toLocaleString()}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-slate-500 font-body">Paid</p>
                    <p className="text-lg font-bold text-green-600 font-heading">₹{agent.totalEarned.toLocaleString()}</p>
                  </div>
                  <Button size="sm" variant="outline" className="font-body" onClick={() => setSelectedAgent(agent)}>
                    <Eye size={14} className="mr-1" /> Details
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Recent Commissions */}
      <Card className="border-slate-200">
        <CardHeader className="bg-gradient-to-r from-blue-50 to-white border-b border-slate-100">
          <CardTitle className="text-lg font-semibold font-heading">Recent Commissions</CardTitle>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700 uppercase">Agent</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700 uppercase hidden md:table-cell">Student</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700 uppercase">Amount</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700 uppercase hidden lg:table-cell">Date</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700 uppercase">Status</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-700 uppercase">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {commissions.map((comm: Commission) => (
                <tr key={comm.id} className="hover:bg-slate-50">
                  <td className="px-4 py-4 text-sm font-semibold text-slate-900 font-body">{comm.agentName}</td>
                  <td className="px-4 py-4 text-sm text-slate-700 font-body hidden md:table-cell">{comm.studentName}</td>
                  <td className="px-4 py-4 text-sm font-bold text-teal-600 font-heading">₹{comm.commissionAmount.toLocaleString()}</td>
                  <td className="px-4 py-4 text-sm text-slate-600 font-body hidden lg:table-cell">{format(new Date(comm.enrollmentDate), 'dd MMM yyyy')}</td>
                  <td className="px-4 py-4">
                    <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-semibold ${comm.status === 'Paid' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                      }`}>
                      {comm.status}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-right">
                    {comm.status === 'Pending' && (
                      <Button size="sm" className="h-8 bg-green-600 hover:bg-green-700 font-body" onClick={() => handlePayCommission(comm.id)}>
                        Mark Paid
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Add Agent Modal */}
      <Dialog.Root open={isAddAgentOpen} onOpenChange={setIsAddAgentOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
          <Dialog.Content className="fixed left-[50%] top-[50%] w-[90vw] max-w-[500px] translate-x-[-50%] translate-y-[-50%] rounded-xl bg-white p-6 shadow-xl z-50 border">
            <Dialog.Title className="text-xl font-bold text-slate-900 mb-6 font-heading">Add New Agent</Dialog.Title>
            <form className="space-y-4" onSubmit={handleAddAgent}>
              <div className="space-y-2">
                <Label className="font-body">Agent Name</Label>
                <Input
                  className="h-11"
                  placeholder="Full name"
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label className="font-body">Email</Label>
                <Input
                  type="email"
                  className="h-11"
                  placeholder="agent@partner.com"
                  value={agentEmail}
                  onChange={(e) => setAgentEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label className="font-body">Commission Type</Label>
                <Select value={commissionType} onValueChange={(val: any) => setCommissionType(val)}>
                  <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Percentage">Percentage (%)</SelectItem>
                    <SelectItem value="Fixed">Flat Amount (₹)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="font-body">Commission Value</Label>
                <Input
                  type="number"
                  className="h-11"
                  placeholder="10"
                  value={commissionValue}
                  onChange={(e) => setCommissionValue(e.target.value)}
                  required
                />
              </div>
              <div className="flex gap-3 pt-4">
                <Button variant="outline" type="button" onClick={() => setIsAddAgentOpen(false)} className="flex-1 h-11 font-body">Cancel</Button>
                <Button type="submit" className="flex-1 h-11 bg-teal-600 hover:bg-teal-700 font-body" disabled={createAgentMutation.isPending}>
                  {createAgentMutation.isPending ? 'Adding...' : 'Add Agent'}
                </Button>
              </div>
            </form>
            <Dialog.Close asChild>
              <button className="absolute top-4 right-4 p-1 rounded-full hover:bg-slate-100">
                <X size={20} />
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <ConfirmDialog
        open={payTarget !== null}
        onClose={() => setPayTarget(null)}
        onConfirm={() => {
          if (payTarget) updateCommissionMutation.mutate({ id: payTarget, data: { status: 'Paid' } });
          setPayTarget(null);
        }}
        title="Mark commission as paid?"
        description="This records the payout as settled. It does not move any money."
        confirmText="Mark as paid"
        isLoading={updateCommissionMutation.isPending}
      />
    </div>
  );
}
