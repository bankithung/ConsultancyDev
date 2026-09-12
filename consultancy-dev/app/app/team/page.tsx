'use client';

import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Building2, Users } from 'lucide-react';
import { BookmarkTabs } from '@/components/common/BookmarkTabs';
import { LoadingState } from '@/components/common/states';
import { RoleRoute } from '@/components/rbac/RoleGate';
import { useCurrentRole } from '@/components/rbac/useCurrentRole';
import { TeamDirectory } from './TeamDirectory';
import { BranchDirectory } from '../branches/BranchDirectory';

function TeamWorkspace() {
  const router = useRouter();
  const params = useSearchParams();
  const { can } = useCurrentRole();
  const canManageBranches = can('manageBranches');
  const tab = params.get('tab') === 'branches' && canManageBranches ? 'branches' : 'members';
  const tabs = [
    { value: 'members', label: 'Team', icon: Users },
    ...(canManageBranches ? [{ value: 'branches', label: 'Branches', icon: Building2 }] : []),
  ];
  return (
    <div className="pt-1">
      <h1 className="sr-only">Team and branches</h1>
      <BookmarkTabs tabs={tabs} value={tab} aria-label="Team and branches" onChange={(value) => router.push(`/app/team?tab=${value}`, { scroll: false })} />
      <section role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {tab === 'members' ? <TeamDirectory /> : <BranchDirectory />}
      </section>
    </div>
  );
}

export default function TeamRoute() {
  return <RoleRoute allow={['DEV_ADMIN', 'COMPANY_ADMIN', 'HEAD_MANAGER', 'BRANCH_MANAGER']}><Suspense fallback={<LoadingState rows={3} label="Loading team" />}><TeamWorkspace /></Suspense></RoleRoute>;
}
