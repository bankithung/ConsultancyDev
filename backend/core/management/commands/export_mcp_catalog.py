"""
Write mcp_server/catalog.json (and optionally docs/mcp/tools.md) from the
running code. Run after any change to models, serializers, filters, viewsets,
actions or capabilities; core/test_mcp_catalog.py fails when it is stale.
"""

import json
import sys
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand

from core import mcp_catalog

DEFAULT_OUT = Path(settings.BASE_DIR) / 'mcp_server' / 'catalog.json'


class Command(BaseCommand):
    help = 'Export the MCP catalog JSON generated from the API code.'

    def add_arguments(self, parser):
        parser.add_argument('--out', default=str(DEFAULT_OUT), help='Output path (default mcp_server/catalog.json)')
        parser.add_argument('--stdout', action='store_true', help='Print JSON instead of writing the file')
        parser.add_argument('--check', action='store_true', help='Exit 1 if the file is stale; write nothing')
        parser.add_argument('--docs', default=None, help='Also write the tools markdown table to this path')

    def handle(self, *args, **options):
        catalog = mcp_catalog.build_catalog()
        text = json.dumps(catalog, indent=2, sort_keys=False) + '\n'
        out = Path(options['out'])

        if options['stdout']:
            self.stdout.write(text)
            return

        if options['check']:
            if not out.exists():
                self.stderr.write(f'{out} does not exist')
                sys.exit(1)
            committed = json.loads(out.read_text(encoding='utf-8'))
            committed.pop('generated_at', None)
            current = dict(catalog)
            current.pop('generated_at', None)
            if committed != current:
                self.stderr.write(f'{out} is stale; run: python manage.py export_mcp_catalog')
                sys.exit(1)
            self.stdout.write('catalog is up to date')
            return

        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding='utf-8')
        self.stdout.write(self.style.SUCCESS(f'Wrote {out} ({len(catalog["resources"])} resources)'))

        if options['docs']:
            docs = Path(options['docs'])
            docs.parent.mkdir(parents=True, exist_ok=True)
            docs.write_text(mcp_catalog.render_tools_markdown(catalog), encoding='utf-8')
            self.stdout.write(self.style.SUCCESS(f'Wrote {docs}'))
