"""
Spawn the real server as a child process and speak MCP to it over stdio.

This is the only test that runs the server the way a client does: `python -m
mcp_server`, one process, protocol frames on stdout. That is what nothing
in-process can check — that the package starts under `-m`, that the handshake
completes, and that NOTHING but protocol frames reaches stdout.

That last one needs an explicit assertion. A stray `print` does not break the
session under this SDK: the client logs "Failed to parse JSONRPC message from
server" and reads the next line. So every session below runs inside
assertNoLogs on the client's stdout reader, which is the only place that
mis-framing is visible. The timeouts are for the other failure mode, a child
that never answers at all.

No backend is involved: CONSULTANCY_API_URL points at a closed port, so the one
tool call made here proves the unreachable-backend path instead of an API
result. The fake key is never sent anywhere.
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

from django.test import SimpleTestCase
from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

BACKEND_DIR = Path(__file__).resolve().parent.parent.parent

# A closed port: connecting to it fails at once on every platform, so an
# accidental API call surfaces as a fast, obvious error rather than a hang.
UNREACHABLE_API = 'http://127.0.0.1:9/api/'
FAKE_KEY = 'cdk_' + 'x' * 40
TIMEOUT_SECONDS = 90
# Where the client reports a line of the child's stdout that was not a protocol
# frame. Nothing else notices, so this test watches it.
STDOUT_READER_LOGGER = 'mcp.client.stdio'


def child_env(**extra: str) -> dict[str, str]:
    """
    The parent environment minus every CONSULTANCY_* variable.

    The developer running the suite may well have a real key and a real API URL
    exported; inheriting them would point this test at a live backend and could
    flip --read-only under it. PATH and the Windows system variables are kept
    because the interpreter needs them to start.
    """
    env = {k: v for k, v in os.environ.items() if not k.startswith('CONSULTANCY_')}
    env['PYTHONUNBUFFERED'] = '1'
    env.update(extra)
    return env


class StdioSmokeTests(SimpleTestCase):
    def run_session(self, args: list[str], env: dict[str, str], work):
        """
        Run `python -m mcp_server <args>` and hand `work` a live ClientSession.

        stdio_client terminates the child process tree on the way out,
        including when the timeout fires, so a server that hangs cannot leak a
        process into the rest of the suite. Its stderr is captured rather than
        passed through: the server logs a startup line there, and the suite's
        output stays clean unless something fails, in which case the log is
        attached to the failure.
        """
        params = StdioServerParameters(command=sys.executable, args=['-m', 'mcp_server', *args],
                                       cwd=str(BACKEND_DIR), env=env)

        async def go():
            async with stdio_client(params, errlog=errlog) as (read, write):
                async with ClientSession(read, write) as session:
                    return await work(session)

        with tempfile.TemporaryFile('w+', encoding='utf-8', errors='replace') as errlog:
            try:
                with self.assertNoLogs(STDOUT_READER_LOGGER, level='ERROR'):
                    return asyncio.run(asyncio.wait_for(go(), timeout=TIMEOUT_SECONDS))
            except Exception as exc:
                errlog.seek(0)
                tail = ''.join(errlog.readlines()[-40:]).strip()
                raise AssertionError(
                    f'python -m mcp_server {" ".join(args)} failed: {type(exc).__name__}: {exc}\n'
                    f'--- child stderr ---\n{tail or "(nothing)"}'
                ) from exc

    def test_a_real_client_can_handshake_and_list_everything(self):
        async def work(session):
            init = await session.initialize()
            tools = await session.list_tools()
            resources = await session.list_resources()
            prompts = await session.list_prompts()
            health = await session.call_tool('health', {})
            return (init, {t.name for t in tools.tools}, {str(r.uri) for r in resources.resources},
                    {p.name for p in prompts.prompts}, health)

        init, tools, resources, prompts, health = self.run_session(
            [], child_env(CONSULTANCY_API_URL=UNREACHABLE_API, CONSULTANCY_API_KEY=FAKE_KEY), work)

        # serverInfo.version is the SDK's, not this package's: FastMCP does not
        # take a server version. `python -m mcp_server --version` reports ours.
        self.assertEqual(init.serverInfo.name, 'consultancy-dev')
        self.assertIn('whoami', init.instructions or '')
        for name in ('whoami', 'list_enquiries', 'create_registration', 'student_360',
                     'daily_briefing', 'analytics_overview', 'upload_document', 'health'):
            self.assertIn(name, tools)
        self.assertIn('consultancy://catalog', resources)
        self.assertIn('consultancy://knowledge', resources)
        self.assertIn('daily_briefing', prompts)
        self.assertIn('onboard_student', prompts)

        # The backend is not there. That must come back as a tool error the
        # client can read, naming the URL to fix, and the session must still be
        # alive afterwards — which is what returning at all proves.
        self.assertTrue(health.isError, health.content)
        message = ' '.join(getattr(c, 'text', '') for c in health.content)
        self.assertIn('127.0.0.1:9', message)
        self.assertIn('CONSULTANCY_API_URL', message)

    def test_read_only_mode_reaches_the_child_process(self):
        """The flag is only real if it survives the CLI, not just load_settings."""
        async def work(session):
            await session.initialize()
            return {t.name for t in (await session.list_tools()).tools}

        tools = self.run_session(
            ['--read-only'],
            child_env(CONSULTANCY_API_URL=UNREACHABLE_API, CONSULTANCY_API_KEY=FAKE_KEY), work)
        self.assertIn('list_enquiries', tools)
        self.assertNotIn('create_enquiry', tools)
        self.assertNotIn('delete_enquiry', tools)
