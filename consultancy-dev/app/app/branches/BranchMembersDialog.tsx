'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Search, Users } from 'lucide-react';
import { Modal } from '@/components/common/Modal';
import { ErrorBanner, LoadingState } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ManagerMultiSelect } from '@/components/admin/ManagerMultiSelect';
import { ROLE_LABELS, assignableRoles } from '@/components/rbac/roles';
import { useCurrentRole } from '@/components/rbac/useCurrentRole';
import { loadAllPages } from '@/app/app/student-profile/aggregate';
import { apiClient } from '@/lib/apiClient';
import { toast } from '@/store/toastStore';
import type { Branch, Role, User, UserAdminInput } from '@/lib/types';

const selectClass = 'h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-50';

export function BranchMembersDialog({ branch, onClose }: { branch: Branch; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { role: actorRole, can } = useCurrentRole();
  const canManage = can('manageUsers');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<User | null>(null);
  const [role, setRole] = useState<Role>('EMPLOYEE');
  const [branchId, setBranchId] = useState(String(branch.id));
  const [managers, setManagers] = useState<number[]>([]);
  const [managersTouched, setManagersTouched] = useState(false);
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
  const candidates = (adding ? companyMembers : currentMembers).filter((member) =>
    `${member.full_name} ${member.username} ${member.email}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const roleChoices = [...new Set([...assignableRoles(actorRole), ...(selected ? [selected.role] : [])])].filter((value) => value !== 'DEV_ADMIN');
  const branchChoices = (branches.data ?? []).filter((item) => item.company === branch.company && (item.is_active || item.id === selected?.branch));
  const identityChanged = !!selected && (selected.role !== role || selected.branch !== (branchId === 'none' ? null : Number(branchId)));
  const changed = identityChanged || managersTouched;
  const requiresBranch = role === 'EMPLOYEE' || role === 'BRANCH_MANAGER';
  const selectedBranch = branchChoices.find((item) => String(item.id) === branchId);
  const invalidBranch = (requiresBranch && branchId === 'none') || (branchId !== 'none' && (!selectedBranch || (!selectedBranch.is_active && selected?.branch !== selectedBranch.id)));

  const save = useMutation({
    mutationFn: async () => {
      if (!selected || !canManage || invalidBranch) throw new Error('Choose an active branch for this member.');
      const patch: Partial<UserAdminInput> = {};
      if (role !== selected.role) patch.role = role;
      if (branchId !== String(selected.branch ?? 'none')) patch.branch = branchId === 'none' ? null : Number(branchId);
      if (role === 'HEAD_MANAGER' && managersTouched) patch.managed_managers = managers;
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
    setRole(member.role);
    setBranchId(String(branch.id));
    setManagers(member.managed_managers ?? []);
    setManagersTouched(false);
    save.reset();
  };

  return (
    <Modal open onClose={() => !save.isPending && onClose()} size="lg" title={branch.name} description="Members, roles and reporting lines" footer={
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
              <div className="space-y-2"><Label htmlFor="assignment-role">Role</Label><select id="assignment-role" className={selectClass} value={role} onChange={(event) => setRole(event.target.value as Role)}>{roleChoices.map((value) => <option key={value} value={value}>{ROLE_LABELS[value]}</option>)}</select></div>
              <div className="space-y-2"><Label htmlFor="assignment-branch">Branch{requiresBranch ? ' *' : ''}</Label><select id="assignment-branch" className={selectClass} value={branchId} onChange={(event) => setBranchId(event.target.value)}>{!requiresBranch && <option value="none">Not assigned</option>}{branchChoices.map((item) => <option key={item.id} value={String(item.id)}>{item.name}{!item.is_active ? ' (inactive)' : ''}</option>)}</select></div>
            </div>
            {role === 'BRANCH_MANAGER' && <p className="text-xs text-slate-500">In charge of members and records in this branch.</p>}
            {role === 'EMPLOYEE' && <p className="text-xs text-slate-500">Reports to this branch’s manager{companyMembers.filter((member) => member.branch === Number(branchId) && member.role === 'BRANCH_MANAGER' && member.id !== selected.id).length === 1 ? '' : 's'}.</p>}
            {role === 'HEAD_MANAGER' && <div className="space-y-2"><Label>Branch managers they oversee</Label><ManagerMultiSelect options={companyMembers.filter((member) => member.role === 'BRANCH_MANAGER' && member.id !== selected.id)} selected={managers} onChange={(next) => { setManagers(next); setManagersTouched(true); }} disabled={!canManage || save.isPending} /></div>}
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
          <p className="text-xs text-slate-500">Add new accounts in <Link href="/app/team?tab=members" className="text-teal-700 underline">Team</Link>. Appoint a branch manager here to set who is in charge.</p>
        </div>
      )}
    </Modal>
  );
}
