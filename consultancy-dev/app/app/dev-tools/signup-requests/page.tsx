'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Check, X, Clock, Building, AlertCircle } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { api, getApiErrorMessage } from '@/lib/api';
import { RoleRoute } from '@/components/rbac/RoleGate';
import { ROLES } from '@/components/rbac/roles';
import { useToast } from '@/hooks/use-toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Modal } from '@/components/common/Modal';
import { Label } from '@/components/ui/label';
import { InlineSpinner } from '@/components/common/states';

interface SignupRequest {
  id: number;
  company_name: string;
  admin_name: string;
  email: string;
  phone: string;
  requested_at: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  plan: string;
  username: string;
  first_name: string;
  last_name: string;
  company_id: string;
  approved_by_name?: string;
  approved_at?: string;
  rejection_reason?: string;
}

function SignupRequestsPageContent() {
  const queryClient = useQueryClient();
  const [approveTarget, setApproveTarget] = useState<number | null>(null);
  const [rejectTarget, setRejectTarget] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const { toast } = useToast();

  // Fetch signup requests
  const { data: requests = [], isLoading, error } = useQuery({
    queryKey: ['signup-requests'],
    queryFn: async () => {
      const response = await api.get<SignupRequest[]>('signup-requests/');
      return response.data;
    }
  });

  // Approve mutation
  const approveMutation = useMutation({
    mutationFn: async (id: number) => {
      const response = await api.post(`signup-requests/${id}/approve/`);
      return response.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['signup-requests'] });
      toast.success('Request approved', 'Company admin account created for ' + data.username);
    },
    onError: (error: any) => {
      toast.error('Approval failed', getApiErrorMessage(error));
    }
  });

  // Reject mutation
  const rejectMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: number; reason: string }) => {
      const response = await api.post(`signup-requests/${id}/reject/`, { reason });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['signup-requests'] });
      toast.success('Request rejected', 'The signup request has been rejected.');
    },
    onError: (error: any) => {
      toast.error('Rejection failed', getApiErrorMessage(error));
    }
  });

  const handleApprove = (id: number) => {
    setApproveTarget(id);
  };

  const handleReject = (id: number) => {
    setRejectTarget(id);
    setRejectReason('');
  };

  const pendingCount = requests.filter(r => r.status === 'Pending').length;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-teal-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <Card className="p-6">
        <div className="flex items-center gap-3 text-red-600">
          <AlertCircle className="h-5 w-5" />
          <p>Failed to load signup requests. Please try again.</p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Company Signup Requests</h1>
          <p className="text-sm text-slate-600 mt-1">Review and approve new company registrations</p>
        </div>
        <div className="flex items-center gap-2 px-4 py-2 bg-yellow-50 border border-yellow-200 rounded-lg">
          <Clock className="h-4 w-4 text-yellow-600" />
          <span className="text-sm font-semibold text-yellow-900">{pendingCount} Pending</span>
        </div>
      </div>

      {requests.length === 0 ? (
        <Card className="p-12 text-center">
          <Building className="h-12 w-12 text-slate-300 mx-auto mb-4" />
          <p className="text-slate-600">No signup requests yet</p>
        </Card>
      ) : (
        <DataTable<SignupRequest>
          data={requests}
          searchKey="company_name"
          columns={[
            {
              header: 'Company',
              cell: (item) => (
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-teal-100 flex items-center justify-center text-teal-600">
                    <Building size={20} />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{item.company_name}</p>
                    <p className="text-xs text-slate-500">{item.admin_name}</p>
                  </div>
                </div>
              )
            },
            {
              header: 'Email',
              accessorKey: 'email',
              className: 'hidden md:table-cell'
            },
            {
              header: 'Phone',
              accessorKey: 'phone',
              className: 'hidden lg:table-cell'
            },
            {
              header: 'Plan',
              accessorKey: 'plan',
              cell: (item) => (
                <span className="px-2.5 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-semibold">
                  {item.plan}
                </span>
              )
            },
            {
              header: 'Requested',
              cell: (item) => <span className="text-sm text-slate-600">{format(new Date(item.requested_at), 'dd MMM yyyy')}</span>,
              className: 'hidden sm:table-cell'
            },
            {
              header: 'Status',
              cell: (item) => (
                <div className="space-y-1">
                  <span className={cn(
                    'px-2.5 py-1 rounded-full text-xs font-semibold inline-block',
                    item.status === 'Pending' && 'bg-yellow-100 text-yellow-700',
                    item.status === 'Approved' && 'bg-green-100 text-green-700',
                    item.status === 'Rejected' && 'bg-red-100 text-red-700'
                  )}>
                    {item.status}
                  </span>
                  {item.status !== 'Pending' && item.approved_by_name && (
                    <p className="text-[10px] text-slate-500">by {item.approved_by_name}</p>
                  )}
                </div>
              )
            },
            {
              header: 'Actions',
              cell: (item) => item.status === 'Pending' ? (
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 w-8 p-0 hover:bg-green-50 hover:text-green-600"
                    onClick={(e) => { e.stopPropagation(); handleApprove(item.id); }}
                    title="Approve"
                    disabled={approveMutation.isPending}
                  >
                    <Check size={16} />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 w-8 p-0 hover:bg-red-50 hover:text-red-600"
                    onClick={(e) => { e.stopPropagation(); handleReject(item.id); }}
                    title="Reject"
                    disabled={rejectMutation.isPending}
                  >
                    <X size={16} />
                  </Button>
                </div>
              ) : (
                <span className="text-xs text-slate-400">-</span>
              )
            }
          ]}
        />
      )}

      <ConfirmDialog
        open={approveTarget !== null}
        onClose={() => setApproveTarget(null)}
        onConfirm={() => {
          if (approveTarget !== null) approveMutation.mutate(approveTarget);
          setApproveTarget(null);
        }}
        title="Approve this signup request?"
        description="A company, its default branch, a trial subscription and a company-admin account will be created. This cannot be undone."
        confirmText="Approve and provision"
        isLoading={approveMutation.isPending}
      />

      <Modal
        open={rejectTarget !== null}
        onClose={() => setRejectTarget(null)}
        title="Reject signup request"
        description="The reason is stored with the request so the decision is auditable."
        footer={
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" type="button" className="h-11 sm:w-32" onClick={() => setRejectTarget(null)}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="reject-form"
              variant="destructive"
              className="h-11 sm:w-40"
              disabled={rejectMutation.isPending || rejectReason.trim() === ''}
            >
              {rejectMutation.isPending ? (
                <>
                  <InlineSpinner className="mr-2" /> Rejecting…
                </>
              ) : (
                'Reject request'
              )}
            </Button>
          </div>
        }
      >
        <form
          id="reject-form"
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (rejectTarget !== null) {
              rejectMutation.mutate({ id: rejectTarget, reason: rejectReason.trim() });
            }
            setRejectTarget(null);
          }}
        >
          <Label htmlFor="reject-reason">Reason *</Label>
          <textarea
            id="reject-reason"
            required
            rows={3}
            autoFocus
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            placeholder="Why is this request being rejected?"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
          />
        </form>
      </Modal>
    </div>
  );
}

export default function SignupRequestsPage() {
  return (
    <RoleRoute allow={[ROLES.DEV_ADMIN]}>
      <SignupRequestsPageContent />
    </RoleRoute>
  );
}
