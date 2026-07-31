'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { toArray } from '@/components/common/pagination';
import { ErrorState, LoadingState } from '@/components/common/states';
import { useAuth } from '@/hooks/useAuth';
import { useDebounce } from '@/hooks/useDebounce';
import { Send, CheckCircle, Clock, Package, Search, XCircle, ArrowRight, FileText, Eye } from 'lucide-react';
import { format } from 'date-fns';
import { useToast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import type { RecordTransferStatus } from '@/lib/types';

/**
 * Standalone document handover screen.
 *
 * Custody moves through `apiClient.transfers` — the real RecordTransfer
 * mechanism that actually reassigns ownership — with `entity_type: 'document'`,
 * matching the tabbed view at /app/documents. The old `documentTransfers`
 * create/accept/reject calls never existed on this backend; that resource is
 * read-only.
 *
 * One transfer carries ONE document, because each document is independently
 * owned. This page differs from the embedded tab by letting the recipient
 * accept or reject inline instead of sending them to /app/transfers.
 */

/** Wire values are UPPERCASE; these are the labels people read. */
const STATUS_LABEL: Record<RecordTransferStatus, string> = {
    PENDING: 'Pending',
    ACCEPTED: 'Accepted',
    REJECTED: 'Rejected',
    CANCELLED: 'Cancelled',
};

const STATUS_BADGE: Record<RecordTransferStatus, string> = {
    PENDING: 'bg-yellow-50 text-yellow-700 border-yellow-200',
    ACCEPTED: 'bg-green-50 text-green-700 border-green-200',
    REJECTED: 'bg-red-50 text-red-700 border-red-200',
    CANCELLED: 'bg-slate-100 text-slate-600 border-slate-200',
};

const STATUS_ICON_WRAP: Record<RecordTransferStatus, string> = {
    PENDING: 'bg-yellow-100 text-yellow-600',
    ACCEPTED: 'bg-green-100 text-green-600',
    REJECTED: 'bg-red-100 text-red-600',
    CANCELLED: 'bg-slate-100 text-slate-500',
};

function formatDateTime(value: string | null): string {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : format(date, 'PPP p');
}

export default function DocumentTransferPage() {
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const { user } = useAuth();
    const [selectedDocs, setSelectedDocs] = useState<string[]>([]);
    const [receiverId, setReceiverId] = useState<string>('');
    const [note, setNote] = useState('');
    const [searchInput, setSearchInput] = useState('');
    const searchTerm = useDebounce(searchInput, 300);

    const usersQuery = useQuery({
        // A thunk, not a bare reference: `list` takes PageParams, and passing it
        // directly would hand react-query's QueryFunctionContext to it.
        queryFn: () => apiClient.users.list({ page_size: 200, ordering: 'first_name' }),
        queryKey: ['users', 'transfer-recipients'],
        staleTime: 5 * 60_000,
    });

    // Only documents currently held (status IN) can be handed over. `IN`/`OUT`
    // are the server's own vocabulary for a document's custody state.
    const documentsQuery = useQuery({
        queryKey: ['documents', 'transferable', searchTerm],
        queryFn: () =>
            apiClient.documents.list({
                page_size: 50,
                ordering: '-uploaded_at',
                search: searchTerm,
                filters: { status: 'IN' },
            }),
    });

    const transfersQuery = useQuery({
        queryKey: ['transfers', 'documents'],
        queryFn: () =>
            apiClient.transfers.list({
                page_size: 20,
                ordering: '-created_at',
                filters: { entity_type: 'document' },
            }),
    });

    const users = toArray(usersQuery.data);
    const availableDocs = toArray(documentsQuery.data);
    const transfers = toArray(transfersQuery.data);

    const invalidate = () => {
        void queryClient.invalidateQueries({ queryKey: ['transfers'] });
        void queryClient.invalidateQueries({ queryKey: ['documents'] });
    };

    const createTransferMutation = useMutation({
        mutationFn: async () => {
            await Promise.all(
                selectedDocs.map((documentId) =>
                    apiClient.transfers.create({
                        entity_type: 'document',
                        entity_id: Number(documentId),
                        to_user: Number(receiverId),
                        note,
                    }),
                ),
            );
            return selectedDocs.length;
        },
        onSuccess: (count) => {
            invalidate();
            setSelectedDocs([]);
            setReceiverId('');
            setNote('');
            toast({
                title: 'Transfer sent',
                description: `${count} document${count === 1 ? '' : 's'} sent for acceptance.`,
                type: 'success',
            });
        },
        onError: () => {
            toast({ title: 'Error', description: 'Failed to initiate transfer', type: 'error' });
        },
    });

    const acceptTransferMutation = useMutation({
        mutationFn: (id: number) => apiClient.transfers.accept(id),
        onSuccess: () => {
            invalidate();
            toast({ title: 'Transfer accepted', description: 'Custody has moved to you.', type: 'success' });
        },
        onError: () => toast({ title: 'Error', description: 'Failed to accept transfer', type: 'error' }),
    });

    const rejectTransferMutation = useMutation({
        mutationFn: (id: number) => apiClient.transfers.reject(id),
        onSuccess: () => {
            invalidate();
            toast({ title: 'Transfer rejected', description: 'The sender keeps custody.', type: 'success' });
        },
        onError: () => toast({ title: 'Error', description: 'Failed to reject transfer', type: 'error' }),
    });

    const handleSend = () => {
        if (selectedDocs.length === 0 || receiverId === '') return;
        createTransferMutation.mutate();
    };

    const toggleDoc = (id: string) => {
        setSelectedDocs((current) =>
            current.includes(id) ? current.filter((docId) => docId !== id) : [...current, id],
        );
    };

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-slate-900 font-heading">Document Transfer</h1>
                    <p className="text-sm text-slate-600 mt-1 font-body">Track and manage document movements</p>
                </div>
                <Button variant="outline" size="sm" className="shrink-0" asChild>
                    <Link href="/app/documents?tab=digital-transfer">Open in Documents</Link>
                </Button>
            </div>

            <Tabs defaultValue="new" className="space-y-6">
                <TabsList>
                    <TabsTrigger value="new">New Transfer</TabsTrigger>
                    <TabsTrigger value="history">Transfer History</TabsTrigger>
                </TabsList>

                <TabsContent value="new">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <Card className="border-slate-200">
                            <CardHeader className="bg-gradient-to-r from-teal-50 to-white border-b border-slate-100">
                                <CardTitle className="text-lg font-semibold font-heading flex items-center gap-2">
                                    <Package className="h-5 w-5 text-teal-600" />
                                    Select Details
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="pt-6 space-y-6">
                                <div className="space-y-2">
                                    <Label className="font-body font-medium">Receiver</Label>
                                    <Select onValueChange={setReceiverId} value={receiverId}>
                                        <SelectTrigger className="h-11">
                                            <SelectValue placeholder="Select team member..." />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {users
                                                .filter((u) => u.id !== user?.id)
                                                .map((u) => (
                                                    <SelectItem key={u.id} value={String(u.id)}>
                                                        {u.full_name || u.username} ({u.username})
                                                    </SelectItem>
                                                ))}
                                        </SelectContent>
                                    </Select>
                                    {usersQuery.isError && (
                                        <p className="text-xs text-red-600">Could not load team members.</p>
                                    )}
                                </div>

                                <div className="space-y-2">
                                    <Label className="font-body font-medium">
                                        Documents to Transfer ({selectedDocs.length})
                                    </Label>
                                    <div className="relative mb-2">
                                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                                        <Input
                                            placeholder="Search available documents..."
                                            value={searchInput}
                                            onChange={(e) => setSearchInput(e.target.value)}
                                            className="pl-10 h-10"
                                        />
                                    </div>
                                    <div className="max-h-80 overflow-y-auto border border-slate-200 rounded-lg bg-white">
                                        {documentsQuery.isLoading ? (
                                            <div className="p-4">
                                                <LoadingState rows={3} label="Loading documents…" />
                                            </div>
                                        ) : documentsQuery.isError ? (
                                            <div className="p-4">
                                                <ErrorState
                                                    error={documentsQuery.error}
                                                    onRetry={() => void documentsQuery.refetch()}
                                                    title="Could not load documents"
                                                />
                                            </div>
                                        ) : availableDocs.length === 0 ? (
                                            <div className="p-8 text-center text-slate-500">
                                                <FileText className="mx-auto h-8 w-8 mb-2 opacity-50" />
                                                <p>No available documents found</p>
                                            </div>
                                        ) : (
                                            <div className="p-2 space-y-1">
                                                {availableDocs.map((doc) => (
                                                    <div
                                                        key={doc.id}
                                                        role="button"
                                                        tabIndex={0}
                                                        className={`flex items-center gap-3 p-3 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer ${selectedDocs.includes(doc.id) ? 'bg-teal-50 border border-teal-200' : 'border border-transparent'}`}
                                                        onClick={() => toggleDoc(doc.id)}
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter' || e.key === ' ') {
                                                                e.preventDefault();
                                                                toggleDoc(doc.id);
                                                            }
                                                        }}
                                                    >
                                                        <Checkbox
                                                            checked={selectedDocs.includes(doc.id)}
                                                            onCheckedChange={() => toggleDoc(doc.id)}
                                                            aria-label={`Select ${doc.fileName}`}
                                                        />
                                                        <div className="flex-1 min-w-0">
                                                            <p className="font-semibold text-slate-900 truncate">{doc.fileName}</p>
                                                            <div className="flex items-center gap-2 text-xs text-slate-500">
                                                                <span className="truncate">{doc.studentName || 'No Student'}</span>
                                                                <span>•</span>
                                                                <span className="shrink-0">{doc.type}</span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <Label className="font-body font-medium" htmlFor="transfer-note">
                                        Note (optional)
                                    </Label>
                                    <Textarea
                                        id="transfer-note"
                                        value={note}
                                        onChange={(e) => setNote(e.target.value)}
                                        placeholder="Why are you handing these over?"
                                        rows={2}
                                    />
                                </div>

                                <Button
                                    className="w-full h-11 bg-teal-600 hover:bg-teal-700"
                                    onClick={handleSend}
                                    disabled={
                                        selectedDocs.length === 0 || receiverId === '' || createTransferMutation.isPending
                                    }
                                >
                                    {createTransferMutation.isPending ? 'Sending...' : 'Initiate Transfer'}
                                    <Send className="ml-2 h-4 w-4" />
                                </Button>
                            </CardContent>
                        </Card>

                        <div className="hidden lg:block space-y-6">
                            <Card className="bg-slate-50 border-slate-200 h-full">
                                <CardContent className="p-8 flex flex-col items-center justify-center text-center h-full text-slate-500">
                                    <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center mb-4 shadow-sm">
                                        <ArrowRight className="h-8 w-8 text-teal-600" />
                                    </div>
                                    <h3 className="text-lg font-semibold text-slate-900 mb-2">Transfer Process</h3>
                                    <p className="max-w-xs mx-auto">
                                        Select a team member and the documents you wish to hand over. The receiver will be
                                        notified and must accept the transfer to complete the process.
                                    </p>
                                </CardContent>
                            </Card>
                        </div>
                    </div>
                </TabsContent>

                <TabsContent value="history">
                    <Card className="border-slate-200">
                        <CardHeader>
                            <CardTitle>Transfer History</CardTitle>
                            <CardDescription>Track incoming and outgoing document transfers</CardDescription>
                        </CardHeader>
                        <CardContent>
                            {transfersQuery.isLoading ? (
                                <LoadingState rows={3} label="Loading transfers…" />
                            ) : transfersQuery.isError ? (
                                <ErrorState
                                    error={transfersQuery.error}
                                    onRetry={() => void transfersQuery.refetch()}
                                    title="Could not load transfers"
                                />
                            ) : (
                                <div className="space-y-4">
                                    {transfers.length === 0 ? (
                                        <div className="text-center py-12 text-slate-500">
                                            <Clock className="mx-auto h-10 w-10 mb-3 opacity-50" />
                                            <p>No transfer history found</p>
                                        </div>
                                    ) : (
                                        transfers.map((t) => {
                                            // Only the RECIPIENT of a still-pending transfer may respond;
                                            // the backend rejects anyone else with a 403.
                                            const canRespond = t.status === 'PENDING' && user?.id === t.to_user;
                                            const label = t.entity_label || `Document #${t.entity_id}`;

                                            return (
                                                <div
                                                    key={t.id}
                                                    className="flex flex-col gap-4 p-4 rounded-lg border border-slate-200 hover:bg-slate-50 transition-colors"
                                                >
                                                    <div className="flex flex-col sm:flex-row items-start justify-between gap-4">
                                                        <div className="flex items-start gap-4 flex-1 min-w-0">
                                                            <div className={`mt-1 p-2 rounded-full shrink-0 ${STATUS_ICON_WRAP[t.status]}`}>
                                                                {t.status === 'ACCEPTED' ? (
                                                                    <CheckCircle size={20} />
                                                                ) : t.status === 'REJECTED' || t.status === 'CANCELLED' ? (
                                                                    <XCircle size={20} />
                                                                ) : (
                                                                    <Clock size={20} />
                                                                )}
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                                <div className="flex items-center gap-2 flex-wrap">
                                                                    <span className="font-semibold text-slate-900 break-words">
                                                                        {t.from_user_name}
                                                                    </span>
                                                                    <ArrowRight size={14} className="text-slate-400 shrink-0" />
                                                                    <span className="font-semibold text-slate-900 break-words">
                                                                        {t.to_user_name}
                                                                    </span>
                                                                    <Badge variant="outline" className={STATUS_BADGE[t.status]}>
                                                                        {STATUS_LABEL[t.status]}
                                                                    </Badge>
                                                                </div>
                                                                <p className="text-sm text-slate-600 mt-1 break-words">
                                                                    {label} • {formatDateTime(t.created_at)}
                                                                </p>
                                                                {t.resolved_at && (
                                                                    <p className="text-xs text-slate-400 mt-0.5">
                                                                        {STATUS_LABEL[t.status]}: {formatDateTime(t.resolved_at)}
                                                                    </p>
                                                                )}
                                                            </div>
                                                        </div>

                                                        <Dialog>
                                                            <DialogTrigger asChild>
                                                                <Button
                                                                    variant="ghost"
                                                                    size="sm"
                                                                    className="h-8 shrink-0 text-slate-500 hover:text-teal-600"
                                                                >
                                                                    <Eye size={16} className="mr-2" /> Details
                                                                </Button>
                                                            </DialogTrigger>
                                                            <DialogContent>
                                                                <DialogHeader>
                                                                    <DialogTitle>Transfer Details</DialogTitle>
                                                                    <DialogDescription>Transfer #{t.id}</DialogDescription>
                                                                </DialogHeader>
                                                                <div className="space-y-4">
                                                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                                                                        <div>
                                                                            <span className="text-slate-500 block">Sender</span>
                                                                            <span className="font-medium break-words">{t.from_user_name}</span>
                                                                        </div>
                                                                        <div>
                                                                            <span className="text-slate-500 block">Receiver</span>
                                                                            <span className="font-medium break-words">{t.to_user_name}</span>
                                                                        </div>
                                                                        <div>
                                                                            <span className="text-slate-500 block">Status</span>
                                                                            <Badge variant="outline" className={STATUS_BADGE[t.status]}>
                                                                                {STATUS_LABEL[t.status]}
                                                                            </Badge>
                                                                        </div>
                                                                        <div>
                                                                            <span className="text-slate-500 block">Date</span>
                                                                            <span className="font-medium">{formatDateTime(t.created_at)}</span>
                                                                        </div>
                                                                    </div>

                                                                    <div>
                                                                        <h4 className="font-medium mb-2 text-sm">Document</h4>
                                                                        <div className="border rounded-md p-2 text-sm flex items-center justify-between gap-2">
                                                                            <span className="truncate" title={label}>
                                                                                {label}
                                                                            </span>
                                                                            <Badge variant="secondary" className="text-xs shrink-0">
                                                                                #{t.entity_id}
                                                                            </Badge>
                                                                        </div>
                                                                    </div>

                                                                    {t.note && (
                                                                        <div>
                                                                            <h4 className="font-medium mb-1 text-sm">Note</h4>
                                                                            <p className="text-sm text-slate-600 break-words">{t.note}</p>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            </DialogContent>
                                                        </Dialog>
                                                    </div>

                                                    {canRespond && (
                                                        <div className="flex items-center gap-2">
                                                            <Button
                                                                size="sm"
                                                                className="bg-green-600 hover:bg-green-700 text-white"
                                                                onClick={() => acceptTransferMutation.mutate(t.id)}
                                                                disabled={acceptTransferMutation.isPending}
                                                            >
                                                                Accept
                                                            </Button>
                                                            <Button
                                                                size="sm"
                                                                variant="outline"
                                                                className="text-red-600 hover:bg-red-50 border-red-200"
                                                                onClick={() => rejectTransferMutation.mutate(t.id)}
                                                                disabled={rejectTransferMutation.isPending}
                                                            >
                                                                Reject
                                                            </Button>
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })
                                    )}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>
        </div>
    );
}
