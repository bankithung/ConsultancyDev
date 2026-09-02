"""python -m mcp_server [--transport stdio|streamable-http] [--host H] [--port P] [--api-url URL] [--read-only]"""

from __future__ import annotations

import argparse
import sys

from .config import load_settings
from .server import build_server, configure_logging, create_http_app


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog='mcp_server', description='ConsultancyDev MCP server')
    parser.add_argument('--transport', choices=('stdio', 'streamable-http'), default=None)
    parser.add_argument('--host', default=None)
    parser.add_argument('--port', type=int, default=None)
    parser.add_argument('--api-url', dest='api_url', default=None)
    parser.add_argument('--read-only', dest='read_only', action='store_true', default=None)
    parser.add_argument('--version', action='store_true')
    args = parser.parse_args(argv)

    if args.version:
        from . import __version__
        # The one deliberate write to stdout, and it never runs in stdio mode:
        # --version prints and exits before any server is built.
        print(__version__)
        return 0

    settings = load_settings(overrides={
        'transport': args.transport, 'host': args.host, 'port': args.port,
        'api_url': args.api_url, 'read_only': args.read_only,
    })
    configure_logging(settings)

    if settings.stdio:
        build_server(settings).run(transport='stdio')
        return 0

    import uvicorn
    uvicorn.run(create_http_app(settings), host=settings.host, port=settings.port, log_level='info')
    return 0


if __name__ == '__main__':
    sys.exit(main())
