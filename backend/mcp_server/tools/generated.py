"""
Tools generated from the catalog: list/get/create/update/delete per resource
plus one tool per custom @action. Every argument that reaches the API is
validated against the catalog first, so an AI client gets "unknown field X;
valid: ..." instead of a bare 400.

Which CRUD tools a resource earns comes from its `verbs`, never from
`methods`: `methods` collapses list and retrieve into one GET, so it cannot
express "api-keys/ lists but has no detail route", and it cannot express
"installments/ routes POST but the serializer makes it unusable". Both would
become tools that can only fail.

Every tool is built by a factory that closes over its resource or action.
FastMCP derives the input schema from the signature and rejects a parameter
whose name starts with an underscore, so per-tool state cannot ride along as a
default argument; it has to be captured in a closure.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Union

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations

from ..catalog import Catalog
from ..server import ServerState, client_for, run_api

logger = logging.getLogger('mcp_server.tools.generated')

# Every tool returns whatever the API answered: an object, a bare array of
# rows, or a scalar. Annotating that union rather than `Any` is what lets
# FastMCP emit STRUCTURED output — without an output schema the SDK splits a
# returned list into one text block per row, and a client that reassembles
# them cannot tell a list of three rows from three separate results.
Payload = Union[dict, list, str, int, float, bool, None]

# Accepted on any list endpoint, so they are never "unknown filters" even
# though no FilterSet declares them.
UNIVERSAL_PARAMS = {'page', 'page_size', 'search', 'ordering'}

MAX_PAGE_SIZE = 200

# Fallback only, for an action the catalog has not classified. A name is weak
# evidence: set_user_active reads as a harmless toggle and revokes every token
# and API key the target holds, which is why `destructive` is declared in the
# catalog's ACTION_OVERLAY and read first.
DESTRUCTIVE_WORDS = ('reject', 'revoke', 'reset', 'delete')


def validate_payload(catalog: Catalog, resource_name: str, data: Any, partial: bool) -> dict:
    """
    Drop read-only fields, reject unknown ones, require required ones on create.

    "Required" is presence, except for a write-only string, where a blank value
    counts as missing too — see _blank_write_only.

    Read-only fields are dropped rather than refused: an AI client that echoes
    a record back with an edit would otherwise be stuck, since every row it
    reads carries id/company/owner/created_at. What was dropped is returned
    under `_stripped` (present only when something was), which the caller
    removes before sending.
    """
    r = catalog.resource(resource_name)
    if not isinstance(data, dict):
        raise ToolError(f'`data` must be a JSON object of field values for {resource_name}, not '
                        f'{type(data).__name__}.')
    fields = {f['name']: f for f in r['fields']}
    unknown = sorted(k for k in data if k not in fields)
    if unknown:
        writable = ', '.join(f['name'] for f in r['fields'] if not f['read_only'])
        raise ToolError(f'Unknown field(s) for {resource_name}: {", ".join(unknown)}. '
                        f'Writable fields: {writable}.')
    cleaned = {k: v for k, v in data.items() if not fields[k]['read_only']}
    stripped = sorted(k for k in data if fields[k]['read_only'])
    if not partial:
        missing = sorted(n for n, f in fields.items() if f['required'] and n not in cleaned)
        blank = sorted(n for n, f in fields.items()
                       if f['required'] and n in cleaned and _blank_write_only(f, cleaned[n]))
        if missing or blank:
            hint = (f' A blank string is not a value: {", ".join(blank)} must carry real content.'
                    if blank else '')
            raise ToolError(f'Missing required field(s) for {resource_name}: '
                            f'{", ".join(sorted(missing + blank))}.{hint}')
    if stripped:
        cleaned['_stripped'] = stripped
    return cleaned


def _blank_write_only(field: dict, value: Any) -> bool:
    """
    Whether a required WRITE-ONLY string arrived empty, which counts as missing.

    Requiring `password` is what stops create_user making an account nobody
    can log into, and presence alone does not achieve that. The API declares
    the field allow_blank, skips its validators for a falsy value and falls
    back to set_unusable_password(), so {"password": ""} produces exactly the
    record the requirement exists to prevent: a 201, a consumed company seat
    and a dead account. A client told a string field is required, with no value
    to put there, sends "" readily.

    Narrow on two counts, both deliberate. Only write-only fields, because
    their value never comes back in the response, so a caller cannot see that
    it was ignored. And only strings, so an integer or a decimal is untouched.
    A blank on an ordinary required field stays the API's business: it answers
    400 with a message about that field, which beats anything guessed here.
    """
    return bool(field['write_only']) and isinstance(value, str) and not value.strip()


def validate_filters(catalog: Catalog, resource_name: str, filters: dict | None) -> dict:
    """Reject a filter the endpoint would silently ignore."""
    r = catalog.resource(resource_name)
    allowed = {f['param'] for f in r['filters']}
    filters = dict(filters or {})
    unknown = sorted(k for k in filters if k not in allowed and k not in UNIVERSAL_PARAMS)
    if unknown:
        raise ToolError(f'Unknown filter(s) for {resource_name}: {", ".join(unknown)}. '
                        f'Valid filters: {", ".join(sorted(allowed)) or "(none)"}; '
                        f'plus search, ordering, page, page_size.')
    return filters


def _payload(catalog: Catalog, resource_name: str, data: Any, partial: bool) -> dict:
    """validate_payload, with `_stripped` reported and removed."""
    cleaned = validate_payload(catalog, resource_name, data, partial)
    stripped = cleaned.pop('_stripped', None)
    if stripped:
        logger.info('%s: dropped read-only field(s) %s from the payload', resource_name, ', '.join(stripped))
    return cleaned


def _clamp_page_size(page_size: int) -> int:
    return max(1, min(int(page_size), MAX_PAGE_SIZE))


def _describe_fields(r: dict) -> str:
    parts = []
    for f in r['fields']:
        if f['read_only']:
            continue
        bit = f"{f['name']}:{f['type']}"
        if f['required']:
            bit += '*'
        if f['choices']:
            bit += '[' + '|'.join(str(c['value']) for c in f['choices']) + ']'
        elif f['related_model']:
            bit += f"(id of {f['related_model']})"
        parts.append(bit)
    return ', '.join(parts) or '(none)'


def _describe_filters(r: dict) -> str:
    parts = []
    for f in r['filters']:
        bit = f['param']
        if f['kind'] in ('multi', 'multi_id', 'json_any'):
            bit += '[]'
        if f.get('choices'):
            bit += '(' + '|'.join(f['choices']) + ')'
        parts.append(bit)
    return ', '.join(parts) or '(none)'


def _access(r: dict) -> str:
    read = r['read_capability'] or 'any active user'
    write = r['write_capability'] or 'scope only'
    return f"Read: {read}. Write: {write}. Roles that write by default: {', '.join(r['write_roles']) or '(none)'}."


def _notes(r: dict) -> str:
    return (' Notes: ' + ' '.join(r['notes'])) if r['notes'] else ''


def register_generated_tools(mcp: FastMCP, state: ServerState) -> None:
    for r in state.catalog.raw['resources']:
        _register_resource(mcp, state, r, state.settings.read_only)


def _register_resource(mcp: FastMCP, state: ServerState, r: dict, read_only: bool) -> None:
    name, singular, prefix = r['name'], r['singular'], r['prefix']
    verbs, notes = r['verbs'], _notes(r)

    if verbs.get('list'):
        envelope = ('Paginated envelope {count,pages,page,page_size,results}' if r['list_paginated']
                    else 'Returns a bare array')
        _add(mcp, _make_list(state, r), f'list_{name}',
             f"List {name} (GET /api/{prefix}/). {_access(r)} Filters: {_describe_filters(r)} "
             f"(multi-value filters take a list). Search fields: {', '.join(r['search_fields']) or '(none)'}. "
             f"Ordering: {', '.join(r['ordering_fields']) or '(none)'} (prefix - for descending). "
             f"{envelope}; all_pages=true returns every row (max 20 pages).{notes}",
             ToolAnnotations(title=f'List {name}', readOnlyHint=True))

    if verbs.get('retrieve'):
        _add(mcp, _make_get(state, r), f'get_{singular}',
             f"Fetch one {singular} by id (GET /api/{prefix}/{{id}}/). "
             f"404 means missing OR outside your scope.{notes}",
             ToolAnnotations(title=f'Get {singular}', readOnlyHint=True))

    if verbs.get('create') and not read_only:
        _add(mcp, _make_create(state, r), f'create_{singular}',
             f"Create a {singular} (POST /api/{prefix}/). {_access(r)} Fields (* required): {_describe_fields(r)}. "
             f"company/branch/owner/created_by are stamped from you.{notes}",
             ToolAnnotations(title=f'Create {singular}', readOnlyHint=False, destructiveHint=False))

    if (verbs.get('partial_update') or verbs.get('update')) and not read_only:
        _add(mcp, _make_update(state, r), f'update_{singular}',
             f"Partially update a {singular} (PATCH /api/{prefix}/{{id}}/). Only send fields that change. "
             f"Fields (* required on create): {_describe_fields(r)}.{notes}",
             ToolAnnotations(title=f'Update {singular}', readOnlyHint=False, destructiveHint=False,
                             idempotentHint=True))

    if verbs.get('destroy') and not read_only:
        cap = r['delete_requires_capability']
        _add(mcp, _make_delete(state, r), f'delete_{singular}',
             f"Delete a {singular} (DELETE /api/{prefix}/{{id}}/). Requires confirm=true. "
             + (f"Needs capability {cap}; roles without it must use create_approval_request instead." if cap else '')
             + notes,
             ToolAnnotations(title=f'Delete {singular}', readOnlyHint=False, destructiveHint=True))

    for action in r['actions']:
        if action['skip_generated']:
            continue
        _register_action(mcp, state, action, read_only)


def _add(mcp: FastMCP, fn, name: str, description: str, annotations: ToolAnnotations) -> None:
    fn.__name__ = name
    fn.__doc__ = description
    mcp.add_tool(fn, name=name, description=description, annotations=annotations, structured_output=True)


# --------------------------------------------------------------------- CRUD
#
# One factory per verb. The closure holds the resource, so the signature holds
# only what the caller supplies — FastMCP publishes the signature verbatim.


def _make_list(state: ServerState, r: dict):
    name, prefix = r['name'], r['prefix']

    def list_tool(ctx: Context, filters: dict[str, Any] | None = None, search: str | None = None,
                  ordering: str | None = None, page: int = 1, page_size: int = 25,
                  all_pages: bool = False) -> Payload:
        params = validate_filters(state.catalog, name, filters)
        if search:
            params['search'] = search
        if ordering:
            params['ordering'] = ordering
        params['page'] = page
        params['page_size'] = _clamp_page_size(page_size)
        client = client_for(ctx, state)
        return run_api(lambda: client.list_pages(f'{prefix}/', params=params, all_pages=all_pages))

    return list_tool


def _make_get(state: ServerState, r: dict):
    prefix = r['prefix']

    def get_tool(ctx: Context, id: int) -> Payload:
        client = client_for(ctx, state)
        return run_api(lambda: client.get(f'{prefix}/{id}/'))

    return get_tool


def _make_create(state: ServerState, r: dict):
    name, prefix = r['name'], r['prefix']

    def create_tool(ctx: Context, data: dict[str, Any]) -> Payload:
        payload = _payload(state.catalog, name, data, partial=False)
        client = client_for(ctx, state)
        return run_api(lambda: client.post(f'{prefix}/', json=payload))

    return create_tool


def _make_update(state: ServerState, r: dict):
    name, prefix = r['name'], r['prefix']

    def update_tool(ctx: Context, id: int, data: dict[str, Any]) -> Payload:
        payload = _payload(state.catalog, name, data, partial=True)
        if not payload:
            raise ToolError('Nothing to update: every supplied field is read-only or `data` is empty.')
        client = client_for(ctx, state)
        return run_api(lambda: client.patch(f'{prefix}/{id}/', json=payload))

    return update_tool


def _make_delete(state: ServerState, r: dict):
    name, singular, prefix = r['name'], r['singular'], r['prefix']

    def delete_tool(ctx: Context, id: int, confirm: bool = False) -> Payload:
        if not confirm:
            raise ToolError(f'Refusing to delete {singular} {id} without confirm=true. Ask the user first.')
        client = client_for(ctx, state)
        run_api(lambda: client.delete(f'{prefix}/{id}/'))
        return {'deleted': id, 'resource': name}

    return delete_tool


# ------------------------------------------------------------------ actions


def _register_action(mcp: FastMCP, state: ServerState, action: dict, read_only: bool) -> None:
    method, tool_name = action['method'], action['tool_name']
    is_write = method != 'GET'
    if read_only and is_write:
        return
    detail, has_body = action['detail'], bool(action['body'])
    has_query = bool(action['query'])
    # A paginated GET collection earns the paging arguments; a bare object or
    # array does not, and offering them there would only invite noise.
    is_list = method == 'GET' and not detail and 'paginated' in (action['response'] or '').lower()

    if detail and has_body:
        fn = _make_detail_body_action(state, action)
    elif detail:
        fn = _make_detail_action(state, action)
    elif has_body:
        fn = _make_body_action(state, action)
    elif has_query and method == 'GET':
        fn = _make_query_action(state, action)
    elif is_list:
        fn = _make_list_action(state, action)
    else:
        fn = _make_plain_action(state, action)

    description = f"{action['description']} ({method} /api/{action['path']})."
    if has_body:
        description += f" body: {json.dumps(action['body'])}."
    if has_query:
        description += f" query: {json.dumps(action['query'])}."
    if action['response']:
        description += f" Returns: {action['response']}."
    # The catalog classifies what an action does; the name is only the fallback
    # for one it has not classified. idempotentHint is left unset on a read,
    # where the spec says it means nothing.
    destructive = (action['destructive'] if 'destructive' in action
                   else any(w in tool_name for w in DESTRUCTIVE_WORDS))
    _add(mcp, fn, tool_name, description,
         ToolAnnotations(title=tool_name.replace('_', ' '), readOnlyHint=not is_write,
                         destructiveHint=destructive,
                         idempotentHint=action.get('idempotent') if is_write else None))


def _detail_path(action: dict, id_value: Any) -> str:
    return action['path'].replace('{id}', str(id_value))


def _make_detail_body_action(state: ServerState, action: dict):
    def tool(ctx: Context, id: int, body: dict[str, Any] | None = None) -> Payload:
        client = client_for(ctx, state)
        return run_api(lambda: client.request(action['method'], _detail_path(action, id), json=body or {}).json())

    return tool


def _make_detail_action(state: ServerState, action: dict):
    def tool(ctx: Context, id: int) -> Payload:
        client = client_for(ctx, state)
        return run_api(lambda: client.request(action['method'], _detail_path(action, id)).json())

    return tool


def _make_body_action(state: ServerState, action: dict):
    def tool(ctx: Context, body: dict[str, Any]) -> Payload:
        client = client_for(ctx, state)
        return run_api(lambda: client.request(action['method'], action['path'], json=body).json())

    return tool


def _make_query_action(state: ServerState, action: dict):
    def tool(ctx: Context, query: dict[str, Any] | None = None, page: int = 1, page_size: int = 25,
             all_pages: bool = False) -> Payload:
        params = dict(query or {})
        params.update({'page': page, 'page_size': _clamp_page_size(page_size)})
        client = client_for(ctx, state)
        return run_api(lambda: client.list_pages(action['path'], params=params, all_pages=all_pages))

    return tool


def _make_list_action(state: ServerState, action: dict):
    def tool(ctx: Context, page: int = 1, page_size: int = 25, all_pages: bool = False) -> Payload:
        params = {'page': page, 'page_size': _clamp_page_size(page_size)}
        client = client_for(ctx, state)
        return run_api(lambda: client.list_pages(action['path'], params=params, all_pages=all_pages))

    return tool


def _make_plain_action(state: ServerState, action: dict):
    def tool(ctx: Context) -> Payload:
        client = client_for(ctx, state)
        body = None if action['method'] == 'GET' else {}
        return run_api(lambda: client.request(action['method'], action['path'], json=body).json())

    return tool
