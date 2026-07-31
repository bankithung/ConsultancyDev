'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { format, formatDistanceToNow, isToday, isYesterday } from 'date-fns';
import {
  AlertCircle,
  AlertTriangle,
  Bell,
  BellOff,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock,
  Eye,
  Inbox,
  Info,
  Search,
  type LucideIcon,
} from 'lucide-react';

import { apiClient } from '@/lib/apiClient';
import type { Notification } from '@/lib/types';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, InlineSpinner, LoadingState } from '@/components/common/states';
import { cn } from '@/lib/utils';
import { toast } from '@/store/toastStore';

/**
 * Notifications are READ-ONLY plus mark-as-read.
 *
 * The backend viewset is a ReadOnlyModelViewSet whose queryset is filtered to
 * `user=request.user`, and creation happens server-side in core.signals. There
 * is deliberately no client-side create or delete: `user` and `action_url` were
 * once writable on an authenticated endpoint, which let any user plant a
 * notification carrying an arbitrary link in an administrator's tray. So this
 * page offers exactly three verbs — read, mark one, mark all.
 */

/** Rows per request, and the ceiling on requests a single load may issue. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

interface NotificationTray {
  rows: Notification[];
  /** Server total. Exceeds `rows.length` only when MAX_PAGES was reached. */
  count: number;
  truncated: boolean;
}

/**
 * Loads the whole tray rather than one page.
 *
 * The day headings, the all/unread/read tabs and the search box all describe
 * the complete set. Running them over a single 25-row page would produce
 * headings and counts that silently describe page one while reading as totals.
 * This endpoint is per-user, so the collection is small; MAX_PAGES bounds it
 * anyway, and `truncated` is surfaced rather than hidden.
 */
async function fetchTray(): Promise<NotificationTray> {
  const rows: Notification[] = [];
  let page = 1;
  let pages = 1;
  let count = 0;

  do {
    const envelope = await apiClient.notifications.list({ page, page_size: PAGE_SIZE });
    rows.push(...envelope.results);
    pages = envelope.pages;
    count = envelope.count;
    page += 1;
  } while (page <= pages && page <= MAX_PAGES);

  return { rows, count, truncated: rows.length < count };
}

type TrayFilter = 'all' | 'unread' | 'read';

const FILTERS: ReadonlyArray<{ id: TrayFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'read', label: 'Read' },
];

interface TypeStyle {
  icon: LucideIcon;
  tint: string;
  fg: string;
}

/**
 * Keyed on `Notification.TYPE_CHOICES` from the model — info/success/warning/
 * error. The field is a plain CharField, so an unrecognised value falls back to
 * a neutral bell rather than rendering nothing.
 */
const TYPE_STYLES: Record<string, TypeStyle> = {
  info: { icon: Info, tint: 'bg-blue-50', fg: 'text-blue-600' },
  success: { icon: CheckCircle2, tint: 'bg-emerald-50', fg: 'text-emerald-600' },
  warning: { icon: AlertTriangle, tint: 'bg-amber-50', fg: 'text-amber-600' },
  error: { icon: AlertCircle, tint: 'bg-red-50', fg: 'text-red-600' },
};

const FALLBACK_STYLE: TypeStyle = { icon: Bell, tint: 'bg-slate-100', fg: 'text-slate-500' };

function styleFor(type: string): TypeStyle {
  return TYPE_STYLES[(type ?? '').toLowerCase()] ?? FALLBACK_STYLE;
}

/**
 * Only same-origin paths are followed.
 *
 * `action_url` is server-generated and read-only on the serializer, but this
 * page turns it into navigation, so it is checked here too: a stored absolute
 * URL should never become an off-site redirect a user clicked from their own
 * notification tray.
 */
function internalPath(actionUrl: string | undefined): string | null {
  if (!actionUrl) return null;
  return actionUrl.startsWith('/') && !actionUrl.startsWith('//') ? actionUrl : null;
}

function groupLabel(date: Date): string {
  if (isToday(date)) return 'Today';
  if (isYesterday(date)) return 'Yesterday';
  return format(date, 'MMMM d, yyyy');
}

export default function NotificationsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<TrayFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const tray = useQuery({
    queryKey: ['notifications', 'tray'],
    queryFn: fetchTray,
  });

  // The authoritative unread figure, straight off `notifications/unread-count/`,
  // so the tile agrees with the bell in the app shell.
  const unreadCount = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => apiClient.notifications.unreadCount(),
  });

  const refreshTray = () => {
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  };

  const markOne = useMutation({
    mutationFn: (id: string) => apiClient.notifications.markAsRead(id),
    onSuccess: refreshTray,
    onError: () => toast.error('Could not mark as read', 'Please try again.'),
  });

  // One request, not one per row. The previous version looped `markAsRead` over
  // every unread notification, which fired N writes and reported success before
  // any of them had landed.
  const markAll = useMutation({
    mutationFn: () => apiClient.notifications.markAllAsRead(),
    onSuccess: () => {
      refreshTray();
      toast.success('All notifications marked as read');
    },
    onError: () => toast.error('Could not mark all as read', 'Please try again.'),
  });

  const rows = useMemo(() => tray.data?.rows ?? [], [tray.data]);

  const filtered = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    return rows.filter((n) => {
      const matchesFilter =
        filter === 'all' || (filter === 'unread' ? !n.read : n.read);
      const matchesSearch =
        !needle ||
        n.title.toLowerCase().includes(needle) ||
        n.message.toLowerCase().includes(needle);
      return matchesFilter && matchesSearch;
    });
  }, [rows, filter, searchQuery]);

  // Built as an array, not an object, so the day order follows the API's
  // newest-first ordering instead of depending on key-insertion behaviour.
  const groups = useMemo(() => {
    const out: Array<{ label: string; items: Notification[] }> = [];
    for (const n of filtered) {
      const label = groupLabel(new Date(n.created_at));
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(n);
      else out.push({ label, items: [n] });
    }
    return out;
  }, [filtered]);

  const total = tray.data?.count ?? 0;
  const unread = unreadCount.data ?? 0;
  const read = Math.max(total - unread, 0);

  const handleView = (notification: Notification) => {
    if (!notification.read) markOne.mutate(notification.id);
    const path = internalPath(notification.actionUrl);
    if (path) router.push(path);
  };

  if (tray.isLoading) {
    return (
      <div className="space-y-4">
        <LoadingState rows={6} label="Loading notifications…" />
      </div>
    );
  }

  if (tray.isError) {
    return (
      <ErrorState
        error={tray.error}
        onRetry={() => void tray.refetch()}
        title="Could not load notifications"
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-base font-semibold text-slate-900">Notifications</h1>
          <p className="text-xs text-slate-500">Updates raised for you by the system</p>
        </div>
        {unread > 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => markAll.mutate()}
            disabled={markAll.isPending}
            className="h-8 shrink-0 text-xs"
          >
            {markAll.isPending ? (
              <InlineSpinner className="mr-2" />
            ) : (
              <Check size={14} className="mr-1.5" />
            )}
            Mark all read ({unread})
          </Button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <StatTile label="Total" value={total} icon={Inbox} tint="bg-slate-100" fg="text-slate-600" valueClass="text-slate-900" />
        <StatTile label="Unread" value={unread} icon={Bell} tint="bg-amber-50" fg="text-amber-600" valueClass="text-amber-600" pending={unreadCount.isLoading} />
        <StatTile label="Read" value={read} icon={CheckCircle2} tint="bg-emerald-50" fg="text-emerald-600" valueClass="text-emerald-600" pending={unreadCount.isLoading} />
      </div>

      {/* Search + filter */}
      <Card className="border-slate-200">
        <CardContent className="p-3">
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <Input
                placeholder="Search notifications…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-9 border-slate-200 pl-8 text-sm focus-visible:border-teal-400"
              />
            </div>

            <div className="grid grid-cols-3 overflow-hidden rounded-lg border border-slate-200 sm:flex">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFilter(f.id)}
                  aria-pressed={filter === f.id}
                  className={cn(
                    'px-3 py-2 text-xs font-medium transition-colors sm:px-4',
                    filter === f.id
                      ? 'bg-teal-600 text-white'
                      : 'bg-white text-slate-600 hover:bg-slate-50',
                    f.id !== 'all' && 'border-l border-slate-200'
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {tray.data?.truncated && (
        <p className="text-[11px] text-slate-400">
          Showing the {rows.length.toLocaleString()} most recent of {total.toLocaleString()}.
        </p>
      )}

      {/* List */}
      {filtered.length === 0 ? (
        searchQuery || filter !== 'all' ? (
          <EmptyState
            title="No notifications match your filters"
            description="Try a different search term, or switch back to All."
            icon={Search}
            action={
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => {
                  setSearchQuery('');
                  setFilter('all');
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            title="No notifications yet"
            description="You're all caught up. Updates about payments, documents and follow-ups will appear here."
            icon={BellOff}
          />
        )
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.label}>
              <div className="mb-2 flex items-center gap-2">
                <Clock size={12} className="shrink-0 text-slate-400" />
                <span className="text-xs font-medium text-slate-500">{group.label}</span>
                <div className="h-px flex-1 bg-slate-200" />
                <span className="shrink-0 text-[10px] text-slate-400">
                  {group.items.length} {group.items.length === 1 ? 'item' : 'items'}
                </span>
              </div>

              <div className="space-y-2">
                {group.items.map((notification) => (
                  <NotificationRow
                    key={notification.id}
                    notification={notification}
                    onOpen={handleView}
                    onMarkRead={(id) => markOne.mutate(id)}
                    isMarking={markOne.isPending && markOne.variables === notification.id}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {filtered.length > 0 && (
        <p className="py-2 text-center text-xs text-slate-400">
          Showing {filtered.length} of {rows.length} loaded
        </p>
      )}
    </div>
  );
}

function StatTile({
  label,
  value,
  icon: Icon,
  tint,
  fg,
  valueClass,
  pending = false,
}: {
  label: string;
  value: number;
  icon: LucideIcon;
  tint: string;
  fg: string;
  valueClass: string;
  pending?: boolean;
}) {
  return (
    <Card className="border-slate-200">
      <CardContent className="p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase text-slate-500">{label}</p>
            <p className={cn('text-lg font-bold sm:text-xl', valueClass)}>
              {pending ? '—' : value.toLocaleString()}
            </p>
          </div>
          <div className={cn('shrink-0 rounded-lg p-2', tint)}>
            <Icon size={16} className={fg} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function NotificationRow({
  notification,
  onOpen,
  onMarkRead,
  isMarking,
}: {
  notification: Notification;
  onOpen: (notification: Notification) => void;
  onMarkRead: (id: string) => void;
  isMarking: boolean;
}) {
  const style = styleFor(notification.type);
  const Icon = style.icon;
  const path = internalPath(notification.actionUrl);
  const created = new Date(notification.created_at);
  const hasTimestamp = !Number.isNaN(created.getTime());

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={() => onOpen(notification)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(notification);
        }
      }}
      className={cn(
        'group cursor-pointer border transition-all hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500',
        !notification.read
          ? 'border-teal-200 bg-teal-50/30'
          : 'border-slate-200 bg-white hover:border-slate-300'
      )}
    >
      <CardContent className="p-3">
        <div className="flex items-start gap-3">
          <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', style.tint)}>
            <Icon size={16} className={style.fg} />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <h3
                  className={cn(
                    'truncate text-sm',
                    !notification.read ? 'font-semibold text-slate-900' : 'font-medium text-slate-700'
                  )}
                >
                  {notification.title}
                </h3>
                {!notification.read && (
                  <span className="h-2 w-2 shrink-0 rounded-full bg-teal-500" aria-label="Unread" />
                )}
              </div>
              {hasTimestamp && (
                <span className="shrink-0 whitespace-nowrap text-[10px] text-slate-400">
                  {formatDistanceToNow(created, { addSuffix: true })}
                </span>
              )}
            </div>

            {notification.message && (
              <p className="mt-0.5 line-clamp-2 text-xs text-slate-600">{notification.message}</p>
            )}

            {/* Always visible on touch, revealed on hover at desk widths — an
                opacity-0 action row is unreachable on a phone. */}
            <div className="mt-2 flex items-center gap-3 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
              {!notification.read && (
                <button
                  type="button"
                  disabled={isMarking}
                  onClick={(e) => {
                    e.stopPropagation();
                    onMarkRead(notification.id);
                  }}
                  className="flex items-center gap-1 text-[10px] font-medium text-teal-600 hover:text-teal-700 disabled:opacity-50"
                >
                  <Check size={10} /> {isMarking ? 'Marking…' : 'Mark read'}
                </button>
              )}
              {path && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(notification);
                  }}
                  className="flex items-center gap-1 text-[10px] font-medium text-blue-600 hover:text-blue-700"
                >
                  <Eye size={10} /> View
                </button>
              )}
            </div>
          </div>

          {path && (
            <ChevronRight
              size={16}
              className="mt-1 hidden shrink-0 text-slate-300 group-hover:text-slate-500 sm:block"
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
