'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { AlertCircle, FileText, Printer, RefreshCcw } from 'lucide-react';
import { apiClient } from '@/lib/apiClient';
import type { Refund, RefundStatus } from '@/lib/types';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states';
import { toast } from '@/store/toastStore';
import { loadAllPages } from '../aggregate';
import { downloadCsv, printTable } from '../exporting';
import { formatCurrency, sameName, toForeignKey } from '../constants';

interface RefundHistoryProps {
  studentName: string;
  /** Registration id — the FK a refund is filed against. */
  registrationId: string | null;
}

const STATUS_STYLE: Record<RefundStatus, string> = {
  Pending: 'bg-yellow-100 text-yellow-700',
  Approved: 'bg-green-100 text-green-700',
  Processed: 'bg-emerald-100 text-emerald-700',
  Rejected: 'bg-red-100 text-red-700',
};

/** Money that has actually left, or been cleared to leave. */
function isSettled(refund: Refund): boolean {
  return refund.status === 'Approved' || refund.status === 'Processed';
}

export function RefundHistory({ studentName, registrationId }: RefundHistoryProps) {
  // Same shape as the payments panel: the refunds endpoint declares no student
  // filter, so `search` narrows and the comparison below decides membership.
  const refundsQuery = useQuery({
    queryKey: ['refunds', 'for-student', registrationId, studentName],
    queryFn: () =>
      loadAllPages<Refund>((params) => apiClient.refunds.list(params), {
        search: studentName,
        ordering: '-created_at',
      }),
    enabled: Boolean(studentName),
  });

  const refunds = useMemo(() => {
    const rows = refundsQuery.data ?? [];
    // `student` is the registration FK and is exact; the name comparison is the
    // fallback for a student who has not registered yet.
    const registrationKey = toForeignKey(registrationId);
    return rows
      .filter((refund) =>
        registrationKey !== null ? refund.student === registrationKey : sameName(refund.student_name, studentName),
      )
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [refundsQuery.data, registrationId, studentName]);

  const totals = useMemo(() => {
    const refunded = refunds.filter(isSettled).reduce((sum, refund) => sum + Number(refund.amount), 0);
    const pending = refunds.filter((refund) => refund.status === 'Pending').length;
    return { refunded, pending };
  }, [refunds]);

  const exportCsv = () => {
    downloadCsv(
      `${studentName}_refunds_${format(new Date(), 'yyyy-MM-dd')}.csv`,
      ['Date', 'Amount', 'Reason', 'Status'],
      refunds.map((refund) => [
        refund.created_at ? format(new Date(refund.created_at), 'dd/MM/yyyy') : '—',
        refund.amount,
        refund.reason,
        refund.status,
      ]),
    );
    toast.success(`Exported ${refunds.length} refund${refunds.length === 1 ? '' : 's'}`);
  };

  const print = () => {
    const opened = printTable({
      title: `Refund history — ${studentName}`,
      subtitle: `Generated ${format(new Date(), 'dd MMM yyyy')}`,
      summary: [
        { label: 'Total refunded', value: formatCurrency(totals.refunded) },
        { label: 'Awaiting review', value: String(totals.pending) },
      ],
      headers: ['Date', 'Amount', 'Reason', 'Status'],
      rows: refunds.map((refund) => [
        refund.created_at ? format(new Date(refund.created_at), 'dd/MM/yyyy') : '—',
        formatCurrency(refund.amount),
        refund.reason,
        refund.status,
      ]),
    });
    if (!opened) toast.error('Your browser blocked the print window', 'Allow pop-ups for this site and try again.');
  };

  const columns = [
    {
      header: 'Date',
      accessorKey: 'created_at' as const,
      cell: (refund: Refund) => (refund.created_at ? format(new Date(refund.created_at), 'dd MMM yyyy') : '—'),
    },
    {
      header: 'Amount',
      accessorKey: 'amount' as const,
      cell: (refund: Refund) => (
        <span className="font-semibold text-orange-700">{formatCurrency(refund.amount)}</span>
      ),
    },
    {
      header: 'Reason',
      accessorKey: 'reason' as const,
      cell: (refund: Refund) => (
        <span className="block max-w-[220px] truncate text-sm text-slate-600" title={refund.reason}>
          {refund.reason || '—'}
        </span>
      ),
    },
    {
      header: 'Status',
      accessorKey: 'status' as const,
      cell: (refund: Refund) => (
        <span className={`inline-block rounded-full px-2 py-1 text-xs font-semibold ${STATUS_STYLE[refund.status]}`}>
          {refund.status}
        </span>
      ),
    },
  ];

  if (refundsQuery.isLoading) return <LoadingState rows={3} label="Loading refunds" />;

  if (refundsQuery.isError) {
    return (
      <ErrorState error={refundsQuery.error} onRetry={() => void refundsQuery.refetch()} title="Could not load refunds" />
    );
  }

  if (refunds.length === 0) {
    return (
      <EmptyState
        title="No refunds"
        description={`Nothing has been refunded to ${studentName}. Raise a request from the Payments tab.`}
        icon={RefreshCcw}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card className="border-orange-200 bg-orange-50">
          <CardContent className="flex items-center justify-between p-4">
            <div>
              <p className="text-[11px] font-medium uppercase text-orange-600">Total refunded</p>
              <p className="text-xl font-bold text-orange-700 sm:text-2xl">{formatCurrency(totals.refunded)}</p>
            </div>
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-orange-100 text-orange-600">
              <RefreshCcw size={20} />
            </div>
          </CardContent>
        </Card>
        <Card className="border-yellow-200 bg-yellow-50">
          <CardContent className="flex items-center justify-between p-4">
            <div>
              <p className="text-[11px] font-medium uppercase text-yellow-600">Awaiting review</p>
              <p className="text-xl font-bold text-yellow-700 sm:text-2xl">{totals.pending}</p>
            </div>
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-yellow-100 text-yellow-600">
              <AlertCircle size={20} />
            </div>
          </CardContent>
        </Card>
      </div>

      <DataTable
        columns={columns}
        data={refunds}
        searchKey="reason"
        title="Refund history"
        action={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-9">
                <FileText className="mr-2 h-4 w-4" /> Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="border-slate-200 bg-white">
              <DropdownMenuItem className="cursor-pointer" onClick={exportCsv}>
                <FileText className="mr-2 h-4 w-4" /> Download CSV
              </DropdownMenuItem>
              <DropdownMenuItem className="cursor-pointer" onClick={print}>
                <Printer className="mr-2 h-4 w-4" /> Print
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
    </div>
  );
}
