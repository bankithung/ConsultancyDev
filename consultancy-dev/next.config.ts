import type { NextConfig } from 'next';

/**
 * Security headers.
 *
 * WHY THIS EXISTS -- stated honestly, because the reason changes what you do
 * when it gets in the way:
 *
 * This is defence in depth, NOT a patch over a live hole. A sweep of every
 * .ts/.tsx found no `eval`, no `new Function`, no `innerHTML`/`outerHTML`, and
 * no `document.write`. The single `dangerouslySetInnerHTML`
 * (components/receipts/RegistrationReceipt.tsx:201) is a static `@media print`
 * stylesheet with no interpolation -- not attacker-reachable.
 *
 * So the CSP is here to contain a FUTURE injection: a compromised npm
 * dependency, or a sink someone adds next quarter without thinking about it.
 * That framing matters. If a header ever breaks a legitimate feature, the fix
 * is to widen that one directive deliberately -- not to delete the block
 * because "there was no vulnerability anyway".
 *
 * It also does real work today for the auth design: the access token lives in a
 * non-HttpOnly cookie and the refresh token in localStorage (see lib/tokens.ts),
 * both readable by any script on this origin. Making script injection hard is
 * the main control protecting them.
 */

/** Origin of the API, so `connect-src` can allow it without allowing everything. */
function apiOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_API_URL;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    // A malformed NEXT_PUBLIC_API_URL should not take the build down; the
    // localhost defaults below keep dev working and production will fail
    // visibly on the first blocked request rather than silently.
    return null;
  }
}

const isDev = process.env.NODE_ENV === 'development';

function contentSecurityPolicy(): string {
  const api = apiOrigin();

  const connect = [
    "'self'",
    api,
    // Dev server: HMR websocket and the error overlay.
    ...(isDev
      ? ['ws:', 'wss:', 'http://localhost:*', 'http://127.0.0.1:*']
      : []),
  ].filter(Boolean) as string[];

  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],

    // 'unsafe-inline' is required because Next inlines its bootstrap and
    // streaming-payload scripts. Removing it means adopting per-request nonces,
    // which must be generated in middleware and threaded through the CSP header
    // -- that forces dynamic rendering on every route, so it is a deliberate
    // trade, not a free win. 'unsafe-eval' is dev-only (the error overlay).
    ['script-src', ["'self'", "'unsafe-inline'", ...(isDev ? ["'unsafe-eval'"] : [])]],

    // Tailwind injects styles at runtime and the print stylesheet above is a
    // <style> tag, so inline styles are unavoidable without nonces.
    ['style-src', ["'self'", "'unsafe-inline'"]],

    // data: for inline SVG/base64, blob: for object URLs created by the
    // document download helper. https: because user avatars are arbitrary
    // remote URLs; images are a low-risk sink.
    ['img-src', ["'self'", 'data:', 'blob:', 'https:']],

    ['font-src', ["'self'", 'data:']],
    ['connect-src', connect],

    // blob: covers the document-download flow in lib/apiClient.ts.
    ['media-src', ["'self'", 'blob:']],

    ['object-src', ["'none'"]],
    ['frame-src', ["'none'"]],
    // Belt and braces with X-Frame-Options below: this is the modern directive,
    // that header is the one older browsers honour.
    ['frame-ancestors', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ...(isDev ? [] : [['upgrade-insecure-requests', []] as [string, string[]]]),
  ];

  return directives
    .map(([name, values]) => (values.length ? `${name} ${values.join(' ')}` : name))
    .join('; ');
}

const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy() },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Drop ambient access to hardware APIs this app never uses.
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  },
  // HSTS only in production: sending it from a dev server would pin localhost
  // to https in the browser and break local http development for two years.
  ...(isDev
    ? []
    : [
        {
          key: 'Strict-Transport-Security',
          value: 'max-age=63072000; includeSubDomains; preload',
        },
      ]),
];

const nextConfig: NextConfig = {
  // There is a second package-lock.json one directory up, so Next infers the
  // workspace root ambiguously and warns. Pin it to this app: an inferred root
  // outside the project changes how modules resolve.
  turbopack: { root: __dirname },

  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
