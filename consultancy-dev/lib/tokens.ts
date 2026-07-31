/**
 * Single source of truth for JWT storage on the client.
 *
 * Both the axios refresh interceptor (`lib/api.ts`) and the auth store
 * (`store/authStore.ts`) write tokens, and BOTH must keep the `auth-token`
 * cookie in sync -- `middleware.ts` verifies that cookie on every navigation.
 * If a refresh updated only localStorage the middleware would keep reading the
 * stale, now-expired token and bounce the user to /login mid-session.
 */

export const ACCESS_TOKEN_KEY = 'auth-token';
export const REFRESH_TOKEN_KEY = 'refresh-token';

/** Cookie the Edge middleware reads. Same name as the localStorage key. */
export const AUTH_COOKIE_NAME = 'auth-token';

/**
 * Fallback cookie lifetime, in seconds. Mirrors Django's
 * SIMPLE_JWT.ACCESS_TOKEN_LIFETIME (15 minutes). Only used when the token's
 * own `exp` claim cannot be read.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export interface TokenPair {
  access: string;
  refresh: string;
}

/** Claims we rely on client-side. The signature is verified in middleware. */
interface AccessTokenClaims {
  exp?: number;
  role?: string;
  user_id?: number;
}

function base64UrlDecode(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  return atob(padded);
}

/**
 * Reads the payload of a JWT WITHOUT verifying it.
 *
 * Safe for the one thing it is used for here: choosing a cookie expiry. Never
 * use this to make an access-control decision -- an attacker controls the
 * contents of an unverified token. Role enforcement happens in `middleware.ts`
 * against a verified signature, and again on the backend.
 */
export function decodeAccessToken(token: string): AccessTokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    const payload: unknown = JSON.parse(base64UrlDecode(parts[1]));
    if (typeof payload !== 'object' || payload === null) return null;
    return payload as AccessTokenClaims;
  } catch {
    return null;
  }
}

/** Seconds until the access token expires, floored at 0. */
function secondsUntilExpiry(token: string): number {
  const claims = decodeAccessToken(token);
  if (!claims?.exp) return ACCESS_TOKEN_TTL_SECONDS;

  const remaining = claims.exp - Math.floor(Date.now() / 1000);
  return remaining > 0 ? remaining : 0;
}

export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(REFRESH_TOKEN_KEY);
}

/**
 * Writes the access token to the cookie the middleware reads.
 *
 * The cookie is deliberately NOT HttpOnly: `middleware.ts` runs on the Edge
 * runtime and needs to read and verify this value on every navigation, which it
 * can only do for a cookie the client is allowed to set.
 *
 * On the actual XSS exposure, stated accurately:
 *
 * Keeping the refresh token out of a cookie does NOT bound the blast radius of
 * an XSS. It is in localStorage (see REFRESH_TOKEN_KEY below), which a script
 * on this origin reads just as easily as document.cookie. What that choice does
 * buy is protection against CSRF and against network-level cookie leakage --
 * different threats.
 *
 * The real exposure is the full refresh-token lifetime, not 15 minutes. Token
 * rotation does not shorten it either: whoever refreshes first keeps the
 * session, so an attacker refreshing on a timer retains access indefinitely
 * while the legitimate user is the one signed out. Rotation buys DETECTION (the
 * victim notices a mysterious logout), not containment.
 *
 * What actually reduces this: the CSP in next.config.ts, which makes injecting
 * a script hard in the first place; and server-side revocation -- the backend
 * blacklists a user's outstanding tokens whenever their role, branch, company
 * or active status changes.
 */
function writeAuthCookie(access: string): void {
  const maxAge = secondsUntilExpiry(access);
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${AUTH_COOKIE_NAME}=${access}; path=/; max-age=${maxAge}; SameSite=Lax${secure}`;
}

function clearAuthCookie(): void {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${AUTH_COOKIE_NAME}=; path=/; max-age=0; SameSite=Lax${secure}`;
}

/**
 * Persists a fresh token pair. Refresh-token rotation is enabled server-side,
 * so the refresh token returned by /api/auth/refresh/ is a NEW one and the
 * previous value is blacklisted -- always store what came back.
 */
export function setTokens(tokens: TokenPair): void {
  if (typeof window === 'undefined') return;

  window.localStorage.setItem(ACCESS_TOKEN_KEY, tokens.access);
  window.localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refresh);
  writeAuthCookie(tokens.access);
}

/** Updates the access token alone, keeping the stored refresh token. */
export function setAccessToken(access: string): void {
  if (typeof window === 'undefined') return;

  window.localStorage.setItem(ACCESS_TOKEN_KEY, access);
  writeAuthCookie(access);
}

export function clearTokens(): void {
  if (typeof window === 'undefined') return;

  window.localStorage.removeItem(ACCESS_TOKEN_KEY);
  window.localStorage.removeItem(REFRESH_TOKEN_KEY);
  clearAuthCookie();
}

/** True when a stored access token exists and has not yet expired. */
export function hasValidAccessToken(): boolean {
  const token = getAccessToken();
  return token !== null && secondsUntilExpiry(token) > 0;
}
