"""Build the FastMCP server: state, tool registration, HTTP app."""

from __future__ import annotations

import logging
import sys
from dataclasses import dataclass

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from . import __version__
from .auth import AuthError, resolve_credentials
from .catalog import Catalog, load_catalog
from .client import ApiClient, ApiError, HttpxTransport, Transport
from .config import Settings

logger = logging.getLogger('mcp_server')

INSTRUCTIONS = """ConsultancyDev CRM for an education/immigration consultancy (NEET/PCB/PCM admissions, university placement, visa tracking).
You act AS the authenticated user: every tool is an API call scoped by their role, company, branch and ownership.
Start with `whoami`. Read `consultancy://knowledge/overview` and `consultancy://schema/<resource>` before writing records.
Pipeline: enquiry -> follow-ups -> registration (auto-creates a Payment) -> enrollment (server builds installments) -> payments/refunds; documents, visa tracking, appointments and tasks hang off it.
Employees cannot delete directly: use create_approval_request. Transfers MOVE ownership.
List tools accept `filters` (multi-value params are lists), `search`, `ordering`, `page`, `page_size` (<=200), `all_pages`.
"""


@dataclass
class ServerState:
    settings: Settings
    catalog: Catalog
    transport: Transport


def configure_logging(settings: Settings) -> None:
    """stderr only: stdout is the protocol stream in stdio mode."""
    logging.basicConfig(stream=sys.stderr, level=logging.INFO,
                        format='%(asctime)s %(levelname)s %(name)s: %(message)s')


def client_for(ctx: Context | None, state: ServerState) -> ApiClient:
    try:
        credentials = resolve_credentials(ctx, state.settings)
    except AuthError as exc:
        raise ToolError(str(exc)) from exc
    return ApiClient(state.transport, credentials)


def run_api(fn):
    """Run an API-calling callable and turn ApiError into a ToolError with the hint attached."""
    try:
        return fn()
    except ApiError as exc:
        raise ToolError(str(exc)) from exc


def build_server(settings: Settings, transport: Transport | None = None) -> FastMCP:
    # Imported here, not at module scope: every register_* module imports
    # ServerState and client_for from this one, so a top-level import would
    # be circular.
    from .prompts import register_prompts
    from .resources import register_resources
    from .tools.analytics import register_analytics_tools
    from .tools.auth_tools import register_auth_tools
    from .tools.documents import register_document_tools
    from .tools.generated import register_generated_tools
    from .tools.workflows import register_workflow_tools

    catalog = load_catalog()
    state = ServerState(
        settings=settings, catalog=catalog,
        transport=transport or HttpxTransport(settings.api_url, timeout=settings.timeout_seconds),
    )
    mcp = FastMCP(
        name='consultancy-dev', instructions=INSTRUCTIONS,
        host=settings.host, port=settings.port, streamable_http_path='/mcp',
        stateless_http=True, json_response=True,
    )
    register_auth_tools(mcp, state)
    register_generated_tools(mcp, state)
    register_analytics_tools(mcp, state)
    register_document_tools(mcp, state)
    register_workflow_tools(mcp, state)
    register_resources(mcp, state)
    register_prompts(mcp)
    logger.info('consultancy-dev MCP %s: %d tools, read_only=%s, api=%s',
                __version__, len(mcp._tool_manager.list_tools()), settings.read_only, settings.api_url)
    return mcp


class BearerRequiredMiddleware(BaseHTTPMiddleware):
    """Reject MCP traffic without a bearer before it reaches the protocol layer."""

    async def dispatch(self, request: Request, call_next):
        if request.url.path.startswith('/mcp'):
            header = request.headers.get('authorization', '')
            if not header.lower().startswith('bearer ') and not request.headers.get('x-api-key'):
                return JSONResponse(
                    {'error': 'Authorization required: Bearer <cdk_ API key>.'}, status_code=401,
                    headers={'WWW-Authenticate': 'Bearer realm="consultancy-mcp"'},
                )
        return await call_next(request)


def create_http_app(settings: Settings, transport: Transport | None = None):
    mcp = build_server(settings, transport=transport)

    @mcp.custom_route('/health', methods=['GET'])
    async def health(request: Request):
        return JSONResponse({'status': 'ok', 'version': __version__, 'read_only': settings.read_only})

    app = mcp.streamable_http_app()
    app.add_middleware(BearerRequiredMiddleware)
    return app
