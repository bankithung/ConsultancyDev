import { redirect } from 'next/navigation';

/** See the note in app/app/enquiries/page.tsx — one screen, three tabs. */
export default function EnrollmentsPage() {
  redirect('/app/admissions?tab=enrollments');
}
