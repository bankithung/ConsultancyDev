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
type ApprovalRow = ApprovalRequest & { requested_by_name?: string };

type WireApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'FAILED';

const wireStatus = (request: { status: string }): WireApprovalStatus =>
  request.status as WireApprovalStatus;

import { loadAllPages } from '@/app/app/student-profile/aggregate';
import { BookmarkTabs } from '@/components/common/BookmarkTabs';
import { PaginationBar } from '@/components/common/PaginationBar';
import { ErrorState, LoadingState, ErrorBanner } from '@/components/common/states';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Check, X, Clock, FileEdit, Trash2, User as UserIcon, AlertCircle, History } from 'lucide-react';
import { format } from 'date-fns';
import * as Dialog from '@radix-ui/react-dialog';
import { toast } from '@/store/toastStore';

export default function ApprovalRequestsPage() {
    const { user } = useAuthStore();
    const queryClient = useQueryClient();
    const [selectedRequest, setSelectedRequest] = useState<ApprovalRow | null>(null);
    const [tab, setTab] = useState<'pending' | 'history'>('pending');
    const [page, setPage] = useState(1);
    const [reviewNote, setReviewNote] = useState('');
    const [actionType, setActionType] = useState<'APPROVE' | 'REJECT' | null>(null);

    const requestsQuery = useQuery({
        queryKey: ['approval-requests', 'workspace'],
        queryFn: () => loadAllPages<ApprovalRow>(apiClient.approvalRequests.list, { ordering: '-created_at' }, 200, 10),
        enabled: user?.role === 'DEV_ADMIN' || user?.role === 'COMPANY_ADMIN',
    });
    const requests = requestsQuery.data ?? [];

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

    const handleAction = (request: ApprovalRow, type: 'APPROVE' | 'REJECT') => {
        setSelectedRequest(request);
        setActionType(type);
        setReviewNote('');
        approveMutation.reset();
        rejectMutation.reset();
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
    const activeRequests = tab === 'pending' ? pendingRequests : historyRequests;
    const pageSize = 20;
    const pages = Math.max(1, Math.ceil(activeRequests.length / pageSize));
    const currentPage = Math.min(page, pages);
    const visibleRequests = activeRequests.slice((currentPage - 1) * pageSize, currentPage * pageSize);

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

    return (
        <div className="pt-1">
            <h1 className="sr-only">Approvals</h1>
            <BookmarkTabs
                aria-label="Approval requests"
                tabs={[{ value: 'pending', label: 'Pending', icon: Clock }, { value: 'history', label: 'History', icon: History }]}
                value={tab}
                onChange={(next) => { setTab(next); setPage(1); }}
            />
            <section role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                {requestsQuery.isError ? <div className="p-4"><ErrorState error={requestsQuery.error} onRetry={() => requestsQuery.refetch()} /></div> : requestsQuery.isLoading ? <div className="p-4"><LoadingState rows={3} label="Loading requests" /></div> : (
                    <>
                        {requests.length >= 2000 && <p className="border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800">Showing the latest 2,000 requests.</p>}
                        {visibleRequests.length === 0 ? (
                            <div className="flex flex-col items-center px-4 py-16 text-center">
                                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-50 text-slate-400">
                                    {tab === 'pending' ? <Check size={20} /> : <History size={20} />}
                                </span>
                                <h2 className="mt-3 text-sm font-semibold text-slate-900">{tab === 'pending' ? 'No pending requests' : 'No history yet'}</h2>
                                <p className="mt-1 text-xs text-slate-500">{tab === 'pending' ? 'You’re all caught up.' : 'Reviewed requests appear here.'}</p>
                            </div>
                        ) : (
                            <div className="divide-y divide-slate-100">
                                {visibleRequests.map((request) => <RequestCard key={request.id} request={request} isHistory={tab === 'history'} onApprove={() => handleAction(request, 'APPROVE')} onReject={() => handleAction(request, 'REJECT')} />)}
                            </div>
                        )}
                        {activeRequests.length > 0 && <PaginationBar page={currentPage} pages={pages} count={activeRequests.length} pageSize={pageSize} onPageChange={setPage} isLoading={requestsQuery.isFetching} />}
                    </>
                )}
            </section>

            {/* Review Modal */}
            <Dialog.Root open={!!selectedRequest} onOpenChange={handleCloseModal}>
                <Dialog.Portal>
                    <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
                    <Dialog.Content className="fixed left-[50%] top-[50%] max-h-[85vh] w-[90vw] max-w-[500px] translate-x-[-50%] translate-y-[-50%] overflow-y-auto rounded-xl bg-white p-6 shadow-xl focus:outline-none z-50 border border-slate-200">
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
                                        <p className="text-xs text-slate-500 mt-2">Reason: {selectedRequest.message}</p>
                                    </div>

                                    <div>
                                        <label className="block text-sm font-medium text-slate-700 mb-2">
                                            Note (optional)
                                        </label>
                                        <textarea
                                            className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500 resize-none"
                                            rows={3}
                                            placeholder="Add a note..."
                                            value={reviewNote}
                                            onChange={(e) => setReviewNote(e.target.value)}
                                        />
                                    </div>

                                    <ErrorBanner error={approveMutation.error || rejectMutation.error} />
                                    <div className="flex gap-3 justify-end mt-4">
                                        <Button variant="outline" onClick={handleCloseModal}>
                                            Cancel
                                        </Button>
                                        <Button
                                            className={actionType === 'APPROVE' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'}
                                            onClick={handleSubmitReview}
                                            disabled={approveMutation.isPending || rejectMutation.isPending}
                                        >
                                            {actionType === 'APPROVE' ? 'Approve request' : 'Reject request'}
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

function RequestCard({ request, onApprove, onReject, isHistory }: { request: ApprovalRow; onApprove?: () => void; onReject?: () => void; isHistory?: boolean }) {
    const isDelete = request.action === 'DELETE';

    return (
        <article className="p-4 sm:p-5">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="min-w-0 flex-1 space-y-2">
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
                            <h3 className="break-words text-sm font-semibold text-slate-900">{request.entity_name}</h3>
                            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 mt-1">
                                <UserIcon className="w-4 h-4" />
                                <span>Requested by <span className="font-medium text-slate-700">{request.requested_by_name || 'Employee'}</span></span>
                                <span>•</span>
                                <Clock className="w-4 h-4" />
                                <span>{format(new Date(request.created_at), 'MMM d, yyyy h:mm a')}</span>
                            </div>
                        </div>

                        <div className="break-words text-sm text-slate-600">
                            <span className="font-medium text-slate-900">Reason: </span>
                            {request.message}
                        </div>

                        {isHistory && request.review_note && (
                            <div className="text-xs text-slate-500 italic">
                                Review note: {request.review_note}
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
        </article>
    );
}
