'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { hasRole } from './roles';
import type { Role } from '@/lib/types';

interface RoleGateProps {
  allow: readonly Role[];
  children: React.ReactNode;
  /** Rendered instead of `children` when the role does not match. */
  fallback?: React.ReactNode;
}

/**
 * Renders `children` only for the listed roles. Cosmetic only — it keeps
 * controls that would 403 off the screen. Use `RoleRoute` to gate a page.
 */
export function RoleGate({ allow, children, fallback = null }: RoleGateProps) {
  const { role } = useAuth();
  return hasRole(role, allow) ? <>{children}</> : <>{fallback}</>;
}

interface RoleRouteProps {
  allow: readonly Role[];
  children: React.ReactNode;
}

/**
 * Page-level guard. Sends unauthenticated visitors to /login and users whose
 * role is not permitted to /app/forbidden, matching the middleware so a direct
 * URL entry and a client navigation land in the same place.
 */
export function RoleRoute({ allow, children }: RoleRouteProps) {
  const router = useRouter();
  const { user, role, isAuthenticated, isLoading } = useAuth();

  const permitted = hasRole(role, allow);

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated || !user) {
      router.replace('/login');
      return;
    }
    if (!permitted) {
      router.replace('/app/forbidden');
    }
  }, [isLoading, isAuthenticated, user, permitted, router]);

  if (isLoading || !isAuthenticated || !user || !permitted) {
    return (
      <div className="flex items-center justify-center py-24" role="status" aria-label="Checking permissions">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-slate-200 border-b-teal-600" />
      </div>
    );
  }

  return <>{children}</>;
}
