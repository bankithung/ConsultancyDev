'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Building2, ChevronRight, Pencil, Plus, Power, Search, ShieldCheck, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ErrorBanner, ErrorState, LoadingState } from '@/components/common/states';
import { ROLE_LABELS } from '@/components/rbac/roles';
import { useCurrentRole } from '@/components/rbac/useCurrentRole';
import { apiClient } from '@/lib/apiClient';
import { loadAllPages } from '@/app/app/student-profile/aggregate';
import type { Branch, Role, User } from '@/lib/types';
import { BranchFormDrawer } from './BranchFormDrawer';
import { BranchMembersDialog } from './BranchMembersDialog';

export function BranchDirectory() {
  const queryClient = useQueryClient();
  const { can } = useCurrentRole();
  const canManageBranches = can('manageBranches');
  const canManageMembers = can('manageUsers');
  const [search, setSearch] = useState('');
  const [memberSearch, setMemberSearch] = useState('');
  const [ordering, setOrdering] = useState('name');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [branchForm, setBranchForm] = useState<{ branch: Branch | null; key: number } | null>(null);
  const [toggleTarget, setToggleTarget] = useState<Branch | null>(null);
  const [assignment, setAssignment] = useState<{ branch: Branch; user?: User; role?: Role } | null>(null);
  const branches = useQuery({
    queryKey: ['branches', 'workspace'],
    queryFn: () => loadAllPages<Branch>(apiClient.branches.list, { ordering: 'name' }, 200, 10),
  });
  const roster = useQuery({
    queryKey: ['users', 'roster'],
    queryFn: () => loadAllPages<User>(apiClient.users.list, { ordering: 'username' }, 200, 10),
  });
  const allBranches = useMemo(() => branches.data ?? [], [branches.data]);
  const allMembers = useMemo(() => roster.data ?? [], [roster.data]);
  const rosterComplete = roster.isSuccess && !roster.isError && allMembers.length < 2000;
  const membersFor = (branch: Branch) => allMembers.filter((user) =>
    user.company === branch.company
    && user.branch === branch.id
    && (user.role === 'EMPLOYEE' || user.role === 'BRANCH_MANAGER'),
  );
  const managersFor = (branch: Branch) => membersFor(branch).filter((user) => user.role === 'BRANCH_MANAGER' && user.is_active && user.is_active_employee);
  const visibleBranches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return allBranches.filter((branch) => `${branch.name} ${branch.code} ${branch.city} ${branch.company_name}`.toLowerCase().includes(needle))
      .sort((a, b) => ordering === 'staff' ? b.user_count - a.user_count : ordering === 'recent' ? b.id - a.id : a.name.localeCompare(b.name));
  }, [allBranches, search, ordering]);
  const selected = visibleBranches.find((branch) => branch.id === selectedId)
    ?? visibleBranches.find((branch) => branch.is_default)
    ?? visibleBranches[0];
  const companyHeads = selected ? allMembers.filter((user) => user.company === selected.company && user.role === 'HEAD_MANAGER' && user.is_active && user.is_active_employee) : [];
  const currentMembers = selected ? membersFor(selected) : [];
  const filteredMembers = currentMembers.filter((user) => `${user.full_name} ${user.username} ${user.email} ${ROLE_LABELS[user.role]}`.toLowerCase().includes(memberSearch.trim().toLowerCase()));
  const missingManager = !!selected && rosterComplete && managersFor(selected).length === 0;
  const toggle = useMutation({
    mutationFn: (branch: Branch) => apiClient.branches.update(branch.id, { is_active: !branch.is_active }),
    onSuccess: async () => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['branches'] }), queryClient.invalidateQueries({ queryKey: ['branch-options'] })]);
      setToggleTarget(null);
    },
  });
  const openBranchForm = (branch: Branch | null) => setBranchForm({ branch, key: Date.now() });
  const setDefault = useMutation({
    mutationFn: (branch: Branch) => apiClient.branches.setDefault(branch.id),
    onSuccess: async (branch) => {
      setSelectedId(branch.id);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['branches'] }), queryClient.invalidateQueries({ queryKey: ['branch-options'] })]);
    },
  });

  return (
    <div className="grid min-w-0 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" data-testid="branch-workspace">
      <section aria-label="Branches" className="min-w-0 border-b border-slate-200 bg-slate-50/40 lg:border-b-0 lg:border-r" data-testid="branch-list">
        <div className="flex items-center justify-between gap-2 p-4">
          <h2 className="text-sm font-semibold text-slate-900">Branches <span className="ml-1 text-xs font-normal text-slate-500">{branches.isSuccess ? allBranches.length : ''}</span></h2>
          {canManageBranches && <Button size="sm" className="h-8 bg-teal-600 text-xs hover:bg-teal-700" onClick={() => openBranchForm(null)}><Plus size={14} className="mr-1" /> New branch</Button>}
        </div>
        <div className="flex flex-col gap-2 px-4 pb-3 xl:flex-row">
          <div className="relative min-w-0 flex-1"><Search size={14} className="absolute left-3 top-2.5 text-slate-400" /><Input className="h-9 bg-white pl-8 text-xs" aria-label="Search branches" placeholder="Search branches…" value={search} onChange={(event) => { setSearch(event.target.value); setMemberSearch(''); }} /></div>
          <Select value={ordering} onValueChange={setOrdering}>
            <SelectTrigger aria-label="Sort branches" className="h-9 bg-white text-xs text-slate-600 xl:w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">Name A–Z</SelectItem>
              <SelectItem value="staff">Most staff</SelectItem>
              <SelectItem value="recent">Newest</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {branches.isError ? <div className="p-4"><ErrorState error={branches.error} onRetry={() => branches.refetch()} /></div> : branches.isLoading ? <div className="p-4"><LoadingState rows={3} label="Loading branches" /></div> : (
          <ul className="max-h-72 space-y-1 overflow-y-auto px-2 pb-3 lg:max-h-[640px]">
            {visibleBranches.map((branch) => {
              const active = selected?.id === branch.id;
              const needsManager = rosterComplete && managersFor(branch).length === 0;
              return <li key={branch.id}><button type="button" aria-pressed={active} aria-controls="selected-branch-members" onClick={() => { setSelectedId(branch.id); setMemberSearch(''); }} className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${active ? 'border-teal-200 bg-white shadow-sm' : 'border-transparent hover:bg-white'}`}>
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${active ? 'bg-teal-50 text-teal-700' : 'bg-slate-100 text-slate-400'}`}><Building2 size={17} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-sm font-semibold text-slate-900">{branch.name}</span>
                  <span className="mt-0.5 block truncate text-xs text-slate-500">{[branch.code, branch.city].filter(Boolean).join(' · ') || branch.company_name}</span>
                  <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
                    <span>{rosterComplete ? membersFor(branch).length : branch.user_count} {((rosterComplete ? membersFor(branch).length : branch.user_count) === 1) ? 'member' : 'members'}</span>
                    {branch.is_default && <span className="text-teal-700">Default</span>}
                    {!branch.is_active && <span>Inactive</span>}
                    {needsManager && <span className="inline-flex items-center gap-1 text-amber-700"><AlertTriangle size={11} /> No branch manager</span>}
                  </span>
                </span>
                <ChevronRight size={15} className={`mt-2 shrink-0 ${active ? 'text-teal-600' : 'text-slate-300'}`} />
              </button></li>;
            })}
            {visibleBranches.length === 0 && <li className="px-4 py-8 text-center text-sm text-slate-500">{search ? 'No matching branches.' : 'No branches yet.'}</li>}
          </ul>
        )}
        {allBranches.length >= 2000 && <p className="px-4 pb-3 text-xs text-amber-700">Showing the first 2,000 branches.</p>}
      </section>

      <section id="selected-branch-members" aria-label="Branch members" className="min-w-0" data-testid="branch-members">
        {selected ? <>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
            <div className="min-w-0"><h2 className="break-words text-sm font-semibold text-slate-900">{selected.name}</h2><p className="mt-0.5 text-xs text-slate-500">{currentMembers.length} {currentMembers.length === 1 ? 'member' : 'members'}</p></div>
            <div className="flex flex-wrap items-center gap-1">
              {selected.is_default ? <Badge className="bg-teal-50 text-teal-700">Default branch</Badge> : canManageBranches && selected.is_active && <Button size="sm" variant="outline" className="h-8 text-xs" disabled={setDefault.isPending} onClick={() => setDefault.mutate(selected)}>{setDefault.isPending ? 'Saving…' : 'Set as default'}</Button>}
              {canManageMembers && <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setAssignment({ branch: selected })}><Plus size={14} className="mr-1" /> Assign member</Button>}
              {canManageBranches && <><Button size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label={`Edit ${selected.name}`} onClick={() => openBranchForm(selected)}><Pencil size={14} /></Button><Button size="sm" variant="ghost" className="h-8 w-8 p-0" disabled={selected.is_default} aria-label={`${selected.is_active ? 'Deactivate' : 'Activate'} ${selected.name}`} title={selected.is_default ? 'Default branch stays active' : undefined} onClick={() => setToggleTarget(selected)}><Power size={14} /></Button></>}
            </div>
          </div>
          <div className="flex items-start gap-3 border-b border-slate-100 bg-slate-50/50 p-4">
            <ShieldCheck size={18} className="mt-0.5 shrink-0 text-teal-600" />
            <div className="min-w-0 flex-1"><p className="text-xs font-semibold text-slate-700">Head manager <span className="ml-1 font-normal text-slate-500">· All branches</span></p>
              {roster.isLoading ? <p className="mt-1 text-xs text-slate-500">Loading…</p> : companyHeads.length > 0 ? <div className="mt-1 space-y-2">{companyHeads.map((head) => <div key={head.id} className="flex items-center justify-between gap-2"><Link href={`/app/team/${head.id}`} className="truncate text-sm font-medium text-slate-900 hover:text-teal-700 hover:underline">{head.full_name || head.username}</Link>{canManageMembers && <button className="shrink-0 text-xs font-medium text-teal-700 hover:underline" onClick={() => setAssignment({ branch: selected, user: head })}>Manage</button>}</div>)}{companyHeads.length > 1 && <p className="text-xs text-amber-700">More than one head manager is active.</p>}</div> : <div className="mt-1 flex items-center justify-between gap-2"><span className="text-xs text-slate-500">{rosterComplete ? 'Not assigned' : 'Unavailable'}</span>{rosterComplete && canManageMembers && <button className="text-xs font-medium text-teal-700 hover:underline" onClick={() => setAssignment({ branch: selected, role: 'HEAD_MANAGER' })}>Assign head manager</button>}</div>}
            </div>
          </div>
          {roster.isError ? <div className="p-4"><ErrorState error={roster.error} onRetry={() => roster.refetch()} /></div> : roster.isLoading ? <div className="p-4"><LoadingState rows={3} label="Loading members" /></div> : <>
            {missingManager && <div role="status" className="mx-4 mt-4 flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2.5 text-xs text-amber-800"><AlertTriangle size={15} className="shrink-0" /><p className="flex-1">Branch manager not assigned.</p>{canManageMembers && <button type="button" className="shrink-0 font-semibold text-amber-900 underline" onClick={() => setAssignment({ branch: selected, role: 'BRANCH_MANAGER' })}>Assign manager</button>}</div>}
            {!rosterComplete && <p className="px-4 pt-3 text-xs text-amber-700">Member list may be incomplete. Manager status unavailable.</p>}
            {currentMembers.length > 0 && <div className="flex items-center gap-3 p-4"><div className="relative min-w-0 flex-1"><Search size={14} className="absolute left-3 top-2.5 text-slate-400" /><Input aria-label="Search branch members" className="h-9 pl-8 text-xs" placeholder="Search members…" value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} /></div></div>}
            <ul className="max-h-[480px] divide-y divide-slate-100 overflow-y-auto">
              {filteredMembers.map((member) => <li key={member.id} className="flex items-center gap-3 px-4 py-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-teal-50 text-xs font-semibold text-teal-700">{(member.full_name || member.username).slice(0, 1).toUpperCase()}</span>
                <div className="min-w-0 flex-1"><Link href={`/app/team/${member.id}`} className="block truncate text-sm font-medium text-slate-900 hover:text-teal-700 hover:underline">{member.full_name || member.username}</Link><p className="mt-0.5 truncate text-xs text-slate-500">{member.email}</p><div className="mt-1 flex flex-wrap items-center gap-2"><Badge className={`border-0 text-[10px] ${member.role === 'BRANCH_MANAGER' ? 'bg-teal-50 text-teal-700' : 'bg-slate-100 text-slate-600'}`}>{ROLE_LABELS[member.role]}</Badge>{(!member.is_active || !member.is_active_employee) && <span className="text-[10px] text-slate-400">Inactive</span>}</div></div>
                {canManageMembers && <Button variant="ghost" size="sm" className="h-8 shrink-0 text-xs text-teal-700" aria-label={`Manage ${member.full_name || member.username}`} onClick={() => setAssignment({ branch: selected, user: member })}>Manage</Button>}
              </li>)}
              {filteredMembers.length === 0 && <li className="px-4 py-12 text-center"><Users size={24} className="mx-auto mb-2 text-slate-300" /><p className="text-sm font-medium text-slate-600">{memberSearch ? 'No matching members' : 'No branch members'}</p><p className="mt-1 text-xs text-slate-500">{memberSearch ? 'Try another name or email.' : 'Assign an employee to this branch.'}</p>{!memberSearch && canManageMembers && <Button size="sm" className="mt-4 bg-teal-600 hover:bg-teal-700" onClick={() => setAssignment({ branch: selected })}><Plus size={14} className="mr-1" /> Assign member</Button>}</li>}
            </ul>
          </>}
        </> : <div className="flex min-h-72 flex-col items-center justify-center p-6 text-center"><Building2 size={28} className="mb-3 text-slate-300" /><p className="text-sm text-slate-500">{branches.isLoading ? 'Loading branches…' : 'Select a branch to view members.'}</p></div>}
      </section>
      {branchForm && <BranchFormDrawer key={branchForm.key} open branch={branchForm.branch} onClose={() => setBranchForm(null)} />}
      {assignment && <BranchMembersDialog branch={assignment.branch} initialUser={assignment.user} initialRole={assignment.role} onClose={() => setAssignment(null)} />}
      <ConfirmDialog open={!!toggleTarget} onClose={() => setToggleTarget(null)} onConfirm={() => toggleTarget && toggle.mutate(toggleTarget)} title={toggleTarget?.is_active ? 'Deactivate branch?' : 'Activate branch?'} description={toggleTarget?.is_active ? 'Existing members and records are kept.' : 'Allow new records and assignments.'} confirmText={toggleTarget?.is_active ? 'Deactivate' : 'Activate'} confirmVariant={toggleTarget?.is_active ? 'destructive' : 'default'} isLoading={toggle.isPending} />
      {toggle.isError && <div className="p-4 lg:col-span-2"><ErrorBanner error={toggle.error} onDismiss={() => toggle.reset()} /></div>}
      {setDefault.isError && <div className="p-4 lg:col-span-2"><ErrorBanner error={setDefault.error} onDismiss={() => setDefault.reset()} /></div>}
    </div>
  );
}
