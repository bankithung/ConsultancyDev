'use client';

import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { ArrowRightLeft, CheckCircle, FileUp, History } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states';
import { apiClient } from '@/lib/apiClient';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import type { Document, RecordTransfer } from '@/lib/types';

type EventType = 'upload' | 'transfer' | 'resolved';

interface TimelineEvent {
    id: string;
    date: Date;
    title: string;
    description: string;
    type: EventType;
}

const DOT_COLOR: Record<EventType, string> = {
    upload: 'bg-blue-600',
    transfer: 'bg-purple-600',
    resolved: 'bg-green-600',
};

const EVENT_ICON: Record<EventType, React.ComponentType<{ size?: number; className?: string }>> = {
    upload: FileUp,
    transfer: ArrowRightLeft,
    resolved: CheckCircle,
};

/** How many of each source feed the timeline. */
const WINDOW = 50;

/**
 * Document history, assembled from the two records the API actually keeps:
 * document uploads and the record transfers that moved their custody. There is
 * no separate audit-log endpoint, so nothing here is invented.
 *
 * The documents panel supplies the heading and the surface; this contributes
 * the filter row and the timeline itself.
 */
export function DocumentTracking() {
    const [filterType, setFilterType] = useState<'all' | EventType>('all');

    const documents = usePaginatedQuery<Document>(['documents-timeline'], apiClient.documents.list, {
        pageSize: WINDOW,
        ordering: '-uploaded_at',
    });

    const transfers = usePaginatedQuery<RecordTransfer>(['transfers', 'documents-timeline'], apiClient.transfers.list, {
        pageSize: WINDOW,
        ordering: '-created_at',
        filters: { entity_type: 'document' },
    });

    const events = useMemo<TimelineEvent[]>(() => {
        const uploads: TimelineEvent[] = documents.rows.map((doc) => ({
            id: `upload-${doc.id}`,
            date: new Date(doc.uploadedAt),
            title: 'Document uploaded',
            description: `${doc.fileName}${doc.studentName ? ` for ${doc.studentName}` : ''}`,
            type: 'upload',
        }));

        const moves: TimelineEvent[] = transfers.rows.flatMap((transfer) => {
            const label = transfer.entity_label || `Document #${transfer.entity_id}`;
            const rows: TimelineEvent[] = [
                {
                    id: `transfer-${transfer.id}`,
                    date: new Date(transfer.created_at),
                    title: 'Transfer initiated',
                    description: `${label} sent from ${transfer.from_user_name} to ${transfer.to_user_name}`,
                    type: 'transfer',
                },
            ];

            if (transfer.resolved_at && transfer.status !== 'PENDING') {
                rows.push({
                    id: `resolved-${transfer.id}`,
                    date: new Date(transfer.resolved_at),
                    title: transfer.status === 'ACCEPTED' ? 'Transfer accepted' : `Transfer ${transfer.status.toLowerCase()}`,
                    description: `${label} — ${transfer.to_user_name}`,
                    type: 'resolved',
                });
            }
            return rows;
        });

        return [...uploads, ...moves]
            .filter((event) => !Number.isNaN(event.date.getTime()))
            .sort((a, b) => b.date.getTime() - a.date.getTime());
    }, [documents.rows, transfers.rows]);

    const visible = filterType === 'all' ? events : events.filter((event) => event.type === filterType);

    const isLoading = documents.isLoading || transfers.isLoading;
    const error = documents.isError ? documents.error : transfers.isError ? transfers.error : null;

    return (
        <div>
            <div className="flex flex-col gap-2 border-b border-slate-100 p-3 sm:flex-row sm:items-center sm:justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Activity timeline</h3>
                <div className="w-full sm:w-56">
                    <Select value={filterType} onValueChange={(value) => setFilterType(value as 'all' | EventType)}>
                        <SelectTrigger className="h-9 bg-white text-sm" aria-label="Filter activity type">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All activity</SelectItem>
                            <SelectItem value="upload">Uploads</SelectItem>
                            <SelectItem value="transfer">Transfers sent</SelectItem>
                            <SelectItem value="resolved">Transfers resolved</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
            </div>

            {/* Capped width: a timeline is a column of prose, and the panel is as
                wide as the screen. */}
            <div className="max-w-4xl p-4">
                {error ? (
                    <ErrorState
                        error={error}
                        onRetry={() => {
                            documents.refetch();
                            transfers.refetch();
                        }}
                    />
                ) : isLoading ? (
                    <LoadingState rows={4} label="Loading activity" />
                ) : visible.length === 0 ? (
                    <EmptyState
                        icon={History}
                        title={filterType === 'all' ? 'No activity yet' : 'No activity of this kind'}
                        description="Uploading a document or transferring one records an entry here."
                    />
                ) : (
                    <ol className="relative ml-4 space-y-6 border-l-2 border-slate-200 py-2">
                        {visible.map((event) => {
                            const Icon = EVENT_ICON[event.type];
                            return (
                                <li key={event.id} className="relative pl-6 sm:pl-8">
                                    <span
                                        className={`absolute -left-[9px] top-1 h-4 w-4 rounded-full ring-4 ring-white ${DOT_COLOR[event.type]}`}
                                        aria-hidden
                                    />
                                    <div className="border-b border-slate-100 pb-6 last:border-0 last:pb-0">
                                        <div className="mb-1 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                                            <h4 className="flex items-center gap-2 text-sm font-bold text-slate-900 sm:text-base">
                                                <Icon size={15} className="shrink-0 text-slate-400" />
                                                {event.title}
                                            </h4>
                                            <time
                                                dateTime={event.date.toISOString()}
                                                className="shrink-0 whitespace-nowrap text-xs text-slate-500"
                                            >
                                                {format(event.date, 'dd MMM yyyy, HH:mm')}
                                            </time>
                                        </div>
                                        <p className="break-words text-sm text-slate-600 font-body">
                                            {event.description}
                                        </p>
                                    </div>
                                </li>
                            );
                        })}
                    </ol>
                )}
            </div>
        </div>
    );
}
