import { isRole, type CapabilityKey, type Role } from '@/lib/types';

/**
 * Role-derived UI capabilities.
 *
 * SECURITY: everything here is presentation-only. The backend is the sole
 * authority on what a user may do; these helpers exist so we do not render
 * controls that are guaranteed to 403.
 */

export const ROLES = {
  DEV_ADMIN: 'DEV_ADMIN',
  COMPANY_ADMIN: 'COMPANY_ADMIN',
  HEAD_MANAGER: 'HEAD_MANAGER',
  BRANCH_MANAGER: 'BRANCH_MANAGER',
  EMPLOYEE: 'EMPLOYEE',
} as const satisfies Record<Role, Role>;

export const ALL_ROLES: readonly Role[] = [
  ROLES.DEV_ADMIN,
  ROLES.COMPANY_ADMIN,
  ROLES.HEAD_MANAGER,
  ROLES.BRANCH_MANAGER,
  ROLES.EMPLOYEE,
];

export const ROLE_LABELS: Record<Role, string> = {
  DEV_ADMIN: 'Platform Admin',
  COMPANY_ADMIN: 'Company Admin',
  HEAD_MANAGER: 'Head Manager',
  BRANCH_MANAGER: 'Branch Manager',
  EMPLOYEE: 'Employee',
};

/** Shorter label for tables and badges where space is tight. */
export const ROLE_SHORT_LABELS: Record<Role, string> = {
  DEV_ADMIN: 'Platform',
  COMPANY_ADMIN: 'Admin',
  HEAD_MANAGER: 'Head Mgr',
  BRANCH_MANAGER: 'Branch Mgr',
  EMPLOYEE: 'Employee',
};

/** Seniority, highest first. Decides which roles a user may hand out. */
const ROLE_RANK: Record<Role, number> = {
  DEV_ADMIN: 5,
  COMPANY_ADMIN: 4,
  HEAD_MANAGER: 3,
  BRANCH_MANAGER: 2,
  EMPLOYEE: 1,
};

/** True when `value` is one of `allowed`. Unknown/absent roles are never allowed. */
export function hasRole(value: unknown, allowed: readonly Role[]): boolean {
  return isRole(value) && allowed.includes(value);
}

export function roleLabel(value: unknown): string {
  return isRole(value) ? ROLE_LABELS[value] : 'Unknown';
}

export function roleShortLabel(value: unknown): string {
  return isRole(value) ? ROLE_SHORT_LABELS[value] : 'Unknown';
}

/** Roles `actor` may assign to an account they create. */
export function assignableRoles(actor: unknown): Role[] {
  if (!isRole(actor)) return [];
  switch (actor) {
    case ROLES.DEV_ADMIN:
      return [ROLES.COMPANY_ADMIN, ROLES.HEAD_MANAGER, ROLES.BRANCH_MANAGER, ROLES.EMPLOYEE];
    case ROLES.COMPANY_ADMIN:
      return [ROLES.HEAD_MANAGER, ROLES.BRANCH_MANAGER, ROLES.EMPLOYEE];
    case ROLES.HEAD_MANAGER:
      return [ROLES.BRANCH_MANAGER, ROLES.EMPLOYEE];
    case ROLES.BRANCH_MANAGER:
      return [ROLES.EMPLOYEE];
    default:
      return [];
  }
}

/** True when `actor` outranks `target` — gates edit/delete on a row. */
export function outranks(actor: unknown, target: unknown): boolean {
  return isRole(actor) && isRole(target) && ROLE_RANK[actor] > ROLE_RANK[target];
}

/**
 * Capability map. Each entry lists the roles the backend accepts for that
 * action; the UI hides the control for everyone else.
 */
export const CAN = {
  manageCompanies: [ROLES.DEV_ADMIN],
  manageBranches: [ROLES.DEV_ADMIN, ROLES.COMPANY_ADMIN],
  manageUsers: [ROLES.DEV_ADMIN, ROLES.COMPANY_ADMIN],
  viewAnalytics: [ROLES.DEV_ADMIN, ROLES.COMPANY_ADMIN, ROLES.HEAD_MANAGER, ROLES.BRANCH_MANAGER],
  viewEarnings: [ROLES.DEV_ADMIN, ROLES.COMPANY_ADMIN],
  manageCommissions: [ROLES.DEV_ADMIN, ROLES.COMPANY_ADMIN],
  manageSettings: [ROLES.DEV_ADMIN, ROLES.COMPANY_ADMIN],
  reviewApprovals: [ROLES.DEV_ADMIN, ROLES.COMPANY_ADMIN, ROLES.HEAD_MANAGER],
  manageCounselors: [ROLES.DEV_ADMIN, ROLES.COMPANY_ADMIN, ROLES.HEAD_MANAGER],
  manageRefunds: [ROLES.DEV_ADMIN, ROLES.COMPANY_ADMIN, ROLES.HEAD_MANAGER, ROLES.BRANCH_MANAGER],
  deleteRecords: [ROLES.DEV_ADMIN, ROLES.COMPANY_ADMIN, ROLES.HEAD_MANAGER, ROLES.BRANCH_MANAGER],
} as const satisfies Record<string, readonly Role[]>;

export type Capability = keyof typeof CAN;

/**
 * Compile-time proof that this map and the server's `Capability` enum name the
 * same twelve things.
 *
 * Both sides are strings, so nothing else would catch a rename: the server
 * would enforce `manage_users` while every `can('manageUsers')` on this side
 * quietly returned the default forever. These two lines fail the build instead.
 * `CapabilityKey` is the wire vocabulary (lib/types.ts), mirrored from
 * `core.models.Capability`.
 */
const _serverKnowsEveryCapability: Record<Capability, CapabilityKey> = {
  manageCompanies: 'manageCompanies',
  manageBranches: 'manageBranches',
  manageUsers: 'manageUsers',
  viewAnalytics: 'viewAnalytics',
  viewEarnings: 'viewEarnings',
  manageCommissions: 'manageCommissions',
  manageSettings: 'manageSettings',
  reviewApprovals: 'reviewApprovals',
  manageCounselors: 'manageCounselors',
  manageRefunds: 'manageRefunds',
  deleteRecords: 'deleteRecords',
};
const _weKnowEveryServerCapability: Record<CapabilityKey, Capability> =
  _serverKnowsEveryCapability;
void _weKnowEveryServerCapability;

/**
 * `can('manageBranches', user.role)` — the built-in DEFAULT for a role.
 *
 * This is the compiled-in fallback, not the live answer: a company can grant
 * and revoke capabilities per role from /app/permissions, and those overrides
 * live on the server. Components that render a control should prefer
 * `useCurrentRole().can`, which consults the server and falls back to this.
 */
export function can(capability: Capability, role: unknown): boolean {
  return hasRole(role, CAN[capability]);
}

export type { Role };
