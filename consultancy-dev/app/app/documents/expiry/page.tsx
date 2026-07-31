'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { toArray } from '@/components/common/pagination';
import { ErrorState, LoadingState } from '@/components/common/states';
import { toast } from '@/store/toastStore';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertTriangle, FileText, Calendar, Bell, Search, Download } from 'lucide-react';
import { format, differenceInDays } from 'date-fns';

/**
 * Document expiry tracking.
 *
 * IMPORTANT: the `status` shown here is a DERIVED validity state
 * (Valid / Expiring Soon / Expired) computed from `expiryDate`. It is NOT
 * `Document.status`, whose server vocabulary is `IN` | `OUT` and describes
 * custody, not validity. Conflating the two is how the old build ended up
 * filtering on values the API never sends.
 */

/** How many days ahead counts as "expiring soon". */
const EXPIRY_WARNING_DAYS = 90;

type ExpiryState = 'Valid' | 'Expiring Soon' | 'Expired';

interface DocumentWithExpiry {
  id: string;
  fileName: string;
  type: string;
  studentName: string;
  expiryDate: string;
  expiryState: ExpiryState;
  daysUntilExpiry: number;
}

export default function DocumentExpiryPage() {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');

  const { data, isLoading, isError, error, refetch } = useQuery({
    // A thunk: `getExpiringSoon` takes PageParams and returns the paginated
    // envelope, not a bare array.
    queryKey: ['documents-expiring'],
    queryFn: () => apiClient.documents.getExpiringSoon({ page_size: 200, ordering: 'expiry_date' }),
  });

  const documents = useMemo<DocumentWithExpiry[]>(() => {
    const today = new Date();
    return toArray(data)
      .filter((doc) => Boolean(doc.expiryDate))
      .map((doc) => {
        const expiryDate = doc.expiryDate as string;
        const daysUntilExpiry = differenceInDays(new Date(expiryDate), today);
        const expiryState: ExpiryState =
          daysUntilExpiry < 0 ? 'Expired' : daysUntilExpiry <= EXPIRY_WARNING_DAYS ? 'Expiring Soon' : 'Valid';
        return {
          id: doc.id,
          fileName: doc.fileName,
          type: doc.type,
          studentName: doc.studentName ?? '—',
          expiryDate,
          expiryState,
          daysUntilExpiry,
        };
      });
  }, [data]);

  const filteredDocs = useMemo(() => {
    const needle = searchTerm.toLowerCase();
    return documents.filter((doc) => {
      const matchesSearch =
        needle === '' ||
        doc.studentName.toLowerCase().includes(needle) ||
        doc.fileName.toLowerCase().includes(needle);
      const matchesFilter = filterStatus === 'all' || doc.expiryState === filterStatus;
      return matchesSearch && matchesFilter;
    });
  }, [documents, searchTerm, filterStatus]);

  const expiredCount = documents.filter((d) => d.expiryState === 'Expired').length;
  const expiringSoonCount = documents.filter((d) => d.expiryState === 'Expiring Soon').length;
  const validCount = documents.filter((d) => d.expiryState === 'Valid').length;

  const handleDownload = async (doc: DocumentWithExpiry) => {
    try {
      await apiClient.documents.downloadAndSave(doc.id, doc.fileName);
    } catch {
      toast.error('Download failed', 'The document could not be retrieved.');
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 font-heading">Document Expiry Tracking</h1>
          <p className="text-sm text-slate-600 mt-1 font-body">Monitor document validity and prevent last-minute issues</p>
        </div>
        <LoadingState rows={5} label="Loading documents…" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 font-heading">Document Expiry Tracking</h1>
          <p className="text-sm text-slate-600 mt-1 font-body">Monitor document validity and prevent last-minute issues</p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0" asChild>
          <Link href="/app/documents?tab=digital">Open in Documents</Link>
        </Button>
      </div>

      {isError && <ErrorState error={error} onRetry={() => void refetch()} title="Could not load documents" />}

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="border-red-200 bg-gradient-to-br from-red-50 to-white">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-600 font-body">Expired</p>
                <h3 className="text-2xl font-bold text-red-600 font-heading">{expiredCount}</h3>
              </div>
              <AlertTriangle className="h-10 w-10 text-red-600" />
            </div>
            <p className="text-xs text-red-600 mt-2 font-body font-semibold">Immediate action required</p>
          </CardContent>
        </Card>

        <Card className="border-yellow-200 bg-gradient-to-br from-yellow-50 to-white">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-600 font-body">Expiring Soon</p>
                <h3 className="text-2xl font-bold text-yellow-600 font-heading">{expiringSoonCount}</h3>
              </div>
              <Bell className="h-10 w-10 text-yellow-600" />
            </div>
            <p className="text-xs text-yellow-600 mt-2 font-body font-semibold">Within 90 days</p>
          </CardContent>
        </Card>

        <Card className="border-green-200 bg-gradient-to-br from-green-50 to-white">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-600 font-body">Valid</p>
                <h3 className="text-2xl font-bold text-green-600 font-heading">{validCount}</h3>
              </div>
              <FileText className="h-10 w-10 text-green-600" />
            </div>
            <p className="text-xs text-green-600 mt-2 font-body font-semibold">No action needed</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card className="border-slate-200 bg-slate-50">
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <Input placeholder="Search by student or file..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="pl-10 h-10 bg-white" />
            </div>
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger className="h-10 bg-white"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="Expired">Expired</SelectItem>
                <SelectItem value="Expiring Soon">Expiring Soon</SelectItem>
                <SelectItem value="Valid">Valid</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" className="h-10" onClick={() => { setFilterStatus('all'); setSearchTerm(''); }}>
              Clear Filters
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Documents Table */}
      <Card className="border-slate-200">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700 uppercase">Document</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700 uppercase hidden md:table-cell">Student</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700 uppercase">Expiry Date</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700 uppercase hidden lg:table-cell">Days Left</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700 uppercase">Status</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-700 uppercase">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {filteredDocs.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center">
                    <FileText className="mx-auto mb-2 h-8 w-8 text-slate-300" />
                    <p className="text-sm font-semibold text-slate-900">
                      {documents.length === 0 ? 'No documents have an expiry date' : 'No documents match your filters'}
                    </p>
                    <p className="mt-1 text-sm text-slate-500">
                      {documents.length === 0
                        ? 'Set an expiry date when uploading a document to track it here.'
                        : 'Try clearing the search or status filter.'}
                    </p>
                  </td>
                </tr>
              )}
              {filteredDocs.map(doc => (
                <tr key={doc.id} className="hover:bg-slate-50">
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-2">
                      <FileText size={16} className="text-teal-500" />
                      <div>
                        <p className="text-sm font-semibold text-slate-900 font-body">{doc.type}</p>
                        <p className="text-xs text-slate-500 font-body truncate max-w-[200px]">{doc.fileName}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-4 text-sm text-slate-700 font-body hidden md:table-cell">{doc.studentName}</td>
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-2">
                      <Calendar size={14} className="text-slate-400" />
                      <span className="text-sm font-medium text-slate-900 font-body">{format(new Date(doc.expiryDate), 'dd MMM yyyy')}</span>
                    </div>
                  </td>
                  <td className="px-4 py-4 hidden lg:table-cell">
                    <span className={`text-sm font-semibold font-body ${doc.daysUntilExpiry < 0 ? 'text-red-600' :
                      doc.daysUntilExpiry < 90 ? 'text-yellow-600' :
                        'text-green-600'
                      }`}>
                      {doc.daysUntilExpiry < 0 ? `${Math.abs(doc.daysUntilExpiry)} days ago` : `${doc.daysUntilExpiry} days`}
                    </span>
                  </td>
                  <td className="px-4 py-4">
                    <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-semibold ${doc.expiryState === 'Expired' ? 'bg-red-100 text-red-700' :
                      doc.expiryState === 'Expiring Soon' ? 'bg-yellow-100 text-yellow-700' :
                        'bg-green-100 text-green-700'
                      }`}>
                      {doc.expiryState}
                    </span>
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs font-body"
                        onClick={() => void handleDownload(doc)}
                      >
                        <Download size={12} className="mr-1" /> Download
                      </Button>
                      {/* GAP: notifications are created server-side only — the
                          viewset is read-only apart from mark-read — so there is
                          no endpoint that can raise a reminder from here. Left
                          visible but disabled rather than silently doing nothing. */}
                      {doc.expiryState !== 'Valid' && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 text-xs font-body"
                          disabled
                          title="Reminders are generated by the server; there is no endpoint to raise one from here."
                        >
                          <Bell size={12} className="mr-1" /> Notify
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

