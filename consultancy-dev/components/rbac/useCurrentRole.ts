'use client';

import { useAuth } from '@/hooks/useAuth';
import { useCapabilities } from './useCapabilities';
import { type Capability } from './roles';
import type { Role } from '@/lib/types';

export interface CurrentRole {
  role: Role | null;
  /** Capability check: `can('manageBranches')`. */
  can: (capability: Capability) => boolean;
  /** Membership check: `is('EMPLOYEE', 'BRANCH_MANAGER')`. */
  is: (...roles: Role[]) => boolean;
}

/**
 * Capability helpers bound to the signed-in user. Presentation only — never
 * treat this as an authorisation boundary.
 *
 * `can` now answers from the company's configured matrix rather than from the
 * compiled-in `CAN` map, falling back to that map until the server replies (see
 * useCapabilities). Every call site keeps working unchanged; the difference is
 * that a capability an admin has granted on /app/permissions now actually
 * shows the control it unlocks.
 */
export function useCurrentRole(): CurrentRole {
  const { role } = useAuth();
  const { has } = useCapabilities();

  return {
    role,
    can: has,
    is: (...roles: Role[]) => role !== null && roles.includes(role),
  };
}
