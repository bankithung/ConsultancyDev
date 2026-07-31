'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import type { ApprovalRequest } from '@/lib/types';

/**
 * `ApprovalRequest.Status` on the backend is PENDING/APPROVED/REJECTED/FAILED
 * (core/models.py:813-817), but lib/types declares it title-case. Comparing
 * against the wire value through this alias keeps the runtime correct until
 * lib/types is corrected — fe-infra has been told.
 */
type WireApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'FAILED';

const wireStatus = (request: { status: string }): WireApprovalStatus =>
  request.status as WireApprovalStatus;

import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { useAuthStore } from '@/store/authStore';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Check, X, Clock, FileEdit, Trash2, User as UserIcon, AlertCircle } from 'lucide-react';
import { format } from 'date-fns';
import * as Dialog from '@radix-ui/react-dialog';
import { toast } from '@/store/toastStore';

export default function ApprovalRequestsPage() {
    const { user } = useAuthStore();
    const queryClient = useQueryClient();
    const [selectedRequest, setSelectedRequest] = useState<any | null>(null);
    const [reviewNote, setReviewNote] = useState('');
    const [actionType, setActionType] = useState<'APPROVE' | 'REJECT' | null>(null);

    // Redirect if not admin
    if (user && user.role !== 'DEV_ADMIN' && user.role !== 'COMPANY_ADMIN') {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
                <AlertCircle className="w-16 h-16 text-red-500 mb-4" />
                <h1 className="text-2xl font-bold text-slate-900">Access Denied</h1>
                <p className="text-slate-600 mt-2">You do not have permission to view this page.</p>
            </div>
        );
    }

    const requestsQuery = usePaginatedQuery<ApprovalRequest>(
        ['approval-requests'],
        apiClient.approvalRequests.list,
        { pageSize: 100, ordering: '-created_at' },
    );
    const requests = requestsQuery.rows;
    const isLoading = requestsQuery.isLoading;

    const approveMutation = useMutation({
        mutationFn: async ({ id, note }: { id: number; note: string }) => {
            await apiClient.approvalRequests.approve(id, note);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['approval-requests'] });
            // Invalidate entity caches to show updated data
            queryClient.invalidateQueries({ queryKey: ['enquiries'] });
            queryClient.invalidateQueries({ queryKey: ['registrations'] });
            queryClient.invalidateQueries({ queryKey: ['enrollments'] });
            handleCloseModal();
            toast.success('Request approved successfully');
        },
        onError: () => {
            toast.error('Failed to approve request');
        }
    });

    const rejectMutation = useMutation({
        mutationFn: async ({ id, note }: { id: number; note: string }) => {
            await apiClient.approvalRequests.reject(id, note);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['approval-requests'] });
            // Invalidate entity caches in case of rejection too
            queryClient.invalidateQueries({ queryKey: ['enquiries'] });
            queryClient.invalidateQueries({ queryKey: ['registrations'] });
            queryClient.invalidateQueries({ queryKey: ['enrollments'] });
            handleCloseModal();
            toast.success('Request rejected');
        },
        onError: () => {
            toast.error('Failed to reject request');
        }
    });

    const handleAction = (request: any, type: 'APPROVE' | 'REJECT') => {
        setSelectedRequest(request);
        setActionType(type);
        setReviewNote('');
    };

    const handleSubmitReview = () => {
        if (!selectedRequest || !actionType) return;

        if (actionType === 'APPROVE') {
            approveMutation.mutate({ id: selectedRequest.id, note: reviewNote });
        } else {
            rejectMutation.mutate({ id: selectedRequest.id, note: reviewNote });
        }
    };

    const handleCloseModal = () => {
        setSelectedRequest(null);
        setActionType(null);
        setReviewNote('');
    };

    const pendingRequests = requests.filter((request) => wireStatus(request) === 'PENDING');
    const historyRequests = requests.filter((request) => wireStatus(request) !== 'PENDING');

    if (isLoading) {
        return <div className="flex items-center justify-center min-h-screen"><div className="animate-pulse text-slate-500">Loading requests...</div></div>;
    }

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-slate-900 font-heading">Approval Requests</h1>
                <p className="text-sm text-slate-600 mt-1 font-body">Review and manage delete/update requests from employees</p>
            </div>

            <Tabs defaultValue="pending" className="w-full">
                <TabsList className="grid w-full max-w-md grid-cols-2 h-auto">
                    <TabsTrigger value="pending" className="relative">
                        Pending
                        {pendingRequests.length > 0 && (
                            <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] text-white">
                                {pendingRequests.length}
                            </span>
                        )}
                    </TabsTrigger>
                    <TabsTrigger value="history">History</TabsTrigger>
                </TabsList>

                <TabsContent value="pending" className="mt-6">
                    {pendingRequests.length === 0 ? (
                        <Card className="border-dashed border-2 border-slate-200 bg-slate-50">
                            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                                <Check className="w-12 h-12 text-green-500 mb-4 bg-green-100 p-2 rounded-full" />
                                <h3 className="text-lg font-medium text-slate-900">All Caught Up!</h3>
                                <p className="text-slate-500 mt-1">There are no pending requests to review.</p>
                            </CardContent>
                        </Card>
                    ) : (
                        <div className="grid gap-4">
                            {pendingRequests.map((request: any) => (
                                <RequestCard
                                    key={request.id}
                                    request={request}
                                    onApprove={() => handleAction(request, 'APPROVE')}
                                    onReject={() => handleAction(request, 'REJECT')}
                                />
                            ))}
                        </div>
                    )}
                </TabsContent>

                <TabsContent value="history" className="mt-6">
                    {historyRequests.length === 0 ? (
                        <div className="text-center py-12 text-slate-500">No history available</div>
                    ) : (
                        <div className="grid gap-4">
                            {historyRequests.map((request: any) => (
                                <RequestCard key={request.id} request={request} isHistory />
                            ))}
                        </div>
                    )}
                </TabsContent>
            </Tabs>

            {/* Review Modal */}
            <Dialog.Root open={!!selectedRequest} onOpenChange={handleCloseModal}>
                <Dialog.Portal>
                    <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
                    <Dialog.Content className="fixed left-[50%] top-[50%] max-h-[85vh] w-[90vw] max-w-[500px] translate-x-[-50%] translate-y-[-50%] rounded-xl bg-white p-6 shadow-xl focus:outline-none z-50 border border-slate-200">
                        {selectedRequest && (
                            <>
                                <Dialog.Title className="text-xl font-bold text-slate-900 mb-1 font-heading flex items-center gap-2">
                                    {actionType === 'APPROVE' ? (
                                        <Check className="w-6 h-6 text-green-600" />
                                    ) : (
                                        <X className="w-6 h-6 text-red-600" />
                                    )}
                                    {actionType === 'APPROVE' ? 'Approve Request' : 'Reject Request'}
                                </Dialog.Title>
                                <Dialog.Description className="text-slate-500 mb-6">
                                    You are about to {actionType?.toLowerCase()} this request.
                                </Dialog.Description>

                                <div className="space-y-4">
                                    <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
                                        <div className="flex items-center gap-2 mb-2">
                                            <Badge variant={selectedRequest.action === 'DELETE' ? 'destructive' : 'default'}>
                                                {selectedRequest.action}
                                            </Badge>
                                            <span className="font-medium text-slate-900">{selectedRequest.entity_type}</span>
                                        </div>
                                        <p className="text-sm text-slate-700 font-medium">{selectedRequest.entity_name}</p>
                                        <p className="text-xs text-slate-500 mt-2">Reason: "{selectedRequest.message}"</p>
                                    </div>

                                    <div>
                                        <label className="block text-sm font-medium text-slate-700 mb-2">
                                            Review Note (Optional)
                                        </label>
                                        <textarea
                                            className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500 resize-none"
                                            rows={3}
                                            placeholder="Add a note..."
                                            value={reviewNote}
                                            onChange={(e) => setReviewNote(e.target.value)}
                                        />
                                    </div>

                                    <div className="flex gap-3 justify-end mt-4">
                                        <Button variant="outline" onClick={handleCloseModal}>
                                            Cancel
                                        </Button>
                                        <Button
                                            className={actionType === 'APPROVE' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'}
                                            onClick={handleSubmitReview}
                                            disabled={approveMutation.isPending || rejectMutation.isPending}
                                        >
                                            {actionType === 'APPROVE' ? 'Confirm Approval' : 'Confirm Rejection'}
                                        </Button>
                                    </div>
                                </div>
                            </>
                        )}
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
        </div>
    );
}

function RequestCard({ request, onApprove, onReject, isHistory }: any) {
    const isDelete = request.action === 'DELETE';

    return (
        <Card className={`border-l-4 ${wireStatus(request) === 'APPROVED' ? 'border-l-green-500' :
            wireStatus(request) === 'REJECTED' ? 'border-l-red-500' :
                isDelete ? 'border-l-red-500' : 'border-l-blue-500'
            }`}>
            <CardContent className="p-5">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <Badge variant={isDelete ? 'destructive' : 'secondary'} className="uppercase">
                                {isDelete ? <Trash2 className="w-3 h-3 mr-1" /> : <FileEdit className="w-3 h-3 mr-1" />}
                                {request.action}
                            </Badge>
                            <span className="text-sm font-medium text-slate-500 uppercase tracking-wide">
                                {request.entity_type}
                            </span>
                            {isHistory && (
                                <Badge variant={wireStatus(request) === 'APPROVED' ? 'default' : 'destructive'} className={wireStatus(request) === 'APPROVED' ? 'bg-green-100 text-green-700 hover:bg-green-200' : 'bg-red-100 text-red-700 hover:bg-red-200'}>
                                    {request.status}
                                </Badge>
                            )}
                        </div>

                        <div>
                            <h3 className="text-lg font-semibold text-slate-900">{request.entity_name}</h3>
                            <div className="flex items-center gap-2 text-sm text-slate-500 mt-1">
                                <UserIcon className="w-4 h-4" />
                                <span>Requested by <span className="font-medium text-slate-700">{request.requested_by_name || 'Employee'}</span></span>
                                <span>•</span>
                                <Clock className="w-4 h-4" />
                                <span>{format(new Date(request.created_at), 'MMM d, yyyy h:mm a')}</span>
                            </div>
                        </div>

                        <div className="bg-slate-50 p-3 rounded-md text-sm text-slate-700 border border-slate-100">
                            <span className="font-medium text-slate-900">Reason: </span>
                            {request.message}
                        </div>

                        {isHistory && request.review_note && (
                            <div className="text-xs text-slate-500 italic">
                                Admin Note: {request.review_note}
                            </div>
                        )}
                    </div>

                    {!isHistory && (
                        <div className="flex items-center gap-2 shrink-0">
                            <Button
                                variant="outline"
                                className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
                                onClick={onReject}
                            >
                                <X className="w-4 h-4 mr-2" />
                                Reject
                            </Button>
                            <Button
                                className="bg-green-600 hover:bg-green-700 text-white"
                                onClick={onApprove}
                            >
                                <Check className="w-4 h-4 mr-2" />
                                Approve
                            </Button>
                        </div>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}
