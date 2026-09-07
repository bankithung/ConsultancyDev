import { redirect } from 'next/navigation';

export default function BranchesRoute() {
  redirect('/app/team?tab=branches');
}
