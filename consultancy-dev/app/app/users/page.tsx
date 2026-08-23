import { redirect } from 'next/navigation';

/**
 * `/app/users` and `/app/counselors` were two views of one roster: this page
 * listed the accounts, the other rendered the same `users/` payload as cards.
 * They are now one screen at `/app/team`, which also carries the performance
 * figures that only the counselor detail page used to show.
 *
 * Kept as a redirect rather than deleted so existing links and bookmarks
 * survive.
 */
export default function UsersRedirect(): never {
  redirect('/app/team');
}
