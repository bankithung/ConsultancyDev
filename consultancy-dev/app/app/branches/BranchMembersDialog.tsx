'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Search, Users } from 'lucide-react';
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
  startAssigning?: boolean;
  onClose: () => void;
}

export function BranchMembersDialog({
  branch,
  initialUser,
  initialRole,
  startAssigning = false,
  onClose,
}: BranchMembersDialogProps) {
  const queryClient = useQueryClient();
  const { role: actorRole, can } = useCurrentRole();
  const canManage = can('manageUsers');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(startAssigning);
  const [selected, setSelected] = useState<User | null>(initialUser ?? null);
  const [role, setRole] = useState<Role>(initialRole ?? initialUser?.role ?? 'EMPLOYEE');
  const [branchId, setBranchId] = useState(
    String(initialRole === 'HEAD_MANAGER' ? 'none' : initialUser?.branch ?? branch.id),
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
  const currentMembers = companyMembers.filter((member) => member.branch === branch.id);
  const assignableCandidates = companyMembers.filter((member) =>
    member.role === 'EMPLOYEE' || member.role === 'BRANCH_MANAGER',
  );
  const candidates = (adding ? assignableCandidates : currentMembers).filter((member) =>
    `${member.full_name} ${member.username} ${member.email}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const roleChoices = [...new Set([...assignableRoles(actorRole), ...(selected ? [selected.role] : [])])].filter((value) => value !== 'DEV_ADMIN');
  const branchChoices = (branches.data ?? []).filter((item) => item.company === branch.company && (item.is_active || item.id === selected?.branch));
  const identityChanged = !!selected && (selected.role !== role || selected.branch !== (branchId === 'none' ? null : Number(branchId)));
  const changed = identityChanged;
  const requiresBranch = role === 'EMPLOYEE' || role === 'BRANCH_MANAGER';
  const selectedBranch = branchChoices.find((item) => String(item.id) === branchId);
  const invalidBranch = (requiresBranch && branchId === 'none') || (branchId !== 'none' && (!selectedBranch || (!selectedBranch.is_active && selected?.branch !== selectedBranch.id)));
  const drawerTitle = initialUser
    ? 'Manage member'
    : initialRole === 'HEAD_MANAGER'
      ? 'Assign head manager'
      : 'Assign member';

  const save = useMutation({
    mutationFn: async () => {
      if (!selected || !canManage || invalidBranch) throw new Error('Choose an active branch for this member.');
      const patch: Partial<UserAdminInput> = {};
      if (role !== selected.role) patch.role = role;
      if (branchId !== String(selected.branch ?? 'none')) patch.branch = branchId === 'none' ? null : Number(branchId);
      // Head managers are company-wide. The branch value is cleared so the UI
      // never implies that their authority belongs to one location.
      if (role === 'HEAD_MANAGER') patch.branch = null;
      if (selected.role === 'HEAD_MANAGER' && role !== 'HEAD_MANAGER') patch.managed_managers = [];
      return apiClient.users.update(selected.id, patch);
    },
    onSuccess: async () => {
      await Promise.all([
        ['users'], ['user'], ['branches'], ['branch-options'], ['counselor-analytics'], ['team'],
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      toast.success('Assignment saved', identityChanged ? 'The member will need to sign in again.' : undefined);
      setSelected(null);
      setAdding(false);
      setSearch('');
    },
  });

  const choose = (member: User) => {
    setSelected(member);
    const nextRole = initialRole ?? member.role;
    setRole(nextRole);
    setBranchId(nextRole === 'HEAD_MANAGER' ? 'none' : String(branch.id));
    save.reset();
  };

  return (
    <Drawer
      open
      onOpenChange={(next) => {
        if (!next && !save.isPending) onClose();
      }}
      onRequestClose={() => !save.isPending}
      title={drawerTitle}
      description={`${branch.name} · Roles and branch`}
      panelClassName="sm:w-[520px] lg:w-[560px]"
      bodyClassName="px-4 py-5 sm:px-6"
      footer={
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={save.isPending}>Close</Button>
        {selected && canManage && <Button type="submit" form="branch-member-form" className="bg-teal-600 hover:bg-teal-700" disabled={!changed || invalidBranch || save.isPending || branches.isError || branches.isLoading}>{save.isPending ? 'Saving…' : 'Save assignment'}</Button>}
      </div>
    }>
      {roster.isLoading ? <LoadingState rows={3} label="Loading members" /> : roster.isError ? <ErrorBanner error={roster.error} /> : selected ? (
        <form id="branch-member-form" className="space-y-5" onSubmit={(event) => { event.preventDefault(); if (changed && !save.isPending) save.mutate(); }}>
          <button type="button" onClick={() => setSelected(null)} disabled={save.isPending} className="flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-teal-700"><ArrowLeft size={14} /> All members</button>
          <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-4">
            <div className="min-w-0"><p className="break-words text-sm font-semibold text-slate-900">{selected.full_name || selected.username}</p><p className="break-all text-xs text-slate-500">{selected.email}</p></div>
            <Link className="shrink-0 text-xs font-medium text-teal-700 hover:underline" href={`/app/team/${selected.id}`}>View profile</Link>
          </div>
          {save.isError && <ErrorBanner error={save.error} />}
          {branches.isError && <ErrorBanner error={branches.error} />}
          <fieldset disabled={!canManage || save.isPending} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="assignment-role">Role</Label>
                <Select
                  value={role}
                  onValueChange={(value) => {
                    const nextRole = value as Role;
                    setRole(nextRole);
                    if (nextRole === 'HEAD_MANAGER') setBranchId('none');
                    else if (branchId === 'none') setBranchId(String(branch.id));
                  }}
                >
                  <SelectTrigger id="assignment-role"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {roleChoices.map((value) => (
                      <SelectItem key={value} value={value}>{ROLE_LABELS[value]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="assignment-branch">Branch{requiresBranch ? ' *' : ''}</Label>
                <Select value={branchId} disabled={role === 'HEAD_MANAGER'} onValueChange={setBranchId}>
                  <SelectTrigger id="assignment-branch"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {!requiresBranch && <SelectItem value="none">All branches</SelectItem>}
                    {branchChoices.map((item) => (
                      <SelectItem key={item.id} value={String(item.id)}>
                        {item.name}{!item.is_active ? ' (inactive)' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {role === 'BRANCH_MANAGER' && <p className="text-xs text-slate-500">In charge of members and records in this branch.</p>}
            {role === 'EMPLOYEE' && <p className="text-xs text-slate-500">Reports to this branch’s manager{companyMembers.filter((member) => member.branch === Number(branchId) && member.role === 'BRANCH_MANAGER' && member.id !== selected.id).length === 1 ? '' : 's'}.</p>}
            {role === 'HEAD_MANAGER' && <p className="rounded-md bg-teal-50 px-3 py-2 text-xs text-teal-800">Oversees every branch in this company.</p>}
          </fieldset>
          {identityChanged && <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">Changing role or branch signs this member out.</p>}
        </form>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium text-slate-700">{adding ? 'Choose a team member' : `${currentMembers.length} members`}</span>{canManage && <Button variant="outline" size="sm" onClick={() => { setAdding(!adding); setSearch(''); }}>{adding ? 'Branch members' : 'Assign member'}</Button>}</div>
          <div className="relative"><Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" /><Input className="h-9 pl-9" aria-label="Search members" placeholder="Search members…" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
          {roster.data && roster.data.length >= 2000 && <p className="text-xs text-amber-700">Showing the first 2,000 members.</p>}
          <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
            {candidates.map((member) => <li key={member.id}><button type="button" className="flex w-full items-center gap-3 p-3 text-left hover:bg-slate-50" onClick={() => choose(member)}><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-teal-50 text-xs font-semibold text-teal-700">{(member.full_name || member.username).slice(0, 1).toUpperCase()}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-slate-900">{member.full_name || member.username}</span><span className="block truncate text-xs text-slate-500">{ROLE_LABELS[member.role]} · {member.branch_name || 'Not assigned'}{!member.is_active_employee && ' · Inactive'}</span></span><span className="text-xs text-teal-700">{canManage ? 'Manage' : 'View'}</span></button></li>)}
            {candidates.length === 0 && <li className="p-6 text-center text-sm text-slate-500"><Users size={22} className="mx-auto mb-2 text-slate-400" />{search ? 'No members match.' : adding ? 'Add members in the Team tab first.' : 'No members assigned yet.'}</li>}
          </ul>
          <p className="text-xs text-slate-500">Add accounts in <Link href="/app/team?tab=members" className="text-teal-700 underline">Team</Link>. Assign roles here.</p>
        </div>
      )}
    </Drawer>
  );
}
