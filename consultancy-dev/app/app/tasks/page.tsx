'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import {
    Plus, Clock, Bell, Phone, Mail, MessageSquare,
    Flag, Layout, FileText, Circle, Loader2, Check,
    ChevronDown, ChevronUp, Search, MoreHorizontal, Trash2, User as UserIcon,
    SlidersHorizontal, X,
} from 'lucide-react';

import { getApiErrorMessage, api } from '@/lib/api';
import { apiClient, fetchCount, fetchPage } from '@/lib/apiClient';
import type { Branch, FollowUp, Paginated, ScopedFields, User as StaffUser } from '@/lib/types';
import { toArray } from '@/components/common/pagination';
import { Drawer } from '@/components/common/Drawer';
import {
    FilterDrawer, selectionCount,
    type FilterGroup, type FilterSelection,
} from '@/components/common/FilterDrawer';
import { ErrorState, LoadingState } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useAuth } from '@/hooks/useAuth';
import { useCurrentRole } from '@/components/rbac/useCurrentRole';
import { ROLES } from '@/components/rbac/roles';
import { useDebounce } from '@/hooks/useDebounce';
import { toast } from '@/store/toastStore';

/* -------------------------------------------------------------------------- */
/* Wire types                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors the backend `TaskSerializer` field-for-field.
 *
 * Declared here rather than imported because `Task` in lib/types.ts is still
 * the pre-migration shape (`assignedTo`/`dueDate` strings, no description,
 * priority, assignee id or completion timestamp) and `apiClient.tasks` maps to
 * it, which would drop everything this board needs. Move this into lib/types.ts
 * and delete the local fetchers once that type is brought up to the serializer.
 */
interface TaskRow extends ScopedFields {
    id: number;
    title: string;
    description: string;
    /** User FK — NOT a name. Required server-side (no null=True on the model). */
    assigned_to: number | null;
    /** Read-only display name, or '—' when unassigned. */
    assigned_to_name: string;
    due_date: string;
    priority: string;
    status: string;
    completed_at: string | null;
    pending_approval?: { id: number; message: string; requested_by: number; assigned_reviewer: number | null; pending_changes: { status: ColumnType } } | null;
}

/** Writable fields on `tasks/`. Scope fields are stamped server-side. */
interface TaskInput {
    title: string;
    description?: string;
    assigned_to: number;
    due_date: string;
    priority?: string;
    status?: string;
}

/* -------------------------------------------------------------------------- */
/* Board vocabulary                                                            */
/* -------------------------------------------------------------------------- */

/** WIRE values for `Task.status`. These are the board's three columns. */
const COLUMNS = ['Todo', 'In Progress', 'Done'] as const;
type ColumnType = typeof COLUMNS[number];

/** WIRE values for `Task.priority` (a free CharField defaulting to 'Medium'). */
const PRIORITIES = ['Low', 'Medium', 'High'] as const;
type Priority = typeof PRIORITIES[number];

const PRIORITY_BORDER: Record<string, string> = {
    High: 'border-l-red-500',
    Medium: 'border-l-amber-500',
    Low: 'border-l-slate-400',
};

const PRIORITY_DOT: Record<string, string> = {
    High: 'bg-red-500',
    Medium: 'bg-amber-500',
    Low: 'bg-slate-400',
};

const COLUMN_ICONS = { 'Todo': Circle, 'In Progress': Loader2, 'Done': Check } as const;

const COLUMN_COLORS: Record<ColumnType, { bg: string; border: string; text: string; badge: string }> = {
    'Todo': { bg: 'bg-slate-50', border: 'border-slate-200', text: 'text-slate-700', badge: 'bg-slate-200 text-slate-700' },
    'In Progress': { bg: 'bg-blue-50/50', border: 'border-blue-200', text: 'text-blue-700', badge: 'bg-blue-100 text-blue-700' },
    'Done': { bg: 'bg-emerald-50/50', border: 'border-emerald-200', text: 'text-emerald-700', badge: 'bg-emerald-100 text-emerald-700' },
};

/**
 * A kanban board has to show every card, not page 1 of 25, so it asks for the
 * server's maximum page.
 *
 * VERIFIED: this is a CAP, not "everything". `StandardPagination` (backend
 * core/pagination.py) sets `max_page_size = 200`, so a larger request is
 * silently trimmed back to 200. Every figure this page derives by counting the
 * loaded rows — the column badges, overdue, due today — is therefore only true
 * while `count <= 200`. Past that they are suppressed rather than shown wrong;
 * see `boardComplete`.
 */
const BOARD_PAGE_SIZE = 200;

/**
 * Roles that see other people's records, and so have a branch worth filtering
 * by. Mirrors the admissions directory.
 */
const SUPERVISOR_ROLES = [
    ROLES.DEV_ADMIN,
    ROLES.COMPANY_ADMIN,
    ROLES.HEAD_MANAGER,
    ROLES.BRANCH_MANAGER,
] as const;

const priorityBorder = (value: string) => PRIORITY_BORDER[value] ?? PRIORITY_BORDER.Low;
const priorityDot = (value: string) => PRIORITY_DOT[value] ?? PRIORITY_DOT.Low;

function isColumn(value: string): value is ColumnType {
    return (COLUMNS as readonly string[]).includes(value);
}

function formatTaskDate(value: string | null | undefined): string {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : format(date, 'MMM d');
}

function formatTimestamp(value: string | null | undefined): string {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : format(date, 'MMM d, yyyy • h:mm a');
}

function isOverdue(value: string | null | undefined): boolean {
    if (!value) return false;
    const date = new Date(value);
    return !Number.isNaN(date.getTime()) && date < new Date();
}

function isDueToday(value: string | null | undefined): boolean {
    if (!value) return false;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return false;
    const today = new Date();
    return (
        date.getFullYear() === today.getFullYear() &&
        date.getMonth() === today.getMonth() &&
        date.getDate() === today.getDate()
    );
}

function staffName(user: StaffUser): string {
    const full = `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim();
    return full || user.username;
}

/** `due_date` is a DateTimeField; the edit form's date input wants YYYY-MM-DD. */
function toDateInput(value: string | null | undefined): string {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : format(date, 'yyyy-MM-dd');
}

/* -------------------------------------------------------------------------- */
/* Cards and columns                                                           */
/* -------------------------------------------------------------------------- */

interface CardProps {
    task: TaskRow;
    onEdit: (task: TaskRow) => void;
    onMove: (task: TaskRow, status: ColumnType) => void;
    onDelete: (task: TaskRow) => void;
    canDelete: boolean;
    onDragStart: (task: TaskRow) => void;
    onDragEnd: () => void;
    isDragging: boolean;
}

function TaskCard({ task, onEdit, onMove, onDelete, canDelete, onDragStart, onDragEnd, isDragging }: CardProps) {
    const [menuOpen, setMenuOpen] = useState(false);
    const overdue = task.status !== 'Done' && isOverdue(task.due_date);

    return (
        <div
            draggable
            onDragStart={(event) => {
                // `setData` is what makes Firefox start the drag at all.
                event.dataTransfer.setData('text/plain', String(task.id));
                event.dataTransfer.effectAllowed = 'move';
                onDragStart(task);
            }}
            onDragEnd={onDragEnd}
            className={`
                relative bg-white rounded-lg border-l-[3px] ${priorityBorder(task.priority)}
                border border-slate-200 p-2.5 cursor-grab active:cursor-grabbing
                transition-all duration-150
                ${isDragging ? 'opacity-40' : ''}
                hover:shadow-md hover:border-slate-300
            `}
        >
            <div className="flex items-start justify-between gap-2 mb-1.5">
                <button
                    type="button"
                    onClick={() => onEdit(task)}
                    className="text-[13px] font-medium text-slate-800 leading-snug line-clamp-2 flex-1 text-left hover:text-teal-700"
                >
                    {task.title}
                </button>

                <div className="flex items-center gap-0.5 shrink-0">
                    {task.description && (
                        <span className="p-0.5 text-slate-400" title={task.description}>
                            <FileText size={12} />
                        </span>
                    )}
                    {/*
                      Touch devices do not fire HTML5 drag events, so every drag
                      action is also reachable from this menu. It is the only way
                      to move a card on a phone.
                    */}
                    <button
                        type="button"
                        onClick={() => setMenuOpen((open) => !open)}
                        onBlur={() => window.setTimeout(() => setMenuOpen(false), 120)}
                        className="p-0.5 text-slate-400 hover:text-slate-600 rounded"
                        aria-label={`Actions for ${task.title}`}
                        aria-expanded={menuOpen}
                    >
                        <MoreHorizontal size={14} />
                    </button>
                </div>
            </div>

            {menuOpen && (
                <div className="absolute right-2 top-8 z-30 w-40 rounded-md border border-slate-200 bg-white py-1 shadow-lg">
                    <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Move to</p>
                    {COLUMNS.filter((column) => column !== task.status).map((column) => (
                        <button
                            key={column}
                            type="button"
                            onMouseDown={(event) => {
                                event.preventDefault();
                                onMove(task, column);
                                setMenuOpen(false);
                            }}
                            className="block w-full px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50"
                        >
                            {column}
                        </button>
                    ))}
                    <div className="my-1 border-t border-slate-100" />
                    <button
                        type="button"
                        onMouseDown={(event) => {
                            event.preventDefault();
                            onEdit(task);
                            setMenuOpen(false);
                        }}
                        className="block w-full px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50"
                    >
                        Edit details
                    </button>
                    {canDelete && (
                        <button
                            type="button"
                            onMouseDown={(event) => {
                                event.preventDefault();
                                onDelete(task);
                                setMenuOpen(false);
                            }}
                            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50"
                        >
                            <Trash2 size={12} /> Delete
                        </button>
                    )}
                </div>
            )}

            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                    <div className={`flex items-center gap-1 text-[11px] ${overdue ? 'text-red-600 font-medium' : 'text-slate-500'}`}>
                        <Clock size={10} />
                        <span>{formatTaskDate(task.due_date)}</span>
                    </div>
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${priorityDot(task.priority)}`} title={`${task.priority} priority`} />
                </div>

                <div
                    className="w-5 h-5 rounded-full bg-gradient-to-br from-teal-400 to-teal-600 flex items-center justify-center text-[9px] font-bold text-white shadow-sm shrink-0"
                    title={task.assigned_to_name}
                >
                    {(task.assigned_to_name || '?').charAt(0).toUpperCase()}
                </div>
            </div>
        </div>
    );
}

function BoardColumn({
    column,
    tasks,
    showCount,
    onAddTask,
    onDropTask,
    children,
}: {
    column: ColumnType;
    tasks: TaskRow[];
    /**
     * False once the board has been trimmed by the page cap — the badge would
     * then be counting the rows that happened to arrive, not the column.
     */
    showCount: boolean;
    onAddTask: () => void;
    onDropTask: (column: ColumnType) => void;
    children: React.ReactNode;
}) {
    const [isOver, setIsOver] = useState(false);
    const colors = COLUMN_COLORS[column];
    const Icon = COLUMN_ICONS[column];

    return (
        <div
            onDragOver={(event) => {
                // Without preventDefault the browser refuses the drop outright.
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                if (!isOver) setIsOver(true);
            }}
            onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsOver(false);
            }}
            onDrop={(event) => {
                event.preventDefault();
                setIsOver(false);
                onDropTask(column);
            }}
            className={`
                flex flex-col rounded-lg border transition-all duration-200 min-h-[140px] md:min-h-[360px]
                ${isOver ? 'border-teal-400 bg-teal-50/50 ring-2 ring-teal-200' : `${colors.border} ${colors.bg}`}
            `}
        >
            <div className={`flex items-center justify-between px-3 py-2 border-b ${colors.border}`}>
                <div className="flex items-center gap-2">
                    <Icon size={14} className={`${colors.text} ${column === 'In Progress' ? 'animate-spin' : ''}`} />
                    <h3 className={`font-semibold text-sm ${colors.text}`}>{column}</h3>
                    {showCount && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${colors.badge}`}>{tasks.length}</span>
                    )}
                </div>
                <button
                    onClick={onAddTask}
                    className="p-1 rounded hover:bg-white/70 text-slate-400 hover:text-teal-600 transition-colors"
                    title={`Add task to ${column}`}
                    aria-label={`Add task to ${column}`}
                >
                    <Plus size={14} />
                </button>
            </div>

            {/*
              The inner scroller only exists from `md` up, where the three
              columns sit side by side and each needs its own viewport. On a
              phone the columns are stacked, and a short scrolling box inside a
              scrolling page is a trap — there the list grows and the page
              scrolls instead.
            */}
            <div className="flex-1 space-y-2 p-2 md:overflow-y-auto md:max-h-[calc(100vh-300px)]">
                {children}
            </div>
        </div>
    );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

const EMPTY_DRAFT = {
    title: '',
    description: '',
    assigned_to: '',
    due_date: '',
    priority: 'Medium' as Priority,
    status: 'Todo' as ColumnType,
};

type Draft = typeof EMPTY_DRAFT;

/** Field-by-field rather than a stringify, so key order cannot decide it. */
function isSameDraft(a: Draft, b: Draft): boolean {
    return (
        a.title === b.title &&
        a.description === b.description &&
        a.assigned_to === b.assigned_to &&
        a.due_date === b.due_date &&
        a.priority === b.priority &&
        a.status === b.status
    );
}

export default function TasksPage() {
    const { user } = useAuth();
    const { can, is } = useCurrentRole();
    const router = useRouter();
    const queryClient = useQueryClient();

    const isEmployee = user?.role === 'EMPLOYEE';
    const [approvalTask, setApprovalTask] = useState<TaskRow | null>(null);
    const [approvalStatus, setApprovalStatus] = useState<ColumnType>('In Progress');
    const [approvalMessage, setApprovalMessage] = useState('');
    const [reviewerId, setReviewerId] = useState('');
    const reviewers = useQuery({
        queryKey: ['task-reviewers', approvalTask?.id],
        enabled: !!approvalTask,
        queryFn: async () => (await api.get<Array<{id:number;name:string;role:string}>>(`tasks/${approvalTask!.id}/reviewers/`)).data,
    });
    const requestApproval = useMutation({
        mutationFn: () => api.post(`tasks/${approvalTask!.id}/request-status/`, {
            status: approvalStatus, message: approvalMessage, assigned_reviewer: Number(reviewerId),
        }),
        onSuccess: () => { invalidateBoard(); setApprovalTask(null); toast.success('Approval request saved'); },
        onError: (error) => toast.error('Could not request approval', getApiErrorMessage(error)),
    });
    const openApproval = (task: TaskRow, status: ColumnType) => {
        setApprovalTask(task);
        setApprovalStatus(status);
        setApprovalMessage(task.pending_approval?.message ?? '');
        setReviewerId(String(task.pending_approval?.assigned_reviewer ?? ''));
    };

    const canSeeOthers = is(...SUPERVISOR_ROLES);

    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [searchInput, setSearchInput] = useState('');
    const search = useDebounce(searchInput, 300);
    const [isFilterOpen, setIsFilterOpen] = useState(false);
    const [activeParam, setActiveParam] = useState<string>('priority');
    const [selection, setSelectionState] = useState<FilterSelection>({});
    const [followUpsExpanded, setFollowUpsExpanded] = useState(true);

    const [draft, setDraft] = useState(EMPTY_DRAFT);
    /** What the create form opened with — the baseline its dirty check uses. */
    const [draftBaseline, setDraftBaseline] = useState(EMPTY_DRAFT);
    const [confirmDiscardCreate, setConfirmDiscardCreate] = useState(false);
    const [editingTask, setEditingTask] = useState<TaskRow | null>(null);
    /** The unedited row, kept so the edit form knows what the user changed. */
    const [originalTask, setOriginalTask] = useState<TaskRow | null>(null);
    const [isEditOpen, setIsEditOpen] = useState(false);
    const [editTab, setEditTab] = useState<'details' | 'history'>('details');
    const [confirmDiscardEdit, setConfirmDiscardEdit] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<TaskRow | null>(null);
    const [draggedTask, setDraggedTask] = useState<TaskRow | null>(null);

    /**
     * Every key here is a parameter `TaskViewSet` actually declares
     * (`filterset_fields = ('status', 'assigned_to', 'priority', 'branch')`).
     * DRF drops query parameters it does not recognise and answers 200 with the
     * UNFILTERED list, so a control wired to anything else would look like it
     * worked while showing the wrong rows.
     */
    const taskFilters = useMemo(() => {
        const filters: Record<string, string> = {};
        for (const [param, values] of Object.entries(selection)) {
            if (values.length > 0) filters[param] = values[0];
        }
        return filters;
    }, [selection]);

    /**
     * Task filters are django-filter's AUTO-GENERATED ones — plain exact
     * lookups, not the `MultiValueFilter` subclasses in core/filters.py that
     * back the enquiry and payment drawers. Repeated keys
     * (`?priority=High&priority=Low`) reach a form field that reads
     * `QueryDict.get()`, so only the LAST value is ever applied.
     *
     * The drawer is multi-select by construction, so each group is clamped to
     * one value here: the newest pick replaces the previous one. The checkbox
     * state then always matches what the server was asked for, which a silent
     * second selection would not.
     */
    const setSelection = (next: FilterSelection) => {
        const clamped: FilterSelection = {};
        for (const [param, values] of Object.entries(next)) {
            if (values.length === 0) continue;
            const previous = selection[param] ?? [];
            const added = values.filter((value) => !previous.includes(value));
            clamped[param] = [added.length > 0 ? added[added.length - 1] : values[values.length - 1]];
        }
        setSelectionState(clamped);
    };

    /** The exact key the board's rows live under, shared with the optimistic move. */
    const boardKey = useMemo(() => ['tasks', 'board', { search, filters: taskFilters }] as const, [search, taskFilters]);

    /**
     * `TaskViewSet` declares `search_fields = ('title', 'description')`, so the
     * search box runs in SQL rather than over one page.
     */
    const tasksQuery = useQuery({
        queryKey: boardKey,
        queryFn: () =>
            fetchPage<TaskRow>('tasks/', {
                page_size: BOARD_PAGE_SIZE,
                ordering: 'due_date',
                search: search || undefined,
                filters: taskFilters,
            }),
    });

    const tasks = useMemo(() => toArray(tasksQuery.data), [tasksQuery.data]);
    const totalCount = tasksQuery.data?.count ?? 0;
    const truncated = totalCount > tasks.length;
    /** True only when every matching task is in memory. Gate for counted figures. */
    const boardComplete = !truncated;

    const usersQuery = useQuery({
        queryKey: ['users', 'assignable'],
        queryFn: () => apiClient.users.list({ page_size: 200, ordering: 'username' }),
    });
    const users = toArray(usersQuery.data);

    const branchesQuery = useQuery({
        queryKey: ['branches', 'filter-options'],
        queryFn: () => apiClient.branches.list({ page_size: 200, ordering: 'name' }),
        enabled: canSeeOthers,
        staleTime: 5 * 60 * 1000,
    });

    /**
     * "Assigned to me" comes from the SERVER's own count for
     * `?assigned_to=<me>` rather than from the rows on screen, so it stays true
     * past the 200-row cap. It is hidden while an explicit "Assigned to" filter
     * is set, where the board is already scoped to named people and a figure
     * ignoring that filter would read as a contradiction.
     */
    const assigneeFilter = selection.assigned_to?.[0];
    const myTaskCountQuery = useQuery({
        queryKey: ['tasks', 'mine-count', user?.id, { search, filters: taskFilters }],
        queryFn: () =>
            fetchCount('tasks/', {
                search: search || undefined,
                filters: { ...taskFilters, assigned_to: String(user?.id ?? 0) },
            }),
        enabled: Boolean(user?.id) && !assigneeFilter,
    });

    /**
     * Follow-ups assigned to the signed-in user and still pending. Filtered in
     * SQL — `FollowUpViewSet.filterset_fields` covers both status and
     * assigned_to, so no client-side sweep over a page of rows.
     */
    const followUpsQuery = useQuery({
        queryKey: ['follow-ups', 'mine', user?.id],
        queryFn: () =>
            apiClient.followUps.list({
                page_size: 10,
                ordering: 'scheduled_for',
                filters: { status: 'Pending', assigned_to: user?.id ?? 0 },
            }),
        enabled: Boolean(user?.id),
    });
    const myFollowUps = toArray<FollowUp>(followUpsQuery.data);

    const tasksByColumn = useMemo(() => {
        const grouped: Record<ColumnType, TaskRow[]> = { 'Todo': [], 'In Progress': [], 'Done': [] };
        for (const task of tasks) {
            // An unrecognised status would otherwise vanish from the board
            // entirely; park it in Todo so it is still actionable.
            grouped[isColumn(task.status) ? task.status : 'Todo'].push(task);
        }
        return grouped;
    }, [tasks]);

    /**
     * The two figures the three columns cannot show. Both are counted over the
     * loaded rows because `due_date` has NO server-side filter — `TaskViewSet`
     * lists it under `ordering_fields` only — so there is no endpoint to ask.
     * That makes them honest exactly while `boardComplete`, and they are not
     * rendered otherwise.
     */
    const dateCounts = useMemo(() => {
        let overdue = 0;
        let dueToday = 0;
        for (const task of tasks) {
            if (task.status === 'Done') continue;
            if (isOverdue(task.due_date)) overdue += 1;
            else if (isDueToday(task.due_date)) dueToday += 1;
        }
        return { overdue, dueToday };
    }, [tasks]);

    /**
     * Only groups the server implements. Deliberately absent:
     *
     * - `status`, which IS a server filter but is also the board's three
     *   columns — filtering it would blank two of them.
     * - anything date-shaped (overdue, due this week): there is no due_date
     *   filter on the viewset, and DRF would answer 200 with every row.
     */
    const groups = useMemo<FilterGroup[]>(() => {
        const base: FilterGroup[] = [
            {
                param: 'priority',
                label: 'Priority',
                options: PRIORITIES.map((priority) => ({ value: priority, label: priority })),
                hint: 'One at a time — the server matches a single priority.',
            },
            {
                param: 'assigned_to',
                label: 'Assigned to',
                searchable: true,
                options: users.map((candidate) => ({
                    value: String(candidate.id),
                    label: staffName(candidate),
                })),
                hint: 'One at a time — the server matches a single assignee.',
            },
        ];

        if (!canSeeOthers) return base;

        return [
            ...base,
            {
                param: 'branch',
                label: 'Branch',
                searchable: true,
                options: toArray<Branch>(branchesQuery.data).map((branch) => ({
                    value: String(branch.id),
                    label: branch.name,
                })),
                hint: 'One at a time — the server matches a single branch.',
            },
        ];
    }, [users, canSeeOthers, branchesQuery.data]);

    const filterCount = selectionCount(selection);

    const openFilters = (param?: string) => {
        setActiveParam(param ?? groups[0]?.param ?? 'priority');
        setIsFilterOpen(true);
    };

    const chips = useMemo(
        () =>
            groups
                .filter((group) => (selection[group.param] ?? []).length > 0)
                .map((group) => {
                    const value = (selection[group.param] ?? [])[0];
                    return {
                        param: group.param,
                        label: group.label,
                        detail: group.options.find((option) => option.value === value)?.label ?? value,
                    };
                }),
        [groups, selection],
    );

    const removeChip = (param: string) => {
        const next = { ...selection };
        delete next[param];
        setSelectionState(next);
    };

    const invalidateBoard = () => {
        void queryClient.invalidateQueries({ queryKey: ['tasks'] });
        void queryClient.invalidateQueries({ queryKey: ['dashboard-tasks'] });
    };

    const createTask = useMutation({
        mutationFn: async (input: TaskInput) => {
            const res = await api.post<TaskRow>('tasks/', input);
            return res.data;
        },
        onSuccess: () => {
            invalidateBoard();
            setIsCreateOpen(false);
            // The draft is deliberately not cleared here. The panel is still
            // sliding out, and blanking its fields mid-exit is visible now the
            // close is animated; `openCreateFor` reseeds it on every open.
            toast.success('Task created');
        },
        onError: () => toast.error('Could not create task', 'Check the assignee and due date, then try again.'),
    });

    const updateTask = useMutation({
        mutationFn: async ({ id, data }: { id: number; data: Partial<TaskInput> }) => {
            const res = await api.patch<TaskRow>(`tasks/${id}/`, data);
            return res.data;
        },
        onSuccess: invalidateBoard,
        onError: () => toast.error('Could not save task'),
    });

    /**
     * Status moves are optimistic: the card lands in the new column instantly
     * and rolls back if the PATCH fails, which is the only way a drag feels
     * right over a network round trip.
     */
    const moveTask = useMutation({
        mutationFn: async ({ id, status }: { id: number; status: ColumnType }) => {
            const res = await api.patch<TaskRow>(`tasks/${id}/`, { status });
            return res.data;
        },
        onMutate: async ({ id, status }) => {
            const key = boardKey;
            await queryClient.cancelQueries({ queryKey: key });
            const previous = queryClient.getQueryData<Paginated<TaskRow>>(key);

            queryClient.setQueryData<Paginated<TaskRow>>(key, (old) =>
                old
                    ? { ...old, results: old.results.map((task) => (task.id === id ? { ...task, status } : task)) }
                    : old,
            );

            return { previous, key };
        },
        onError: (_error, _variables, context) => {
            if (context?.previous) queryClient.setQueryData(context.key, context.previous);
            toast.error('Could not move task', 'The board has been put back the way it was.');
        },
        onSettled: invalidateBoard,
    });

    const deleteTask = useMutation({
        mutationFn: (id: number) => api.delete(`tasks/${id}/`),
        onSuccess: () => {
            invalidateBoard();
            setDeleteTarget(null);
            toast.success('Task deleted');
        },
        onError: () => toast.error('Could not delete task'),
    });

    const handleMove = (task: TaskRow, status: ColumnType) => {
        if (task.status === status) return;
        if (isEmployee) { openApproval(task, status); return; }
        moveTask.mutate({ id: task.id, status });
    };

    const handleDrop = (column: ColumnType) => {
        const task = draggedTask;
        setDraggedTask(null);
        if (task) handleMove(task, column);
    };

    const handleCreate = (event: React.FormEvent) => {
        event.preventDefault();
        if (!draft.assigned_to) {
            toast.error('Pick an assignee', 'Tasks must belong to someone.');
            return;
        }
        createTask.mutate({
            title: draft.title,
            description: draft.description,
            assigned_to: Number(draft.assigned_to),
            due_date: draft.due_date,
            priority: draft.priority,
            status: isEmployee ? 'Todo' : draft.status,
        });
    };

    const handleUpdate = (event: React.FormEvent) => {
        event.preventDefault();
        if (!editingTask || editingTask.assigned_to === null) return;

        updateTask.mutate(
            {
                id: editingTask.id,
                data: {
                    title: editingTask.title,
                    description: editingTask.description,
                    assigned_to: editingTask.assigned_to,
                    due_date: editingTask.due_date,
                    priority: editingTask.priority,
                    status: editingTask.status,
                },
            },
            {
                onSuccess: () => {
                    setIsEditOpen(false);
                    // `editingTask` is left in place for the same reason the
                    // create draft is: clearing it would empty the panel while
                    // it is still animating out. Every open replaces it.
                    toast.success('Task updated');
                },
            },
        );
    };

    const openCreateFor = (column: ColumnType) => {
        const seeded = { ...EMPTY_DRAFT, status: isEmployee ? 'Todo' as ColumnType : column, assigned_to: user ? String(user.id) : '' };
        setDraft(seeded);
        setDraftBaseline(seeded);
        setConfirmDiscardCreate(false);
        setIsCreateOpen(true);
    };

    const openEditFor = (task: TaskRow) => {
        setEditingTask(task);
        setOriginalTask(task);
        setEditTab('details');
        setConfirmDiscardEdit(false);
        setIsEditOpen(true);
    };

    /**
     * Vetoes scrim clicks, Escape and the close button while either form holds
     * unsaved input, and asks instead. A typed-out task disappearing on a
     * misplaced click is the failure these exist to prevent.
     */
    const requestCloseCreate = (): boolean => {
        // Mid-submit the task may already be on its way to the server.
        if (createTask.isPending) return false;
        if (isSameDraft(draft, draftBaseline) || confirmDiscardCreate) return true;
        setConfirmDiscardCreate(true);
        return false;
    };

    const isEditDirty =
        editingTask !== null &&
        originalTask !== null &&
        (editingTask.title !== originalTask.title ||
            editingTask.description !== originalTask.description ||
            editingTask.assigned_to !== originalTask.assigned_to ||
            // The date input writes a bare YYYY-MM-DD over what arrived as an
            // ISO timestamp, so both sides are normalised before comparison.
            toDateInput(editingTask.due_date) !== toDateInput(originalTask.due_date) ||
            editingTask.priority !== originalTask.priority ||
            editingTask.status !== originalTask.status);

    const requestCloseEdit = (): boolean => {
        if (updateTask.isPending) return false;
        if (!isEditDirty || confirmDiscardEdit) return true;
        setConfirmDiscardEdit(true);
        return false;
    };

    const hasFilters = searchInput !== '' || filterCount > 0;

    const createFooter = confirmDiscardCreate ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm font-medium text-slate-700">
                Discard this task? What you have entered will be lost.
            </p>
            <div className="flex shrink-0 gap-2">
                <Button type="button" variant="outline" onClick={() => setConfirmDiscardCreate(false)} className="flex-1 sm:flex-none">
                    Keep editing
                </Button>
                <Button type="button" onClick={() => setIsCreateOpen(false)} className="flex-1 bg-rose-600 hover:bg-rose-700 sm:flex-none">
                    Discard
                </Button>
            </div>
        </div>
    ) : (
        <div className="mx-auto flex w-full max-w-2xl flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
                type="button"
                variant="outline"
                onClick={() => { if (requestCloseCreate()) setIsCreateOpen(false); }}
                disabled={createTask.isPending}
                className="w-full sm:w-auto"
            >
                Cancel
            </Button>
            <Button type="submit" form="task-create-form" className="w-full bg-teal-600 hover:bg-teal-700 sm:w-auto" disabled={createTask.isPending}>
                {createTask.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                Create
            </Button>
        </div>
    );

    const editFooter = confirmDiscardEdit ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm font-medium text-slate-700">
                Discard your changes to this task?
            </p>
            <div className="flex shrink-0 gap-2">
                <Button type="button" variant="outline" onClick={() => setConfirmDiscardEdit(false)} className="flex-1 sm:flex-none">
                    Keep editing
                </Button>
                <Button type="button" onClick={() => setIsEditOpen(false)} className="flex-1 bg-rose-600 hover:bg-rose-700 sm:flex-none">
                    Discard
                </Button>
            </div>
        </div>
    ) : editTab === 'details' ? (
        <div className="mx-auto flex w-full max-w-2xl flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
                type="button"
                variant="outline"
                onClick={() => { if (requestCloseEdit()) setIsEditOpen(false); }}
                disabled={updateTask.isPending}
                className="w-full sm:w-auto"
            >
                Cancel
            </Button>
            <Button type="submit" form="task-edit-form" className="w-full bg-teal-600 hover:bg-teal-700 sm:w-auto" disabled={updateTask.isPending}>
                {updateTask.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
        </div>
    ) : (
        /* The Activity tab unmounts the form, so a `form="task-edit-form"`
           submit button would point at nothing and silently do nothing. Only a
           way out is offered here. */
        <div className="mx-auto flex w-full max-w-2xl justify-end">
            <Button
                type="button"
                variant="outline"
                onClick={() => { if (requestCloseEdit()) setIsEditOpen(false); }}
                className="w-full sm:w-auto"
            >
                Close
            </Button>
        </div>
    );

    if (tasksQuery.isLoading) {
        return (
            <div className="space-y-3">
                <LoadingState rows={3} label="Loading tasks" />
            </div>
        );
    }

    if (tasksQuery.isError) {
        return <ErrorState error={tasksQuery.error} onRetry={() => void tasksQuery.refetch()} title="Could not load the task board" />;
    }

    return (
        <div className="space-y-3">
            {/*
              One panel: toolbar, the summary line, the applied-filter chips and
              the board itself. The same object the admissions and engagements
              directories are.
            */}
            <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
                    <div className="relative min-w-0 flex-1">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                        <Input
                            value={searchInput}
                            onChange={(event) => setSearchInput(event.target.value)}
                            placeholder="Search tasks by title or description…"
                            aria-label="Search tasks"
                            className="h-9 border-slate-200 bg-white pl-9 text-sm focus:border-teal-500 focus:ring-teal-500"
                        />
                    </div>

                    <div className="flex items-center gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => openFilters()}
                            aria-haspopup="dialog"
                            aria-expanded={isFilterOpen}
                            className={
                                filterCount > 0
                                    ? 'h-9 shrink-0 border-teal-200 bg-teal-50 text-xs text-teal-700 hover:bg-teal-100'
                                    : 'h-9 shrink-0 border-slate-200 text-xs'
                            }
                        >
                            <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" />
                            Filter
                            {filterCount > 0 && (
                                <span className="ml-1.5 rounded-full bg-teal-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                                    {filterCount}
                                </span>
                            )}
                        </Button>

                        <Button
                            onClick={() => openCreateFor('Todo')}
                            size="sm"
                            className="h-9 shrink-0 bg-teal-600 text-xs hover:bg-teal-700"
                        >
                            <Plus className="mr-1 h-3.5 w-3.5" />
                            <span className="hidden sm:inline">New Task</span>
                            <span className="sm:hidden">New</span>
                        </Button>
                    </div>
                </div>

                {/*
                  The summary line, and only what the three columns cannot say
                  themselves. A Todo/In Progress/Done strip here would be the
                  same three numbers twice on one screen, free to disagree.

                  Read-outs, not controls: `due_date` has no server filter, so a
                  clickable "Overdue" could only ever filter the rows already
                  fetched. Nothing here is styled as a button.
                */}
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 pb-3 text-xs text-slate-500">
                    <span>
                        <span className="font-semibold text-slate-900">{totalCount}</span>{' '}
                        {totalCount === 1 ? 'task' : 'tasks'}
                        {hasFilters && ' matching'}
                    </span>

                    {boardComplete && (
                        <>
                            <span aria-hidden className="text-slate-300">·</span>
                            <span className={dateCounts.overdue > 0 ? 'text-red-600' : undefined}>
                                <span className="font-semibold">{dateCounts.overdue}</span> overdue
                            </span>
                            <span aria-hidden className="text-slate-300">·</span>
                            <span>
                                <span className="font-semibold text-slate-700">{dateCounts.dueToday}</span> due today
                            </span>
                        </>
                    )}

                    {!assigneeFilter && myTaskCountQuery.data !== undefined && (
                        <>
                            <span aria-hidden className="text-slate-300">·</span>
                            <span>
                                <span className="font-semibold text-slate-700">{myTaskCountQuery.data}</span> assigned to me
                            </span>
                        </>
                    )}
                </div>

                {/* Applied filters. Clicking a chip reopens the drawer at that group. */}
                {chips.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 bg-slate-50/70 px-3 py-2">
                        {chips.map((chip) => (
                            <span
                                key={chip.param}
                                className="inline-flex items-center overflow-hidden rounded-full border border-teal-200 bg-white text-xs text-teal-800"
                            >
                                <button
                                    type="button"
                                    onClick={() => openFilters(chip.param)}
                                    className="py-1 pl-2.5 pr-1.5 transition-colors hover:bg-teal-50"
                                >
                                    <span className="text-slate-500">{chip.label}:</span>{' '}
                                    <span className="font-medium">{chip.detail}</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => removeChip(chip.param)}
                                    aria-label={`Remove ${chip.label} filter`}
                                    className="py-1 pl-0.5 pr-2 text-teal-500 transition-colors hover:text-teal-800"
                                >
                                    <X size={12} />
                                </button>
                            </span>
                        ))}
                        <button
                            type="button"
                            onClick={() => setSelectionState({})}
                            className="ml-1 text-xs text-slate-500 underline-offset-2 hover:text-slate-900 hover:underline"
                        >
                            Clear filters
                        </button>
                    </div>
                )}

                {truncated && (
                    <p className="border-t border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                        Showing the {tasks.length} soonest-due tasks of {totalCount} — the server caps a page at{' '}
                        {BOARD_PAGE_SIZE}. Column totals and the overdue figures are hidden rather than counted over a
                        part of the board; narrow the search or filters to bring them back.
                    </p>
                )}

                {/* Board */}
                <div className="grid grid-cols-1 gap-3 border-t border-slate-100 bg-slate-50/40 p-3 md:grid-cols-3">
                    {COLUMNS.map((column) => {
                        const columnTasks = tasksByColumn[column];
                        return (
                            <BoardColumn
                                key={column}
                                column={column}
                                tasks={columnTasks}
                                showCount={boardComplete}
                                onAddTask={() => openCreateFor(column)}
                                onDropTask={handleDrop}
                            >
                                {columnTasks.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center h-24 text-slate-400">
                                        <Layout size={20} className="mb-1 opacity-50" />
                                        <span className="text-xs">{hasFilters ? 'No matching tasks' : 'No tasks'}</span>
                                    </div>
                                ) : (
                                    columnTasks.map((task) => (
                                        <div key={task.id}>
                                        {task.pending_approval && <button className="mb-1 text-xs font-medium text-amber-700" onClick={() => openApproval(task, task.pending_approval!.pending_changes.status)}>Awaiting approval · {task.pending_approval.pending_changes.status}{task.pending_approval.requested_by === user?.id ? ' · Edit request' : ''}</button>}
                                        <TaskCard
                                            task={task}
                                            isDragging={draggedTask?.id === task.id}
                                            canDelete={can('deleteRecords')}
                                            onDragStart={setDraggedTask}
                                            onDragEnd={() => setDraggedTask(null)}
                                            onMove={handleMove}
                                            onDelete={setDeleteTarget}
                                            onEdit={openEditFor}
                                        />
                                        </div>
                                    ))
                                )}
                            </BoardColumn>
                        );
                    })}
                </div>
            </section>

            {/* My pending follow-ups — a separate concern from the board, so it
                sits outside the panel rather than competing inside it. */}
            {myFollowUps.length > 0 && (
                <div className="bg-gradient-to-r from-teal-50 to-emerald-50 border border-teal-200 rounded-lg overflow-hidden">
                    <button
                        onClick={() => setFollowUpsExpanded((open) => !open)}
                        className="w-full flex items-center justify-between px-3 py-2 hover:bg-teal-100/50 transition-colors"
                        aria-expanded={followUpsExpanded}
                    >
                        <div className="flex items-center gap-2">
                            <Bell className="h-3.5 w-3.5 text-teal-600" />
                            <span className="text-xs font-semibold text-slate-700">My Pending Follow-ups</span>
                            <span className="bg-teal-600 text-white text-[10px] px-1.5 py-0.5 rounded-full font-bold">
                                {followUpsQuery.data?.count ?? myFollowUps.length}
                            </span>
                        </div>
                        {followUpsExpanded ? <ChevronUp size={14} className="text-slate-500" /> : <ChevronDown size={14} className="text-slate-500" />}
                    </button>

                    {followUpsExpanded && (
                        <div className="px-3 pb-2.5 flex flex-wrap gap-2">
                            {myFollowUps.slice(0, 6).map((followUp) => (
                                <button
                                    key={followUp.id}
                                    onClick={() => router.push(`/app/follow-ups/${followUp.id}`)}
                                    className="flex items-center gap-2 bg-white border border-slate-200 rounded-md px-2.5 py-1.5 hover:shadow-sm hover:border-teal-300 transition-all text-left"
                                >
                                    <div className={`w-5 h-5 rounded flex items-center justify-center shrink-0 ${followUp.type === 'Call' ? 'bg-blue-100 text-blue-600' :
                                        followUp.type === 'Email' ? 'bg-purple-100 text-purple-600' :
                                            'bg-green-100 text-green-600'
                                        }`}>
                                        {followUp.type === 'Call' && <Phone size={10} />}
                                        {followUp.type === 'Email' && <Mail size={10} />}
                                        {(followUp.type === 'WhatsApp' || followUp.type === 'SMS') && <MessageSquare size={10} />}
                                    </div>
                                    <div>
                                        {/* Read-only label from the linked enquiry — there is no student_name on a follow-up. */}
                                        <p className="text-[11px] font-medium text-slate-800 leading-tight">{followUp.enquiry_candidate}</p>
                                        <p className="text-[10px] text-slate-500">{formatTimestamp(followUp.scheduled_for)}</p>
                                    </div>
                                </button>
                            ))}
                            {(followUpsQuery.data?.count ?? 0) > 6 && (
                                <button
                                    onClick={() => router.push('/app/follow-ups')}
                                    className="flex items-center px-2.5 py-1.5 text-[11px] text-teal-600 bg-teal-50 border border-teal-200 rounded-md hover:bg-teal-100 font-medium"
                                >
                                    +{(followUpsQuery.data?.count ?? 0) - 6} more
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}

            <FilterDrawer
                open={isFilterOpen}
                onOpenChange={setIsFilterOpen}
                groups={groups}
                selection={selection}
                onChange={setSelection}
                activeParam={activeParam}
                onActiveParamChange={setActiveParam}
                noun="task"
            />

            <Drawer open={!!approvalTask} onOpenChange={(open) => { if (!open) setApprovalTask(null); }}
                panelClassName="md:w-[50vw]"
                title={approvalTask?.pending_approval ? 'Update approval request' : 'Request status change'}
                description={approvalTask?.title} bodyClassName="p-5"
                footer={<Button disabled={requestApproval.isPending || !reviewerId || !approvalMessage.trim()} onClick={() => requestApproval.mutate()}>{requestApproval.isPending ? 'Sending…' : 'Send for approval'}</Button>}>
                <div className="space-y-4">
                    <p className="text-sm text-slate-500">The task moves after approval.</p>
                    <Label>Status</Label>
                    <Select value={approvalStatus} onValueChange={(value) => setApprovalStatus(value as ColumnType)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{COLUMNS.filter(c=>c!==approvalTask?.status).map(c=><SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent></Select>
                    <Label htmlFor="task-progress">Progress update *</Label>
                    <Textarea id="task-progress" value={approvalMessage} onChange={e=>setApprovalMessage(e.target.value)} placeholder="What have you worked on or completed?" />
                    <Label>Send to *</Label>
                    <Select value={reviewerId} onValueChange={setReviewerId}><SelectTrigger><SelectValue placeholder="Choose a reviewer" /></SelectTrigger><SelectContent>{reviewers.data?.map(r=><SelectItem key={r.id} value={String(r.id)}>{r.name} · {r.role.replaceAll('_',' ').toLowerCase()}</SelectItem>)}</SelectContent></Select>
                    {reviewers.isError && <p className="text-sm text-red-600">Could not load reviewers. Close and try again.</p>}
                    {reviewers.isSuccess && !reviewers.data.length && <p className="text-sm text-amber-700">No active reviewer available. Contact your company admin.</p>}
                </div>
            </Drawer>

            {/* Create task */}
            <Drawer
                open={isCreateOpen}
                onOpenChange={(next) => { if (!next) setIsCreateOpen(false); }}
                onRequestClose={requestCloseCreate}
                title="New task"
                description="Add to your board"
                /* Matches the refund and payment panels: 60% of the viewport
                   from `md` up, full width on a phone. */
                panelClassName="md:w-[60vw]"
                bodyClassName="px-4 py-5 sm:px-6"
                footer={createFooter}
            >
                <form id="task-create-form" onSubmit={handleCreate} className="mx-auto w-full max-w-2xl space-y-4">
                    <div className="space-y-1">
                        <Label className="text-xs font-medium text-slate-600">Title</Label>
                        <Input
                            placeholder="What needs to be done?"
                            value={draft.title}
                            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                            className="h-9 text-sm"
                            required
                            autoFocus
                        />
                    </div>

                    <div className="space-y-1">
                        <Label className="text-xs font-medium text-slate-600">Description</Label>
                        <Textarea
                            value={draft.description}
                            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                            placeholder="Add details..."
                            className="min-h-[70px] text-sm resize-none"
                        />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="space-y-1">
                            <Label className="text-xs font-medium text-slate-600">Assign to</Label>
                            <Select value={draft.assigned_to} onValueChange={(value) => setDraft({ ...draft, assigned_to: value })}>
                                <SelectTrigger className="h-9 text-sm">
                                    <SelectValue placeholder="Select..." />
                                </SelectTrigger>
                                <SelectContent>
                                    {user && <SelectItem value={String(user.id)}>Myself</SelectItem>}
                                    {users.filter((candidate) => candidate.id !== user?.id).map((candidate) => (
                                        <SelectItem key={candidate.id} value={String(candidate.id)}>
                                            {candidate.full_name || candidate.username}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="space-y-1">
                            <Label className="text-xs font-medium text-slate-600">Priority</Label>
                            <Select value={draft.priority} onValueChange={(value) => setDraft({ ...draft, priority: value as Priority })}>
                                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {PRIORITIES.map((priority) => (
                                        <SelectItem key={priority} value={priority}>{priority}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="space-y-1">
                            <Label className="text-xs font-medium text-slate-600">Due date</Label>
                            <Input
                                type="date"
                                value={draft.due_date}
                                onChange={(e) => setDraft({ ...draft, due_date: e.target.value })}
                                className="h-9 text-sm"
                                required
                            />
                        </div>

                        <div className="space-y-1">
                            <Label className="text-xs font-medium text-slate-600">Status</Label>
                            <Select disabled={isEmployee} value={draft.status} onValueChange={(value) => setDraft({ ...draft, status: value as ColumnType })}>
                                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {COLUMNS.map((column) => (
                                        <SelectItem key={column} value={column}>{column}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                </form>
            </Drawer>

            {/* Edit task */}
            <Drawer
                open={isEditOpen}
                onOpenChange={(next) => { if (!next) setIsEditOpen(false); }}
                onRequestClose={requestCloseEdit}
                title="Edit task"
                /* The unedited title, so the sub-line does not rewrite itself
                   as the user types in the Title field. */
                description={originalTask?.title}
                panelClassName="md:w-[60vw]"
                bodyClassName="px-4 py-5 sm:px-6"
                footer={editFooter}
            >
                {editingTask && (
                    <Tabs
                        value={editTab}
                        onValueChange={(value) => setEditTab(value as 'details' | 'history')}
                        className="mx-auto w-full max-w-2xl"
                    >
                        <TabsList className="grid w-full grid-cols-2 h-8">
                            <TabsTrigger value="details" className="text-xs">Details</TabsTrigger>
                            <TabsTrigger value="history" className="text-xs">Activity</TabsTrigger>
                        </TabsList>

                        <TabsContent value="details" className="mt-4">
                            <form id="task-edit-form" onSubmit={handleUpdate} className="space-y-4">
                                <div className="space-y-1">
                                    <Label className="text-xs font-medium text-slate-600">Title</Label>
                                    <Input
                                        value={editingTask.title}
                                        onChange={(e) => setEditingTask({ ...editingTask, title: e.target.value })}
                                        className="h-9 text-sm"
                                        required
                                    />
                                </div>

                                <div className="space-y-1">
                                    <Label className="text-xs font-medium text-slate-600">Description</Label>
                                    <Textarea
                                        value={editingTask.description}
                                        onChange={(e) => setEditingTask({ ...editingTask, description: e.target.value })}
                                        placeholder="Add details..."
                                        className="min-h-[70px] text-sm resize-none"
                                    />
                                </div>

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div className="space-y-1">
                                        <Label className="text-xs font-medium text-slate-600">Assign to</Label>
                                        <Select
                                            value={editingTask.assigned_to === null ? '' : String(editingTask.assigned_to)}
                                            onValueChange={(value) => setEditingTask({ ...editingTask, assigned_to: Number(value) })}
                                        >
                                            <SelectTrigger className="h-9 text-sm">
                                                <SelectValue placeholder="Select..." />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {users.map((candidate) => (
                                                    <SelectItem key={candidate.id} value={String(candidate.id)}>
                                                        {candidate.full_name || candidate.username}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    <div className="space-y-1">
                                        <Label className="text-xs font-medium text-slate-600">Priority</Label>
                                        <Select
                                            value={editingTask.priority}
                                            onValueChange={(value) => setEditingTask({ ...editingTask, priority: value })}
                                        >
                                            <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                                            <SelectContent>
                                                {PRIORITIES.map((priority) => (
                                                    <SelectItem key={priority} value={priority}>{priority}</SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    <div className="space-y-1">
                                        <Label className="text-xs font-medium text-slate-600">Due date</Label>
                                        <Input
                                            type="date"
                                            value={toDateInput(editingTask.due_date)}
                                            onChange={(e) => setEditingTask({ ...editingTask, due_date: e.target.value })}
                                            className="h-9 text-sm"
                                            required
                                        />
                                    </div>

                                    <div className="space-y-1">
                                        <Label className="text-xs font-medium text-slate-600">Status</Label>
                                        <Select
                                            disabled={isEmployee}
                                            value={editingTask.status}
                                            onValueChange={(value) => setEditingTask({ ...editingTask, status: value })}
                                        >
                                            <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                                            <SelectContent>
                                                {COLUMNS.map((column) => (
                                                    <SelectItem key={column} value={column}>{column}</SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </div>
                            </form>
                        </TabsContent>

                        <TabsContent value="history" className="mt-4">
                            <TaskActivity task={editingTask} />
                        </TabsContent>
                    </Tabs>
                )}
            </Drawer>

            <ConfirmDialog
                open={deleteTarget !== null}
                onClose={() => setDeleteTarget(null)}
                onConfirm={() => deleteTarget && deleteTask.mutate(deleteTarget.id)}
                title="Delete task"
                description={
                    deleteTarget
                        ? `Delete “${deleteTarget.title}”? This cannot be undone.`
                        : 'Delete this task?'
                }
                confirmText="Delete"
                confirmVariant="destructive"
                isLoading={deleteTask.isPending}
            />
        </div>
    );
}

/**
 * Provenance for one task, built from the audit columns the serializer already
 * returns (created_by/created_at, owner, updated_at, completed_at).
 *
 * GAP: this is NOT a per-change log. `TaskViewSet` is a plain
 * `ScopedModelViewSet` with no `history` action and there is no activity model
 * behind tasks, so "who moved this from Todo to Done, when, and why" cannot be
 * answered today. The old build called `tasks/{id}/history/`, which has never
 * existed on this backend. Restoring it needs a backend TaskActivity model.
 */
function TaskActivity({ task }: { task: TaskRow }) {
    const entries: Array<{ label: string; who?: string; when: string | null }> = [
        // `created_at`/`updated_at` come from ScopedFields and are optional on
        // the type, so coerce absent to null rather than leaving `undefined`
        // to render as an empty row.
        { label: 'Created', who: task.created_by_name, when: task.created_at ?? null },
        { label: 'Last updated', when: task.updated_at ?? null },
        { label: 'Completed', when: task.completed_at },
    ];

    return (
        <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-700">Record activity</h3>

            <div className="space-y-2">
                {entries.map((entry) => (
                    <div key={entry.label} className="flex gap-2 items-start text-xs border-b border-slate-100 pb-2 last:border-0 last:pb-0">
                        <div className="mt-1.5 w-1.5 h-1.5 rounded-full bg-teal-500 shrink-0" />
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                                <span className="font-medium text-slate-800">{entry.label}</span>
                                <span className="text-[10px] text-slate-400">{formatTimestamp(entry.when)}</span>
                            </div>
                            {entry.who && <p className="text-slate-500">by {entry.who}</p>}
                        </div>
                    </div>
                ))}
            </div>

            <div className="rounded-md bg-slate-50 border border-slate-200 p-3 space-y-1.5">
                <p className="flex items-center gap-1.5 text-[11px] text-slate-600">
                    <UserIcon size={11} className="text-slate-400" /> Assigned to {task.assigned_to_name}
                </p>
                <p className="flex items-center gap-1.5 text-[11px] text-slate-600">
                    <Flag size={11} className="text-slate-400" /> {task.priority} priority
                </p>
                <p className="flex items-center gap-1.5 text-[11px] text-slate-600">
                    <Clock size={11} className="text-slate-400" /> Due {formatTimestamp(task.due_date)}
                </p>
                {task.branch_name && (
                    <p className="text-[11px] text-slate-600">Branch: {task.branch_name}</p>
                )}
            </div>

            <p className="text-[10px] leading-relaxed text-slate-400">
                A step-by-step change log is not available — the API records who created a task and when it last
                changed, but not each individual edit.
            </p>
        </div>
    );
}
