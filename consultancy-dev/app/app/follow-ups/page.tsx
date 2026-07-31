import { redirect } from 'next/navigation';

/**
 * Follow-ups and appointments are one screen with two tabs now, so this route
 * forwards rather than duplicating it. The old address stays valid for anyone
 * who bookmarked it and for the links elsewhere in the app — the dashboard, the
 * tasks board and the profile page all still point here.
 *
 * Only the index moves: `/app/follow-ups/[id]` is a separate route and is
 * untouched.
 */
export default function FollowUpsPage() {
  redirect('/app/engagements?tab=follow-ups');
}
