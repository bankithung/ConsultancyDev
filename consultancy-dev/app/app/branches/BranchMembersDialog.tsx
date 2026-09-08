'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Search, Users } from 'lucide-react';
import { Drawer } from '@/components/common/Drawer';
import { ErrorBanner, LoadingState } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ROLE_LABELS, assignableRoles } from '@/components/rbac/roles';
import { useCurrentRole } from '@/components/rbac/useCurrentRole';
import { loadAllPages } from '@/app/app/student-profile/aggregate';
import { apiClient } from '@/lib/apiClient';
import { toast } from '@/store/toastStore';
import type { Branch, Role, User, UserAdminInput } from '@/lib/types';

interface BranchMembersDialogProps {
  branch: Branch;
  initialUser?: User;
  initialRole?: Role;
  onClose: () => void;
}

export function BranchMembersDialog({ branch, initialUser, initialRole, onClose }: BranchMembersDialogProps) {
  const queryClient = useQueryClient();
  const { role: actorRole, can } = useCurrentRole();
  const canManage = can('manageUsers');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<User | null>(initialUser ?? null);
  const [role, setRole] = useState<Role>(initialRole ?? initialUser?.role ?? 'EMPLOYEE');
  const [branchId, setBranchId] = useState(
    String(initialUser?.branch ?? branch.id),
  );

  const roster = useQuery({
    queryKey: ['users', 'roster'],
    queryFn: () => loadAllPages<User>(apiClient.users.list, { ordering: 'username' }, 200, 10),
  });
  const branches = useQuery({
    queryKey: ['branch-options'],
    queryFn: () => loadAllPages<Branch>(apiClient.branches.list, { ordering: 'name' }),
  });
  const companyMembers = (roster.data ?? []).filter((member) => member.company === branch.company && member.role !== 'DEV_ADMIN');
  const assignableCandidates = companyMembers.filter((member) =>
    member.is_active
    && member.is_active_employee
    && (member.role === 'EMPLOYEE' || member.role === 'BRANCH_MANAGER')
    && (initialRole !== undefined || member.branch !== branch.id),
  );
  const needle = search.trim().toLowerCase();
  const candidates = assignableCandidates.filter((member) =>
    `${member.full_name} ${member.username} ${member.email}`.toLowerCase().includes(needle),
  );
  const roleChoices = [...new Set([
    ...assignableRoles(actorRole),
    ...(selected ? [selected.role] : []),
  ])].filter((value) => value !== 'DEV_ADMIN');
  const branchChoices = (branches.data ?? []).filter((item) =>
    item.company === branch.company && (item.is_active || item.id === selected?.branch),
  );
  const requiresBranch = role === 'EMPLOYEE' || role === 'BRANCH_MANAGER';
  const selectedBranch = branchChoices.find((item) => String(item.id) === branchId);
  const invalidBranch = (requiresBranch && branchId === 'none')
    || (branchId !== 'none' && (!selectedBranch || (!selectedBranch.is_active && selected?.branch !== selectedBranch.id)));
  const changed = !!selected
    && (selected.role !== role || selected.branch !== (branchId === 'none' ? null : Number(branchId)));

  const save = useMutation({
    mutationFn: async () => {
      if (!selected || !canManage || invalidBranch) throw new Error('Choose an active branch.');
      const patch: Partial<UserAdminInput> = {};
      if (role !== selected.role) patch.role = role;
      if (branchId !== String(selected.branch ?? 'none')) {
        patch.branch = branchId === 'none' ? null : Number(branchId);
      }
      if (selected.role === 'HEAD_MANAGER' && role !== 'HEAD_MANAGER') patch.managed_managers = [];
      return apiClient.users.update(selected.id, patch);
    },
    onSuccess: async () => {
      await Promise.all([
        ['users'], ['user'], ['branches'], ['branch-options'], ['counselor-analytics'], ['team'],
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      toast.success('Assignment saved');
      onClose();
    },
  });

  const choose = (member: User) => {
    const nextRole = initialRole ?? member.role;
    setSelected(member);
    setRole(nextRole);
    setBranchId(String(nextRole === 'HEAD_MANAGER' ? member.branch ?? branch.id : branch.id));
    save.reset();
  };

  const drawerTitle = initialUser
    ? `Manage ${initialUser.full_name || initialUser.username}`
    : initialRole === 'HEAD_MANAGER'
      ? 'Assign head manager'
      : initialRole === 'BRANCH_MANAGER'
        ? 'Assign branch manager'
        : 'Assign member';
  const drawerDescription = initialUser
    ? initialUser.email
    : initialRole === 'HEAD_MANAGER'
      ? 'Oversees all branches'
      : `To ${branch.name}`;

  return (
    <Drawer
      open
      onOpenChange={(next) => {
        if (!next && !save.isPending) onClose();
      }}
      onRequestClose={() => !save.isPending}
      title={drawerTitle}
      description={drawerDescription}
      panelClassName="sm:w-[500px]"
      bodyClassName="px-4 py-5 sm:px-6"
      footer={(
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>Close</Button>
          {selected && canManage && (
            <Button
              type="submit"
              form="branch-member-form"
              className="bg-teal-600 hover:bg-teal-700"
              disabled={!changed || invalidBranch || save.isPending || branches.isError || branches.isLoading}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          )}
        </div>
      )}
    >
      {roster.isLoading ? <LoadingState rows={3} label="Loading team" /> : roster.isError ? <ErrorBanner error={roster.error} /> : selected ? (
        <form
          id="branch-member-form"
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (changed && !save.isPending) save.mutate();
          }}
        >
          {!initialUser && (
            <button
              type="button"
              onClick={() => setSelected(null)}
              disabled={save.isPending}
              className="flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-teal-700"
            >
              <ArrowLeft size={14} /> Choose another
            </button>
          )}
          <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-4">
            <div className="min-w-0">
              <p className="break-words text-sm font-semibold text-slate-900">{selected.full_name || selected.username}</p>
              <p className="break-all text-xs text-slate-500">{selected.email}</p>
            </div>
            <Link className="shrink-0 text-xs font-medium text-teal-700 hover:underline" href={`/app/team/${selected.id}`}>Profile</Link>
          </div>
          {save.isError && <ErrorBanner error={save.error} />}
          {branches.isError && <ErrorBanner error={branches.error} />}
          <fieldset disabled={!canManage || save.isPending} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="assignment-role">Role</Label>
              <Select
                value={role}
                disabled={initialRole !== undefined}
                onValueChange={(value) => {
                  const nextRole = value as Role;
                  setRole(nextRole);
                  if (nextRole !== 'HEAD_MANAGER' && branchId === 'none') setBranchId(String(branch.id));
                }}
              >
                <SelectTrigger id="assignment-role"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {roleChoices.map((value) => <SelectItem key={value} value={value}>{ROLE_LABELS[value]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="assignment-branch">{role === 'HEAD_MANAGER' ? 'Base branch' : 'Branch'}{requiresBranch ? ' *' : ''}</Label>
              <Select value={branchId} disabled={save.isPending} onValueChange={setBranchId}>
                <SelectTrigger id="assignment-branch"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {!requiresBranch && <SelectItem value="none">Not assigned</SelectItem>}
                  {branchChoices.map((item) => (
                    <SelectItem key={item.id} value={String(item.id)}>{item.name}{!item.is_active ? ' (inactive)' : ''}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {role === 'HEAD_MANAGER' && <p className="rounded-md bg-teal-50 px-3 py-2 text-xs text-teal-800">Access to every company branch.</p>}
            {role === 'BRANCH_MANAGER' && <p className="text-xs text-slate-500">Manages this branch and its team.</p>}
          </fieldset>
          {changed && <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">This change signs the member out.</p>}
        </form>
      ) : (
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Choose a team member</h3>
            <p className="mt-1 text-xs text-slate-500">Select a person, then confirm their role.</p>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <Input className="h-9 pl-9" aria-label="Search team members" placeholder="Search team…" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          {roster.data && roster.data.length >= 2000 && <p className="text-xs text-amber-700">Showing the first 2,000 members.</p>}
          {candidates.length > 0 ? (
            <ul className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
              {candidates.map((member) => (
                <li key={member.id}>
                  <button type="button" className="flex w-full items-center gap-3 p-3 text-left hover:bg-slate-50" onClick={() => choose(member)}>
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-teal-50 text-xs font-semibold text-teal-700">{(member.full_name || member.username).slice(0, 1).toUpperCase()}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-900">{member.full_name || member.username}</span>
                      <span className="block truncate text-xs text-slate-500">{ROLE_LABELS[member.role]} · {member.branch_name || 'Unassigned'}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="rounded-lg border border-dashed border-slate-200 px-5 py-10 text-center">
              <Users size={24} className="mx-auto mb-2 text-slate-300" />
              <p className="text-sm font-medium text-slate-700">{search ? 'No matching members' : 'No members available'}</p>
              <p className="mx-auto mt-1 max-w-xs text-xs text-slate-500">{search ? 'Try another name or email.' : 'Create an employee account first.'}</p>
              {!search && (
                <Button asChild size="sm" className="mt-4 bg-teal-600 hover:bg-teal-700">
                  <Link href="/app/team?tab=members"><Plus size={14} className="mr-1" /> Add team member</Link>
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
