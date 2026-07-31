'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import {
    Plus, Clock, Bell, Phone, Mail, MessageSquare,
    Flag, Layout, FileText, Circle, Loader2, Check,
    ChevronDown, ChevronUp, Search, MoreHorizontal, Trash2, User as UserIcon,
} from 'lucide-react';

import { api } from '@/lib/api';
import { apiClient, fetchPage } from '@/lib/apiClient';
import type { FollowUp, Paginated, ScopedFields } from '@/lib/types';
import { toArray } from '@/components/common/pagination';
import { Drawer } from '@/components/common/Drawer';
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
 * server's maximum page. Past that the board reports the shortfall instead of
 * pretending the tail does not exist.
 */
const BOARD_PAGE_SIZE = 200;

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
    onAddTask,
    onDropTask,
    children,
}: {
    column: ColumnType;
    tasks: TaskRow[];
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
                flex flex-col rounded-xl border transition-all duration-200 min-h-[220px] md:min-h-[400px]
                ${isOver ? 'border-teal-400 bg-teal-50/50 ring-2 ring-teal-200' : `${colors.border} ${colors.bg}`}
            `}
        >
            <div className={`flex items-center justify-between px-3 py-2.5 border-b ${colors.border}`}>
                <div className="flex items-center gap-2">
                    <Icon size={14} className={`${colors.text} ${column === 'In Progress' ? 'animate-spin' : ''}`} />
                    <h3 className={`font-semibold text-sm ${colors.text}`}>{column}</h3>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${colors.badge}`}>{tasks.length}</span>
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

            <div className="flex-1 space-y-2 p-2 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 280px)' }}>
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
    const { can } = useCurrentRole();
    const router = useRouter();
    const queryClient = useQueryClient();

    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [searchInput, setSearchInput] = useState('');
    const search = useDebounce(searchInput, 300);
    const [priorityFilter, setPriorityFilter] = useState<string>('all');
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

    const taskFilters = useMemo(() => {
        const filters: Record<string, string> = {};
        if (priorityFilter !== 'all') filters.priority = priorityFilter;
        return filters;
    }, [priorityFilter]);

    /**
     * `TaskViewSet` declares `search_fields = (title, description)` and
     * `filterset_fields = (status, assigned_to, priority, branch)`, so both the
     * search box and the priority filter run in SQL rather than over one page.
     */
    const tasksQuery = useQuery({
        queryKey: ['tasks', { search, priority: priorityFilter }],
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

    const usersQuery = useQuery({
        queryKey: ['users', 'assignable'],
        queryFn: () => apiClient.users.list({ page_size: 200, ordering: 'username' }),
    });
    const users = toArray(usersQuery.data);

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
            const key = ['tasks', { search, priority: priorityFilter }];
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
            status: draft.status,
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
        const seeded = { ...EMPTY_DRAFT, status: column, assigned_to: user ? String(user.id) : '' };
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

    const hasFilters = searchInput !== '' || priorityFilter !== 'all';

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
            {/* Toolbar */}
            <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[180px]">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <Input
                        placeholder="Search tasks by title or description..."
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                        className="pl-9 h-9 w-full text-sm bg-white border-slate-200 focus:border-teal-500 focus:ring-teal-500/20"
                    />
                </div>

                <Select value={priorityFilter} onValueChange={setPriorityFilter}>
                    <SelectTrigger className="h-9 w-32 text-xs border-slate-200 bg-white shrink-0">
                        <SelectValue placeholder="All Priority" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All Priority</SelectItem>
                        {PRIORITIES.map((priority) => (
                            <SelectItem key={priority} value={priority}>
                                <span className="flex items-center gap-1.5">
                                    <span className={`w-2 h-2 rounded-full ${priorityDot(priority)}`} /> {priority}
                                </span>
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>

                {hasFilters && (
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-9 text-xs border-slate-200 text-slate-600 hover:bg-slate-100 shrink-0"
                        onClick={() => { setSearchInput(''); setPriorityFilter('all'); }}
                    >
                        Clear
                    </Button>
                )}

                <Button
                    className="h-9 text-xs bg-teal-600 hover:bg-teal-700 shadow-sm shrink-0"
                    onClick={() => openCreateFor('Todo')}
                >
                    <Plus className="mr-1.5 h-3.5 w-3.5" /> New Task
                </Button>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <div className="bg-white border border-slate-200 rounded p-2 flex items-center justify-between shadow-sm">
                    <span className="text-xs font-medium text-slate-500 uppercase">Total</span>
                    <span className="text-lg font-bold text-slate-900">{totalCount}</span>
                </div>
                <div className="bg-emerald-50 border border-emerald-100 rounded p-2 flex items-center justify-between shadow-sm">
                    <span className="text-xs font-medium text-emerald-600 uppercase">Done</span>
                    <span className="text-lg font-bold text-emerald-700">{tasksByColumn['Done'].length}</span>
                </div>
                <div className="bg-blue-50 border border-blue-100 rounded p-2 flex items-center justify-between shadow-sm">
                    <span className="text-xs font-medium text-blue-600 uppercase">In Progress</span>
                    <span className="text-lg font-bold text-blue-700">{tasksByColumn['In Progress'].length}</span>
                </div>
                <div className="bg-slate-50 border border-slate-200 rounded p-2 flex items-center justify-between shadow-sm">
                    <span className="text-xs font-medium text-slate-600 uppercase">Todo</span>
                    <span className="text-lg font-bold text-slate-700">{tasksByColumn['Todo'].length}</span>
                </div>
            </div>

            {truncated && (
                <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                    Showing the {tasks.length} soonest-due tasks of {totalCount}. Narrow the search or priority filter to see the rest.
                </p>
            )}

            {/* My pending follow-ups */}
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

            {/* Board */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {COLUMNS.map((column) => {
                    const columnTasks = tasksByColumn[column];
                    return (
                        <BoardColumn
                            key={column}
                            column={column}
                            tasks={columnTasks}
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
                                    <TaskCard
                                        key={task.id}
                                        task={task}
                                        isDragging={draggedTask?.id === task.id}
                                        canDelete={can('deleteRecords')}
                                        onDragStart={setDraggedTask}
                                        onDragEnd={() => setDraggedTask(null)}
                                        onMove={handleMove}
                                        onDelete={setDeleteTarget}
                                        onEdit={openEditFor}
                                    />
                                ))
                            )}
                        </BoardColumn>
                    );
                })}
            </div>

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
                            <Select value={draft.status} onValueChange={(value) => setDraft({ ...draft, status: value as ColumnType })}>
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
