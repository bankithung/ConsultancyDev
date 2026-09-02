# Roles, capabilities and who sees what

## Roles (rank)

| Role | Rank | Sees |
|---|---|---|
| DEV_ADMIN | 5 | Everything across all companies. Has no company; records it creates land with company NULL and are invisible to tenants. |
| COMPANY_ADMIN | 4 | Everything in its own company. |
| HEAD_MANAGER | 3 | The union of the branches of the branch managers assigned to it (`managed_managers`), plus its own branch. |
| BRANCH_MANAGER | 2 | Its own branch. |
| EMPLOYEE | 1 | Records it **owns** (`owner` field) plus records transferred to it and accepted. Never `created_by`. |

A Django superuser counts as DEV_ADMIN regardless of role. A manager with no branch sees only
records it owns. A non-dev-admin with no company sees nothing at all, not everything.

## Write scope

- DEV_ADMIN: anything. COMPANY_ADMIN: anything in the company.
- HEAD_MANAGER and BRANCH_MANAGER: records whose branch is in their branch set, or that they own.
- EMPLOYEE: records they own, or transferred to them and accepted (for transferable entity types
  only — see `transfers`).

`users/`: an employee sees only their own row; a branch manager their branch plus self; a head
manager their branches plus self.

## Capabilities (defaults, before company overrides)

| Capability | Default roles | Floor (cannot go below) |
|---|---|---|
| manageCompanies | DEV_ADMIN | DEV_ADMIN |
| manageBranches | admins | COMPANY_ADMIN |
| manageUsers | admins | COMPANY_ADMIN |
| viewAnalytics | managers and up | none |
| viewEarnings | admins + HEAD_MANAGER | HEAD_MANAGER |
| manageCommissions | admins | HEAD_MANAGER |
| manageSettings | admins | COMPANY_ADMIN |
| reviewApprovals | managers and up | BRANCH_MANAGER |
| manageCounselors | everyone | none |
| manageRefunds | managers and up | none |
| deleteRecords | managers and up | BRANCH_MANAGER |

"admins" = DEV_ADMIN, COMPANY_ADMIN. "managers and up" adds HEAD_MANAGER and BRANCH_MANAGER.

- A row in the company matrix decides; no row means the default. `allowed: null` in an update
  deletes the override and restores the default.
- manageSettings and manageUsers can never be revoked from COMPANY_ADMIN: nobody inside the
  tenant could then administer it, including undoing the change.
- A floor is enforced when the matrix is RESOLVED, not only when it is written, so a row
  inserted straight into the database still cannot escalate anyone.
- DEV_ADMIN always holds everything and is not configurable.
- The live answer for the caller is `my_capabilities` (`role-permissions/mine/`);
  `explain_permission` explains the shipped default, the floor, and why the floor exists.

## Reading `explain_permission`

`capability` names every gate the action passes. A delete clears the resource's write gate
before the delete gate, so for a commission it reads "manageCommissions + deleteRecords" and
`allowed_by_default` is the intersection of the two — reporting deleteRecords alone would say a
head manager can delete a commission, and the API answers 403.

The per-resource `read_roles` and `write_roles` in the catalog are viewset-level approximations.
For `users` and `signup-requests` the real rule differs per action, which is why the resource's
`notes` travel with the answer; read them rather than the role lists alone.

## Hiring rules

- Company admins create any role except DEV_ADMIN (only a dev admin can mint one) and set
  `branch` and `managed_managers`.
- Head and branch managers may create only EMPLOYEE accounts, and only in branches they run.
  Anything else is 403, decided inside the viewset rather than by the permission class.
- Users edit only their own profile unless they hold manageUsers. Password changes go through
  `change_password`.
- Changing a user's role, branch, company, password or active flag revokes all their tokens and
  API keys immediately; that user is signed out on their next refresh.

## Cross-tenant rules

- Another company's record answers 404, not 403, so existence is never revealed.
- `role-permissions/?company=` is honoured only for DEV_ADMIN; every other role is pinned to
  their own company whatever the query string says.
- Shared universities (company = null) are visible to all tenants and, by a known gap, writable
  by any manager of any tenant. See `gotchas`.
