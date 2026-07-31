'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Calendar, Clock, Mail, MapPin, Phone, User, Video } from 'lucide-react';

import { apiClient } from '@/lib/apiClient';
import type { Appointment } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { BackButton } from '@/components/ui/back-button';
import { ConfirmationModal } from '@/components/common/ConfirmationModal';
import { EmptyState, ErrorBanner, ErrorState, LoadingState } from '@/components/common/states';
import { toast } from '@/store/toastStore';

/*
 * `AppointmentSerializer` is consumed in its own snake_case — there is no
 * camelCase mapping layer for this resource, which is why the old build's
 * `appointment.studentName` and `appointment.studentEmail` were both
 * `undefined`.
 */

/** `Appointment.STATUS_CHOICES`. */
const APPOINTMENT_STATUS = {
  SCHEDULED: 'Scheduled',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
} as const;

const STATUS_TONES: Record<string, string> = {
  [APPOINTMENT_STATUS.SCHEDULED]: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  [APPOINTMENT_STATUS.COMPLETED]: 'bg-blue-50 text-blue-700 border-blue-200',
  [APPOINTMENT_STATUS.CANCELLED]: 'bg-slate-50 text-slate-600 border-slate-200',
};

/** `Appointment.TYPE_CHOICES`. */
function TypeIcon({ type }: { type: string }) {
  switch (type) {
    case 'Video Call':
      return <Video size={20} className="text-emerald-600" />;
    case 'Phone Call':
      return <Phone size={20} className="text-blue-600" />;
    // 'In-Person' is the model default.
    default:
      return <MapPin size={20} className="text-amber-600" />;
  }
}

/** `time` is a nullable TimeField; fall back to the time part of `date`. */
function displayTime(appointment: Appointment): string {
  if (appointment.time) return appointment.time.slice(0, 5);
  const parsed = new Date(appointment.date);
  return Number.isNaN(parsed.getTime()) ? '—' : format(parsed, 'h:mm a');
}

export default function AppointmentDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const id = params.id;

  const [pendingStatus, setPendingStatus] = useState<string | null>(null);

  const appointmentQuery = useQuery({
    queryKey: ['appointment', id],
    // `appointments/{id}/` exists on the client now; the local fetch this
    // replaced predated it.
    queryFn: () => apiClient.appointments.get(id),
    enabled: Boolean(id),
  });

  const statusMutation = useMutation({
    mutationFn: (status: string) => apiClient.appointments.update(id, { status }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['appointment', id], updated);
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
      setPendingStatus(null);
      toast.success(
        updated.status === APPOINTMENT_STATUS.COMPLETED
          ? 'Appointment completed'
          : 'Appointment cancelled',
      );
    },
    onError: () => setPendingStatus(null),
  });

  if (appointmentQuery.isPending) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <BackButton label="Back to appointments" />
        <LoadingState rows={4} label="Loading appointment…" />
      </div>
    );
  }

  if (appointmentQuery.isError) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <BackButton label="Back to appointments" />
        <ErrorState error={appointmentQuery.error} onRetry={() => appointmentQuery.refetch()} />
      </div>
    );
  }

  const appointment = appointmentQuery.data;

  if (!appointment) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <BackButton label="Back to appointments" />
        <EmptyState
          title="Appointment not found"
          description="It may have been cancelled or deleted."
          action={
            <Button variant="outline" onClick={() => router.push('/app/appointments')}>
              Back to appointments
            </Button>
          }
        />
      </div>
    );
  }

  const isScheduled = appointment.status === APPOINTMENT_STATUS.SCHEDULED;
  const scheduledOn = new Date(appointment.date);

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <BackButton label="Back to appointments" />

      {statusMutation.isError && (
        <ErrorBanner error={statusMutation.error} onDismiss={() => statusMutation.reset()} />
      )}

      <div className="rounded-lg border border-slate-200 bg-white p-4 sm:p-6">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-slate-100 bg-slate-50">
              <TypeIcon type={appointment.type} />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold text-slate-900 sm:text-xl">
                {appointment.student_name}
              </h1>
              <p className="text-sm text-slate-500">{appointment.type}</p>
            </div>
          </div>
          <Badge
            className={`w-fit shrink-0 ${
              STATUS_TONES[appointment.status] ?? 'bg-slate-50 text-slate-600 border-slate-200'
            }`}
          >
            {appointment.status}
          </Badge>
        </div>

        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-slate-50 p-4">
            <dt className="mb-1 flex items-center gap-2 text-xs text-slate-500">
              <Calendar size={14} /> Date
            </dt>
            <dd className="text-sm font-medium text-slate-900">
              {Number.isNaN(scheduledOn.getTime())
                ? '—'
                : format(scheduledOn, 'EEEE, dd MMMM yyyy')}
            </dd>
          </div>

          <div className="rounded-lg bg-slate-50 p-4">
            <dt className="mb-1 flex items-center gap-2 text-xs text-slate-500">
              <Clock size={14} /> Time
            </dt>
            <dd className="text-sm font-medium text-slate-900">
              {displayTime(appointment)} ({appointment.duration} mins)
            </dd>
          </div>

          <div className="min-w-0 rounded-lg bg-slate-50 p-4">
            <dt className="mb-1 flex items-center gap-2 text-xs text-slate-500">
              <User size={14} /> Counselor
            </dt>
            {/* The serializer renders '—' for an unassigned counselor. */}
            <dd className="truncate text-sm font-medium text-slate-900">
              {appointment.counselor_name}
            </dd>
          </div>

          <div className="min-w-0 rounded-lg bg-slate-50 p-4">
            <dt className="mb-1 flex items-center gap-2 text-xs text-slate-500">
              <Mail size={14} /> Student email
            </dt>
            <dd className="truncate text-sm font-medium text-slate-900">
              {appointment.student_email || '—'}
            </dd>
          </div>
        </dl>

        {appointment.notes && (
          <div className="mt-6 border-t border-slate-200 pt-6">
            <h2 className="mb-2 text-sm font-medium text-slate-700">Notes</h2>
            <p className="whitespace-pre-wrap break-words text-sm text-slate-600">
              {appointment.notes}
            </p>
          </div>
        )}

        <p className="mt-6 border-t border-slate-100 pt-4 text-xs text-slate-400">
          Created by {appointment.created_by_name}
          {appointment.branch_name ? ` — ${appointment.branch_name}` : ''}
        </p>
      </div>

      {isScheduled ? (
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => setPendingStatus(APPOINTMENT_STATUS.CANCELLED)}
            disabled={statusMutation.isPending}
          >
            Cancel appointment
          </Button>
          <Button
            className="flex-1 bg-emerald-600 text-white hover:bg-emerald-700"
            onClick={() => setPendingStatus(APPOINTMENT_STATUS.COMPLETED)}
            disabled={statusMutation.isPending}
          >
            Mark as completed
          </Button>
        </div>
      ) : (
        <p className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-center text-sm text-slate-500">
          This appointment is {appointment.status.toLowerCase()} and can no longer be changed here.
        </p>
      )}

      <ConfirmationModal
        open={pendingStatus !== null}
        onOpenChange={(next) => !next && setPendingStatus(null)}
        title={
          pendingStatus === APPOINTMENT_STATUS.CANCELLED
            ? 'Cancel this appointment?'
            : 'Mark as completed?'
        }
        description={
          pendingStatus === APPOINTMENT_STATUS.CANCELLED
            ? `The appointment with ${appointment.student_name} will be marked cancelled.`
            : `The appointment with ${appointment.student_name} will be marked completed.`
        }
        confirmLabel={
          pendingStatus === APPOINTMENT_STATUS.CANCELLED ? 'Cancel appointment' : 'Mark completed'
        }
        cancelLabel="Go back"
        variant={pendingStatus === APPOINTMENT_STATUS.CANCELLED ? 'destructive' : 'default'}
        isLoading={statusMutation.isPending}
        onConfirm={() => pendingStatus && statusMutation.mutate(pendingStatus)}
      />
    </div>
  );
}
