'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Lock, RotateCcw, Search, X } from 'lucide-react';

import { apiClient } from '@/lib/apiClient';
import { getApiErrorMessage, getApiFieldErrors } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ErrorState, InlineSpinner, LoadingState } from '@/components/common/states';
import { toArray } from '@/components/common/pagination';
import { RoleRoute } from '@/components/rbac/RoleGate';
import { ROLE_SHORT_LABELS } from '@/components/rbac/roles';
import { useAuth } from '@/hooks/useAuth';
import { toast } from '@/store/toastStore';
import type {
  CapabilityKey,
  Company,
  PermissionCell,
  PermissionChange,
  PermissionMatrix,
  Role,
} from '@/lib/types';

/**
 * Roles x capabilities: who can do what, decided per ROLE rather than per
 * person.
 *
 * WHY /app/permissions AND NOT /app/settings/permissions
 * ------------------------------------------------------
 * The sidebar's active-state rule (`isActiveHref` in layout/Sidebar.tsx) treats
 * a path as owning everything nested under it, which the Documents group and
 * the transfer detail routes both depend on. A nav entry at
 * /app/settings/permissions would therefore light Settings and Permissions at
 * the same time, and the only fix would be changing that shared rule for every
 * other entry. A flat route sits cleanly beside Users and Branches — which is
 * also where it belongs conceptually, since this is the screen that decides
 * what the accounts on those screens can do. One line in proxy.ts gates it,
 * exactly as /app/users and /app/branches are gated.
 *
 * WHY NO FilterDrawer
 * -------------------
 * The drawer exists so a multi-select maps onto a real server-side filter on a
 * PAGINATED list, where narrowing in the browser would hide matches on later
 * pages. This grid is twelve capabilities and five roles, delivered whole in
 * one response — there are no later pages to hide, so the search box below is
 * complete rather than misleading, and a drawer would be four taps to filter a
 * list that already fits on the screen.
 *
 * WHAT THE SERVER OWNS
 * --------------------
 * Everything. `editable`, `reason`, `source` and `allowed` all arrive from
 * `GET /api/role-permissions/`; nothing here decides what may be granted. A
 * disabled toggle is a rendering of the server's answer, and submitting one
 * anyway is refused with the same sentence the tooltip shows.
 */

const PENDING = 'pending';

/** A cell the admin has touched but not yet saved. `null` means "back to default". */
type Draft = Record<string, boolean | null>;

const draftKey = (role: Role, capability: CapabilityKey) => `${role}:${capability}`;

/**
 * The value a cell should render: the pending edit if there is one, otherwise
 * whatever the server last told us.
 */
function effectiveValue(
  cell: PermissionCell,
  defaultAllowed: boolean,
  pending: boolean | null | undefined
): boolean {
  if (pending === undefined) return cell.allowed;
  if (pending === null) return defaultAllowed;
  return pending;
}

function PermissionsScreen() {
  const queryClient = useQueryClient();
  const { role: myRole } = useAuth();
  const isPlatformAdmin = myRole === 'DEV_ADMIN';

  /** Platform operators have no company of their own and must name one. */
  const [companyId, setCompanyId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Draft>({});
  const [confirmReset, setConfirmReset] = useState(false);

  const companies = useQuery({
    queryKey: ['companies', 'permission-target'],
    queryFn: () => apiClient.companies.list({ page_size: 200, ordering: 'name' }),
    enabled: isPlatformAdmin,
    staleTime: 5 * 60 * 1000,
  });
  const companyOptions: Company[] = toArray(companies.data);

  const grid = useQuery({
    queryKey: ['role-permissions', companyId],
    queryFn: () => apiClient.rolePermissions.get(companyId),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['role-permissions'] });
  };

  const saveMutation = useMutation({
    mutationFn: (changes: PermissionChange[]) =>
      apiClient.rolePermissions.update(changes, companyId),
    onSuccess: (fresh, changes) => {
      // The server returns the re-rendered grid, so the cache is replaced with
      // what was actually persisted rather than with what we hoped for.
      queryClient.setQueryData(['role-permissions', companyId], fresh);
      invalidate();
      setDraft({});
      toast.success(
        changes.length === 1 ? 'Permission updated' : `${changes.length} permissions updated`,
        'Anyone signed in with an affected role gets the new access on their next request.'
      );
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => apiClient.rolePermissions.reset(companyId),
    onSuccess: (fresh) => {
      queryClient.setQueryData(['role-permissions', companyId], fresh);
      invalidate();
      setDraft({});
      setConfirmReset(false);
      toast.success('Back to the built-in defaults', 'Every override was removed.');
    },
  });

  const data: PermissionMatrix | undefined = grid.data;

  /** Default value per cell, so "revert" and the `changed` marker can be computed. */
  const defaults = useMemo(() => {
    const out: Record<string, boolean> = {};
    if (!data) return out;
    for (const capability of data.capabilities) {
      for (const role of data.roles) {
        out[draftKey(role.value, capability.value)] =
          capability.default_roles.includes(role.value);
      }
    }
    return out;
  }, [data]);

  const visibleCapabilities = useMemo(() => {
    if (!data) return [];
    const needle = search.trim().toLowerCase();
    if (!needle) return data.capabilities;
    return data.capabilities.filter(
      (capability) =>
        capability.label.toLowerCase().includes(needle) ||
        capability.value.toLowerCase().includes(needle)
    );
  }, [data, search]);

  const pendingChanges: PermissionChange[] = useMemo(
    () =>
      Object.entries(draft).map(([key, allowed]) => {
        const [role, capability] = key.split(':');
        return { role: role as Role, capability: capability as CapabilityKey, allowed };
      }),
    [draft]
  );

  const toggle = (role: Role, capability: CapabilityKey, cell: PermissionCell) => {
    const key = draftKey(role, capability);
    const current = effectiveValue(cell, defaults[key] ?? false, draft[key]);
    const next = !current;

    // Refuse locally in the direction the server has already said it refuses.
    // The check is repeated on save, so this only spares a round trip.
    if ((next && !cell.can_grant) || (!next && !cell.can_revoke)) return;

    setDraft((previous) => {
      const updated = { ...previous };
      // Returning a cell to the value the server already holds is not a change.
      if (next === cell.allowed) delete updated[key];
      else updated[key] = next;
      return updated;
    });
  };

  /** Queue "delete the override" for every touched cell in one capability row. */
  const revertRow = (capability: CapabilityKey) => {
    if (!data) return;
    setDraft((previous) => {
      const updated = { ...previous };
      for (const role of data.roles) {
        const key = draftKey(role.value, capability);
        const cell = data.matrix[role.value][capability];
        if (cell.source === 'override' && cell.editable) updated[key] = null;
        else delete updated[key];
      }
      return updated;
    });
  };

  const rowIsOverridden = (capability: CapabilityKey) =>
    Boolean(
      data &&
        data.roles.some((role) => data.matrix[role.value][capability].source === 'override')
    );

  const refusal = saveMutation.isError
    ? getApiFieldErrors(saveMutation.error)?.changes ??
      getApiErrorMessage(saveMutation.error)
    : null;

  const hasOverrides = Boolean(
    data &&
      data.capabilities.some((capability) =>
        data.roles.some((role) => data.matrix[role.value][capability.value].source === 'override')
      )
  );

  /* ------------------------------------------------------------------ cells */

  const Toggle = ({
    role,
    capability,
    cell,
  }: {
    role: Role;
    capability: CapabilityKey;
    cell: PermissionCell;
  }) => {
    const key = draftKey(role, capability);
    const pending = draft[key];
    const value = effectiveValue(cell, defaults[key] ?? false, pending);
    const isPending = pending !== undefined;
    const locked = !(value ? cell.can_revoke : cell.can_grant);
    const state = isPending ? PENDING : cell.source;

    return (
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={`${ROLE_SHORT_LABELS[role]}: ${capability}`}
        disabled={locked}
        // `title` is the hover explanation the brief asks for; the lock icon
        // below carries the same information for touch and for anyone who
        // never hovers, because a greyed control with no visible reason reads
        // as a bug rather than a rule.
        title={locked ? cell.reason : undefined}
        onClick={() => toggle(role, capability, cell)}
        className={[
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-1',
          locked
            ? 'cursor-not-allowed border-slate-200 bg-slate-100'
            : value
              ? 'border-teal-600 bg-teal-600 hover:bg-teal-700'
              : 'border-slate-300 bg-slate-200 hover:bg-slate-300',
          state === PENDING ? 'ring-2 ring-amber-400 ring-offset-1' : '',
        ].join(' ')}
      >
        <span
          className={[
            'flex h-5 w-5 items-center justify-center rounded-full bg-white shadow transition-transform',
            value ? 'translate-x-[22px]' : 'translate-x-0.5',
          ].join(' ')}
        >
          {locked ? (
            <Lock size={10} className="text-slate-400" aria-hidden />
          ) : value ? (
            <Check size={11} className="text-teal-600" aria-hidden />
          ) : (
            <X size={11} className="text-slate-400" aria-hidden />
          )}
        </span>
      </button>
    );
  };

  /** The dot under a toggle that says where its value came from. */
  const SourceNote = ({
    role,
    capability,
    cell,
  }: {
    role: Role;
    capability: CapabilityKey;
    cell: PermissionCell;
  }) => {
    const pending = draft[draftKey(role, capability)];
    if (pending !== undefined) {
      return <span className="text-[10px] font-semibold text-amber-700">unsaved</span>;
    }
    if (cell.source === 'override') {
      return <span className="text-[10px] font-semibold text-teal-700">changed</span>;
    }
    if (cell.source === 'platform') {
      return <span className="text-[10px] text-slate-400">always</span>;
    }
    return <span className="text-[10px] text-slate-400">default</span>;
  };

  /* ------------------------------------------------------------------ render */

  return (
    <div className="space-y-6">
      <div className="min-w-0">
        <h1 className="font-heading text-2xl font-bold text-slate-900">Roles &amp; Permissions</h1>
        <p className="mt-1 font-body text-sm text-slate-600">
          What each type of user can do. Granted to a role, never to one person — so a change
          here applies to everyone who holds that role.
        </p>
      </div>

      {/*
        One panel. Toolbar, legend, grid and footer all live inside it so the
        screen reads as a single object rather than a stack of cards.
      */}
      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-2 border-b border-slate-100 p-3 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search permissions…"
              aria-label="Search permissions"
              className="h-9 border-slate-200 bg-white pl-9 text-sm focus:border-teal-500 focus:ring-teal-500"
            />
          </div>

          {isPlatformAdmin && (
            <Select
              value={companyId === null ? '' : String(companyId)}
              onValueChange={(value) => {
                setCompanyId(value === '' ? null : Number(value));
                setDraft({});
              }}
            >
              <SelectTrigger className="h-9 w-full text-xs sm:w-56" aria-label="Company">
                <SelectValue placeholder="Choose a company" />
              </SelectTrigger>
              <SelectContent>
                {companyOptions.map((company) => (
                  <SelectItem key={company.id} value={String(company.id)}>
                    {company.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 shrink-0 border-slate-200 text-xs"
            disabled={!hasOverrides || resetMutation.isPending}
            onClick={() => setConfirmReset(true)}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Reset to defaults
          </Button>
        </div>

        {/* Legend. Three words each, because the grid below is dense enough. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-100 bg-slate-50/70 px-3 py-2 text-[11px] text-slate-500">
          <span>
            <span className="font-semibold text-slate-700">default</span> — the built-in rule
          </span>
          <span>
            <span className="font-semibold text-teal-700">changed</span> — set by an admin here
          </span>
          <span className="inline-flex items-center gap-1">
            <Lock size={11} className="text-slate-400" /> locked — hover or tap for the reason
          </span>
        </div>

        {isPlatformAdmin && companyId === null ? (
          <div className="p-6">
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
              Permissions belong to a company. Choose one above to configure it — the grid below
              shows the built-in defaults until you do.
            </p>
          </div>
        ) : null}

        {grid.isError ? (
          <div className="p-4">
            <ErrorState error={grid.error} onRetry={() => grid.refetch()} />
          </div>
        ) : grid.isLoading || !data ? (
          <div className="p-4">
            <LoadingState rows={6} label="Loading permissions" />
          </div>
        ) : (
          <>
            {refusal && (
              <div className="border-b border-red-100 bg-red-50 px-3 py-2.5">
                <p className="text-sm font-semibold text-red-800">
                  Nothing was saved — the whole change was refused.
                </p>
                <p className="mt-0.5 break-words text-sm text-red-700">{refusal}</p>
              </div>
            )}

            {/*
              DESKTOP: capabilities down, roles across. Two layouts rather than
              one scrolling table, because a five-column grid of switches at
              390px is a control nobody can hit — and horizontal scrolling to
              reach a toggle is how you flip the wrong one.
            */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-700">
                      Permission
                    </th>
                    {data.roles.map((role) => (
                      <th
                        key={role.value}
                        className="px-2 py-3 text-center text-xs font-semibold uppercase tracking-wide text-slate-700"
                      >
                        {ROLE_SHORT_LABELS[role.value]}
                      </th>
                    ))}
                    <th className="px-2 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleCapabilities.map((capability) => (
                    <tr key={capability.value} className="hover:bg-slate-50/60">
                      <td className="px-4 py-3 align-top">
                        <p className="font-medium text-slate-900">{capability.label}</p>
                        {capability.floor && (
                          <p className="mt-0.5 flex items-start gap-1 text-xs text-slate-500">
                            <Lock size={11} className="mt-0.5 shrink-0 text-slate-400" />
                            <span>
                              Never below {ROLE_SHORT_LABELS[capability.floor]}.{' '}
                              {capability.protection_reason}
                            </span>
                          </p>
                        )}
                      </td>
                      {data.roles.map((role) => {
                        const cell = data.matrix[role.value][capability.value];
                        return (
                          <td key={role.value} className="px-2 py-3 align-top">
                            <div className="flex flex-col items-center gap-1">
                              <Toggle
                                role={role.value}
                                capability={capability.value}
                                cell={cell}
                              />
                              <SourceNote
                                role={role.value}
                                capability={capability.value}
                                cell={cell}
                              />
                            </div>
                          </td>
                        );
                      })}
                      <td className="px-2 py-3 align-top">
                        {rowIsOverridden(capability.value) && (
                          <button
                            type="button"
                            onClick={() => revertRow(capability.value)}
                            title="Return this permission to its built-in default"
                            aria-label={`Reset ${capability.label} to its default`}
                            className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                          >
                            <RotateCcw size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* MOBILE: one block per permission, roles stacked as full-width rows. */}
            <div className="divide-y divide-slate-100 md:hidden">
              {visibleCapabilities.map((capability) => (
                <div key={capability.value} className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900">{capability.label}</p>
                      {capability.floor && (
                        <p className="mt-0.5 flex items-start gap-1 text-xs text-slate-500">
                          <Lock size={11} className="mt-0.5 shrink-0 text-slate-400" />
                          <span>
                            Never below {ROLE_SHORT_LABELS[capability.floor]}.{' '}
                            {capability.protection_reason}
                          </span>
                        </p>
                      )}
                    </div>
                    {rowIsOverridden(capability.value) && (
                      <button
                        type="button"
                        onClick={() => revertRow(capability.value)}
                        aria-label={`Reset ${capability.label} to its default`}
                        className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                      >
                        <RotateCcw size={14} />
                      </button>
                    )}
                  </div>

                  <ul className="mt-2 space-y-1">
                    {data.roles.map((role) => {
                      const cell = data.matrix[role.value][capability.value];
                      // Printed whenever the cell is pinned in EITHER direction,
                      // not just the one it currently sits in: there is no
                      // hover on a phone, so the rule has to be visible before
                      // the tap that would be refused.
                      const pinned = !cell.can_grant || !cell.can_revoke;
                      return (
                        <li key={role.value} className="rounded-md bg-slate-50/70 px-2.5 py-2">
                          <div className="flex items-center justify-between gap-3">
                            <span className="min-w-0 truncate text-sm text-slate-700">
                              {ROLE_SHORT_LABELS[role.value]}
                            </span>
                            <div className="flex shrink-0 items-center gap-2">
                              <SourceNote
                                role={role.value}
                                capability={capability.value}
                                cell={cell}
                              />
                              <Toggle
                                role={role.value}
                                capability={capability.value}
                                cell={cell}
                              />
                            </div>
                          </div>
                          {pinned && cell.reason && (
                            <p className="mt-1 text-[11px] leading-snug text-slate-500">
                              {cell.reason}
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>

            {visibleCapabilities.length === 0 && (
              <div className="px-4 py-10 text-center">
                <p className="text-sm text-slate-600">
                  No permission matches &ldquo;{search}&rdquo;.
                </p>
                <Button variant="outline" size="sm" className="mt-3" onClick={() => setSearch('')}>
                  Clear search
                </Button>
              </div>
            )}

            {/* Save bar. Inside the panel, sticky so it stays reachable. */}
            <div className="sticky bottom-0 flex flex-col gap-2 border-t border-slate-200 bg-white/95 p-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-slate-600">
                {pendingChanges.length === 0
                  ? 'No unsaved changes.'
                  : `${pendingChanges.length} unsaved change${pendingChanges.length === 1 ? '' : 's'}.`}
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 flex-1 text-xs sm:flex-none"
                  disabled={pendingChanges.length === 0 || saveMutation.isPending}
                  onClick={() => {
                    setDraft({});
                    saveMutation.reset();
                  }}
                >
                  Discard
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-9 flex-1 bg-teal-600 text-xs hover:bg-teal-700 sm:flex-none"
                  disabled={pendingChanges.length === 0 || saveMutation.isPending}
                  onClick={() => saveMutation.mutate(pendingChanges)}
                >
                  {saveMutation.isPending ? (
                    <>
                      <InlineSpinner className="mr-2" /> Saving…
                    </>
                  ) : (
                    'Save changes'
                  )}
                </Button>
              </div>
            </div>
          </>
        )}
      </section>

      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={() => resetMutation.mutate()}
        title="Return every permission to its default?"
        description="Every change made on this screen will be removed and the built-in rules take over again. People signed in now keep their current access until their next request."
        confirmText="Reset to defaults"
        confirmVariant="destructive"
        isLoading={resetMutation.isPending}
      />
    </div>
  );
}

export default function PermissionsRoute() {
  return (
    <RoleRoute allow={['DEV_ADMIN', 'COMPANY_ADMIN']}>
      <PermissionsScreen />
    </RoleRoute>
  );
}
