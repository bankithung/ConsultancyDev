import { redirect } from 'next/navigation';

/**
 * Document activity is the Tracking view under /app/documents now, so this
 * route forwards rather than maintaining a second timeline. The old address
 * stays valid for anyone who bookmarked it.
 *
 * Worth knowing what went with it: this page assembled its timeline from
 * THREE sources — uploads, physical custody and record transfers — where the
 * tab merges two, omitting `student-documents` received/returned events. That
 * gap now belongs to the tab.
 */
export default function DocumentTrackingPage() {
  redirect('/app/documents?tab=tracking');
}
