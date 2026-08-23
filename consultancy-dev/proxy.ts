import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { importSPKI, jwtVerify, type CryptoKey, type JWTVerifyResult } from 'jose';
import type { Role } from '@/lib/types';
import { isRole } from '@/lib/types';
import { AUTH_REASON_PARAM, AuthReason, type AuthReasonValue } from '@/lib/authReason';

/**
 * Edge auth gate.
 *
 * This is the Next 16 `proxy` convention, which replaced `middleware.ts`. The
 * exported function MUST be named `proxy` -- Next discovers it by name, so a
 * file exporting `middleware` from here is silently inert: it typechecks, it
 * builds, and every gated route renders unguarded. If you rename this file or
 * its export, re-run the auth checks in DEPLOYMENT.md rather than trusting a
 * green build.
 *
 * Runs on the Edge runtime, so it must use Web Crypto -- hence `jose` rather
 * than `jsonwebtoken`.
 */

/**
 * Signature verification keys.
 *
 * PREFERRED -- `JWT_PUBLIC_KEY_B64`: the RSA public key (base64-encoded PEM, or
 * raw PEM) matching the backend's `JWT_PRIVATE_KEY_B64`. The backend signs
 * RS256 with the private key and only ever ships the public half here, so
 * compromising the frontend does NOT let an attacker mint tokens. This is
 * required on the backend whenever DEBUG is off, so it is the production path.
 *
 * FALLBACK -- `JWT_VERIFY_SECRET`: must equal Django's `SECRET_KEY`. Only valid
 * when the backend has no keypair configured, which it permits solely in DEBUG
 * (it then signs HS256 with SECRET_KEY). Never use this in production: a shared
 * symmetric secret means the frontend can forge tokens too.
 *
 * Both are server-only -- deliberately NOT prefixed with NEXT_PUBLIC_.
 */
const JWT_PUBLIC_KEY_B64 = process.env.JWT_PUBLIC_KEY_B64;
const JWT_VERIFY_SECRET = process.env.JWT_VERIFY_SECRET;

/** Accepts either raw PEM or the base64-encoded PEM the backend's .env stores. */
function decodePem(value: string): string {
    const trimmed = value.trim();
    if (trimmed.startsWith('-----BEGIN')) return trimmed;
    return atob(trimmed);
}

/**
 * Imported public key, cached at module scope.
 *
 * `importSPKI` is async and comparatively expensive; the Edge runtime reuses
 * this module across requests, so the import happens once per isolate rather
 * than once per navigation. Failures are cached as null so a malformed key does
 * not retry on every request.
 */
let publicKeyPromise: Promise<CryptoKey | null> | null = null;

function getPublicKey(): Promise<CryptoKey | null> {
    if (!publicKeyPromise) {
        publicKeyPromise = (async () => {
            if (!JWT_PUBLIC_KEY_B64) return null;
            try {
                return await importSPKI(decodePem(JWT_PUBLIC_KEY_B64), 'RS256');
            } catch (error) {
                console.error('[proxy] JWT_PUBLIC_KEY_B64 is not a valid public key.', error);
                return null;
            }
        })();
    }
    return publicKeyPromise;
}

/**
 * Role requirements per route prefix.
 *
 * Order matters: the FIRST matching prefix wins, so more specific paths must be
 * listed before the prefixes that contain them.
 */
const routeAccess: ReadonlyArray<readonly [string, readonly Role[]]> = [
    ['/app/dev-tools', ['DEV_ADMIN']],
    ['/app/companies', ['DEV_ADMIN']],
    // Reading the roster is wider than editing it: `/app/team` replaced both
    // `/app/users` (admins) and `/app/counselors` (admins + head manager), so
    // the gate is the wider of the two. Every write on the screen is still
    // behind `manageUsers`, which is floored at company admin.
    ['/app/team', ['DEV_ADMIN', 'COMPANY_ADMIN', 'HEAD_MANAGER']],
    // The screen that decides what every other role can do. Gated here as well
    // as by RoleRoute so a direct URL entry never renders it, and by
    // `CanManageSettings` server-side, which is the only one that counts.
    ['/app/permissions', ['DEV_ADMIN', 'COMPANY_ADMIN']],
    ['/app/branches', ['DEV_ADMIN', 'COMPANY_ADMIN']],
    ['/app/earnings', ['DEV_ADMIN', 'COMPANY_ADMIN']],
    ['/app/commissions', ['DEV_ADMIN', 'COMPANY_ADMIN']],
    ['/app/settings', ['DEV_ADMIN', 'COMPANY_ADMIN']],
    ['/app/reports', ['DEV_ADMIN', 'COMPANY_ADMIN', 'HEAD_MANAGER', 'BRANCH_MANAGER']],
    ['/app/analytics', ['DEV_ADMIN', 'COMPANY_ADMIN', 'HEAD_MANAGER', 'BRANCH_MANAGER']],
];

// Public routes that don't require authentication
const publicRoutes = ['/', '/login', '/signup', '/privacy', '/terms', '/contact', '/help', '/about'];

/** Where an authenticated-but-unauthorised user lands. Must stay reachable to any role. */
const FORBIDDEN_PATH = '/app/forbidden';

interface VerifiedClaims {
    role: Role | null;
}

function isPublicRoute(pathname: string): boolean {
    return publicRoutes.some(
        (route) => pathname === route || pathname.startsWith(`${route}/`)
    );
}

/** Roles allowed on `pathname`, or null when the route is not role-gated. */
function requiredRolesFor(pathname: string): readonly Role[] | null {
    for (const [prefix, roles] of routeAccess) {
        if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
            return roles;
        }
    }
    return null;
}

/**
 * Verifies the token's signature and expiry and extracts the `role` claim.
 * Returns null when the token is malformed, expired or badly signed.
 *
 * The accepted algorithm is pinned to whichever key is in use, so a token
 * cannot select its own verification algorithm (`alg: none`, or HS256 signed
 * with the public key as the shared secret).
 */
async function verifyToken(token: string): Promise<VerifiedClaims | null> {
    try {
        const publicKey = await getPublicKey();

        let result: JWTVerifyResult;
        if (publicKey) {
            result = await jwtVerify(token, publicKey, { algorithms: ['RS256'] });
        } else if (JWT_VERIFY_SECRET) {
            const key = new TextEncoder().encode(JWT_VERIFY_SECRET);
            result = await jwtVerify(token, key, { algorithms: ['HS256'] });
        } else {
            return null;
        }

        // jwtVerify checks the signature AND the exp/nbf claims.
        const role = isRole(result.payload.role) ? result.payload.role : null;

        if (role === null) {
            // The signature is good but we cannot tell who this is. SimpleJWT's
            // default token carries only token_type/exp/iat/jti/user_id -- the
            // backend must add `role` in TokenObtainPairSerializer.get_token().
            // Until it does, every role-gated route denies every user, which is
            // the safe direction but very much a misconfiguration, so say so
            // loudly rather than letting it look like a permissions bug.
            console.error(
                '[proxy] Token verified but carries no usable `role` claim ' +
                `(got ${JSON.stringify(result.payload.role)}). Role-gated routes will be ` +
                'denied for everyone. The backend must add `role` to the JWT.'
            );
        }

        return { role };
    } catch {
        return null;
    }
}

/** True when we hold a key capable of verifying a signature. */
async function canVerify(): Promise<boolean> {
    return (await getPublicKey()) !== null || Boolean(JWT_VERIFY_SECRET);
}

function redirectToLogin(
    request: NextRequest,
    pathname: string,
    reason: AuthReasonValue
): NextResponse {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('from', pathname);
    loginUrl.searchParams.set(AUTH_REASON_PARAM, reason);
    return NextResponse.redirect(loginUrl);
}

export async function proxy(request: NextRequest) {
    const { pathname } = request.nextUrl;

    // Allow public routes
    if (isPublicRoute(pathname)) {
        return NextResponse.next();
    }

    // Everything below /app is protected; anything else is not ours to gate.
    if (!pathname.startsWith('/app')) {
        return NextResponse.next();
    }

    const token = request.cookies.get('auth-token')?.value;

    // If no token and trying to access protected route, redirect to login
    if (!token) {
        return redirectToLogin(request, pathname, AuthReason.SESSION_EXPIRED);
    }

    const requiredRoles = requiredRolesFor(pathname);

    if (!(await canVerify())) {
        // Misconfiguration. We cannot tell a real token from a forged one, so
        // fail CLOSED on role-gated routes rather than waving them through.
        // Non-gated /app routes still fall back to the presence check, and the
        // backend rejects a bad token on the first API call regardless.
        console.error(
            '[proxy] No JWT verification key configured. Role-gated routes are being ' +
            'denied. Set JWT_PUBLIC_KEY_B64 to the backend\'s JWT_PUBLIC_KEY_B64 ' +
            '(or, for a DEBUG backend signing HS256, JWT_VERIFY_SECRET to its SECRET_KEY).'
        );
        if (requiredRoles) {
            return NextResponse.redirect(new URL(FORBIDDEN_PATH, request.url));
        }
        return NextResponse.next();
    }

    const claims = await verifyToken(token);

    // Invalid or expired signature is treated exactly like no session at all.
    if (!claims) {
        const response = redirectToLogin(request, pathname, AuthReason.SESSION_INVALID);
        response.cookies.delete('auth-token');
        return response;
    }

    // The forbidden page itself must never be role-gated, or an unauthorised
    // user would bounce between it and the redirect forever.
    if (pathname === FORBIDDEN_PATH) {
        return NextResponse.next();
    }

    if (requiredRoles && (claims.role === null || !requiredRoles.includes(claims.role))) {
        return NextResponse.redirect(new URL(FORBIDDEN_PATH, request.url));
    }

    return NextResponse.next();
}

export const config = {
    matcher: [
        /*
         * Match all request paths except for the ones starting with:
         * - api (API routes)
         * - _next/static (static files)
         * - _next/image (image optimization files)
         * - favicon.ico (favicon file)
         */
        '/((?!api|_next/static|_next/image|favicon.ico).*)',
    ],
};
