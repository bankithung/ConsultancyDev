'use client';

import { useQuery } from '@tanstack/react-query';

import { apiClient } from '@/lib/apiClient';
import { useAuth } from '@/hooks/useAuth';
import { can as canByDefault, type Capability } from './roles';

/**
 * The capabilities the signed-in user's ROLE actually holds, per the server.
 *
 * `CAN` in ./roles.ts is a compiled-in copy of the built-in defaults. It cannot
 * know that an admin has granted head managers the commissions screen, so
 * without this the server would honour a permission the UI still hid — and the
 * permissions page would be a screen that changes nothing visible, which is the
 * failure mode worth avoiding most.
 *
 * FALLBACK BEHAVIOUR IS DELIBERATE. While the request is in flight, or if it
 * fails, `has()` falls back to the static defaults. That is the safe direction:
 * the defaults are what the server enforces when nothing is configured, so the
 * worst case is a control that appears a moment late, never one that appears
 * and then 403s. Denying everything until the fetch resolved would flash an
 * empty screen at every admin on every navigation.
 *
 * This is still presentation only. The server decides.
 */
export function useCapabilities(): {
  /** True when the role holds `capability`, per the server where known. */
  has: (capability: Capability) => boolean;
  /** False while the server's answer is still the compiled-in default. */
  isResolved: boolean;
} {
  const { role, isAuthenticated } = useAuth();

  const query = useQuery({
    queryKey: ['role-permissions', 'mine', role],
    queryFn: () => apiClient.rolePermissions.mine(),
    enabled: isAuthenticated && role !== null,
    // The matrix changes only when an admin edits it, and the server caches it
    // for five minutes anyway. Refetching more often would add a request per
    // navigation for data that is nearly static.
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const granted = query.data?.capabilities;

  return {
    has: (capability: Capability) =>
      granted ? granted.includes(capability) : canByDefault(capability, role),
    isResolved: granted !== undefined,
  };
}
