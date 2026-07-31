'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ArrowRightLeft, Download, FileText, Search, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
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
import { getApiFieldErrors } from '@/lib/api';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { useDebounce } from '@/hooks/useDebounce';
import type { Document } from '@/lib/types';

const DOC_TYPES = ['General', 'Marksheet', 'ID Proof', 'Passport', 'Certificate', 'Offer Letter', 'Visa'] as const;

/** Matches the 10 MB ceiling advertised on the drop zone. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function formatSize(bytes: number | undefined): string {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Uploaded scans (`apiClient.documents`).
 *
 * Rendered straight into the documents panel, so it brings no card and no
 * heading of its own: the toolbar, the table and the upload column are
 * regions of that one surface, divided by rules rather than stacked cards.
 */
export function DocumentList() {
    const queryClient = useQueryClient();

    const [searchInput, setSearchInput] = useState('');
    const search = useDebounce(searchInput, 300);
    const [statusFilter, setStatusFilter] = useState('all');

    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [docType, setDocType] = useState<string>('General');
    const [studentName, setStudentName] = useState('');
    const [expiryDate, setExpiryDate] = useState('');
    const [fileError, setFileError] = useState<string | null>(null);
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [uploaded, setUploaded] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<Document | null>(null);
    const [downloadingId, setDownloadingId] = useState<string | null>(null);

    const documents = usePaginatedQuery<Document>(['documents'], apiClient.documents.list, {
        search,
        ordering: '-uploaded_at',
        filters: statusFilter === 'all' ? undefined : { status: statusFilter },
    });

    const invalidate = () => {
        queryClient.invalidateQueries({ queryKey: ['documents'] });
        queryClient.invalidateQueries({ queryKey: ['documents-expiring'] });
    };

    const uploadMutation = useMutation({
        mutationFn: () => {
            if (!selectedFile) throw new Error('Choose a file to upload.');
            return apiClient.documents.upload({
                file: selectedFile,
                type: docType,
                studentName: studentName || undefined,
                expiryDate: expiryDate || undefined,
            });
        },
        onSuccess: () => {
            invalidate();
            setSelectedFile(null);
            setStudentName('');
            setExpiryDate('');
            setFieldErrors({});
            setUploaded(true);
        },
        onError: (error: unknown) => {
            setUploaded(false);
            setFieldErrors(getApiFieldErrors(error) ?? {});
        },
    });

    const toggleStatusMutation = useMutation({
        mutationFn: ({ id, status }: { id: string; status: Document['status'] }) =>
            apiClient.documents.toggleStatus(id, status),
        onSuccess: invalidate,
    });

    const deleteMutation = useMutation({
        mutationFn: (doc: Document) => apiClient.documents.delete(doc.id),
        onSuccess: () => {
            invalidate();
            setDeleteTarget(null);
        },
    });

    const downloadMutation = useMutation({
        mutationFn: (doc: Document) => apiClient.documents.downloadAndSave(doc.id, doc.fileName),
        onSettled: () => setDownloadingId(null),
    });

    const handleFileChange = (file: File | null) => {
        setUploaded(false);
        if (file && file.size > MAX_UPLOAD_BYTES) {
            setSelectedFile(null);
            setFileError(`“${file.name}” is ${formatSize(file.size)}. The limit is 10 MB.`);
            return;
        }
        setFileError(null);
        setSelectedFile(file);
    };

    const mutationError = toggleStatusMutation.error ?? deleteMutation.error ?? downloadMutation.error;

    return (
        <div>
            {mutationError && (
                <div className="border-b border-slate-100 p-3">
                    <ErrorBanner
                        error={mutationError}
                        onDismiss={() => {
                            toggleStatusMutation.reset();
                            deleteMutation.reset();
                            downloadMutation.reset();
                        }}
                    />
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3">
                <div className="min-w-0 lg:col-span-2">
                    <div className="flex flex-col gap-2 border-b border-slate-100 p-3 sm:flex-row sm:items-center">
                        <div className="relative min-w-0 flex-1">
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                            <Input
                                placeholder="Search documents or students…"
                                aria-label="Search documents"
                                className="h-9 border-slate-200 pl-9 text-sm"
                                value={searchInput}
                                onChange={(e) => setSearchInput(e.target.value)}
                            />
                        </div>
                        <Select value={statusFilter} onValueChange={setStatusFilter}>
                            <SelectTrigger className="h-9 text-sm sm:w-44" aria-label="Filter by custody status">
                                <SelectValue placeholder="All" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All documents</SelectItem>
                                <SelectItem value="IN">In custody</SelectItem>
                                <SelectItem value="OUT">Checked out</SelectItem>
                            </SelectContent>
                        </Select>
                        <span className="shrink-0 text-xs text-slate-500">{documents.count} files</span>
                    </div>

                    {documents.isError ? (
                        <div className="p-4">
                            <ErrorState error={documents.error} onRetry={documents.refetch} />
                        </div>
                    ) : documents.isLoading ? (
                        <div className="p-4">
                            <LoadingState rows={4} label="Loading documents" />
                        </div>
                    ) : documents.rows.length === 0 ? (
                        <div className="p-4">
                            <EmptyState
                                icon={FileText}
                                title={search || statusFilter !== 'all' ? 'No documents match' : 'No documents yet'}
                                description={
                                    search || statusFilter !== 'all'
                                        ? 'Try a different search term or status.'
                                        : 'Upload a student document using the panel alongside.'
                                }
                            />
                        </div>
                    ) : (
                        <>
                            <div className="overflow-x-auto">
                                <table className="w-full min-w-[560px] text-left text-sm">
                                    <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-600">
                                        <tr>
                                            <th className="px-4 py-3">File</th>
                                            <th className="hidden px-4 py-3 md:table-cell">Student</th>
                                            <th className="hidden px-4 py-3 sm:table-cell">Type</th>
                                            <th className="px-4 py-3">Status</th>
                                            <th className="hidden px-4 py-3 lg:table-cell">Date</th>
                                            <th className="px-4 py-3 text-right">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-100">
                                        {documents.rows.map((doc) => (
                                            <tr key={doc.id} className="transition-colors hover:bg-slate-50">
                                                <td className="px-4 py-3">
                                                    <div className="flex items-center gap-2">
                                                        <FileText size={16} className="shrink-0 text-teal-500" />
                                                        <div className="min-w-0">
                                                            <p className="truncate font-medium text-slate-900">
                                                                {doc.fileName}
                                                            </p>
                                                            <p className="truncate text-xs text-slate-500 md:hidden">
                                                                {doc.studentName || 'Unassigned'}
                                                            </p>
                                                        </div>
                                                    </div>
                                                </td>
                                                <td className="hidden px-4 py-3 text-slate-600 md:table-cell">
                                                    {doc.studentName || '—'}
                                                </td>
                                                <td className="hidden px-4 py-3 text-slate-600 sm:table-cell">
                                                    {doc.type}
                                                </td>
                                                <td className="px-4 py-3">
                                                    <span
                                                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
                                                            doc.status === 'IN'
                                                                ? 'bg-green-100 text-green-700'
                                                                : 'bg-orange-100 text-orange-700'
                                                        }`}
                                                    >
                                                        {doc.status}
                                                    </span>
                                                </td>
                                                <td className="hidden whitespace-nowrap px-4 py-3 text-xs text-slate-500 lg:table-cell">
                                                    {format(new Date(doc.uploadedAt), 'dd MMM yyyy')}
                                                </td>
                                                <td className="px-4 py-3">
                                                    <div className="flex justify-end gap-1">
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            className="h-8 w-8 p-0 hover:bg-blue-50 hover:text-blue-600"
                                                            onClick={() => {
                                                                setDownloadingId(doc.id);
                                                                downloadMutation.mutate(doc);
                                                            }}
                                                            disabled={downloadingId === doc.id}
                                                            aria-label={`Download ${doc.fileName}`}
                                                        >
                                                            {downloadingId === doc.id ? (
                                                                <InlineSpinner />
                                                            ) : (
                                                                <Download size={14} />
                                                            )}
                                                        </Button>
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            className="h-8 w-8 p-0 hover:bg-teal-50 hover:text-teal-600"
                                                            onClick={() =>
                                                                toggleStatusMutation.mutate({
                                                                    id: doc.id,
                                                                    status: doc.status === 'IN' ? 'OUT' : 'IN',
                                                                })
                                                            }
                                                            disabled={toggleStatusMutation.isPending}
                                                            aria-label={`Mark ${doc.fileName} as ${
                                                                doc.status === 'IN' ? 'checked out' : 'in custody'
                                                            }`}
                                                            title="Toggle custody"
                                                        >
                                                            <ArrowRightLeft size={14} />
                                                        </Button>
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            className="h-8 w-8 p-0 hover:bg-red-50 hover:text-red-600"
                                                            onClick={() => setDeleteTarget(doc)}
                                                            aria-label={`Delete ${doc.fileName}`}
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
                                page={documents.page}
                                pages={documents.pages}
                                count={documents.count}
                                pageSize={documents.pageSize}
                                onPageChange={documents.setPage}
                                isLoading={documents.isFetching}
                            />
                        </>
                    )}
                </div>

                {/*
                    The upload form used to be `lg:sticky`, which stopped working
                    the moment it moved inside the panel: the panel clips its own
                    overflow, so the sticky box has nowhere to travel. Tinting it
                    instead marks it as the other half of the split.
                */}
                <aside className="border-t border-slate-200 bg-slate-50/60 p-3 lg:border-l lg:border-t-0">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                        Upload document
                    </h3>

                    <div className="mt-3 space-y-4">
                        {uploadMutation.isError && <ErrorBanner error={uploadMutation.error} />}
                        {uploaded && (
                            <SuccessBanner message="Document uploaded." onDismiss={() => setUploaded(false)} />
                        )}

                        <div className="space-y-2">
                            <Label htmlFor="doc-student" className="font-medium text-slate-700">
                                Student name
                            </Label>
                            <Input
                                id="doc-student"
                                placeholder="Who does this belong to?"
                                value={studentName}
                                onChange={(e) => setStudentName(e.target.value)}
                                className="h-10 bg-white"
                            />
                            {fieldErrors.student_name && (
                                <p className="text-xs text-red-600">{fieldErrors.student_name}</p>
                            )}
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="doc-type" className="font-medium text-slate-700">
                                Document type
                            </Label>
                            <Select value={docType} onValueChange={setDocType}>
                                <SelectTrigger id="doc-type" className="h-10 bg-white">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {DOC_TYPES.map((type) => (
                                        <SelectItem key={type} value={type}>
                                            {type}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            {fieldErrors.type && <p className="text-xs text-red-600">{fieldErrors.type}</p>}
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="doc-expiry" className="font-medium text-slate-700">
                                Expiry date <span className="font-normal text-slate-400">(optional)</span>
                            </Label>
                            <Input
                                id="doc-expiry"
                                type="date"
                                className="h-10 bg-white"
                                value={expiryDate}
                                onChange={(e) => setExpiryDate(e.target.value)}
                            />
                            {fieldErrors.expiry_date && (
                                <p className="text-xs text-red-600">{fieldErrors.expiry_date}</p>
                            )}
                        </div>

                        <div className="group relative cursor-pointer rounded-xl border-2 border-dashed border-slate-300 bg-white p-6 text-center transition-all hover:border-teal-300 hover:bg-slate-50">
                            <input
                                type="file"
                                aria-label="Choose a file to upload"
                                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                                onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
                            />
                            <Upload className="mx-auto mb-2 h-9 w-9 text-slate-400 transition-colors group-hover:text-teal-500" />
                            <p className="break-words text-sm font-medium text-slate-600">
                                {selectedFile ? selectedFile.name : 'Drop file or click to upload'}
                            </p>
                            <p className="mt-1 text-xs text-slate-400">
                                {selectedFile ? formatSize(selectedFile.size) : 'PDF, DOC, JPG up to 10 MB'}
                            </p>
                        </div>
                        {fileError && <p className="text-xs text-red-600">{fileError}</p>}
                        {fieldErrors.file && <p className="text-xs text-red-600">{fieldErrors.file}</p>}

                        <Button
                            className="h-10 w-full bg-teal-600 font-semibold hover:bg-teal-700"
                            disabled={!selectedFile || uploadMutation.isPending}
                            onClick={() => uploadMutation.mutate()}
                        >
                            {uploadMutation.isPending ? (
                                <>
                                    <InlineSpinner className="mr-2" /> Uploading…
                                </>
                            ) : (
                                'Upload document'
                            )}
                        </Button>
                    </div>
                </aside>
            </div>

            <ConfirmDialog
                open={deleteTarget !== null}
                onClose={() => setDeleteTarget(null)}
                onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
                title="Delete document?"
                description={`${deleteTarget?.fileName} will be permanently removed, including the stored file.`}
                confirmText="Delete"
                confirmVariant="destructive"
                isLoading={deleteMutation.isPending}
            />
        </div>
    );
}
