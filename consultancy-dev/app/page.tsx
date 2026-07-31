import { redirect } from 'next/navigation';

/**
 * The root URL goes straight to sign-in.
 *
 * This is an internal tool, not a public product site — every visitor is a
 * member of staff, so a marketing landing page at `/` was a step between them
 * and the thing they came for. The previous landing page and the About /
 * Contact / Help / Privacy / Terms routes are archived under
 * `_removed_marketing/` if any of them is ever wanted again.
 *
 * `/login` stays the canonical sign-in route rather than moving the form here:
 * `proxy.ts` redirects unauthenticated `/app/*` traffic to `/login?from=…`, and
 * involuntary sign-outs arrive as `/login?reason=…`. Keeping that one address
 * means neither has to change, and a bookmarked `/login` still works.
 */
export default function RootPage() {
  redirect('/login');
}
