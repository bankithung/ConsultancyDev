import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Role, User } from '@/lib/types';
import { api, getApiErrorMessage } from '@/lib/api';
import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
  setTokens,
} from '@/lib/tokens';

/** POST /api/auth/login/ response. */
interface LoginResponse {
  access: string;
  refresh: string;
  user: User;
}

export interface SignupPayload {
  username: string;
  email: string;
  password: string;
  first_name: string;
  last_name: string;
  role: Role;
  phone?: string;
  /** COMPANY_ADMIN signups only -- these create a signup request for review. */
  company_name?: string;
  admin_name?: string;
  plan?: string;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  signup: (userData: SignupPayload) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  clearError: () => void;
  hasRole: (role: Role | Role[]) => boolean;
  isDevAdmin: () => boolean;
  isCompanyAdmin: () => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,

      login: async (username, password) => {
        set({ isLoading: true, error: null });
        try {
          const response = await api.post<LoginResponse>('auth/login/', {
            username,
            password,
          });
          const { access, refresh, user } = response.data;

          // Writes both tokens to localStorage and mirrors the access token
          // into the `auth-token` cookie that middleware.ts verifies. The
          // cookie's max-age is derived from the token's own `exp`, so the
          // route guard and the token expire together (~15 min) instead of the
          // cookie outliving the token by a day.
          setTokens({ access, refresh });

          // The login response already carries the user, so no follow-up
          // request to /api/users/me/ is needed here.
          set({
            user,
            isAuthenticated: true,
            isLoading: false,
            error: null,
          });
        } catch (error) {
          const errorMessage = getApiErrorMessage(
            error,
            'Login failed. Please check your credentials.'
          );
          set({ error: errorMessage, isLoading: false });
          throw error;
        }
      },

      signup: async (userData) => {
        set({ isLoading: true, error: null });
        try {
          // If company admin signup, create a signup request
          if (userData.role === 'COMPANY_ADMIN') {
            await api.post('signup-requests/', {
              username: userData.username,
              email: userData.email,
              password: userData.password,
              first_name: userData.first_name,
              last_name: userData.last_name,
              company_name: userData.company_name,
              admin_name: userData.admin_name,
              phone: userData.phone,
              plan: userData.plan || 'Starter',
            });
          } else {
            // Regular employee signup (requires company admin)
            await api.post('users/', userData);
          }
          set({ isLoading: false, error: null });
        } catch (error) {
          const errorMessage = getApiErrorMessage(
            error,
            'Signup failed. Please try again.'
          );
          set({ error: errorMessage, isLoading: false });
          throw error;
        }
      },

      logout: async () => {
        const refresh = getRefreshToken();

        // Revoke server-side first: /api/auth/logout/ blacklists the refresh
        // token (205). Without this call the token stays valid until it
        // expires, so "logging out" never actually ended the session.
        if (refresh) {
          try {
            await api.post('auth/logout/', { refresh });
          } catch {
            // A failed revocation must not strand the user in a logged-in UI.
            // Worst case the refresh token lives out its natural lifetime; the
            // local session is cleared either way.
          }
        }

        clearTokens();
        set({ user: null, isAuthenticated: false, error: null });
      },

      checkAuth: async () => {
        const token = getAccessToken();
        if (!token) {
          // Clear any stale persisted user from a previous session.
          if (get().isAuthenticated) {
            set({ user: null, isAuthenticated: false });
          }
          return;
        }

        set({ isLoading: true });
        try {
          const userResponse = await api.get<User>('users/me/');
          set({
            user: userResponse.data,
            isAuthenticated: true,
            isLoading: false,
            error: null,
          });
        } catch {
          // The axios interceptor already attempted a refresh; reaching here
          // means the session is genuinely gone.
          clearTokens();
          set({
            user: null,
            isAuthenticated: false,
            isLoading: false,
          });
        }
      },

      clearError: () => {
        set({ error: null });
      },

      hasRole: (role: Role | Role[]) => {
        const user = get().user;
        if (!user) return false;
        if (Array.isArray(role)) {
          return role.includes(user.role);
        }
        return user.role === role;
      },

      isDevAdmin: () => get().user?.role === 'DEV_ADMIN',

      isCompanyAdmin: () => get().user?.role === 'COMPANY_ADMIN',
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);
