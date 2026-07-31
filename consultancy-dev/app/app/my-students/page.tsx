import { redirect } from 'next/navigation';

/**
 * "My students" and "All students" are now one screen with two tabs, so this
 * route forwards rather than duplicating it. The old address stays valid for
 * anyone who bookmarked it, and for links elsewhere in the app.
 */
export default function MyStudentsPage() {
  redirect('/app/students?view=mine');
}
