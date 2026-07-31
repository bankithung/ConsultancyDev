import { redirect } from 'next/navigation';

/**
 * Appointments now live beside follow-ups on the engagements screen, so this
 * route forwards rather than duplicating it. The old address stays valid for
 * anyone who bookmarked it and for the "Back to appointments" link on the
 * detail page.
 *
 * Only the index moves: `/app/appointments/[id]` is a separate route and is
 * untouched.
 */
export default function AppointmentsPage() {
  redirect('/app/engagements?tab=appointments');
}
