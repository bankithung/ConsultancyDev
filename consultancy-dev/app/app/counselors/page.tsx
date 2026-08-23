import { redirect } from 'next/navigation';

/** Merged into `/app/team`. See the note in `app/app/users/page.tsx`. */
export default function CounselorsRedirect(): never {
  redirect('/app/team');
}
