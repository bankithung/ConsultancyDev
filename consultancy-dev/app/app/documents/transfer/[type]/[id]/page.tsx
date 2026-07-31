'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Clock,
  FileText,
  FolderOpen,
  User,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState, ErrorBanner, ErrorState, LoadingState } from '@/components/common/states';
import { RoleRoute } from '@/components/rbac/RoleGate';
import { ALL_ROLES } from '@/components/rbac/roles';
import { apiClient } from '@/lib/apiClient';
import { useAuth } from '@/hooks/useAuth';
import type { RecordTransferStatus } from '@/lib/types';
import { PhysicalDocumentList } from '../../../components/PhysicalDocumentList';
import { formatDateTime } from '../../../components/physicalDocuments';

/**
 * Detail view for a hand-over, of either kind. The `[type]` segment decides
 * which resource is being looked at, because the two are genuinely different
 * things on this API:
 *
 *   record    `[id]` is a RecordTransfer id. `apiClient.transfers` — ownership
 *             of a record moves when the recipient accepts.
 *   physical  `[id]` is a REGISTRATION id. `apiClient.studentDocuments` — the
 *             originals the office is holding for that student. There is no
 *             per-document detail endpoint (studentDocuments has no `get`), and
 *             custody is only meaningful per student anyway.
 *
 * `digital` is accepted as an alias for `record` so links written before record
 * transfers were generalised still resolve.
 */

const STATUS_STYLE: Record<RecordTransferStatus, string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  ACCEPTED: 'bg-green-100 text-green-700',
  REJECTED: 'bg-red-100 text-red-700',
  CANCELLED: 'bg-slate-200 text-slate-600',
};

const ENTITY_LABELS: Record<string, string> = {
  enquiry: 'Enquiry',
  registration: 'Registration',
  enrollment: 'Enrollment',
  document: 'Document',
  task: 'Task',
  follow_up: 'Follow-up',
  visa_tracking: 'Visa tracking',
};

function entityLabel(entityType: string): string {
  return ENTITY_LABELS[entityType] ?? entityType.replace(/_/g, ' ');
}

function firstParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function PageShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  const router = useRouter();

  return (
    <div className="mx-auto max-w-5xl space-y-4 py-2">
      <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-3 sm:flex-row sm:items-center sm:gap-4">
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0 hover:bg-slate-100"
          aria-label="Go back"
          onClick={() => router.back()}
        >
          <ArrowLeft size={16} className="text-slate-600" />
        </Button>
        <div className="min-w-0">
          <h1 className="break-words text-base font-semibold text-slate-900 sm:text-lg font-heading">
            {title}
          </h1>
          <p className="break-words text-sm text-slate-600">{subtitle}</p>
        </div>
      </div>

      {children}
    </div>
  );
}

function ParticipantRow({ label, name, isMe, tone }: { label: string; name: string; isMe: boolean; tone: 'from' | 'to' }) {
  return (
    <div className="flex items-start gap-3">
      <span
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
          tone === 'from' ? 'bg-blue-100 text-blue-600' : 'bg-teal-100 text-teal-600'
        }`}
      >
        <User size={18} />
      </span>
      <div className="min-w-0 pt-0.5">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="break-words text-sm font-medium text-slate-900">{name}</p>
          {isMe && (
            <Badge variant="secondary" className="h-4 px-1 py-0 text-[10px] font-medium">
              You
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}

function RecordTransferDetail({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);

  const transfer = useQuery({
    queryKey: ['transfers', 'detail', id],
    queryFn: () => apiClient.transfers.get(id),
    retry: 1,
  });

  const respond = useMutation({
    mutationFn: (action: 'accept' | 'reject') =>
      action === 'accept' ? apiClient.transfers.accept(id) : apiClient.transfers.reject(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transfers'] });
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      setAcceptOpen(false);
      setRejectOpen(false);
    },
  });

  if (transfer.isLoading) {
    return (
      <PageShell title="Record transfer" subtitle="Loading…">
        <LoadingState rows={4} label="Loading transfer" />
      </PageShell>
    );
  }

  if (transfer.isError || !transfer.data) {
    return (
      <PageShell title="Record transfer" subtitle={`#${id}`}>
        <ErrorState
          error={transfer.error ?? 'That transfer could not be found.'}
          onRetry={() => transfer.refetch()}
          title="Could not load this transfer"
        />
      </PageShell>
    );
  }

  const record = transfer.data;
  const title = record.entity_label || `${entityLabel(record.entity_type)} #${record.entity_id}`;
  const isRecipient = user?.id === record.to_user;
  const isSender = user?.id === record.from_user;
  const canRespond = isRecipient && record.status === 'PENDING';

  return (
    <PageShell title={title} subtitle={`Record transfer #${record.id} · ${entityLabel(record.entity_type)}`}>
      {respond.isError && <ErrorBanner error={respond.error} onDismiss={() => respond.reset()} />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-8">
          <Card className="border-slate-200">
            <CardHeader className="border-b border-slate-100 bg-slate-50/50 py-3">
              <CardTitle className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-700">
                <FileText size={14} /> What is being handed over
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-4">
              <p className="break-words text-sm font-medium text-slate-900">{title}</p>
              <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-slate-500">Sent</dt>
                  <dd className="text-slate-900">{formatDateTime(record.created_at)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Resolved</dt>
                  <dd className="text-slate-900">{formatDateTime(record.resolved_at)}</dd>
                </div>
              </dl>
              {record.note && (
                <p className="break-words rounded-md bg-slate-50 px-3 py-2 text-sm italic text-slate-700">
                  &ldquo;{record.note}&rdquo;
                </p>
              )}
              {!record.requires_acceptance && (
                <p className="text-xs text-slate-500">
                  This transfer did not need the recipient&rsquo;s acceptance.
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4 lg:col-span-4">
          <Card className="border-slate-200">
            <CardHeader className="border-b border-slate-100 bg-slate-50/50 py-3">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-slate-700">
                Participants
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-4">
              <ParticipantRow label="From" name={record.from_user_name} isMe={isSender} tone="from" />
              <ParticipantRow label="To" name={record.to_user_name} isMe={isRecipient} tone="to" />
              <div className="flex items-center gap-2 border-t border-slate-100 pt-3">
                <span className="text-xs text-slate-500">Status</span>
                <Badge className={`border-transparent ${STATUS_STYLE[record.status]}`}>
                  {record.status}
                </Badge>
              </div>
            </CardContent>
          </Card>

          {canRespond && (
            <Card className="border-amber-200 bg-amber-50/40">
              <CardHeader className="p-4 pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold text-amber-900">
                  <AlertCircle size={16} /> Action required
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-2 p-4 pt-2 sm:grid-cols-2">
                <Button
                  size="sm"
                  className="h-9 bg-teal-600 hover:bg-teal-700"
                  onClick={() => setAcceptOpen(true)}
                  disabled={respond.isPending}
                >
                  <Check size={14} className="mr-1.5" /> Accept
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 border-red-200 bg-white text-red-700 hover:bg-red-50"
                  onClick={() => setRejectOpen(true)}
                  disabled={respond.isPending}
                >
                  <X size={14} className="mr-1.5" /> Reject
                </Button>
              </CardContent>
            </Card>
          )}

          {record.status === 'PENDING' && !canRespond && (
            <Card className="border-slate-200">
              <CardContent className="flex items-start gap-2 p-4 text-xs text-slate-500">
                <Clock size={14} className="mt-0.5 shrink-0" />
                <p>
                  Waiting for {record.to_user_name} to accept. Only the recipient can resolve a
                  transfer.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={acceptOpen}
        onClose={() => setAcceptOpen(false)}
        onConfirm={() => respond.mutate('accept')}
        title="Accept this transfer?"
        description={`You will become the owner of ${title} and it will appear in your lists.`}
        confirmText="Accept transfer"
        isLoading={respond.isPending}
      />

      <ConfirmDialog
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        onConfirm={() => respond.mutate('reject')}
        title="Reject this transfer?"
        description={`${title} stays with ${record.from_user_name}. They will see that you declined.`}
        confirmText="Reject transfer"
        confirmVariant="destructive"
        isLoading={respond.isPending}
      />
    </PageShell>
  );
}

function PhysicalCustodyDetail({ registrationId }: { registrationId: string }) {
  const registration = useQuery({
    queryKey: ['registrations', 'detail', registrationId],
    queryFn: () => apiClient.registrations.get(registrationId),
    retry: 1,
  });

  const student = registration.data?.studentName;

  return (
    <PageShell
      title={student ? `${student}: originals held` : 'Originals held'}
      subtitle={
        registration.data
          ? `Registration ${registration.data.registrationNo}`
          : `Registration ${registrationId}`
      }
    >
      {/* The custody list below works from the registration id alone, so a
          failed name lookup is worth reporting but does not block the page. */}
      {registration.isError && <ErrorBanner error={registration.error} />}

      {/* The list renders bare so it can be dropped straight into the documents
          panel; here the card is what gives it an edge. */}
      <Card className="overflow-hidden border-slate-200">
        <PhysicalDocumentList registrationId={registrationId} />
      </Card>
    </PageShell>
  );
}

function TransferDetailRoute() {
  const params = useParams();
  const type = firstParam(params?.type).toLowerCase();
  const id = firstParam(params?.id);

  if (id === '') {
    return (
      <PageShell title="Transfer" subtitle="Nothing to show">
        <EmptyState icon={FolderOpen} title="No transfer specified" description="The link is missing an id." />
      </PageShell>
    );
  }

  if (type === 'physical') {
    return <PhysicalCustodyDetail registrationId={id} />;
  }

  if (type === 'record' || type === 'digital') {
    return <RecordTransferDetail id={id} />;
  }

  return (
    <PageShell title="Transfer" subtitle={`Unknown transfer type “${type}”`}>
      <EmptyState
        icon={FolderOpen}
        title="That is not a transfer view"
        description="Use /record/<transfer id> for a record hand-over, or /physical/<registration id> for originals held by the office."
      />
    </PageShell>
  );
}

export default function Page() {
  // Anyone can be party to a transfer; the API scopes what each role can see.
  return (
    <RoleRoute allow={ALL_ROLES}>
      <TransferDetailRoute />
    </RoleRoute>
  );
}
