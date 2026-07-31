import axios, {
  AxiosError,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from 'axios';
import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
  setTokens,
} from './tokens';
import type { ApiErrorBody } from './types';
import { AUTH_REASON_PARAM, AuthReason, type AuthReasonValue } from './authReason';

/**
 * API base URL.
 *
 * Must be supplied per-environment via NEXT_PUBLIC_API_URL (e.g.
 * `https://api.example.com/api/`); the localhost value is a dev-only fallback.
 * A trailing slash is enforced because every call site uses relative paths
 * like `auth/login/`.
 */
const RAW_API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:8000/api/';

export const API_URL = RAW_API_URL.endsWith('/') ? RAW_API_URL : `${RAW_API_URL}/`;

/**
 * Note: no default `Content-Type` is declared here on purpose.
 *
 * Axios already sets `application/json` for plain-object payloads. Pinning the
 * header on the instance instead makes axios JSON-stringify FormData bodies
 * (see its `transformRequest`), which silently drops file uploads; leaving it
 * unset lets the browser emit `multipart/form-data` with the required boundary.
 */
export const api = axios.create({
  baseURL: API_URL,
  headers: {
    Accept: 'application/json',
  },
  /**
   * Array params go out as repeated keys -- `?status=New&status=Contacted` --
   * which is what Django's `request.GET.getlist()` reads.
   *
   * Axios would otherwise emit `status[]=New`, a name no filter is registered
   * under. DRF ignores parameters it does not recognise, so the request would
   * succeed and return the UNFILTERED list: a multi-select that looks like it
   * works and quietly does nothing.
   */
  paramsSerializer: { indexes: null },
});

/** Shape of POST /api/auth/refresh/ -- rotation is on, so `refresh` is new. */
interface RefreshResponse {
  access: string;
  refresh: string;
}

type RetriableRequest = InternalAxiosRequestConfig & { _retry?: boolean };

// Track if we're currently refreshing to avoid multiple refresh calls.
// With rotation enabled this is no longer just an optimisation: two concurrent
// refreshes would each spend the same refresh token, and the loser's token is
// already blacklisted by the time it lands.
let isRefreshing = false;
let failedQueue: Array<{
  resolve: () => void;
  reject: (reason: unknown) => void;
}> = [];

const processQueue = (error: unknown = null) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve();
    }
  });
  failedQueue = [];
};

/**
 * Sends the user to /login, preserving where they were headed and why they were
 * sent there.
 *
 * The `reason` matters now that the backend revokes outstanding refresh tokens
 * whenever an account is changed or deactivated: a user can be signed out
 * mid-action through no fault of their own, and a bare bounce to a sign-in form
 * is indistinguishable from the app breaking.
 */
const redirectToLogin = (reason: AuthReasonValue = AuthReason.SESSION_EXPIRED) => {
  clearTokens();
  if (typeof window === 'undefined') return;

  const from = window.location.pathname + window.location.search;
  const target = new URL('/login', window.location.origin);
  if (from && !from.startsWith('/login')) {
    target.searchParams.set('from', from);
  }
  target.searchParams.set(AUTH_REASON_PARAM, reason);
  window.location.href = target.pathname + target.search;
};

// Add a request interceptor to attach the token
api.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = getAccessToken();
    if (token && config.headers) {
      config.headers['Authorization'] = `Bearer ${token}`;
    }
    return config;
  },
  (error: AxiosError) => Promise.reject(error)
);

// Add a response interceptor to handle token refresh
api.interceptors.response.use(
  (response: AxiosResponse) => response,
  async (error: AxiosError<ApiErrorBody>) => {
    const originalRequest = error.config as RetriableRequest | undefined;

    // If error is 401 and we haven't tried to refresh yet
    if (error.response?.status === 401 && originalRequest && !originalRequest._retry) {
      // Never try to refresh a failed refresh/login -- that is a dead end.
      const url = originalRequest.url ?? '';
      if (url.includes('auth/refresh/') || url.includes('auth/login/')) {
        // A 401 from refresh means the token was rejected outright -- normally
        // because the backend blacklisted it (account changed or deactivated,
        // or signed out elsewhere), not because it quietly aged out.
        redirectToLogin(AuthReason.SESSION_ENDED);
        return Promise.reject(error);
      }

      if (isRefreshing) {
        // If already refreshing, queue this request
        return new Promise<void>((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then(() => api(originalRequest));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      const refreshToken = getRefreshToken();

      if (!refreshToken) {
        // No refresh token at all: an ordinary lapsed session.
        isRefreshing = false;
        processQueue(error);
        redirectToLogin(AuthReason.SESSION_EXPIRED);
        return Promise.reject(error);
      }

      try {
        // Attempt to refresh the token. Uses a bare axios call so this request
        // does not re-enter these interceptors.
        const response = await axios.post<RefreshResponse>(
          `${API_URL}auth/refresh/`,
          { refresh: refreshToken },
          { headers: { 'Content-Type': 'application/json' } }
        );

        const { access, refresh } = response.data;

        // Rotation is ON: the response carries a NEW refresh token and the one
        // we just sent is now blacklisted. Storing both is mandatory -- keeping
        // the old refresh token would log the user out on the next refresh.
        setTokens({ access, refresh });

        // Update the authorization header
        if (originalRequest.headers) {
          originalRequest.headers['Authorization'] = `Bearer ${access}`;
        }

        processQueue(null);

        // Retry the original request
        return api(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError);

        // The refresh itself failed. The common cause is server-side
        // revocation, so report it as a session that was ended rather than one
        // that expired.
        redirectToLogin(AuthReason.SESSION_ENDED);
        return Promise.reject(refreshError);
      } finally {
        // Cleared here rather than in each branch.
        //
        // Stated precisely, because an overstated comment invites the wrong
        // fix later: the previous version cleared the flag in BOTH the try and
        // the catch, and setTokens() is called inside the try — so a
        // localStorage failure (disabled or over quota, real in private-mode
        // browsers) was caught by that same catch, which cleared the flag and
        // drained the queue. No hang was reachable.
        //
        // `finally` is still correct: it makes the invariant "this flag is
        // always cleared on the way out" structural rather than something two
        // separate branches have to remember, and it survives someone later
        // adding an early return or moving setTokens().
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

/**
 * Extracts a displayable message from an API error.
 *
 * The backend returns `{error: "..."}` or
 * `{error: "Validation failed", fields: {...}}`.
 */
export function getApiErrorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (!axios.isAxiosError<ApiErrorBody>(error)) {
    return error instanceof Error ? error.message : fallback;
  }

  const body = error.response?.data;
  if (!body) {
    return error.message || fallback;
  }

  if (body.fields) {
    const firstField = Object.entries(body.fields)[0];
    if (firstField) {
      const [name, detail] = firstField;
      const text = Array.isArray(detail) ? detail[0] : detail;
      return `${name}: ${text}`;
    }
  }

  return body.error || fallback;
}

/** Field-level validation errors, keyed by field name, or null if none. */
export function getApiFieldErrors(error: unknown): Record<string, string> | null {
  if (!axios.isAxiosError<ApiErrorBody>(error)) return null;

  const fields = error.response?.data?.fields;
  if (!fields) return null;

  return Object.fromEntries(
    Object.entries(fields).map(([name, detail]) => [
      name,
      Array.isArray(detail) ? detail[0] : detail,
    ])
  );
}
