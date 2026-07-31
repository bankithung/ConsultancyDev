'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  parseISO,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Edit,
  MapPin,
  MoreHorizontal,
  Phone,
  Plus,
  Trash2,
  Video,
} from 'lucide-react';

import { apiClient } from '@/lib/apiClient';
import type { Appointment, AppointmentInput } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Drawer } from '@/components/common/Drawer';
import { ConfirmationModal } from '@/components/common/ConfirmationModal';
import { PaginationBar, toArray } from '@/components/common/pagination';
import { EmptyState, ErrorBanner, ErrorState, LoadingState } from '@/components/common/states';
import { useCurrentRole } from '@/components/rbac/useCurrentRole';
import { toast } from '@/store/toastStore';

import type { AppointmentsTabState } from '../state';
import {
  APPOINTMENT_DEFAULT_TYPE,
  APPOINTMENT_KPI_FILTERS,
  APPOINTMENT_SCHEDULED,
  APPOINTMENT_STATUSES,
  APPOINTMENT_STATUS_TONES,
  APPOINTMENT_TYPES,
  DURATIONS,
  appointmentAccent,
  displayTime,
  safeDate,
} from '../vocabulary';

/**
 * The appointment board: a month grid with a day panel, or a paginated list of
 * cards. Search, filters, page, the open month and the open day all live on the
 * engagements page so they survive a tab switch.
 */

const PAGE_SIZE = 12;

const DAY_FORMAT = 'yyyy-MM-dd';

function TypeIcon({ type, size = 14 }: { type: string; size?: number }) {
  switch (type) {
    case 'Video Call':
      return <Video size={size} className="text-blue-500" />;
    case 'Phone Call':
      return <Phone size={size} className="text-emerald-500" />;
    // 'In-Person' is the model default.
    default:
      return <MapPin size={size} className="text-amber-500" />;
  }
}

const emptyForm = (day: string) => ({
  student_name: '',
  student_email: '',
  counselorId: '',
  date: day,
  time: '10:00',
  duration: '30',
  type: APPOINTMENT_DEFAULT_TYPE as string,
  status: APPOINTMENT_SCHEDULED as string,
  notes: '',
});

interface AppointmentsViewProps {
  state: AppointmentsTabState;
  onChange: (patch: Partial<AppointmentsTabState>) => void;
  /** Driven by the panel's primary action; the dialog itself is owned here. */
  formOpen: boolean;
  onFormOpenChange: (open: boolean) => void;
}

export function AppointmentsView({
  state,
  onChange,
  formOpen,
  onFormOpenChange,
}: AppointmentsViewProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { can } = useCurrentRole();

  const { committed, selection, page, mode } = state;
  const month = useMemo(() => startOfMonth(parseISO(state.month)), [state.month]);
  const selectedDay = useMemo(() => parseISO(state.day), [state.day]);

  const [editing, setEditing] = useState<Appointment | null>(null);
  const [form, setForm] = useState(() => emptyForm(state.day));
  /** What the form held when it opened — the baseline for the dirty check. */
  const [pristineForm, setPristineForm] = useState(form);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Appointment | null>(null);

  /**
   * Opening the drawer from the panel's primary action means "new appointment
   * on the open day". Reset during render rather than in an effect, so the
   * previous draft never flashes; an edit fills `form` and sets `editing` in the
   * same batch, and is left alone here.
   */
  const [wasFormOpen, setWasFormOpen] = useState(formOpen);
  if (formOpen !== wasFormOpen) {
    setWasFormOpen(formOpen);
    if (formOpen) {
      setConfirmDiscard(false);
      if (editing === null) {
        const fresh = emptyForm(state.day);
        setForm(fresh);
        setPristineForm(fresh);
        setFormError(null);
      }
    }
    if (!formOpen) setEditing(null);
  }

  /**
   * The whole month, unpaginated: `appointments/calendar/` returns every row
   * for the window in one bare array, narrowed by the SAME search and filters
   * as the list beside it. Because that set is COMPLETE for the query,
   * grouping it by day — and counting it — is correct, unlike reducing over one
   * page of a paginated list.
   */
  const monthQuery = useQuery({
    queryKey: ['appointments', 'calendar', format(month, 'yyyy-MM'), committed, selection],
    queryFn: async () => {
      // The grid renders whole weeks, so its first and last rows spill into the
      // neighbouring months. Fetching only `month` left those cells looking
      // permanently empty even when they had appointments.
      const windows = [subMonths(month, 1), month, addMonths(month, 1)];
      const batches = await Promise.all(
        windows.map((window) =>
          apiClient.appointments.getCalendarView({
            month: window.getMonth() + 1,
            year: window.getFullYear(),
            search: committed || undefined,
            filters: selection,
          }),
        ),
      );
      // A row near a month boundary can come back in two windows; key by id.
      const byId = new Map<number, Appointment>();
      for (const batch of batches) {
        for (const row of batch) byId.set(row.id, row);
      }
      return [...byId.values()];
    },
    enabled: mode === 'calendar',
  });

  const listQuery = useQuery({
    queryKey: ['appointments', 'list', page, committed, selection],
    queryFn: () =>
      apiClient.appointments.list({
        page,
        page_size: PAGE_SIZE,
        search: committed || undefined,
        ordering: '-date',
        filters: selection,
      }),
    enabled: mode === 'list',
    placeholderData: keepPreviousData,
  });

  /**
   * The board's totals, counted by the SERVER over the whole collection.
   *
   * These used to be reduced from the month on screen, which meant the tiles
   * disagreed with the list beside them whenever the month was not the whole
   * story. They are now the same kind of number as the follow-up tiles: press
   * one and it applies exactly the filter it counts.
   */
  const statsQuery = useQuery({
    queryKey: ['appointments', 'stats'],
    queryFn: async () => {
      const [all, scheduled, completed, cancelled] = await Promise.all([
        apiClient.appointments.list({ page_size: 1 }),
        apiClient.appointments.list({ page_size: 1, filters: { status: 'Scheduled' } }),
        apiClient.appointments.list({ page_size: 1, filters: { status: 'Completed' } }),
        apiClient.appointments.list({ page_size: 1, filters: { status: 'Cancelled' } }),
      ]);
      return {
        total: all.count,
        scheduled: scheduled.count,
        completed: completed.count,
        cancelled: cancelled.count,
      };
    },
  });

  const staffQuery = useQuery({
    queryKey: ['users', 'assignable'],
    queryFn: () =>
      apiClient.users.list({
        page_size: 200,
        ordering: 'username',
        filters: { is_active_employee: true },
      }),
  });

  const monthRows = useMemo(() => monthQuery.data ?? [], [monthQuery.data]);
  const listRows = toArray(listQuery.data);
  const staff = toArray(staffQuery.data);

  /** One pass over the month instead of a filter per cell. */
  const byDay = useMemo(() => {
    const map = new Map<string, Appointment[]>();
    for (const row of monthRows) {
      const parsed = safeDate(row.date);
      if (!parsed) continue;
      const key = format(parsed, DAY_FORMAT);
      const bucket = map.get(key);
      if (bucket) bucket.push(row);
      else map.set(key, [row]);
    }
    for (const bucket of map.values()) {
      bucket.sort((a, b) => displayTime(a).localeCompare(displayTime(b)));
    }
    return map;
  }, [monthRows]);

  /**
   * Rows belonging to the month on screen. The fetch window spans its
   * neighbours so the grid's spill-over cells fill in, and counting those would
   * inflate the figure.
   */
  const monthCount = useMemo(
    () =>
      monthRows.filter((row) => {
        const parsed = safeDate(row.date);
        return parsed !== null && isSameMonth(parsed, month);
      }).length,
    [monthRows, month],
  );

  /**
   * Full weeks, so the 1st lands under its real weekday. Rendering only the
   * month's own days into a 7-column grid put every date in the wrong column
   * unless the month happened to start on a Sunday.
   */
  const gridDays = useMemo(
    () =>
      eachDayOfInterval({
        start: startOfWeek(startOfMonth(month)),
        end: endOfWeek(endOfMonth(month)),
      }),
    [month],
  );

  const selectedDayRows = byDay.get(state.day) ?? [];

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['appointments'] });
  };

  const createMutation = useMutation({
    mutationFn: (input: AppointmentInput) => apiClient.appointments.create(input),
    onSuccess: () => {
      invalidate();
      onFormOpenChange(false);
      toast.success('Appointment scheduled');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Partial<AppointmentInput> }) =>
      apiClient.appointments.update(id, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(['appointment', String(updated.id)], updated);
      invalidate();
      onFormOpenChange(false);
      toast.success('Appointment updated');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiClient.appointments.delete(id),
    onSuccess: () => {
      invalidate();
      setPendingDelete(null);
      toast.success('Appointment deleted');
    },
  });

  const openEdit = (appointment: Appointment) => {
    const parsed = safeDate(appointment.date);
    const time = displayTime(appointment);
    const loaded = {
      student_name: appointment.student_name,
      student_email: appointment.student_email,
      counselorId: appointment.counselor === null ? '' : appointment.counselor.toString(),
      date: parsed ? format(parsed, DAY_FORMAT) : format(new Date(), DAY_FORMAT),
      time: time === '—' ? '10:00' : time,
      duration: appointment.duration.toString(),
      type: appointment.type,
      status: appointment.status,
      notes: appointment.notes,
    };
    setEditing(appointment);
    setFormError(null);
    setForm(loaded);
    // The row's own values are the baseline, so an edit that changes nothing
    // closes without arguing about unsaved work.
    setPristineForm(loaded);
    onFormOpenChange(true);
  };

  /**
   * Vetoes the scrim, Escape and the close button while the form holds unsaved
   * changes, and asks instead.
   *
   * A drawer's scrim is a much easier target to clip by accident than a centred
   * dialog's backdrop, and this form carries a client name, a date, a time and
   * notes.
   */
  const requestCloseForm = (): boolean => {
    if (createMutation.isPending || updateMutation.isPending) return false;
    if (JSON.stringify(form) === JSON.stringify(pristineForm) || confirmDiscard) return true;
    setConfirmDiscard(true);
    return false;
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.counselorId) {
      setFormError('Pick the staff member who will take this appointment.');
      return;
    }
    if (!form.student_name.trim()) {
      setFormError('Enter the client’s name.');
      return;
    }
    setFormError(null);

    const payload: AppointmentInput = {
      student_name: form.student_name.trim(),
      student_email: form.student_email.trim(),
      // `counselor` is a non-nullable FK on the model; the serializer 400s
      // without it, which is why the form requires it.
      counselor: Number(form.counselorId),
      // `date` is a DateTimeField and `time` a separate TimeField.
      //
      // The datetime carries an explicit offset. The server runs USE_TZ=True
      // with TIME_ZONE='UTC', so a NAIVE string is read as UTC: 22:00 typed in
      // IST would be stored as 22:00Z and read back as 03:30 the NEXT day,
      // putting the appointment in the wrong calendar cell. Sending the instant
      // and rendering it back in local time round-trips to the day and time the
      // user actually picked.
      date: new Date(`${form.date}T${form.time}`).toISOString(),
      // TimeField has no timezone; this is the wall-clock time as typed, which
      // is what `displayTime` shows.
      time: `${form.time}:00`,
      duration: Number(form.duration),
      type: form.type,
      status: form.status,
      notes: form.notes,
    };

    if (editing) updateMutation.mutate({ id: editing.id, patch: payload });
    else createMutation.mutate(payload);
  };

  const staffOptions = staff.map((member) => ({
    value: member.id.toString(),
    label: member.full_name || member.username,
  }));

  const isSaving = createMutation.isPending || updateMutation.isPending;
  const hasQuery = Object.keys(selection).length > 0 || state.search !== '';
  const stats = statsQuery.data;

  const activeKpi = (
    Object.keys(APPOINTMENT_KPI_FILTERS) as Array<keyof typeof APPOINTMENT_KPI_FILTERS>
  ).find((key) => JSON.stringify(APPOINTMENT_KPI_FILTERS[key]) === JSON.stringify(selection));

  const kpis = [
    { key: 'total' as const, label: 'Total', value: stats?.total, tone: 'text-slate-900' },
    { key: 'scheduled' as const, label: 'Scheduled', value: stats?.scheduled, tone: 'text-blue-700' },
    {
      key: 'completed' as const,
      label: 'Completed',
      value: stats?.completed,
      tone: 'text-emerald-700',
    },
    { key: 'cancelled' as const, label: 'Cancelled', value: stats?.cancelled, tone: 'text-rose-700' },
  ];

  /**
   * Pinned to the bottom of the drawer, so the actions stay reachable while the
   * form scrolls — with date, time, type, duration, status and notes it does
   * scroll on a laptop. When a dismiss has been vetoed it becomes the choice
   * that vetoed it, rather than a second dialog stacked over the panel.
   */
  const formFooter = confirmDiscard ? (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm font-medium text-slate-700">
        Discard {editing ? 'these changes' : 'this appointment'}? What you have entered will be lost.
      </p>
      <div className="flex shrink-0 gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => setConfirmDiscard(false)}
          className="flex-1 sm:flex-none"
        >
          Keep editing
        </Button>
        <Button
          type="button"
          onClick={() => onFormOpenChange(false)}
          className="flex-1 bg-rose-600 text-white hover:bg-rose-700 sm:flex-none"
        >
          Discard
        </Button>
      </div>
    </div>
  ) : (
    <div className="mx-auto flex w-full max-w-2xl flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          if (requestCloseForm()) onFormOpenChange(false);
        }}
        disabled={isSaving}
        className="w-full sm:w-auto"
      >
        Cancel
      </Button>
      <Button
        type="submit"
        form="appointment-form"
        disabled={isSaving}
        className="w-full bg-teal-600 text-white hover:bg-teal-700 sm:w-auto"
      >
        {isSaving ? 'Saving…' : editing ? 'Save changes' : 'Schedule appointment'}
      </Button>
    </div>
  );

  return (
    <>
      {/*
        Counted by the SERVER over the whole collection, never over the month on
        screen — a branch with 300 appointments must not be told it has 12. Each
        tile applies exactly the filter it counts, which is what keeps a tile
        reading 5 from looking wrong beside a grid showing 2.
      */}
      <div className="grid grid-cols-2 divide-slate-100 border-b border-slate-100 sm:grid-cols-4 sm:divide-x">
        {kpis.map((kpi) => {
          const isActive = activeKpi === kpi.key;
          return (
            <button
              key={kpi.key}
              type="button"
              aria-pressed={isActive}
              onClick={() => onChange({ selection: APPOINTMENT_KPI_FILTERS[kpi.key] })}
              className={`flex items-baseline justify-between gap-2 border-b border-slate-100 px-3 py-2.5 text-left transition-colors sm:border-b-0 ${
                isActive ? 'bg-teal-50/70' : 'hover:bg-slate-50'
              }`}
            >
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                {kpi.label}
              </span>
              <span className={`text-lg font-bold tabular-nums ${kpi.tone}`}>
                {statsQuery.isError ? '—' : (kpi.value ?? '·')}
              </span>
            </button>
          );
        })}
      </div>

      {deleteMutation.isError && (
        <div className="px-3 pt-3">
          <ErrorBanner error={deleteMutation.error} onDismiss={() => deleteMutation.reset()} />
        </div>
      )}

      {mode === 'calendar' ? (
        <div className="grid grid-cols-1 gap-3 p-3 lg:grid-cols-12">
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white lg:col-span-8">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50/50 px-3 py-2.5 sm:px-4">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-slate-900">
                  {format(month, 'MMMM yyyy')}
                </h3>
                {/*
                  The month's own count, not the fetch window's: the grid pulls
                  in the neighbouring months to fill its first and last rows.
                */}
                <p className="text-[11px] text-slate-500">
                  {monthQuery.isPending
                    ? 'Loading…'
                    : `${monthCount} ${monthCount === 1 ? 'appointment' : 'appointments'}${
                        hasQuery ? ' matching' : ''
                      }`}
                </p>
              </div>
              <div className="flex items-center rounded-full border border-slate-200 bg-white p-0.5">
                <button
                  type="button"
                  onClick={() =>
                    onChange({ month: format(subMonths(month, 1), DAY_FORMAT) })
                  }
                  className="rounded-full p-1.5 hover:bg-slate-100"
                  aria-label="Previous month"
                >
                  <ChevronLeft size={14} className="text-slate-500" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const today = new Date();
                    onChange({
                      month: format(startOfMonth(today), DAY_FORMAT),
                      day: format(today, DAY_FORMAT),
                    });
                  }}
                  className="px-2 text-xs font-medium text-slate-600 hover:text-slate-900"
                >
                  Today
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onChange({ month: format(addMonths(month, 1), DAY_FORMAT) })
                  }
                  className="rounded-full p-1.5 hover:bg-slate-100"
                  aria-label="Next month"
                >
                  <ChevronRight size={14} className="text-slate-500" />
                </button>
              </div>
            </div>

            {monthQuery.isPending ? (
              <div className="p-4">
                <LoadingState rows={4} label="Loading calendar…" />
              </div>
            ) : monthQuery.isError ? (
              <div className="p-4">
                <ErrorState error={monthQuery.error} onRetry={() => monthQuery.refetch()} />
              </div>
            ) : (
              <>
                <div className="grid grid-cols-7 border-b border-slate-200">
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                    <div
                      key={day}
                      className="bg-slate-50 py-2 text-center text-[10px] font-semibold uppercase text-slate-500"
                    >
                      {/* One letter at 390px; the full abbreviation has nowhere to go. */}
                      <span className="sm:hidden">{day.charAt(0)}</span>
                      <span className="hidden sm:inline">{day}</span>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-7">
                  {gridDays.map((day) => {
                    const key = format(day, DAY_FORMAT);
                    const dayRows = byDay.get(key) ?? [];
                    const inMonth = isSameMonth(day, month);
                    const isSelected = isSameDay(day, selectedDay);

                    return (
                      <button
                        type="button"
                        key={key}
                        onClick={() => onChange({ day: key })}
                        aria-current={isSelected}
                        aria-label={`${format(day, 'd MMMM yyyy')}, ${dayRows.length} appointments`}
                        className={cn(
                          'group/cell relative min-h-[3.25rem] border-b border-r border-slate-100 p-1 text-left transition-all sm:min-h-[4.75rem] sm:p-1.5',
                          !inMonth && 'bg-slate-50/50 opacity-50',
                          isSelected
                            ? 'bg-teal-50 ring-1 ring-inset ring-teal-300'
                            : 'hover:bg-slate-50',
                        )}
                      >
                        <div className="mb-1 flex items-center justify-between gap-1">
                          <span
                            className={cn(
                              'flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-medium sm:h-6 sm:w-6 sm:text-xs',
                              isToday(day) && 'bg-teal-600 text-white',
                              isSelected && !isToday(day) && 'bg-teal-100 text-teal-700',
                              !isToday(day) && !isSelected && 'text-slate-600',
                            )}
                          >
                            {format(day, 'd')}
                          </span>
                          {dayRows.length > 0 && (
                            <span className="hidden rounded bg-teal-50 px-1.5 py-0.5 text-[9px] font-semibold text-teal-600 sm:inline">
                              {dayRows.length}
                            </span>
                          )}
                        </div>

                        {/*
                          A 7-column grid at 390px gives cells around 40px of
                          usable width. A text pill there is an unreadable
                          sliver, so below `sm` each appointment is a dot and the
                          day panel below carries the detail.
                        */}
                        <div className="flex flex-wrap gap-0.5 sm:hidden">
                          {dayRows.slice(0, 3).map((row) => (
                            <span
                              key={row.id}
                              className={cn('h-1.5 w-1.5 rounded-full', appointmentAccent(row.status))}
                            />
                          ))}
                          {dayRows.length > 3 && (
                            <span className="text-[8px] font-bold leading-[6px] text-slate-400">
                              +{dayRows.length - 3}
                            </span>
                          )}
                        </div>

                        <div className="hidden space-y-0.5 sm:block">
                          {dayRows.slice(0, 2).map((row) => (
                            <span
                              key={row.id}
                              className="block truncate rounded border-l-2 border-teal-400 bg-teal-50 px-1.5 py-0.5 text-[10px] text-slate-700"
                            >
                              <span className="font-medium text-teal-600">{displayTime(row)}</span>{' '}
                              {row.student_name.split(' ')[0]}
                            </span>
                          ))}
                          {dayRows.length > 2 && (
                            <span className="block pl-1 text-[9px] text-slate-400">
                              +{dayRows.length - 2} more
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white lg:col-span-4">
            <div className="bg-gradient-to-r from-teal-600 to-teal-500 px-4 py-3 text-white">
              <p className="text-[10px] font-medium uppercase opacity-80">
                {format(selectedDay, 'EEEE')}
              </p>
              <h3 className="text-base font-bold">{format(selectedDay, 'dd MMM yyyy')}</h3>
            </div>
            <div className="p-3 sm:p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h4 className="text-xs font-semibold text-slate-700">Schedule</h4>
                <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-medium text-teal-600">
                  {selectedDayRows.length} {selectedDayRows.length === 1 ? 'item' : 'items'}
                </span>
              </div>

              <div className="max-h-[18rem] space-y-2 overflow-y-auto">
                {selectedDayRows.length > 0 ? (
                  selectedDayRows.map((appointment) => (
                    <button
                      type="button"
                      key={appointment.id}
                      onClick={() => router.push(`/app/appointments/${appointment.id}`)}
                      className="flex w-full gap-2.5 rounded-lg border border-slate-100 p-2.5 text-left transition-all hover:border-teal-200 hover:bg-teal-50/30"
                    >
                      <span
                        className={cn(
                          'w-1 shrink-0 rounded-full',
                          appointmentAccent(appointment.status),
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-teal-600">
                            {displayTime(appointment)}
                          </span>
                          <span className="text-[9px] text-slate-400">
                            {appointment.duration} min
                          </span>
                        </span>
                        <span className="block truncate text-sm font-medium text-slate-900">
                          {appointment.student_name}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1 text-[10px] text-slate-500">
                          <TypeIcon type={appointment.type} size={11} /> {appointment.type}
                        </span>
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 py-8 text-center">
                    <CalendarDays size={20} className="mx-auto mb-2 text-slate-300" />
                    <p className="text-xs text-slate-400">
                      {hasQuery ? 'Nothing matching on this day' : 'No appointments'}
                    </p>
                  </div>
                )}
              </div>

              <Button
                onClick={() => onFormOpenChange(true)}
                className="mt-4 h-9 w-full bg-teal-600 text-xs font-medium text-white hover:bg-teal-700"
              >
                <Plus size={14} className="mr-1.5" /> Add on this day
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="p-3">
          {listQuery.isPending ? (
            <LoadingState rows={4} label="Loading appointments…" />
          ) : listQuery.isError ? (
            <ErrorState error={listQuery.error} onRetry={() => listQuery.refetch()} />
          ) : listRows.length === 0 ? (
            <EmptyState
              title="No appointments here"
              description={
                hasQuery
                  ? 'Nothing matches this search. Try widening it or clearing a filter.'
                  : 'Schedule one to get started.'
              }
              icon={CalendarDays}
              action={
                hasQuery ? (
                  <Button
                    variant="outline"
                    onClick={() => onChange({ search: '', committed: '', selection: {} })}
                  >
                    Clear search and filters
                  </Button>
                ) : (
                  <Button
                    onClick={() => onFormOpenChange(true)}
                    className="bg-teal-600 text-white hover:bg-teal-700"
                  >
                    <Plus className="mr-1.5 h-4 w-4" /> New appointment
                  </Button>
                )
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {listRows.map((appointment) => (
                <AppointmentCard
                  key={appointment.id}
                  appointment={appointment}
                  onOpen={() => router.push(`/app/appointments/${appointment.id}`)}
                  onEdit={() => openEdit(appointment)}
                  onDelete={can('deleteRecords') ? () => setPendingDelete(appointment) : undefined}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {mode === 'list' && listQuery.data && listRows.length > 0 && (
        <PaginationBar
          page={listQuery.data.page}
          pages={listQuery.data.pages}
          count={listQuery.data.count}
          pageSize={listQuery.data.page_size}
          onPageChange={(next) => onChange({ page: next })}
          isLoading={listQuery.isFetching}
        />
      )}

      {/*
        A right-edge panel, not a centred dialog — same shape and same width
        rule as the refund drawer: full width on a phone, 60% of the viewport
        from `md` up. Below 768px a 60% panel would be 384px, narrower than the
        form's own fields.
      */}
      <Drawer
        open={formOpen}
        onOpenChange={onFormOpenChange}
        onRequestClose={requestCloseForm}
        title={editing ? 'Edit appointment' : 'New appointment'}
        description="Schedule a meeting with a client."
        panelClassName="md:w-[60vw]"
        bodyClassName="px-4 py-5 sm:px-6"
        footer={formFooter}
      >
        <form
          id="appointment-form"
          onSubmit={handleSubmit}
          className="mx-auto w-full max-w-2xl space-y-4"
        >
          {formError && <ErrorBanner error={formError} />}
          {createMutation.isError && <ErrorBanner error={createMutation.error} />}
          {updateMutation.isError && <ErrorBanner error={updateMutation.error} />}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="apt-name" className="text-xs font-medium text-slate-600">
                Client name <span className="text-rose-500">*</span>
              </Label>
              <Input
                id="apt-name"
                value={form.student_name}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, student_name: event.target.value }))
                }
                placeholder="Enter name"
                className="h-9 text-sm"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="apt-email" className="text-xs font-medium text-slate-600">
                Email
              </Label>
              <Input
                id="apt-email"
                type="email"
                value={form.student_email}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, student_email: event.target.value }))
                }
                placeholder="client@email.com"
                className="h-9 text-sm"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-slate-600">
              Assign to <span className="text-rose-500">*</span>
            </Label>
            {staffQuery.isPending ? (
              <div className="h-9 animate-pulse rounded-md bg-slate-100" />
            ) : staffQuery.isError ? (
              <ErrorState
                error={staffQuery.error}
                onRetry={() => staffQuery.refetch()}
                title="Could not load staff"
              />
            ) : (
              <Select
                value={form.counselorId}
                onValueChange={(value) => setForm((prev) => ({ ...prev, counselorId: value }))}
              >
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue placeholder="Select staff member" />
                </SelectTrigger>
                <SelectContent className="max-h-60">
                  {staffOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="apt-date" className="text-xs font-medium text-slate-600">
                Date <span className="text-rose-500">*</span>
              </Label>
              <Input
                id="apt-date"
                type="date"
                value={form.date}
                onChange={(event) => setForm((prev) => ({ ...prev, date: event.target.value }))}
                className="h-9 text-sm"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="apt-time" className="text-xs font-medium text-slate-600">
                Time <span className="text-rose-500">*</span>
              </Label>
              <Input
                id="apt-time"
                type="time"
                value={form.time}
                onChange={(event) => setForm((prev) => ({ ...prev, time: event.target.value }))}
                className="h-9 text-sm"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-slate-600">Meeting type</Label>
              <Select
                value={form.type}
                onValueChange={(value) => setForm((prev) => ({ ...prev, type: value }))}
              >
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {APPOINTMENT_TYPES.map((value) => (
                    <SelectItem key={value} value={value}>
                      <span className="flex items-center gap-2">
                        <TypeIcon type={value} /> {value}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-slate-600">Duration</Label>
              <Select
                value={form.duration}
                onValueChange={(value) => setForm((prev) => ({ ...prev, duration: value }))}
              >
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DURATIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Status is only meaningful once the appointment exists. */}
          {editing && (
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-slate-600">Status</Label>
              <Select
                value={form.status}
                onValueChange={(value) => setForm((prev) => ({ ...prev, status: value }))}
              >
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {APPOINTMENT_STATUSES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="apt-notes" className="text-xs font-medium text-slate-600">
              Notes
            </Label>
            <Textarea
              id="apt-notes"
              rows={3}
              value={form.notes}
              onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
              placeholder="Anything to prepare?"
            />
          </div>
        </form>
      </Drawer>

      <ConfirmationModal
        open={pendingDelete !== null}
        onOpenChange={(next) => !next && setPendingDelete(null)}
        title="Delete this appointment?"
        description={
          pendingDelete
            ? `The appointment with ${pendingDelete.student_name} on ${
                safeDate(pendingDelete.date)
                  ? format(safeDate(pendingDelete.date) as Date, 'dd MMM yyyy')
                  : 'an unknown date'
              } will be removed.`
            : ''
        }
        confirmLabel="Delete"
        variant="destructive"
        isLoading={deleteMutation.isPending}
        onConfirm={() => pendingDelete && deleteMutation.mutate(pendingDelete.id)}
      />
    </>
  );
}

/* -------------------------------------------------------------------------- */

function AppointmentCard({
  appointment,
  onOpen,
  onEdit,
  onDelete,
}: {
  appointment: Appointment;
  onOpen: () => void;
  onEdit: () => void;
  /** Absent for roles the backend refuses a delete from; see ScopedModelViewSet. */
  onDelete?: () => void;
}) {
  const parsed = safeDate(appointment.date);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 transition-all hover:border-teal-300 hover:shadow-md">
      <div className="mb-3 flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100">
            <TypeIcon type={appointment.type} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-slate-900">
              {appointment.student_name}
            </span>
            <span className="block text-[10px] text-slate-500">{appointment.type}</span>
          </span>
        </button>

        {/*
          `modal={false}`: a modal Radix menu sets `pointer-events: none` on the
          body and only clears it when IT closes. Choosing Delete opens the
          confirmation on top, and the menu's cleanup then loses the race with
          the dialog's — leaving the whole page unclickable after the delete,
          with nothing on screen to explain why.
        */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 shrink-0 p-0"
              aria-label={`Actions for ${appointment.student_name}`}
            >
              <MoreHorizontal size={14} className="text-slate-400" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[9rem]">
            <DropdownMenuItem onClick={onEdit} className="text-xs">
              <Edit size={12} className="mr-2" /> Edit
            </DropdownMenuItem>
            {onDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onDelete} className="text-xs text-rose-600">
                  <Trash2 size={12} className="mr-2" /> Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2">
        <div className="rounded-md bg-slate-50 px-2.5 py-2">
          <p className="text-[9px] font-semibold uppercase text-slate-400">Date &amp; time</p>
          <p className="truncate text-xs font-medium text-slate-800">
            {parsed ? format(parsed, 'dd MMM') : '—'} • {displayTime(appointment)}
          </p>
        </div>
        <div className="rounded-md bg-slate-50 px-2.5 py-2">
          <p className="text-[9px] font-semibold uppercase text-slate-400">Duration</p>
          <p className="text-xs font-medium text-slate-800">{appointment.duration} min</p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-2">
        <Badge
          className={cn(
            'border px-2 py-0.5 text-[9px]',
            APPOINTMENT_STATUS_TONES[appointment.status] ??
              'border-slate-200 bg-slate-50 text-slate-600',
          )}
        >
          {appointment.status}
        </Badge>
        <span className="truncate text-[10px] text-slate-500">
          with {appointment.counselor_name}
        </span>
      </div>
    </div>
  );
}
