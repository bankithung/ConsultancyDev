import { redirect } from 'next/navigation';

/**
 * `/app/dev-tools` has no content of its own — it is a section prefix with
 * two children. Without this file the bare URL 404s for a DEV_ADMIN who types
 * it or trims the path in the address bar, which reads as a broken permission
 * rather than a missing index.
 *
 * The proxy already gates this prefix to DEV_ADMIN, so anyone reaching here is
 * authorised for the destination.
 */
export default function DevToolsIndex() {
  redirect('/app/dev-tools/signup-requests');
}
