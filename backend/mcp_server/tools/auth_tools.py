"""Identity and permission tools. Task 8 replaces this with the full set."""

from mcp.server.fastmcp import Context, FastMCP
from mcp.types import ToolAnnotations

from ..server import ServerState, client_for, run_api


def register_auth_tools(mcp: FastMCP, state: ServerState) -> None:
    def whoami(ctx: Context) -> dict:
        """Who the server is acting as: user, role, company, branch, capabilities."""
        client = client_for(ctx, state)
        me = run_api(lambda: client.get('users/me/'))
        caps = run_api(lambda: client.get('role-permissions/mine/'))
        return {'user': me, 'role': me['role'], 'company': me.get('company_name'), 'branch': me.get('branch_name'),
                'capabilities': caps['capabilities'], 'auth': client.credentials.describe()}

    mcp.add_tool(whoami, name='whoami', annotations=ToolAnnotations(title='Who am I', readOnlyHint=True))
