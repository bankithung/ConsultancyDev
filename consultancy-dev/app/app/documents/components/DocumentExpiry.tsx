'use client';

import { useMemo, useState } from 'react';
import { differenceInCalendarDays, format } from 'date-fns';
import { AlertTriangle, Bell, Calendar, FileText, Search } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PaginationBar } from '@/components/common/PaginationBar';
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states';
import { apiClient } from '@/lib/apiClient';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { useDebounce } from '@/hooks/useDebounce';
import type { Document } from '@/lib/types';

type ExpiryStatus = 'Expired' | 'Expiring Soon' | 'Valid';

/** Documents inside this window are flagged as expiring soon. */
const SOON_WINDOW_DAYS = 90;

interface ExpiryRow {
    document: Document;
    expiryDate: string;
    daysUntilExpiry: number;
    status: ExpiryStatus;
}

function classify(days: number): ExpiryStatus {
    if (days < 0) return 'Expired';
    if (days <= SOON_WINDOW_DAYS) return 'Expiring Soon';
    return 'Valid';
}

const STATUS_STYLE: Record<ExpiryStatus, string> = {
    Expired: 'bg-red-100 text-red-700',
    'Expiring Soon': 'bg-yellow-100 text-yellow-700',
    Valid: 'bg-green-100 text-green-700',
};

export function DocumentExpiry() {
    const [searchInput, setSearchInput] = useState('');
    const search = useDebounce(searchInput, 300);
    const [statusFilter, setStatusFilter] = useState<'all' | ExpiryStatus>('all');

    // `documents/expiring-soon/` returns the same Document shape as the list
    // endpoint; the status is derived here so the thresholds stay visible.
    const documents = usePaginatedQuery<Document>(['documents-expiring'], apiClient.documents.getExpiringSoon, {
        search,
        ordering: 'expiry_date',
    });

    const rows = useMemo<ExpiryRow[]>(() => {
        const today = new Date();
        return documents.rows
            .filter((document): document is Document & { expiryDate: string } => Boolean(document.expiryDate))
            .map((document) => {
                const days = differenceInCalendarDays(new Date(document.expiryDate), today);
                return {
                    document,
                    expiryDate: document.expiryDate,
                    daysUntilExpiry: days,
                    status: classify(days),
                };
            });
    }, [documents.rows]);

    const visible = statusFilter === 'all' ? rows : rows.filter((row) => row.status === statusFilter);

    const counts = useMemo(
        () => ({
            expired: rows.filter((row) => row.status === 'Expired').length,
            soon: rows.filter((row) => row.status === 'Expiring Soon').length,
            valid: rows.filter((row) => row.status === 'Valid').length,
        }),
        [rows],
    );

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-lg font-semibold text-slate-900 sm:text-xl">Document expiry tracking</h2>
                <p className="mt-1 text-sm text-slate-600">Monitor document validity and prevent last-minute issues</p>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Card className="border-red-200 bg-gradient-to-br from-red-50 to-white">
                    <CardContent className="p-5">
                        <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                                <p className="truncate text-sm font-medium text-slate-600 font-body">Expired</p>
                                <h3 className="text-2xl font-bold text-red-600 font-heading">
                                    {counts.expired}
                                </h3>
                            </div>
                            <AlertTriangle className="h-8 w-8 shrink-0 text-red-600 sm:h-10 sm:w-10" />
                        </div>
                        <p className="mt-2 text-xs font-semibold text-red-600 font-body">Immediate action required</p>
                    </CardContent>
                </Card>

                <Card className="border-yellow-200 bg-gradient-to-br from-yellow-50 to-white">
                    <CardContent className="p-5">
                        <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                                <p className="truncate text-sm font-medium text-slate-600 font-body">Expiring soon</p>
                                <h3 className="text-2xl font-bold text-yellow-600 font-heading">
                                    {counts.soon}
                                </h3>
                            </div>
                            <Bell className="h-8 w-8 shrink-0 text-yellow-600 sm:h-10 sm:w-10" />
                        </div>
                        <p className="mt-2 text-xs font-semibold text-yellow-600 font-body">
                            Within {SOON_WINDOW_DAYS} days
                        </p>
                    </CardContent>
                </Card>

                <Card className="border-green-200 bg-gradient-to-br from-green-50 to-white">
                    <CardContent className="p-5">
                        <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                                <p className="truncate text-sm font-medium text-slate-600 font-body">Valid</p>
                                <h3 className="text-2xl font-bold text-green-600 font-heading">
                                    {counts.valid}
                                </h3>
                            </div>
                            <FileText className="h-8 w-8 shrink-0 text-green-600 sm:h-10 sm:w-10" />
                        </div>
                        <p className="mt-2 text-xs font-semibold text-green-600 font-body">No action needed</p>
                    </CardContent>
                </Card>
            </div>

            <Card className="border-slate-200 bg-slate-50">
                <CardContent className="pt-6">
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                        <div className="relative">
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                            <Input
                                placeholder="Search by student or file…"
                                aria-label="Search expiring documents"
                                value={searchInput}
                                onChange={(e) => setSearchInput(e.target.value)}
                                className="h-10 bg-white pl-10"
                            />
                        </div>
                        <Select
                            value={statusFilter}
                            onValueChange={(value) => setStatusFilter(value as 'all' | ExpiryStatus)}
                        >
                            <SelectTrigger className="h-10 bg-white" aria-label="Filter by expiry status">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All statuses</SelectItem>
                                <SelectItem value="Expired">Expired</SelectItem>
                                <SelectItem value="Expiring Soon">Expiring soon</SelectItem>
                                <SelectItem value="Valid">Valid</SelectItem>
                            </SelectContent>
                        </Select>
                        <Button
                            variant="outline"
                            className="h-10"
                            onClick={() => {
                                setStatusFilter('all');
                                setSearchInput('');
                            }}
                            disabled={statusFilter === 'all' && searchInput === ''}
                        >
                            Clear filters
                        </Button>
                    </div>
                </CardContent>
            </Card>

            {documents.isError ? (
                <ErrorState error={documents.error} onRetry={documents.refetch} />
            ) : documents.isLoading ? (
                <LoadingState rows={4} label="Loading expiring documents" />
            ) : visible.length === 0 ? (
                <EmptyState
                    icon={Calendar}
                    title="Nothing expiring"
                    description="Documents with an expiry date appear here as the date approaches."
                />
            ) : (
                <Card className="overflow-hidden border-slate-200">
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[560px] text-sm">
                            <thead className="border-b border-slate-200 bg-slate-50">
                                <tr>
                                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-700">
                                        Document
                                    </th>
                                    <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase text-slate-700 md:table-cell">
                                        Student
                                    </th>
                                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-700">
                                        Expiry date
                                    </th>
                                    <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase text-slate-700 lg:table-cell">
                                        Days left
                                    </th>
                                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-700">
                                        Status
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 bg-white">
                                {visible.map((row) => (
                                    <tr key={row.document.id} className="hover:bg-slate-50">
                                        <td className="px-4 py-4">
                                            <div className="flex items-center gap-2">
                                                <FileText size={16} className="shrink-0 text-teal-500" />
                                                <div className="min-w-0">
                                                    <p className="truncate text-sm font-semibold text-slate-900 font-body">
                                                        {row.document.type}
                                                    </p>
                                                    <p className="max-w-[200px] truncate text-xs text-slate-500 font-body">
                                                        {row.document.fileName}
                                                    </p>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="hidden px-4 py-4 text-sm text-slate-700 font-body md:table-cell">
                                            {row.document.studentName || '—'}
                                        </td>
                                        <td className="px-4 py-4">
                                            <div className="flex items-center gap-2">
                                                <Calendar size={14} className="shrink-0 text-slate-400" />
                                                <span className="whitespace-nowrap text-sm font-medium text-slate-900 font-body">
                                                    {format(new Date(row.expiryDate), 'dd MMM yyyy')}
                                                </span>
                                            </div>
                                        </td>
                                        <td className="hidden px-4 py-4 lg:table-cell">
                                            <span
                                                className={`whitespace-nowrap text-sm font-semibold font-body ${
                                                    row.daysUntilExpiry < 0
                                                        ? 'text-red-600'
                                                        : row.daysUntilExpiry <= SOON_WINDOW_DAYS
                                                          ? 'text-yellow-600'
                                                          : 'text-green-600'
                                                }`}
                                            >
                                                {row.daysUntilExpiry < 0
                                                    ? `${Math.abs(row.daysUntilExpiry)} days ago`
                                                    : `${row.daysUntilExpiry} days`}
                                            </span>
                                        </td>
                                        <td className="px-4 py-4">
                                            <span
                                                className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_STYLE[row.status]}`}
                                            >
                                                {row.status}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <PaginationBar
                        page={documents.page}
                        pages={documents.pages}
                        count={documents.count}
                        pageSize={documents.pageSize}
                        onPageChange={documents.setPage}
                        isLoading={documents.isFetching}
                    />
                </Card>
            )}
        </div>
    );
}
