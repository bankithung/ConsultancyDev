'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { CheckCircle, Clock, Package, Search, Send, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { PaginationBar } from '@/components/common/PaginationBar';
import {
    EmptyState,
    ErrorBanner,
    ErrorState,
    InlineSpinner,
    LoadingState,
    SuccessBanner,
} from '@/components/common/states';
import { apiClient } from '@/lib/apiClient';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { useDebounce } from '@/hooks/useDebounce';
import { useAuth } from '@/hooks/useAuth';
import type { Document, RecordTransfer } from '@/lib/types';

const STATUS_STYLE: Record<RecordTransfer['status'], string> = {
    PENDING: 'bg-yellow-100 text-yellow-700',
    ACCEPTED: 'bg-green-100 text-green-700',
    REJECTED: 'bg-red-100 text-red-700',
    CANCELLED: 'bg-slate-200 text-slate-600',
};

/**
 * Handing a document to a colleague goes through the same RecordTransfer
 * mechanism as every other record type, so custody actually changes owner and
 * the recipient sees it in their /app/transfers inbox.
 *
 * The two halves are divided by a rule rather than boxed in cards: this renders
 * inside the documents panel, which is already the surface.
 */
export function DocumentTransfer() {
    const queryClient = useQueryClient();
    const { user } = useAuth();

    const [selectedDocs, setSelectedDocs] = useState<string[]>([]);
    const [receiverId, setReceiverId] = useState('');
    const [note, setNote] = useState('');
    const [searchInput, setSearchInput] = useState('');
    const search = useDebounce(searchInput, 300);
    const [sentCount, setSentCount] = useState(0);

    // Only documents currently in custody can be handed over.
    const documents = usePaginatedQuery<Document>(['documents-transfer'], apiClient.documents.list, {
        pageSize: 50,
        search,
        ordering: '-uploaded_at',
        filters: { status: 'IN' },
    });

    const recipients = useQuery({
        queryKey: ['transfer-recipients'],
        queryFn: () => apiClient.users.list({ page_size: 200, ordering: 'first_name' }),
        staleTime: 5 * 60_000,
    });

    const history = usePaginatedQuery<RecordTransfer>(['transfers', 'documents'], apiClient.transfers.list, {
        pageSize: 10,
        ordering: '-created_at',
        filters: { entity_type: 'document' },
    });

    const sendMutation = useMutation({
        mutationFn: async () => {
            if (!receiverId) throw new Error('Choose who should receive these documents.');
            // One transfer per document: each is an independently owned record.
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
            queryClient.invalidateQueries({ queryKey: ['transfers'] });
            queryClient.invalidateQueries({ queryKey: ['documents'] });
            setSentCount(count);
            setSelectedDocs([]);
            setReceiverId('');
            setNote('');
        },
    });

    const availableRecipients = (recipients.data?.results ?? []).filter((candidate) => candidate.id !== user?.id);

    const toggleDoc = (id: string, checked: boolean) => {
        setSentCount(0);
        setSelectedDocs((current) => (checked ? [...current, id] : current.filter((value) => value !== id)));
    };

    return (
        <div className="grid grid-cols-1 lg:grid-cols-2">
            <div className="space-y-4 border-b border-slate-100 p-3 sm:p-4 lg:border-b-0 lg:border-r">
                <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                    <Package size={14} className="text-teal-600" />
                    New transfer
                </h3>

                {sendMutation.isError && <ErrorBanner error={sendMutation.error} />}
                {sentCount > 0 && (
                    <SuccessBanner
                        message={`Sent ${sentCount} document${sentCount === 1 ? '' : 's'} for acceptance.`}
                        onDismiss={() => setSentCount(0)}
                    />
                )}

                <div className="space-y-2">
                    <Label htmlFor="transfer-receiver" className="font-medium font-body">
                        Send to
                    </Label>
                    <Select value={receiverId} onValueChange={setReceiverId}>
                        <SelectTrigger id="transfer-receiver" className="h-10">
                            <SelectValue placeholder={recipients.isLoading ? 'Loading…' : 'Choose a colleague…'} />
                        </SelectTrigger>
                        <SelectContent>
                            {availableRecipients.map((candidate) => (
                                <SelectItem key={candidate.id} value={String(candidate.id)}>
                                    {candidate.full_name || candidate.username}
                                    {candidate.branch_name ? ` · ${candidate.branch_name}` : ''}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    {recipients.isError && <ErrorBanner error={recipients.error} />}
                    {!recipients.isLoading && availableRecipients.length === 0 && (
                        <p className="text-xs text-slate-500">
                            There is nobody else in your company to transfer to yet.
                        </p>
                    )}
                </div>

                <div className="space-y-2">
                    <Label className="font-medium font-body">Documents ({selectedDocs.length} selected)</Label>
                    <div className="relative mb-2">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                        <Input
                            placeholder="Search documents…"
                            aria-label="Search documents to transfer"
                            value={searchInput}
                            onChange={(e) => setSearchInput(e.target.value)}
                            className="h-10 pl-10"
                        />
                    </div>

                    <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-200 bg-white">
                        {documents.isError ? (
                            <div className="p-3">
                                <ErrorState error={documents.error} onRetry={documents.refetch} />
                            </div>
                        ) : documents.isLoading ? (
                            <div className="p-3">
                                <LoadingState rows={3} label="Loading documents" />
                            </div>
                        ) : documents.rows.length === 0 ? (
                            <p className="py-8 text-center text-sm text-slate-500">
                                No documents in custody to transfer
                            </p>
                        ) : (
                            <div className="space-y-1 p-2">
                                {documents.rows.map((doc) => (
                                    <label
                                        key={doc.id}
                                        className={`flex cursor-pointer items-center gap-3 rounded-lg p-3 transition-colors hover:bg-slate-50 ${
                                            selectedDocs.includes(doc.id) ? 'border border-teal-200 bg-teal-50' : ''
                                        }`}
                                    >
                                        <Checkbox
                                            checked={selectedDocs.includes(doc.id)}
                                            onCheckedChange={(checked) => toggleDoc(doc.id, checked === true)}
                                        />
                                        <span className="min-w-0 flex-1 text-sm">
                                            <span className="block truncate font-semibold text-slate-900">
                                                {doc.fileName}
                                            </span>
                                            <span className="block truncate text-xs text-slate-500">
                                                {doc.studentName || 'Unassigned'} · {doc.type}
                                            </span>
                                        </span>
                                    </label>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                <div className="space-y-2">
                    <Label htmlFor="transfer-note" className="font-medium font-body">
                        Note <span className="font-normal text-slate-400">(optional)</span>
                    </Label>
                    <textarea
                        id="transfer-note"
                        rows={2}
                        className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        placeholder="Why are you handing these over?"
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                    />
                </div>

                <Button
                    className="h-10 w-full bg-teal-600 hover:bg-teal-700"
                    onClick={() => sendMutation.mutate()}
                    disabled={selectedDocs.length === 0 || !receiverId || sendMutation.isPending}
                >
                    {sendMutation.isPending ? (
                        <>
                            <InlineSpinner className="mr-2" /> Sending…
                        </>
                    ) : (
                        <>
                            <Send className="mr-2 h-4 w-4" /> Send transfer
                        </>
                    )}
                </Button>
            </div>

            <div className="space-y-3 p-3 sm:p-4">
                <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                    <Clock size={14} className="text-slate-400" />
                    Transfer history
                </h3>

                {history.isError ? (
                    <ErrorState error={history.error} onRetry={history.refetch} />
                ) : history.isLoading ? (
                    <LoadingState rows={3} label="Loading transfer history" />
                ) : history.rows.length === 0 ? (
                    <EmptyState
                        icon={Clock}
                        title="No document transfers yet"
                        description="Transfers you send or receive appear here."
                    />
                ) : (
                    <div className="space-y-2">
                        {history.rows.map((transfer) => {
                            const outgoing = transfer.from_user === user?.id;
                            return (
                                <div
                                    key={transfer.id}
                                    className="rounded-lg border border-slate-200 p-3 transition-colors hover:bg-slate-50"
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0 flex-1">
                                            <div className="mb-2 flex flex-wrap items-center gap-2">
                                                <p className="font-semibold text-slate-900 font-heading">
                                                    {outgoing
                                                        ? `To: ${transfer.to_user_name}`
                                                        : `From: ${transfer.from_user_name}`}
                                                </p>
                                                <span
                                                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[transfer.status]}`}
                                                >
                                                    {transfer.status}
                                                </span>
                                            </div>
                                            <p className="break-words text-sm text-slate-600 font-body">
                                                {transfer.entity_label || `Document #${transfer.entity_id}`}
                                            </p>
                                            {transfer.note && (
                                                <p className="mt-1 break-words text-xs text-slate-500">
                                                    “{transfer.note}”
                                                </p>
                                            )}
                                            <p className="mt-1 text-xs text-slate-400">
                                                {format(new Date(transfer.created_at), 'dd MMM yyyy, HH:mm')}
                                            </p>
                                        </div>

                                        <div className="shrink-0">
                                            {transfer.status === 'ACCEPTED' && (
                                                <CheckCircle size={20} className="text-green-600" />
                                            )}
                                            {transfer.status === 'REJECTED' && (
                                                <XCircle size={20} className="text-red-600" />
                                            )}
                                            {transfer.status === 'PENDING' && (
                                                <Clock size={20} className="text-yellow-600" />
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}

                        <PaginationBar
                            page={history.page}
                            pages={history.pages}
                            count={history.count}
                            pageSize={history.pageSize}
                            onPageChange={history.setPage}
                            isLoading={history.isFetching}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}
