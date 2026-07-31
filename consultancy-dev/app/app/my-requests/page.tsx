'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApprovalRequest } from '@/lib/types';

/**
 * `ApprovalRequest.Status` on the backend is PENDING/APPROVED/REJECTED/FAILED
 * (core/models.py:813-817), but lib/types declares it title-case. Comparing
 * against the wire value through this alias keeps the runtime correct until
 * lib/types is corrected — fe-infra has been told.
 */
type WireApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'FAILED';

const wireStatus = (request: { status: string }): WireApprovalStatus =>
  request.status as WireApprovalStatus;

import { format } from 'date-fns';
import { Search, Filter, Clock, CheckCircle, XCircle, MessageSquare, Trash2, FileEdit, CheckSquare } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';

export default function MyRequestsPage() {
    const { user } = useAuthStore();
    const [searchTerm, setSearchTerm] = useState('');
    const [filterStatus, setFilterStatus] = useState<string>('all');
    const [filterAction, setFilterAction] = useState<string>('all');

    const requestsQuery = usePaginatedQuery<ApprovalRequest>(
        ['approval-requests', 'mine'],
        apiClient.approvalRequests.list,
        { pageSize: 100, ordering: '-created_at' },
    );
    const requests = requestsQuery.rows;
    const isLoading = requestsQuery.isLoading;

    // The API already scopes to what the caller may see; this narrows it to the
    // requests they raised themselves.
    const filteredRequests = requests.filter((req: ApprovalRequest) => {
        if (user && req.requested_by !== user.id) return false;

        const matchesSearch = req.entity_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            req.message.toLowerCase().includes(searchTerm.toLowerCase());

        const matchesStatus = filterStatus === 'all' || req.status === filterStatus;
        const matchesAction = filterAction === 'all' || req.action === filterAction;

        return matchesSearch && matchesStatus && matchesAction;
    });

    const getStatusColor = (status: string) => {
        switch (status) {
            case 'APPROVED': return 'bg-green-100 text-green-700 border-green-200';
            case 'REJECTED': return 'bg-red-100 text-red-700 border-red-200';
            default: return 'bg-yellow-100 text-yellow-700 border-yellow-200';
        }
    };

    const getStatusIcon = (status: string) => {
        switch (status) {
            case 'APPROVED': return <CheckCircle size={16} className="mr-1" />;
            case 'REJECTED': return <XCircle size={16} className="mr-1" />;
            default: return <Clock size={16} className="mr-1" />;
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-[400px]">
                <div className="animate-pulse text-slate-500">Loading requests...</div>
            </div>
        );
    }

    return (
        <div className="space-y-6 p-6">
            <div>
                <h1 className="text-2xl font-bold text-slate-900 font-heading">My Requests</h1>
                <p className="text-slate-500 mt-1">Track status of your approval requests</p>
            </div>

            {/* Filters */}
            <Card className="p-4 border-slate-200 bg-white">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                        <Input
                            placeholder="Search by name or reason..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="pl-10"
                        />
                    </div>
                    <Select value={filterStatus} onValueChange={setFilterStatus}>
                        <SelectTrigger>
                            <div className="flex items-center gap-2">
                                <Filter size={16} className="text-slate-400" />
                                <SelectValue placeholder="Filter by status" />
                            </div>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All Status</SelectItem>
                            <SelectItem value="PENDING">Pending</SelectItem>
                            <SelectItem value="APPROVED">Approved</SelectItem>
                            <SelectItem value="REJECTED">Rejected</SelectItem>
                        </SelectContent>
                    </Select>
                    <Select value={filterAction} onValueChange={setFilterAction}>
                        <SelectTrigger>
                            <SelectValue placeholder="Filter by action" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All Actions</SelectItem>
                            <SelectItem value="DELETE">Delete Requests</SelectItem>
                            <SelectItem value="UPDATE">Update Requests</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
            </Card>

            {/* Requests List */}
            <div className="space-y-4">
                {filteredRequests && filteredRequests.length > 0 ? (
                    filteredRequests.map((req: ApprovalRequest) => (
                        <Card key={req.id} className="overflow-hidden border-slate-200 transition-all hover:shadow-md">
                            <div className="p-6">
                                <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                                    <div className="flex items-start gap-4">
                                        <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${req.action === 'DELETE' ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'
                                            }`}>
                                            {req.action === 'DELETE' ? <Trash2 size={20} /> : <FileEdit size={20} />}
                                        </div>
                                        <div>
                                            <div className="flex items-center gap-2 mb-1">
                                                <h3 className="font-semibold text-slate-900">
                                                    {req.action === 'DELETE' ? 'Delete' : 'Update'} {req.entity_type}
                                                </h3>
                                                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${getStatusColor(req.status)}`}>
                                                    {getStatusIcon(req.status)}
                                                    {req.status}
                                                </span>
                                            </div>
                                            <p className="text-slate-600 font-medium">{req.entity_name}</p>
                                            <p className="text-sm text-slate-500 mt-1">
                                                Requested on {format(new Date(req.created_at), 'MMM d, yyyy h:mm a')}
                                            </p>
                                        </div>
                                    </div>
                                </div>

                                <div className="mt-4 pl-14 space-y-3">
                                    <div className="bg-slate-50 rounded-lg p-3 text-sm text-slate-700">
                                        <span className="font-medium text-slate-900 block mb-1">Reason:</span>
                                        {req.message}
                                    </div>

                                    {(wireStatus(req) === 'APPROVED' || wireStatus(req) === 'REJECTED') && req.review_note && (
                                        <div className={`rounded-lg p-3 text-sm ${wireStatus(req) === 'APPROVED' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'
                                            }`}>
                                            <div className="flex items-start gap-2">
                                                <MessageSquare size={16} className="mt-0.5 shrink-0" />
                                                <div>
                                                    <span className="font-medium block mb-1">Admin Feedback:</span>
                                                    {req.review_note}
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </Card>
                    ))
                ) : (
                    <div className="text-center py-12 bg-white rounded-lg border border-dashed border-slate-300">
                        <div className="w-12 h-12 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-3 text-slate-400">
                            <CheckSquare size={24} />
                        </div>
                        <h3 className="text-lg font-medium text-slate-900">No requests found</h3>
                        <p className="text-slate-500 mt-1">You haven't submitted any approval requests yet.</p>
                    </div>
                )}
            </div>
        </div>
    );
}
