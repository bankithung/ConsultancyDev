import { redirect } from 'next/navigation';

/**
 * Enquiries, registrations and enrollments are one screen with three tabs now,
 * so this route forwards rather than duplicating it. The old address stays
 * valid for anyone who bookmarked it and for links elsewhere in the app.
 *
 * Only the index moves: `/app/enquiries/new` and `/app/enquiries/[id]` are
 * separate routes and are untouched.
 */
export default function EnquiriesPage() {
  redirect('/app/admissions?tab=enquiries');
}
