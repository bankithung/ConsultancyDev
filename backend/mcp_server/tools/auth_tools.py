"""
Identity, live capabilities, the role x capability matrix, and "why can't I".

Two of these answer from different sources and the difference matters.
`my_capabilities` asks the API what the caller's role holds RIGHT NOW, after
the company's overrides are applied. `explain_permission` answers from the
committed catalog and so describes the SHIPPED DEFAULT — no API call at all
when a role is named. An agent debugging a refusal wants both: the default
explains the design, the live list explains the refusal.

The catalog's per-resource `read_roles`/`write_roles` are viewset-level
approximations. For `users` and `signup_requests` the real rules differ per
action, and that is recorded in those resources' `notes` — which is why
`explain_permission` always returns the resource's notes alongside the role
lists rather than the lists alone.
"""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations

from ..catalog import Catalog
from ..server import ServerState, client_for, run_api

ACTIONS = ('read', 'write', 'create', 'update', 'delete')
CHANGE_KEYS = frozenset({'role', 'capability', 'allowed'})

READ_SCOPE_NOTE = ('Holding the capability is not the whole answer: a read returns only records inside your '
                   'visibility scope, and one outside it is not listed and fetches as 404.')
WRITE_SCOPE_NOTE = ('Within a tenant, a write also requires the record to be in your scope: own branch(es) for '
                    'a manager, own records or records transferred in and accepted for an employee.')
APPROVAL_NOTE = ('A role without deleteRecords does not get a hard refusal on every path — the API raises an '
                 'approval request instead. Use create_approval_request with action="DELETE".')


def check_changes(catalog: Catalog, changes: list[dict[str, Any]]) -> None:
    """
    Reject a malformed cell before the API sees it, naming the values that work.

    Worth doing here rather than leaving to the serializer for two reasons. A
    bad role or capability comes back as a per-index ChoiceField error that
    never lists the choices, so a caller that guessed `castSpells` learns only
    that it was wrong. And an unrecognised KEY is not an error at all — DRF
    drops it — so `{"role", "capability", "value"}` would report success while
    changing nothing.
    """
    roles = list(catalog.roles['rank'])
    capabilities = list(catalog.roles['defaults'])
    for index, change in enumerate(changes):
        where = f'changes[{index}]'
        unknown = sorted(set(change) - CHANGE_KEYS)
        if unknown:
            raise ToolError(f'{where}: unknown key(s) {", ".join(unknown)}. A change is exactly '
                            f'{{role, capability, allowed}}.')
        missing = sorted(CHANGE_KEYS - set(change))
        if missing:
            raise ToolError(f'{where} is missing {", ".join(missing)}.')
        if change['role'] not in roles:
            raise ToolError(f'{where}: unknown role {change["role"]!r}. Roles: {", ".join(roles)}.')
        if change['capability'] not in capabilities:
            raise ToolError(f'{where}: unknown capability {change["capability"]!r}. '
                            f'Capabilities: {", ".join(capabilities)}.')
        allowed = change['allowed']
        if allowed is not None and not isinstance(allowed, bool):
            raise ToolError(f'{where}: allowed must be true, false, or null (null restores the built-in '
                            f'default); got {allowed!r}.')


def register_auth_tools(mcp: FastMCP, state: ServerState) -> None:
    catalog = state.catalog
    read_only = state.settings.read_only

    def add(fn, name: str, title: str, *, writes: bool = False, destructive: bool = False) -> None:
        """`idempotentHint` and `destructiveHint` are left unset on a read, where the spec gives them no meaning."""
        mcp.add_tool(fn, name=name, description=(fn.__doc__ or '').strip(), structured_output=True,
                     annotations=ToolAnnotations(title=title, readOnlyHint=not writes,
                                                 destructiveHint=destructive if writes else None,
                                                 idempotentHint=True if writes else None))

    def whoami(ctx: Context) -> dict[str, Any]:
        """Who this server is acting as: the user record, their role, company and branch, the capabilities the role holds after company overrides, what that role can see, and how the session authenticated. Call this first — every other tool is scoped by this identity."""
        client = client_for(ctx, state)
        me = run_api(lambda: client.get('users/me/'))
        caps = run_api(lambda: client.get('role-permissions/mine/'))
        return {
            'user': me,
            'role': me['role'],
            'company': me.get('company_name'),
            'branch': me.get('branch_name'),
            'capabilities': caps['capabilities'],
            'visibility': catalog.roles['visibility'].get(me['role'], ''),
            'auth': client.credentials.describe(),
            'read_only_mode': read_only,
        }

    def my_capabilities(ctx: Context) -> dict[str, Any]:
        """The caller's role and the capabilities it holds right now, with the company's overrides already applied: {role, capabilities[]}. This is the live answer; explain_permission gives the shipped default and the reasoning behind it."""
        client = client_for(ctx, state)
        return run_api(lambda: client.get('role-permissions/mine/'))

    def explain_permission(ctx: Context, action: str, resource: str, role: str | None = None) -> dict[str, Any]:
        """Explain whether `role` (default: the caller's) may `action` (read, write, create, update or delete) a `resource` (a catalog name such as enquiries or commissions): which capability governs it, the role floor below which it cannot be delegated, and why that floor exists. Answered from the committed catalog, so it describes the SHIPPED DEFAULT — a company override can widen or narrow it, and my_capabilities is the live answer. Reads the API only to discover the caller's role when `role` is omitted."""
        action = (action or '').lower()
        if action not in ACTIONS:
            raise ToolError(f'action must be one of {", ".join(ACTIONS)}; got {action!r}.')
        try:
            r = catalog.resource(resource)
        except KeyError as exc:
            # KeyError stringifies to the repr of its argument, which would
            # wrap the whole sentence in quotes; the message itself is arg 0.
            raise ToolError(exc.args[0]) from None

        if role is None:
            client = client_for(ctx, state)
            role = run_api(lambda: client.get('users/me/'))['role']
        role = str(role).upper()
        if role not in catalog.roles['rank']:
            raise ToolError(f'Unknown role {role}. Roles: {", ".join(catalog.roles["rank"])}.')

        if action == 'read':
            capability, roles = r['read_capability'], r['read_roles']
        elif action == 'delete' and r['delete_requires_capability']:
            capability = r['delete_requires_capability']
            roles = catalog.roles['defaults'].get(capability, [])
        else:
            capability, roles = r['write_capability'], r['write_roles']

        protected = catalog.roles['protected'].get(capability or '', {})
        notes = list(r['notes'])
        notes.append(READ_SCOPE_NOTE if action == 'read' else WRITE_SCOPE_NOTE)
        if action == 'delete' and capability == 'deleteRecords':
            notes.append(APPROVAL_NOTE)

        return {
            'resource': r['name'],
            'action': action,
            'role': role,
            # A platform admin holds everything by construction, and the
            # per-resource role lists are tenant lists that do not always name
            # them explicitly.
            'allowed_by_default': role == 'DEV_ADMIN' or role in roles,
            'capability': capability,
            'floor': protected.get('floor'),
            'reason': protected.get('reason', ''),
            'read_roles': r['read_roles'],
            'write_roles': r['write_roles'],
            'notes': notes,
        }

    def get_role_permissions(ctx: Context, company: int | None = None) -> dict[str, Any]:
        """The whole role x capability grid for your company (a DEV_ADMIN has no company and must name one with `company`; without it they get the built-in defaults, read-only). Needs manageSettings, which is company admin and above by default. Each cell is {allowed, source: default|override|platform, editable, can_grant, can_revoke, reason}."""
        client = client_for(ctx, state)
        params = {'company': company} if company else None
        return run_api(lambda: client.get('role-permissions/', params=params))

    def update_role_permissions(ctx: Context, changes: list[dict[str, Any]],
                                company: int | None = None) -> dict[str, Any]:
        """Apply a batch of {role, capability, allowed} cell changes and return the new grid. `allowed` may be true, false, or null to delete the override and fall back to the built-in default. The WHOLE batch is refused if any single cell is refused: the DEV_ADMIN row is not configurable, a protected capability cannot be granted below its floor, you cannot grant what your own role does not hold, and manageSettings/manageUsers cannot be taken from COMPANY_ADMIN. Needs manageSettings; a DEV_ADMIN must pass `company`."""
        if not isinstance(changes, list) or not changes:
            raise ToolError('changes must be a non-empty list of {role, capability, allowed} objects, where '
                            'allowed is true, false, or null to restore the default.')
        check_changes(catalog, changes)
        body: dict[str, Any] = {'changes': changes}
        if company:
            body['company'] = company
        client = client_for(ctx, state)
        return run_api(lambda: client.put('role-permissions/', json=body))

    def reset_role_permissions(ctx: Context, company: int | None = None, confirm: bool = False) -> dict[str, Any]:
        """Drop EVERY permission override for the company and return it to the built-in defaults, then return the restored grid. This cannot be undone from here — the overrides are deleted, not archived — so it requires confirm=true. Needs manageSettings; a DEV_ADMIN must pass `company`."""
        if not confirm:
            raise ToolError('Refusing to reset the permissions matrix without confirm=true. This deletes every '
                            'override the company has configured; ask the user before retrying.')
        client = client_for(ctx, state)
        params = {'company': company} if company else None
        return run_api(lambda: client.request('DELETE', 'role-permissions/', params=params).json())

    add(whoami, 'whoami', 'Who am I')
    add(my_capabilities, 'my_capabilities', 'My capabilities')
    add(explain_permission, 'explain_permission', 'Explain permission')
    add(get_role_permissions, 'get_role_permissions', 'Role permissions')
    if not read_only:
        add(update_role_permissions, 'update_role_permissions', 'Update role permissions',
            writes=True, destructive=False)
        # Destructive rather than merely a write: it deletes every override the
        # company configured, and nothing here can put them back.
        add(reset_role_permissions, 'reset_role_permissions', 'Reset role permissions',
            writes=True, destructive=True)
