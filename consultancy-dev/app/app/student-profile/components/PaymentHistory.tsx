'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { FileText, MoreHorizontal, Plus, Printer, RotateCcw, Wallet } from 'lucide-react';
import { apiClient } from '@/lib/apiClient';
import type { Payment, PaymentStatus } from '@/lib/types';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states';
import { useCurrentRole } from '@/components/rbac/useCurrentRole';
import { toast } from '@/store/toastStore';
import { loadAllPages } from '../aggregate';
import { downloadCsv, printTable } from '../exporting';
import { formatCurrency, sameName, toForeignKey } from '../constants';
import { PaymentFormModal, type PaymentStage } from './PaymentFormModal';
import { RefundRequestModal } from './RefundRequestModal';

interface PaymentHistoryProps {
  studentName: string;
  /** Pre-selects the stage when recording a new payment. */
  stage: PaymentStage;
  /** Registration id, when the student has one. */
  registrationId: string | null;
  /** Enrollment id, when the profile is an enrollment. */
  enrollmentId: string | null;
}

const STATUS_STYLE: Record<PaymentStatus, string> = {
  Success: 'bg-green-100 text-green-700',
  Pending: 'bg-yellow-100 text-yellow-700',
  Failed: 'bg-red-100 text-red-700',
  Refunded: 'bg-orange-100 text-orange-700',
};

export function PaymentHistory({ studentName, stage, registrationId, enrollmentId }: PaymentHistoryProps) {
  const { can } = useCurrentRole();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [refundFor, setRefundFor] = useState<Payment | null>(null);

  // The payments endpoint filters on status/type/branch/method only, so `search`
  // is the widest server-side net available and membership is settled below.
  // Pulling every page is what keeps the totals honest.
  const paymentsQuery = useQuery({
    queryKey: ['payments', 'for-student', registrationId, studentName],
    queryFn: () =>
      loadAllPages<Payment>((params) => apiClient.payments.list(params), {
        search: studentName,
        ordering: '-date',
      }),
    enabled: Boolean(studentName),
  });

  const payments = useMemo(() => {
    const rows = paymentsQuery.data ?? [];
    // Prefer the registration foreign key — it is exact. Name matching is the
    // fallback for a student who has not registered yet, and for older rows
    // written before payments carried the FK.
    const registrationKey = toForeignKey(registrationId);
    return rows
      .filter((payment) => {
        if (registrationKey !== null && payment.registration != null) {
          return payment.registration === registrationKey;
        }
        return sameName(payment.studentName, studentName);
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [paymentsQuery.data, registrationId, studentName]);

  const totals = useMemo(() => {
    const paid = payments.filter((p) => p.status === 'Success').reduce((sum, p) => sum + Number(p.amount), 0);
    const pending = payments.filter((p) => p.status === 'Pending').reduce((sum, p) => sum + Number(p.amount), 0);
    const refunded = payments.filter((p) => p.status === 'Refunded').reduce((sum, p) => sum + Number(p.amount), 0);
    return { paid, pending, refunded, net: paid - refunded, transactions: payments.length };
  }, [payments]);

  const exportCsv = () => {
    downloadCsv(
      `${studentName}_payments_${format(new Date(), 'yyyy-MM-dd')}.csv`,
      ['Date', 'Type', 'Method', 'Reference', 'Amount', 'Status'],
      payments.map((payment) => [
        payment.date ? format(new Date(payment.date), 'dd/MM/yyyy') : '—',
        payment.type,
        payment.method,
        payment.reference ?? '',
        payment.amount,
        payment.status,
      ]),
    );
    toast.success(`Exported ${payments.length} transaction${payments.length === 1 ? '' : 's'}`);
  };

  const print = () => {
    const opened = printTable({
      title: `Payment history — ${studentName}`,
      subtitle: `Generated ${format(new Date(), 'dd MMM yyyy')}`,
      summary: [
        { label: 'Received', value: formatCurrency(totals.paid) },
        { label: 'Refunded', value: formatCurrency(totals.refunded) },
        { label: 'Net', value: formatCurrency(totals.net) },
        { label: 'Transactions', value: String(totals.transactions) },
      ],
      headers: ['Date', 'Type', 'Method', 'Reference', 'Amount', 'Status'],
      rows: payments.map((payment) => [
        payment.date ? format(new Date(payment.date), 'dd/MM/yyyy') : '—',
        payment.type,
        payment.method,
        payment.reference ?? '—',
        formatCurrency(payment.amount),
        payment.status,
      ]),
    });
    if (!opened) toast.error('Your browser blocked the print window', 'Allow pop-ups for this site and try again.');
  };

  const columns = [
    {
      header: 'Date',
      accessorKey: 'date' as const,
      cell: (payment: Payment) => (payment.date ? format(new Date(payment.date), 'dd MMM yyyy') : '—'),
    },
    {
      header: 'Amount',
      accessorKey: 'amount' as const,
      cell: (payment: Payment) => <span className="font-semibold">{formatCurrency(payment.amount)}</span>,
    },
    { header: 'Type', accessorKey: 'type' as const },
    {
      header: 'Method',
      accessorKey: 'method' as const,
      cell: (payment: Payment) => (
        <span className="block">
          {payment.method}
          {payment.reference && <span className="block text-[10px] text-slate-400">{payment.reference}</span>}
        </span>
      ),
    },
    {
      header: 'Status',
      accessorKey: 'status' as const,
      cell: (payment: Payment) => (
        <span className={`inline-block rounded-full px-2 py-1 text-xs font-semibold ${STATUS_STYLE[payment.status]}`}>
          {payment.status}
        </span>
      ),
    },
    {
      header: 'Actions',
      className: 'text-right',
      cell: (payment: Payment) => {
        // A refund needs the registration FK; without one the API would 400.
        const canRefund = can('manageRefunds') && registrationId !== null && payment.status === 'Success';
        return (
          <div className="flex justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-8 w-8 p-0">
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="sr-only">Actions for payment {payment.id}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="border-slate-200 bg-white shadow-lg">
                <DropdownMenuLabel>Payment {payment.id}</DropdownMenuLabel>
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(payment.id)
                      .then(() => toast.success('Payment reference copied'))
                      .catch(() => toast.error('Could not copy to clipboard'));
                  }}
                >
                  Copy reference
                </DropdownMenuItem>
                {canRefund && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="cursor-pointer text-orange-600 focus:bg-orange-50 focus:text-orange-700"
                      onClick={() => setRefundFor(payment)}
                    >
                      <RotateCcw className="mr-2 h-4 w-4" />
                      Request refund
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  ];

  if (paymentsQuery.isLoading) return <LoadingState rows={4} label="Loading payments" />;

  if (paymentsQuery.isError) {
    return (
      <ErrorState
        error={paymentsQuery.error}
        onRetry={() => void paymentsQuery.refetch()}
        title="Could not load payments"
      />
    );
  }

  return (
    <>
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Card className="border-green-200 bg-green-50">
            <CardContent className="p-3 sm:p-4">
              <p className="text-[11px] font-medium uppercase text-green-600">Received</p>
              <p className="text-lg font-bold text-green-700 sm:text-2xl">{formatCurrency(totals.paid)}</p>
            </CardContent>
          </Card>
          <Card className="border-orange-200 bg-orange-50">
            <CardContent className="p-3 sm:p-4">
              <p className="text-[11px] font-medium uppercase text-orange-600">Refunded</p>
              <p className="text-lg font-bold text-orange-700 sm:text-2xl">{formatCurrency(totals.refunded)}</p>
            </CardContent>
          </Card>
          <Card className="border-blue-200 bg-blue-50">
            <CardContent className="p-3 sm:p-4">
              <p className="text-[11px] font-medium uppercase text-blue-600">Net</p>
              <p className="text-lg font-bold text-blue-700 sm:text-2xl">{formatCurrency(totals.net)}</p>
            </CardContent>
          </Card>
          <Card className="border-yellow-200 bg-yellow-50">
            <CardContent className="p-3 sm:p-4">
              <p className="text-[11px] font-medium uppercase text-yellow-600">Awaiting</p>
              <p className="text-lg font-bold text-yellow-700 sm:text-2xl">{formatCurrency(totals.pending)}</p>
            </CardContent>
          </Card>
        </div>

        {payments.length === 0 ? (
          <EmptyState
            title="No payments recorded"
            description={`Nothing has been taken from ${studentName} yet.`}
            icon={Wallet}
            action={
              <Button size="sm" className="h-9" onClick={() => setIsAddOpen(true)}>
                <Plus className="mr-2 h-4 w-4" /> Record payment
              </Button>
            }
          />
        ) : (
          <DataTable
            columns={columns}
            data={payments}
            searchKey="type"
            title="Transaction history"
            action={
              <div className="flex gap-2">
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
                <Button size="sm" className="h-9" onClick={() => setIsAddOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" /> Add
                </Button>
              </div>
            }
          />
        )}
      </div>

      <PaymentFormModal
        open={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        studentName={studentName}
        defaultType={stage}
        registrationId={registrationId}
        enrollmentId={enrollmentId}
      />

      {registrationId !== null && (
        <RefundRequestModal
          open={refundFor !== null}
          onClose={() => setRefundFor(null)}
          studentName={studentName}
          registrationId={registrationId}
          payment={refundFor}
        />
      )}
    </>
  );
}
