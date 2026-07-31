'use client';

import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addHours, isToday, isTomorrow, isPast, isWithinInterval, parseISO } from 'date-fns';

import { apiClient } from '@/lib/apiClient';
import { toArray } from '@/components/common/pagination';
import { useAuth } from '@/hooks/useAuth';
import { toast } from '@/store/toastStore';

/**
 * Due-work reminders for the signed-in user.
 *
 * DELIVERY: polled, not pushed. Chat and the WebSocket layer were removed at
 * the owner's request, and notifications are delivered by polling now (see the
 * note above `SignupRequest` in core/models.py). react-query's
 * `refetchInterval` is the whole mechanism.
 *
 * SCOPING: `tasks/` and `follow-ups/` both declare `assigned_to` in their
 * `filterset_fields`, so those two are filtered server-side. `appointments/`
 * declares none — passing `?counselor=` there would be silently ignored and
 * return every appointment in scope, so that one is filtered here, over a
 * bounded page.
 */

/** Five minutes. Reminders are not time-critical enough to poll harder. */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** `Task.status` is a free CharField; 'Done' is the convention for finished. */
const TASK_DONE_STATUS = 'Done';
/** `FollowUp.status` default. */
const FOLLOW_UP_PENDING_STATUS = 'Pending';
/** `Appointment.STATUS_CHOICES`. */
const APPOINTMENT_CANCELLED_STATUS = 'Cancelled';

const UPCOMING_WINDOW_HOURS = 2;

export interface UpcomingReminders {
  pendingTasksCount: number;
  pendingFollowUpsCount: number;
  todayAppointmentsCount: number;
  overdueCount: number;
  isLoading: boolean;
}

/** Parses an ISO string, returning null rather than an Invalid Date. */
function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = parseISO(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function withinNextHours(date: Date, hours: number): boolean {
  const now = new Date();
  return isWithinInterval(date, { start: now, end: addHours(now, hours) });
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

export function useUpcomingReminders(): UpcomingReminders {
  const { user } = useAuth();
  const userId = user?.id;
  const enabled = userId != null;

  const tasksQuery = useQuery({
    queryKey: ['tasks', 'reminders', userId],
    // Thunks, always. `queryFn: apiClient.tasks.list` would hand react-query's
    // context object to a function expecting PageParams.
    queryFn: () =>
      apiClient.tasks.list({
        filters: { assigned_to: userId as number },
        page_size: 100,
        ordering: 'due_date',
      }),
    enabled,
    refetchInterval: POLL_INTERVAL_MS,
  });

  const followUpsQuery = useQuery({
    queryKey: ['followUps', 'reminders', userId],
    queryFn: () =>
      apiClient.followUps.list({
        filters: { assigned_to: userId as number, status: FOLLOW_UP_PENDING_STATUS },
        page_size: 100,
        ordering: 'scheduled_for',
      }),
    enabled,
    refetchInterval: POLL_INTERVAL_MS,
  });

  const appointmentsQuery = useQuery({
    queryKey: ['appointments', 'reminders', userId],
    queryFn: () => apiClient.appointments.list({ page_size: 100, ordering: '-date' }),
    enabled,
    refetchInterval: POLL_INTERVAL_MS,
  });

  const buckets = useMemo(() => {
    // Already scoped to this user server-side; only the status needs narrowing.
    const myTasks = toArray(tasksQuery.data).filter((task) => task.status !== TASK_DONE_STATUS);
    const myFollowUps = toArray(followUpsQuery.data);

    // No server-side filter available here, so both conditions are applied
    // locally. `counselor` is the assignee field — the old build read
    // `appt.assigned_to`, which does not exist on AppointmentSerializer.
    const myAppointments = toArray(appointmentsQuery.data).filter(
      (appointment) =>
        appointment.counselor === userId &&
        appointment.status !== APPOINTMENT_CANCELLED_STATUS,
    );

    const taskDates = myTasks.map((task) => parseDate(task.dueDate)).filter((d): d is Date => d !== null);
    const followUpDates = myFollowUps
      .map((followUp) => parseDate(followUp.scheduled_for))
      .filter((d): d is Date => d !== null);
    const appointmentDates = myAppointments
      .map((appointment) => parseDate(appointment.date))
      .filter((d): d is Date => d !== null);

    return {
      pendingTasksCount: myTasks.length,
      pendingFollowUpsCount: myFollowUps.length,
      overdueTasks: taskDates.filter((date) => isPast(date) && !isToday(date)).length,
      todayTasks: taskDates.filter((date) => isToday(date)).length,
      overdueFollowUps: followUpDates.filter((date) => isPast(date) && !isToday(date)).length,
      todayFollowUps: followUpDates.filter((date) => isToday(date)).length,
      tomorrowFollowUps: followUpDates.filter((date) => isTomorrow(date)).length,
      soonFollowUps: followUpDates.filter((date) => withinNextHours(date, UPCOMING_WINDOW_HOURS)).length,
      todayAppointments: appointmentDates.filter((date) => isToday(date)).length,
      soonAppointments: appointmentDates.filter((date) => withinNextHours(date, UPCOMING_WINDOW_HOURS))
        .length,
    };
  }, [tasksQuery.data, followUpsQuery.data, appointmentsQuery.data, userId]);

  const settled =
    !tasksQuery.isPending && !followUpsQuery.isPending && !appointmentsQuery.isPending;

  useEffect(() => {
    if (!userId || !settled) return;

    // Once per user per day. Polling every five minutes would otherwise
    // re-announce the same overdue work all day.
    const key = `reminders-shown-${userId}-${new Date().toDateString()}`;
    if (sessionStorage.getItem(key)) return;

    let announced = false;

    if (buckets.overdueTasks > 0) {
      toast.error(`${plural(buckets.overdueTasks, 'overdue task')}`, 'These were due before today.');
      announced = true;
    }
    if (buckets.todayTasks > 0) {
      toast.info(`${plural(buckets.todayTasks, 'task')} due today`);
      announced = true;
    }
    if (buckets.overdueFollowUps > 0) {
      toast.error(`${plural(buckets.overdueFollowUps, 'overdue follow-up')}`);
      announced = true;
    }
    if (buckets.soonFollowUps > 0) {
      toast.warning(
        `${plural(buckets.soonFollowUps, 'follow-up')} in the next ${UPCOMING_WINDOW_HOURS} hours`,
      );
      announced = true;
    } else if (buckets.todayFollowUps > 0) {
      toast.info(`${plural(buckets.todayFollowUps, 'follow-up')} scheduled today`);
      announced = true;
    }
    if (buckets.tomorrowFollowUps > 0) {
      toast.info(`${plural(buckets.tomorrowFollowUps, 'follow-up')} scheduled tomorrow`);
      announced = true;
    }
    if (buckets.soonAppointments > 0) {
      toast.warning(
        `${plural(buckets.soonAppointments, 'appointment')} in the next ${UPCOMING_WINDOW_HOURS} hours`,
      );
      announced = true;
    } else if (buckets.todayAppointments > 0) {
      toast.info(`${plural(buckets.todayAppointments, 'appointment')} scheduled today`);
      announced = true;
    }

    if (announced) sessionStorage.setItem(key, 'true');
  }, [userId, settled, buckets]);

  return {
    pendingTasksCount: buckets.pendingTasksCount,
    pendingFollowUpsCount: buckets.pendingFollowUpsCount,
    todayAppointmentsCount: buckets.todayAppointments,
    overdueCount: buckets.overdueTasks + buckets.overdueFollowUps,
    isLoading: !settled,
  };
}
