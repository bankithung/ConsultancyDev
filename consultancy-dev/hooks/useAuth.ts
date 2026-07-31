'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import type { Role, User } from '@/lib/types';

export interface UseAuthResult {
  user: User | null;
  role: Role | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  /** True when the user holds any of the given roles. */
  hasRole: (role: Role | Role[]) => boolean;
  isDevAdmin: boolean;
  isCompanyAdmin: boolean;
  /** True for any role that manages others (admins and managers). */
  isManager: boolean;
  login: (username: string, password: string) => Promise<void>;
  /** Revokes the refresh token server-side, clears state, then sends the user to /login. */
  logout: () => Promise<void>;
  clearError: () => void;
}

const MANAGER_ROLES: readonly Role[] = [
  'DEV_ADMIN',
  'COMPANY_ADMIN',
  'HEAD_MANAGER',
  'BRANCH_MANAGER',
];

/**
 * Auth facade for pages and components.
 *
 * Wraps the zustand store so components do not each re-implement role checks or
 * the post-logout redirect.
 */
export function useAuth(): UseAuthResult {
  const router = useRouter();

  const user = useAuthStore((state) => state.user);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isLoading = useAuthStore((state) => state.isLoading);
  const error = useAuthStore((state) => state.error);
  const hasRole = useAuthStore((state) => state.hasRole);
  const login = useAuthStore((state) => state.login);
  const storeLogout = useAuthStore((state) => state.logout);
  const clearError = useAuthStore((state) => state.clearError);

  const logout = useCallback(async () => {
    await storeLogout();
    router.push('/login');
  }, [storeLogout, router]);

  const role = user?.role ?? null;

  return {
    user,
    role,
    isAuthenticated,
    isLoading,
    error,
    hasRole,
    isDevAdmin: role === 'DEV_ADMIN',
    isCompanyAdmin: role === 'COMPANY_ADMIN',
    isManager: role !== null && MANAGER_ROLES.includes(role),
    login,
    logout,
    clearError,
  };
}
