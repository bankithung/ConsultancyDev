/**
 * Why the user was sent to /login.
 *
 * Passed as `?reason=` so the login page can say "your session ended" instead
 * of showing a bare sign-in form. Without it, a forced sign-out -- which now
 * happens whenever an admin changes someone's role, branch, company or active
 * status, because the backend blacklists their outstanding refresh tokens --
 * is indistinguishable from the app breaking.
 *
 * Shared by `proxy.ts` (edge) and `lib/api.ts` (client), so it must stay free
 * of any browser- or node-only imports.
 */

export const AUTH_REASON_PARAM = 'reason';

export const AuthReason = {
  /** Token expired or was never present. The ordinary "come back later" case. */
  SESSION_EXPIRED: 'session_expired',
  /**
   * The server rejected a refresh that should have worked. In practice this is
   * revocation: the account was changed or deactivated, or the user signed out
   * elsewhere. Distinct from SESSION_EXPIRED because the user did nothing and
   * may have lost in-flight work.
   */
  SESSION_ENDED: 'session_ended',
  /** Signature failed to verify -- a malformed or forged cookie. */
  SESSION_INVALID: 'session_invalid',
} as const;

export type AuthReasonValue = (typeof AuthReason)[keyof typeof AuthReason];

/** Copy for each reason. Rendered by the login page. */
export const AUTH_REASON_MESSAGES: Record<AuthReasonValue, string> = {
  [AuthReason.SESSION_EXPIRED]: 'Your session expired. Please sign in again.',
  [AuthReason.SESSION_ENDED]:
    'Your session ended because your account was changed. Please sign in again.',
  [AuthReason.SESSION_INVALID]: 'Your session was no longer valid. Please sign in again.',
};

/** Narrows an untrusted `?reason=` value; returns null for anything unknown. */
export function isAuthReason(value: unknown): value is AuthReasonValue {
  return (
    typeof value === 'string' &&
    Object.values(AuthReason).includes(value as AuthReasonValue)
  );
}

/**
 * Message for a `?reason=` query value, or null when absent/unrecognised.
 *
 * Always route the raw param through this rather than rendering it: the value
 * comes from the URL, so an attacker can put arbitrary text in it and would
 * otherwise get to choose what the login page tells the user.
 */
export function authReasonMessage(value: unknown): string | null {
  return isAuthReason(value) ? AUTH_REASON_MESSAGES[value] : null;
}
