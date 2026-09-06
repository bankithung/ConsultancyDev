"""Build the FastMCP server: state, tool registration, HTTP app."""

from __future__ import annotations

import logging
import sys
from dataclasses import dataclass

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
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


# What a client running on this machine sends as Host/Origin. FastMCP installs
# the same list itself when it binds a loopback address, and installs NOTHING
# when it binds anything else; both are wrong for a proxied deployment, so the
# settings are always built here instead.
LOOPBACK_HOSTS = ('127.0.0.1', 'localhost', '[::1]', '127.0.0.1:*', 'localhost:*', '[::1]:*')
LOOPBACK_ORIGINS = ('http://127.0.0.1:*', 'http://localhost:*', 'http://[::1]:*')


@dataclass
class ServerState:
    settings: Settings
    catalog: Catalog
    transport: Transport


def transport_security_for(settings: Settings) -> TransportSecuritySettings:
    """
    Which Host and Origin headers the HTTP transport will answer.

    Protection stays ON always. Behind nginx the Host header is the public name
    (`proxy_set_header Host $host`), which is not a loopback address, so the
    deployment must name itself in CONSULTANCY_MCP_ALLOWED_HOSTS; otherwise
    every proxied request answers 421 and the server looks dead while the
    process is healthy. Loopback is always allowed so a local client keeps
    working with no configuration at all.

    Origin is only sent by browser-based clients. An absent Origin passes, so
    CONSULTANCY_MCP_ALLOWED_ORIGINS is needed only for those.
    """
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=[*LOOPBACK_HOSTS, *settings.allowed_hosts],
        allowed_origins=[*LOOPBACK_ORIGINS, *settings.allowed_origins],
    )


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


def build_server(settings: Settings, transport: Transport | None = None,
                 catalog: Catalog | None = None) -> FastMCP:
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

    # `catalog` is injectable so a caller that builds many servers — the test
    # suite builds one per tool call — can parse catalog.json once. It is
    # read-only, so one instance is safely shared.
    catalog = catalog or load_catalog()
    state = ServerState(
        settings=settings, catalog=catalog,
        transport=transport or HttpxTransport(settings.api_url, timeout=settings.timeout_seconds),
    )
    mcp = FastMCP(
        name='consultancy-dev', instructions=INSTRUCTIONS,
        host=settings.host, port=settings.port, streamable_http_path='/mcp',
        stateless_http=True, json_response=True,
        transport_security=transport_security_for(settings),
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

    def __init__(self, app, api_url):
        super().__init__(app)
        self.api_url = api_url.rstrip('/') + '/'
        from urllib.parse import urlsplit
        parsed = urlsplit(api_url)
        self.metadata_url = f'{parsed.scheme}://{parsed.netloc}/.well-known/oauth-protected-resource/mcp'

    async def dispatch(self, request: Request, call_next):
        if not request.url.path.startswith('/mcp'):
            return await call_next(request)
        header = request.headers.get('authorization', '')
        key = request.headers.get('x-api-key', '')
        challenge = {'WWW-Authenticate': f'Bearer resource_metadata="{self.metadata_url}", scope="crm"'}
        if not header.lower().startswith('bearer ') and not key:
            return JSONResponse({'error': 'Connect your account or provide an API key.'}, status_code=401, headers=challenge)
        # Validate at the MCP boundary as well as at each downstream API call.
        # This makes expired/revoked tokens trigger the client's OAuth flow
        # instead of surfacing as a successful MCP response with a tool error.
        import httpx
        credentials = {'Authorization': header} if header else {'X-API-Key': key}
        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
                response = await client.get(self.api_url + 'users/me/', headers=credentials)
        except httpx.HTTPError:
            return JSONResponse({'error': 'Account verification temporarily unavailable.'}, status_code=503)
        if response.status_code in (401, 403):
            return JSONResponse({'error': 'Reconnect your account.'}, status_code=401, headers=challenge)
        if response.status_code != 200:
            return JSONResponse({'error': 'Account verification temporarily unavailable.'}, status_code=503)
        return await call_next(request)


def create_http_app(settings: Settings, transport: Transport | None = None,
                    catalog: Catalog | None = None):
    if not settings.allowed_hosts:
        # Said once at startup rather than left to be diagnosed from a wall of
        # 421s: the symptom (every request refused) does not name its cause.
        logger.warning('CONSULTANCY_MCP_ALLOWED_HOSTS is empty: only loopback Host headers are '
                       'accepted. Behind a reverse proxy, set it to the public hostname.')
    mcp = build_server(settings, transport=transport, catalog=catalog)

    @mcp.custom_route('/health', methods=['GET'])
    async def health(request: Request):
        return JSONResponse({'status': 'ok', 'version': __version__, 'read_only': settings.read_only})

    app = mcp.streamable_http_app()
    app.add_middleware(BearerRequiredMiddleware, api_url=settings.api_url)
    return app
