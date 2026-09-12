"""
Role capabilities: the defaults, the delegation rules, and the resolver.

WHAT THIS FILE IS FOR
---------------------
Authorization used to be a set of hardcoded role tuples on the permission
classes in core/permissions.py. That is correct but not configurable, and the
product needs an admin screen where a company decides which capabilities each
of its ROLES holds — not which capabilities a named employee holds. Granting to
a role rather than a person is the whole design: it keeps "who can approve a
refund?" answerable by looking at five rows instead of every user.

So the tuples moved here, as DEFAULTS, and `resolve()` layers a company's
`RolePermission` overrides on top of them.

THE THREE RULES
---------------
1. FALLBACK. A capability with no override row uses the default for that role.
   An empty table reproduces the previous hardcoded behaviour exactly. See the
   RolePermission docstring for why neither "empty means deny" nor "empty means
   allow" is acceptable.

2. FLOORS. Some capabilities cannot be held below a floor role, and the floor is
   applied HERE, at resolution, not only at write time. `manageUsers` is the
   sharp example: a company admin who could grant it to EMPLOYEE would be
   handing every employee the ability to mint a COMPANY_ADMIN account and take
   the tenant over. Enforcing the floor on the read path means a row written
   around the API — Django admin, a shell, a bad data migration — still cannot
   escalate anyone.

3. DEV_ADMIN IS NOT CONFIGURABLE. The platform operator holds everything and no
   tenant row can change that, or a customer could lock their vendor out.

CACHING
-------
`resolve()` is on the hot path: every permission class calls it, so it runs on
essentially every request. The resolved matrix is cached per company under a key
that INCLUDES THE COMPANY ID. That is a security property, not a performance
detail — a shared key would serve company A the matrix company B configured.

Invalidation is explicit on every write (see `invalidate`), which is exact under
Redis. Under the LocMemCache fallback the cache is PER PROCESS, so a change made
on one gunicorn worker is not seen by the others until the entry expires; the
TTL below bounds that window. Set REDIS_CACHE_URL in production, exactly as the
throttle counters in config/settings.py require.
"""

from django.core.cache import cache

from .models import Capability, Role, RolePermission

# --------------------------------------------------------------------- ranks

# Seniority, highest first. Mirrors ROLE_RANK in rbac/roles.ts.
ROLE_RANK = {
    Role.DEV_ADMIN: 5,
    Role.COMPANY_ADMIN: 4,
    Role.HEAD_MANAGER: 3,
    Role.BRANCH_MANAGER: 2,
    Role.EMPLOYEE: 1,
}

ALL_ROLES = tuple(ROLE_RANK)
# Roles a tenant may configure. DEV_ADMIN is deliberately absent.
CONFIGURABLE_ROLES = tuple(r for r in ALL_ROLES if r != Role.DEV_ADMIN)


# ------------------------------------------------------------------ defaults

_ADMINS = (Role.DEV_ADMIN, Role.COMPANY_ADMIN)
_MANAGERS_UP = _ADMINS + (Role.HEAD_MANAGER, Role.BRANCH_MANAGER)

#: The built-in matrix: which roles hold each capability when nothing is
#: overridden.
#:
#: These values record WHAT THE SERVER ALREADY DID before this table existed —
#: not what rbac/roles.ts advertises. Where the two differ the comment says so,
#: because silently tightening a rule in the name of tidiness is a regression
#: dressed as a fix. An admin who wants the stricter rule can now set it here.
DEFAULTS = {
    # companies/ — IsDevAdmin. Cross-tenant by definition.
    Capability.MANAGE_COMPANIES: (Role.DEV_ADMIN,),
    # branches/ writes — ReadOnlyOrCompanyAdmin.
    Capability.MANAGE_BRANCHES: _ADMINS,
    # users/ create, destroy, set-active — CanManageUsers.
    Capability.MANAGE_USERS: _ADMINS,
    # analytics/{funnel,revenue,branches,sources} — IsManagerOrAbove.
    Capability.VIEW_ANALYTICS: _MANAGERS_UP,
    # commissions/ READS — CanViewFinancials. WIDER than CAN.viewEarnings in
    # rbac/roles.ts, which lists admins only: a head manager runs a branch P&L
    # and the server has always let them read company results.
    Capability.VIEW_EARNINGS: _ADMINS + (Role.HEAD_MANAGER,),
    # commissions/ WRITES and the whole of agents/ — CanManageCommissions.
    Capability.MANAGE_COMMISSIONS: _ADMINS,
    # This screen, and everything else under /app/settings.
    Capability.MANAGE_SETTINGS: _ADMINS,
    # approval-requests/{approve,reject} — _require_reviewer. WIDER than
    # CAN.reviewApprovals, which omits BRANCH_MANAGER: a branch manager has
    # always been able to review requests raised in their own branch, and
    # `approve()` re-checks the reviewer's write scope on the target anyway.
    Capability.REVIEW_APPROVALS: _MANAGERS_UP,
    # users/counselors/ — never gated beyond "authenticated and active". The
    # default records that fact rather than quietly tightening it; the results
    # are scoped by get_queryset, so an employee sees only their own row. An
    # admin who wants it restricted can now do that from the permissions screen.
    Capability.MANAGE_COUNSELORS: ALL_ROLES,
    # refunds/ writes — ReadOnlyOrManager. Reads stay open to the tenant.
    Capability.MANAGE_REFUNDS: _MANAGERS_UP,
    # ScopedModelViewSet.perform_destroy — everyone except EMPLOYEE, who raises
    # an approval request instead.
    Capability.DELETE_RECORDS: _MANAGERS_UP,
}


# ------------------------------------------------------------------- floors

#: Capabilities that may never be held below a given role, with the reason
#: shown to the admin on the greyed-out cell.
#:
#: The test is not "is this powerful?" — most capabilities are. It is "can
#: holding this be used to acquire MORE authority than it names, or to switch
#: off a control that exists to make someone else accountable?". Anything that
#: can rewrite the role/branch graph, reach across tenants, or remove an audit
#: step is floored. Everything else is left delegable, because a permissions
#: screen where most of the grid is locked is a permissions screen the customer
#: cannot use.
PROTECTED = {
    Capability.MANAGE_COMPANIES: (
        Role.DEV_ADMIN,
        'Creating and deleting companies is a platform-operator action and '
        'crosses tenant boundaries. It cannot be delegated inside a company.',
    ),
    Capability.MANAGE_USERS: (
        Role.COMPANY_ADMIN,
        'Managing staff accounts includes choosing their role, so anyone who '
        'holds it can create a company admin and take over the account. It '
        'cannot be granted below company admin. Managers can still add '
        'employees to their own branches without it.',
    ),
    Capability.MANAGE_SETTINGS: (
        Role.COMPANY_ADMIN,
        'This capability governs this screen. Granting it to a lower role '
        'would let that role grant itself everything else on the grid.',
    ),
    Capability.MANAGE_BRANCHES: (
        Role.COMPANY_ADMIN,
        'Branch membership is what decides which records a manager can see. '
        'Anyone who can create or re-point branches can widen their own scope '
        'across the company.',
    ),
    Capability.VIEW_EARNINGS: (
        Role.HEAD_MANAGER,
        'Earnings cover every branch, not just the reader’s own. This is a '
        'confidentiality floor rather than an escalation one, but company-wide '
        'revenue is not a branch-level figure.',
    ),
    Capability.MANAGE_COMMISSIONS: (
        Role.HEAD_MANAGER,
        'Writing a commission row is a promise to pay money to an agent. '
        'Below head manager there is nobody accountable for the payout, and '
        'the same person could create the agent and the commission.',
    ),
    Capability.REVIEW_APPROVALS: (
        Role.BRANCH_MANAGER,
        'The approval queue exists to put a second person between an employee '
        'and a deletion. Granting review to employees would let the requester '
        'approve their own request, which removes the control entirely.',
    ),
    Capability.DELETE_RECORDS: (
        Role.BRANCH_MANAGER,
        'Employees raise an approval request instead of deleting. Granting '
        'this to employees does not widen access — it switches the approval '
        'workflow off, and with it the audit trail of who authorised a '
        'deletion.',
    ),
}

#: Capabilities a COMPANY_ADMIN may not have taken away. Without these nobody
#: inside the tenant could administer it, and the only way back would be a
#: database edit by the vendor.
ADMIN_ESSENTIALS = (Capability.MANAGE_SETTINGS, Capability.MANAGE_USERS)


def floor_for(capability):
    """The lowest role that may hold `capability`, or None when unrestricted."""
    entry = PROTECTED.get(capability)
    return entry[0] if entry else None


def protection_reason(capability):
    entry = PROTECTED.get(capability)
    return entry[1] if entry else ''


def is_delegable_to(capability, role):
    """Whether `capability` may be held by `role` at all."""
    floor = floor_for(capability)
    if floor is None:
        return True
    return ROLE_RANK.get(role, 0) >= ROLE_RANK[floor]


# ---------------------------------------------------------------- resolution

CACHE_TTL = 300
_CACHE_PREFIX = 'core:rolecaps:v1'


def cache_key(company_id):
    """
    Per-company cache key.

    The company id is part of the key on purpose. One shared key would let
    whichever tenant warmed the cache first decide every other tenant's
    permissions — a cross-tenant authorization bug, not a caching nicety.
    """
    return f'{_CACHE_PREFIX}:{company_id or "none"}'


def _base_matrix():
    """The defaults, already clamped to the floors, as {role: {capability: bool}}."""
    matrix = {}
    for role in ALL_ROLES:
        row = {}
        for capability in Capability.values:
            cap = Capability(capability)
            allowed = role in DEFAULTS[cap]
            row[capability] = allowed and is_delegable_to(cap, role)
        matrix[role] = row
    return matrix


def resolve(company_id):
    """
    The effective {role: {capability: bool}} matrix for one company.

    Overrides are layered over the defaults and then clamped: a stored row can
    never grant a capability below its floor, and rows for DEV_ADMIN are
    ignored outright. Clamping on this path (rather than only in the serializer)
    is what makes a row written outside the API harmless.
    """
    key = cache_key(company_id)
    cached = cache.get(key)
    if cached is not None:
        return cached

    matrix = _base_matrix()
    if company_id:
        rows = RolePermission.objects.filter(company_id=company_id).values_list(
            'role', 'capability', 'allowed',
        )
        for role, capability, allowed in rows:
            if role == Role.DEV_ADMIN or role not in matrix:
                continue
            if capability not in matrix[role]:
                # A capability that has since been removed from the enum. Ignore
                # rather than crash; the row is inert and the admin screen will
                # not offer it.
                continue
            if allowed and not is_delegable_to(Capability(capability), role):
                continue
            matrix[role][capability] = allowed

    # DEV_ADMIN always holds everything, whatever the table says.
    matrix[Role.DEV_ADMIN] = {c: True for c in Capability.values}

    cache.set(key, matrix, CACHE_TTL)
    return matrix


def invalidate(company_id):
    """Drop one company's cached matrix. Call after every write."""
    cache.delete(cache_key(company_id))


def role_has(user, capability):
    """
    Whether `user`'s role currently holds `capability`.

    The single question every permission class asks. Deliberately keyed on the
    user's role and company as they are IN THE DATABASE — never on JWT claims,
    which go stale the moment an admin changes something.
    """
    if user is None or not user.is_authenticated:
        return False
    if getattr(user, 'is_dev_admin', False):
        return True
    matrix = resolve(user.company_id)
    return matrix.get(user.role, {}).get(getattr(capability, 'value', capability), False)


def capabilities_for(user):
    """Every capability `user` currently holds, as a sorted list of values."""
    if user is None or not user.is_authenticated:
        return []
    if getattr(user, 'is_dev_admin', False):
        return sorted(Capability.values)
    row = resolve(user.company_id).get(user.role, {})
    return sorted(c for c, allowed in row.items() if allowed)
