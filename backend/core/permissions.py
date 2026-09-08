"""
Authorization: one place that answers "who may see and do what".

Previously this logic did not exist. 21 of 24 viewsets declared no permission
class at all (so DRF defaulted to AllowAny), and the few role checks that did
exist were ten inline `if user.role == '...'` comparisons scattered across
views.py in three mutually inconsistent styles. Adding a role to the system
meant finding all ten.

The visibility rules, stated once:

    DEV_ADMIN       everything, across all companies
    COMPANY_ADMIN   everything within their own company
    HEAD_MANAGER    records in every branch of their own company
    BRANCH_MANAGER  records in their own branch
    EMPLOYEE        records they own, plus records transferred to them

`scope_queryset` is the single implementation. Every viewset routes through it.
"""

from django.db.models import Q
from rest_framework import permissions

from .capabilities import role_has
from .models import Capability, Role, RolePermission

SAFE_METHODS = permissions.SAFE_METHODS


# ---------------------------------------------------------------- primitives

def branch_ids_for(user):
    """Branch ids a manager-level user may reach."""
    if user.is_head_manager:
        # Company leadership includes new branches and branches without a manager.
        # Always scope by company; legacy reporting links cannot cross tenants.
        from .models import Branch
        if not user.company_id:
            return set()
        return set(
            Branch.objects.filter(company_id=user.company_id)
            .values_list('id', flat=True)
        )
    if user.is_branch_manager or user.is_employee:
        return {user.branch_id} if user.branch_id else set()
    return set()


def transferred_entity_ids(user, entity_type):
    """Ids of records of `entity_type` transferred to and accepted by `user`."""
    from .models import RecordTransfer
    return RecordTransfer.objects.filter(
        to_user=user,
        entity_type=entity_type,
        status=RecordTransfer.Status.ACCEPTED,
    ).values_list('entity_id', flat=True)


def scope_queryset(queryset, user, entity_type=None):
    """
    Narrow `queryset` to what `user` is allowed to see.

    `entity_type` enables the transfer rule for employees; omit it for models
    that are not transferable.
    """
    if user is None or not user.is_authenticated:
        return queryset.none()

    if user.is_dev_admin:
        return queryset

    model = queryset.model
    has_company = any(f.name == 'company' for f in model._meta.get_fields() if hasattr(f, 'name'))

    # Everyone below dev-admin is confined to their own company first.
    if not user.company_id:
        # A non-dev-admin with no company can see nothing rather than everything.
        return queryset.none()
    if has_company:
        queryset = queryset.filter(company_id=user.company_id)

    if user.is_company_admin:
        return queryset

    if user.is_head_manager or user.is_branch_manager:
        branches = branch_ids_for(user)
        if not branches:
            # A manager with no branch assigned sees only their own records,
            # rather than the whole company.
            return queryset.filter(owner=user)
        return queryset.filter(branch_id__in=branches)

    # EMPLOYEE: records they currently own, plus anything transferred to them.
    #
    # Deliberately keyed on `owner`, not `created_by`. Transfer MOVES custody,
    # so the sender must lose sight of the record — matching "employees see
    # only their own entries unless it was transferred to them". `created_by`
    # is retained on the row as an immutable audit trail, not as a grant.
    condition = Q(owner=user)
    if entity_type:
        ids = list(transferred_entity_ids(user, entity_type))
        if ids:
            condition |= Q(id__in=ids)
    return queryset.filter(condition)


def can_write_object(user, obj, entity_type=None):
    """Whether `user` may modify this specific object."""
    if user.is_dev_admin:
        return True
    obj_company = getattr(obj, 'company_id', None)
    if obj_company and user.company_id != obj_company:
        return False
    if user.is_company_admin:
        return True
    if user.is_head_manager or user.is_branch_manager:
        branches = branch_ids_for(user)
        obj_branch = getattr(obj, 'branch_id', None)
        if branches and obj_branch in branches:
            return True
        return getattr(obj, 'owner_id', None) == user.id

    # Employee. Keyed on `owner` only, matching the read rule in
    # scope_queryset. Granting on `created_by` here would let a former owner
    # keep write access to records they had transferred away — currently
    # unreachable because get_object() consults the scoped queryset first, but
    # a bulk action or service call that skips it would expose the gap.
    if getattr(obj, 'owner_id', None) == user.id:
        return True
    if entity_type:
        return obj.id in set(transferred_entity_ids(user, entity_type))
    return False


# -------------------------------------------------------- permission classes

class IsAuthenticatedAndActive(permissions.BasePermission):
    """Authenticated, and not a deactivated employee."""

    message = 'Your account is not active.'

    def has_permission(self, request, view):
        user = request.user
        return bool(
            user and user.is_authenticated and user.is_active
            and getattr(user, 'is_active_employee', True)
        )


class ScopedObjectPermission(IsAuthenticatedAndActive):
    """
    Object-level enforcement.

    get_queryset() scoping already hides other tenants' rows, which makes
    retrieve/update/destroy return 404. This is the belt-and-braces layer for
    any code path that fetches an object without going through get_queryset.
    """

    def has_object_permission(self, request, view, obj):
        user = request.user
        if request.method in SAFE_METHODS:
            # Readability was already decided by the scoped queryset.
            return True
        return can_write_object(user, obj, getattr(view, 'entity_type', None))


class RoleRequired(IsAuthenticatedAndActive):
    """
    Base for role gates.

    Set `capability` to a `Capability` member and the answer comes from the
    company's resolved matrix (core/capabilities.py) — defaults plus whatever
    the admin has configured on the permissions screen. `allowed_roles` remains
    for the handful of gates that are not part of that configurable vocabulary;
    setting neither denies everyone below dev admin.

    Consulting the database here rather than a hardcoded tuple is the point of
    the whole feature: a permissions screen the server does not read is a
    promise the product does not keep. The read is cached per company, so this
    is a dict lookup on the common path.
    """

    allowed_roles: tuple = ()
    capability = None
    message = 'Your role does not permit this action.'

    def has_permission(self, request, view):
        if not super().has_permission(request, view):
            return False
        user = request.user
        if user.is_dev_admin:
            return True
        if self.capability is not None:
            return role_has(user, self.capability)
        return user.role in self.allowed_roles


class IsDevAdmin(RoleRequired):
    """
    Platform-operator actions.

    Wired to `manageCompanies`, whose floor is DEV_ADMIN — so no tenant row can
    ever hand this to anyone else, and the resolver clamps it even if one is
    written directly into the table.
    """

    capability = Capability.MANAGE_COMPANIES
    allowed_roles = (Role.DEV_ADMIN,)


class IsCompanyAdmin(RoleRequired):
    """
    Plain role check, deliberately NOT capability-backed.

    Currently unused: its consumer (`agents/`) moved to `CanManageAgents` so an
    admin can configure it from the permissions screen. Kept because a gate outside the capability
    vocabulary is a legitimate thing to want, and this is the honest way to
    write one — hardcoded, and visibly not on the grid.
    """

    allowed_roles = (Role.COMPANY_ADMIN,)


class IsManagerOrAbove(RoleRequired):
    """Analytics beyond the personal dashboard."""

    capability = Capability.VIEW_ANALYTICS
    allowed_roles = (Role.COMPANY_ADMIN, Role.HEAD_MANAGER, Role.BRANCH_MANAGER)


class CanManageUsers(RoleRequired):
    """
    Full staff administration: creating any role, deleting, deactivating.

    `manageUsers` is floored at COMPANY_ADMIN and cannot be delegated below it —
    it decides who holds which role, so anyone with it can mint an admin. The
    narrower "a manager may add employees to their own branch" right is
    `CanCreateStaff` below, which is a different and much smaller grant.
    """

    capability = Capability.MANAGE_USERS
    allowed_roles = (Role.COMPANY_ADMIN,)
    message = 'Only a company admin can manage staff accounts.'


class CanCreateStaff(IsAuthenticatedAndActive):
    """
    Who may POST /api/users/ at all.

    Admins (via `manageUsers`) may create any role they outrank. Head and
    branch managers may also reach this endpoint, but only to create EMPLOYEE
    accounts inside branches they actually run — `UserViewSet.perform_create`
    enforces both halves of that, and this class is only the outer door.

    Splitting the two is what keeps `manageUsers` non-delegable: the business
    wants managers to be able to hire, and the naive way to grant that is to
    give managers `manageUsers`, which would also let them create an admin.
    """

    message = 'Your role cannot create staff accounts.'

    def has_permission(self, request, view):
        if not super().has_permission(request, view):
            return False
        user = request.user
        return (
            user.is_dev_admin
            or role_has(user, Capability.MANAGE_USERS)
            or (user.role in (Role.HEAD_MANAGER, Role.BRANCH_MANAGER)
                and not RolePermission.objects.filter(company_id=user.company_id,
                    role=user.role, capability=Capability.MANAGE_USERS, allowed=False).exists())
        )


class CanViewFinancials(RoleRequired):
    """Earnings, commissions, and company-wide revenue."""

    capability = Capability.VIEW_EARNINGS
    allowed_roles = (Role.COMPANY_ADMIN, Role.HEAD_MANAGER)
    message = 'Your role does not permit viewing financial reports.'


class CanManageCommissions(CanViewFinancials):
    """
    Reading the commission ledger and WRITING to it are different rights.

    A head manager oversees company branches, so `viewEarnings` deliberately lets them
    read it. Creating or amending a row is a promise to pay money to an agent,
    which is `manageCommissions` — a separate capability with its own row on
    the permissions grid, so an admin can hand out one without the other.
    Gating the whole viewset on the read capability let a head manager POST a
    commission the product never intended them to create.
    """

    message = 'Your role does not permit creating or amending a commission.'

    def has_permission(self, request, view):
        if not super().has_permission(request, view):
            return False
        if request.method in SAFE_METHODS:
            return True
        return role_has(request.user, Capability.MANAGE_COMMISSIONS)


class CanManageAgents(RoleRequired):
    """
    The agent roster, read and write.

    The commissions screen is its only consumer, so it carries the same
    capability as the ledger it feeds — including for reads, which is one step
    tighter than `commissions/` itself and matches the previous rule.
    """

    capability = Capability.MANAGE_COMMISSIONS
    message = 'Your role does not permit managing agents.'


class CanViewCounselors(RoleRequired):
    """
    Per-counselor performance (`users/counselors/`).

    Its default grants every role, because that is what the endpoint has always
    done and the results are scoped by `get_queryset` — an employee sees only
    their own row. It is on the grid so an admin who wants performance figures
    kept to managers can say so, which was not previously expressible.
    """

    capability = Capability.MANAGE_COUNSELORS
    message = 'Your role does not permit viewing counselor performance.'


class CanReviewApprovals(RoleRequired):
    """Approving or rejecting an approval request."""

    capability = Capability.REVIEW_APPROVALS
    message = 'Your role cannot review approval requests.'


class CanManageSettings(RoleRequired):
    """
    Company configuration, including the role-permission grid itself.

    Floored at COMPANY_ADMIN: a role that can edit the grid can grant itself
    every other capability on it, so its floor has to be at least as high as
    anything it can reach.
    """

    capability = Capability.MANAGE_SETTINGS
    message = 'Only a company admin can change permission settings.'


class CanManageOwnCompany(IsAuthenticatedAndActive):
    """
    `companies/` serves two screens that want two different rights.

    /app/companies is the platform operator's tenant list — `manageCompanies`,
    floored at DEV_ADMIN, covering list, create and delete across every tenant.
    /app/settings is one customer's own profile card — `manageSettings`,
    floored at COMPANY_ADMIN, covering retrieve and update of their own row and
    nothing else.

    Gating the whole viewset with `IsDevAdmin` served only the first, so
    `GET /api/companies/` answered 403 for a company admin and the Settings
    page's company tab could never have loaded. This grants the second WITHOUT
    widening the first: create and destroy stay dev-admin-only whatever the
    tenant's permission grid says, and `CompanyViewSet.get_queryset` narrows a
    non-dev-admin to their own row, so another company's id 404s rather than
    403s — a 403 would confirm the row exists.

    `manageSettings` is floored at COMPANY_ADMIN and listed in
    `ADMIN_ESSENTIALS`, so this reads as: dev admins always, company admins
    always, everyone else never — not merely by default, but unconfigurable.
    """

    message = 'Your role does not permit viewing or changing company details.'

    def has_permission(self, request, view):
        if not super().has_permission(request, view):
            return False
        user = request.user
        if user.is_dev_admin:
            return True
        # Creating a tenant and deleting one are platform-operator actions and
        # cross tenant boundaries; `manageCompanies` cannot be delegated into a
        # company (capabilities.PROTECTED). Keyed on the action rather than the
        # method because POST/DELETE mean nothing else on this viewset.
        if getattr(view, 'action', None) in ('create', 'destroy'):
            # Per-request instance, so this is safe — same pattern as
            # SubscriptionActive below. The default message talks about viewing
            # and editing, which is not what was refused here.
            self.message = (
                'Creating and deleting companies is a platform-operator '
                'action and cannot be done from inside a company.'
            )
            return False
        return role_has(user, Capability.MANAGE_SETTINGS)

    def has_object_permission(self, request, view, obj):
        user = request.user
        if user.is_dev_admin:
            return True
        # Belt and braces behind the scoped queryset, for any path that fetches
        # a Company without going through it. Deliberately NOT
        # `ScopedObjectPermission`: the generic `can_write_object` keys on
        # `obj.company_id`, which a Company row does not have — it IS the
        # company — so it would fall through to "is a company admin" and wave
        # an admin through onto any tenant. Identity is the only correct test.
        return obj.pk == user.company_id


class ReadOnlyOrManager(IsAuthenticatedAndActive):
    """
    Anyone in the tenant may read; only managers and above may write.

    Not capability-backed: its remaining user is the university catalogue,
    which no entry in the capability vocabulary governs. Resources that ARE on
    the permissions grid use `ReadOnlyOrCapability` below.
    """

    def has_permission(self, request, view):
        if not super().has_permission(request, view):
            return False
        if request.method in SAFE_METHODS:
            return True
        user = request.user
        return user.is_dev_admin or user.role in (
            Role.COMPANY_ADMIN, Role.HEAD_MANAGER, Role.BRANCH_MANAGER,
        )


class ReadOnlyOrCapability(IsAuthenticatedAndActive):
    """
    Anyone in the tenant may read; writing needs `capability`.

    For resources whose read side is deliberately open — the branch list feeds
    every filter drawer, the refund history renders on the student profile for
    every role — while the write is a configurable right.
    """

    capability = None
    message = 'Your role does not permit changing this.'

    def has_permission(self, request, view):
        if not super().has_permission(request, view):
            return False
        if request.method in SAFE_METHODS:
            return True
        return role_has(request.user, self.capability)


class ReadOnlyOrCompanyAdmin(ReadOnlyOrCapability):
    """
    Branches: open to read, `manageBranches` to write.

    One step tighter than `ReadOnlyOrManager` — `perform_create` already
    refused a non-admin POST, but PATCH and DELETE were once left open to
    managers, who could rename the branch they work in or delete an empty one.
    """

    capability = Capability.MANAGE_BRANCHES
    message = 'Your role does not permit changing branches.'


class CanManageRefunds(ReadOnlyOrCapability):
    """
    Refunds: open to read, `manageRefunds` to write.

    Reads stay open to the tenant because the student profile renders a refund
    history card for every role, and `scope_queryset` already narrows an
    employee to refunds they own. Filing or approving one moves money.
    """

    capability = Capability.MANAGE_REFUNDS
    message = 'Your role does not permit filing or approving a refund.'


class SubscriptionActive(permissions.BasePermission):
    """
    No-op. Subscription gating was removed -- every tenant gets free, unlimited
    access for unlimited time, so billing state never blocks a write. Kept as a
    class because many viewsets list it in permission_classes.
    """

    message = 'Your subscription is inactive. Please renew to continue.'

    def has_permission(self, request, view):
        return True
