"""Typed access to the generated catalog.json."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

CATALOG_PATH = Path(__file__).resolve().parent / 'catalog.json'


class Catalog:
    def __init__(self, raw: dict[str, Any]):
        self.raw = raw
        self.resources: dict[str, dict] = {r['name']: r for r in raw['resources']}
        self.by_prefix: dict[str, dict] = {r['prefix']: r for r in raw['resources']}
        self.enums: dict[str, list] = raw['enums']
        self.roles: dict = raw['roles']
        self.approvals: dict = raw['approvals']
        self.transfers: dict = raw['transfers']
        self.conventions: dict = raw['conventions']
        self.standalone_endpoints: list = raw['standalone_endpoints']
        self.encrypted_fields: list[str] = raw['encrypted_fields']

    def resource(self, name: str) -> dict:
        try:
            return self.resources[name]
        except KeyError:
            raise KeyError(f'Unknown resource {name!r}. Valid: {", ".join(sorted(self.resources))}') from None

    def writable_fields(self, name: str) -> list[dict]:
        return [f for f in self.resource(name)['fields'] if not f['read_only']]

    def field_names(self, name: str) -> set[str]:
        return {f['name'] for f in self.resource(name)['fields']}

    def filter_params(self, name: str) -> list[dict]:
        return list(self.resource(name)['filters'])

    @staticmethod
    def tool_names_for(resource: dict) -> list[str]:
        """
        The CRUD tool names one resource earns, gated on `verbs` rather than on
        `methods`.

        A router advertises the HTTP verbs of the whole collection, so
        api-keys — which lists and creates but has no retrieve route — reports
        both GET and POST, and a name derived from `methods` would offer a
        get_api_key that always 404s. `verbs` records the actions the viewset
        actually implements, which is what a tool corresponds to.
        """
        verbs = resource['verbs']
        names: list[str] = []
        if verbs.get('list'):
            names.append(f"list_{resource['name']}")
        if verbs.get('retrieve'):
            names.append(f"get_{resource['singular']}")
        if verbs.get('create'):
            names.append(f"create_{resource['singular']}")
        if verbs.get('update') or verbs.get('partial_update'):
            names.append(f"update_{resource['singular']}")
        if verbs.get('destroy'):
            names.append(f"delete_{resource['singular']}")
        return names

    def all_tool_names(self) -> list[str]:
        names: list[str] = []
        for r in self.raw['resources']:
            names += self.tool_names_for(r)
            names += [a['tool_name'] for a in r['actions']]
        return names

    # ------------------------------------------------------------ rendering

    def schema_markdown(self, name: str) -> str:
        r = self.resource(name)
        lines = [f"# {r['name']}  (`/api/{r['prefix']}/`)", '']
        lines.append(f"Model: {r['model']}  |  entity_type: {r['entity_type']}  |  methods: {', '.join(r['methods'])}")
        lines.append(f"Read: {r['read_capability'] or 'any active user'} ({', '.join(r['read_roles'])})")
        lines.append(f"Write: {r['write_capability'] or 'scope only'} ({', '.join(r['write_roles'])})")
        if r['delete_requires_capability']:
            lines.append(f"Delete needs capability `{r['delete_requires_capability']}`; "
                         f"others raise an approval request.")
        lines += ['', '## Fields', '', '| name | type | required | read_only | choices / related | notes |',
                  '|---|---|---|---|---|---|']
        for f in r['fields']:
            extra = ''
            if f['choices']:
                extra = ', '.join(c['value'] for c in f['choices'])
            elif f['related_model']:
                extra = f"id of {f['related_model']}"
            note = 'write-only' if f['write_only'] else ''
            if f['max_length']:
                note = (note + ' ' if note else '') + f"max {f['max_length']}"
            lines.append(f"| {f['name']} | {f['type']} | {'yes' if f['required'] else ''} | "
                         f"{'yes' if f['read_only'] else ''} | {extra} | {note} |")
        if r['filters']:
            lines += ['', '## Filters (query params)', '']
            for flt in r['filters']:
                choices = f" one of {', '.join(flt['choices'])}" if flt.get('choices') else ''
                lines.append(f"- `{flt['param']}` ({flt['kind']}, {flt['lookup']}){choices}")
        if r['search_fields']:
            lines += ['', f"Search (`search=`): {', '.join(r['search_fields'])}"]
        if r['ordering_fields']:
            lines.append(f"Ordering (`ordering=`, prefix - for desc): {', '.join(r['ordering_fields'])}")
        if r['actions']:
            lines += ['', '## Actions', '']
            for a in r['actions']:
                lines.append(f"- `{a['tool_name']}` — {a['method']} {a['path']}: {a['description']}")
                if a['body']:
                    lines.append(f"  body: {json.dumps(a['body'])}")
                if a.get('query'):
                    lines.append(f"  query: {json.dumps(a['query'])}")
                if a['response']:
                    lines.append(f"  response: {a['response']}")
        if r['notes']:
            lines += ['', '## Notes', ''] + [f'- {n}' for n in r['notes']]
        return '\n'.join(lines) + '\n'

    def api_reference_markdown(self) -> str:
        lines = ['# ConsultancyDev API reference (generated)', '',
                 f"Base path `{self.conventions['base_path']}`. {self.conventions['multi_value_query_params']}.", '']
        for r in self.raw['resources']:
            lines.append(f"## {r['name']}")
            lines.append('')
            lines.append(self.schema_markdown(r['name']))
        lines += ['## Standalone endpoints', '']
        for e in self.standalone_endpoints:
            lines.append(f"- {e['method']} `{e['path']}` — {e['permission']}. body {json.dumps(e['body'])}"
                         + (f", query {json.dumps(e['query'])}" if e.get('query') else '')
                         + f". Response: {e['response']}")
        return '\n'.join(lines) + '\n'


def load_catalog(path: Path | None = None) -> Catalog:
    p = path or CATALOG_PATH
    return Catalog(json.loads(p.read_text(encoding='utf-8')))
