"""
consultancy:// resources: the catalog, per-resource schemas, enums, roles, the
curated knowledge base, and a live `me`.

Resources are the reference half of this server. A tool answers "do this"; a
resource answers "how does this system work", which an AI client can pull once
and reason over instead of guessing at field names and then learning them one
validation error at a time. Everything here except `me` is static — rendered
from the committed catalog.json or read off disk — so it costs no API call and
cannot be scoped wrongly. `me` is the deliberate exception: it is the caller's
own identity, and it must be fetched per read or it would report whoever
happened to build the server.
"""

from __future__ import annotations

import json
from pathlib import Path

from mcp.server.fastmcp import FastMCP

from .server import ServerState, client_for, run_api

KNOWLEDGE_DIR = Path(__file__).resolve().parent / 'knowledge'


def list_topics() -> list[str]:
    return sorted(p.stem for p in KNOWLEDGE_DIR.glob('*.md'))


def read_topic(topic: str) -> str:
    """
    One knowledge file by name.

    A topic name is one bare stem: no separator and no dot. That is checked
    BEFORE the path is joined, because '../catalog' resolves to a real file
    outside the knowledge directory and `is_file()` would happily agree. Both
    a traversal attempt and an honest typo get the same answer — the list of
    topics that do exist — since neither caller can do anything with more.
    """
    if topic and not ({'/', '\\', '.'} & set(topic)):
        path = KNOWLEDGE_DIR / f'{topic}.md'
        if path.is_file():
            return path.read_text(encoding='utf-8')
    raise KeyError(f'Unknown knowledge topic {topic!r}. Topics: {", ".join(list_topics())}')


def register_resources(mcp: FastMCP, state: ServerState) -> None:
    catalog = state.catalog

    @mcp.resource('consultancy://catalog', name='catalog', mime_type='application/json',
                  description='The full generated API catalog: every resource, field, filter, action, enum and rule.')
    def catalog_resource() -> str:
        return json.dumps(catalog.raw, indent=2)

    @mcp.resource('consultancy://enums', name='enums', mime_type='application/json',
                  description='Every status/stage/type enum with its exact values.')
    def enums_resource() -> str:
        return json.dumps(catalog.enums, indent=2)

    @mcp.resource('consultancy://roles', name='roles', mime_type='application/json',
                  description='Roles, default capabilities, protected floors, and visibility rules.')
    def roles_resource() -> str:
        return json.dumps(catalog.roles, indent=2)

    @mcp.resource('consultancy://api-reference', name='api-reference', mime_type='text/markdown',
                  description='Human-readable reference for the whole API, rendered from the catalog.')
    def api_reference() -> str:
        return catalog.api_reference_markdown()

    @mcp.resource('consultancy://knowledge', name='knowledge-index', mime_type='text/markdown',
                  description='Index of curated knowledge topics about how the CRM works.')
    def knowledge_index() -> str:
        lines = ['# ConsultancyDev knowledge topics', '',
                 'Read one with `consultancy://knowledge/<topic>`:', '']
        for topic in list_topics():
            headline = read_topic(topic).splitlines()[0].lstrip('# ').strip()
            lines.append(f'- **{topic}** (`consultancy://knowledge/{topic}`) — {headline}')
        return '\n'.join(lines) + '\n'

    @mcp.resource('consultancy://schema/{resource}', name='schema', mime_type='text/markdown',
                  description='Fields, filters, actions and notes for one resource (catalog name, e.g. enquiries).')
    def schema_resource(resource: str) -> str:
        # An unknown name answers with the valid ones rather than raising: a
        # client that guessed the singular ("enquiry") learns the plural from
        # the body instead of getting a protocol error it has to parse.
        try:
            return catalog.schema_markdown(resource)
        except KeyError as exc:
            return f'# Unknown resource\n\n{exc.args[0]}\n'

    @mcp.resource('consultancy://knowledge/{topic}', name='knowledge', mime_type='text/markdown',
                  description='One curated knowledge topic. Read consultancy://knowledge for the index.')
    def knowledge_resource(topic: str) -> str:
        try:
            return read_topic(topic)
        except KeyError as exc:
            return f'# Unknown topic\n\n{exc.args[0]}\n'

    @mcp.resource('consultancy://me', name='me', mime_type='application/json',
                  description='The authenticated user, role, scope and live capabilities.')
    def me_resource() -> str:
        # The context is fetched here rather than declared as a parameter:
        # FastMCP registers ANY function with parameters as a resource
        # TEMPLATE, so `def me_resource(ctx: Context)` would take
        # consultancy://me off the resource listing entirely.
        client = client_for(mcp.get_context(), state)
        me = run_api(lambda: client.get('users/me/'))
        caps = run_api(lambda: client.get('role-permissions/mine/'))
        return json.dumps({'user': me, 'role': me['role'], 'capabilities': caps['capabilities'],
                           'visibility': catalog.roles['visibility'].get(me['role'], '')}, indent=2)
