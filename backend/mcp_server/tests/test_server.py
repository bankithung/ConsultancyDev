import os

os.environ.setdefault('DJANGO_ALLOW_ASYNC_UNSAFE', 'true')

from django.test import SimpleTestCase
from mcp.server.fastmcp.exceptions import ToolError
from mcp.shared.memory import create_connected_server_and_client_session
from starlette.datastructures import Headers
from starlette.testclient import TestClient

from mcp_server.auth import AuthError, resolve_credentials
from mcp_server.catalog import load_catalog
from mcp_server.client import ApiError
from mcp_server.config import Settings
from mcp_server.server import ServerState, build_server, client_for, create_http_app, run_api
from mcp_server.testing import DjangoTestTransport

from .base import CATALOG, McpTestCase, QuietLogsMixin, _run


class _StubRequestContext:
    def __init__(self, request):
        self.request = request


class _StubContext:
    """
    Stands in for FastMCP's Context. `request_context` is a property on the
    real class that RAISES when no request is in flight, so the two shapes
    resolve_credentials must survive are both reproduced here.
    """

    def __init__(self, headers=None, raises=None):
        self._headers = headers
        self._raises = raises

    @property
    def request_context(self):
        if self._raises is not None:
            raise self._raises
        if self._headers is None:
            return _StubRequestContext(None)
        return _StubRequestContext(_StubRequest(Headers(self._headers)))


class _StubRequest:
    def __init__(self, headers):
        self.headers = headers


class CatalogLoaderTests(SimpleTestCase):
    def test_loads_committed_catalog(self):
        cat = load_catalog()
        self.assertIn('enquiries', cat.resources)
        self.assertEqual(cat.resources['enquiries']['singular'], 'enquiry')
        self.assertEqual(cat.by_prefix['visa-tracking']['name'], 'visa_tracking')
        self.assertIn('candidate_name', cat.field_names('enquiries'))
        self.assertNotIn('company', {f['name'] for f in cat.writable_fields('enquiries')})
        self.assertIn('status', {f['param'] for f in cat.filter_params('enquiries')})
        self.assertIn('list_enquiries', cat.all_tool_names())
        self.assertIn('download_document', cat.all_tool_names())

    def test_unknown_resource_names_the_valid_ones(self):
        cat = load_catalog()
        with self.assertRaises(KeyError) as ctx:
            cat.resource('nope')
        message = str(ctx.exception)
        self.assertIn('nope', message)
        self.assertIn('enquiries', message)
        self.assertIn('registrations', message)

    def test_tool_names_follow_verbs_not_methods(self):
        """
        api-keys accepts POST and GET but has no retrieve route, so a name
        derived from `methods` would advertise a get_api_key that 404s. The
        read-only resources are the same trap in reverse.
        """
        cat = load_catalog()
        names = set(cat.all_tool_names())
        self.assertIn('list_api_keys', names)
        self.assertNotIn('get_api_key', names)
        self.assertNotIn('update_api_key', names)
        self.assertNotIn('delete_api_key', names)
        for absent in ('create_notification', 'update_notification', 'delete_notification',
                       'create_plan', 'create_subscription'):
            self.assertNotIn(absent, names)
        for present in ('list_notifications', 'get_notification', 'list_plans', 'get_plan'):
            self.assertIn(present, names)

    def test_tool_names_are_unique_snake_case_ascii(self):
        names = load_catalog().all_tool_names()
        self.assertEqual(len(names), len(set(names)), 'duplicate tool names')
        for name in names:
            self.assertRegex(name, r'^[a-z][a-z0-9_]*$', f'{name} is not snake_case ASCII')

    def test_markdown_renderers(self):
        cat = load_catalog()
        md = cat.schema_markdown('registrations')
        self.assertIn('registration_no', md)
        self.assertIn('REG-<year>', md)
        ref = cat.api_reference_markdown()
        self.assertIn('analytics/revenue/', ref)
        self.assertIn('## enquiries', ref)


class CredentialResolutionTests(SimpleTestCase):
    def test_stdio_uses_api_key_from_settings(self):
        creds = resolve_credentials(None, Settings(api_key='cdk_x'))
        self.assertEqual(creds.apply(None)['Authorization'], 'Bearer cdk_x')

    def test_stdio_uses_password_when_no_key(self):
        creds = resolve_credentials(None, Settings(username='u', password='p'))
        self.assertEqual(creds.username, 'u')

    def test_stdio_without_credentials_raises(self):
        with self.assertRaises(AuthError) as ctx:
            resolve_credentials(None, Settings())
        self.assertIn('CONSULTANCY_API_KEY', str(ctx.exception))

    def test_context_without_a_live_request_falls_back_to_settings(self):
        creds = resolve_credentials(_StubContext(raises=ValueError('no request')), Settings(api_key='cdk_x'))
        self.assertEqual(creds.api_key, 'cdk_x')
        creds = resolve_credentials(_StubContext(headers=None), Settings(api_key='cdk_y'))
        self.assertEqual(creds.api_key, 'cdk_y')

    def test_http_uses_the_request_header_not_the_settings_key(self):
        ctx = _StubContext(headers={'Authorization': 'Bearer cdk_caller'})
        creds = resolve_credentials(ctx, Settings(api_key='cdk_server_owner'))
        self.assertEqual(creds.api_key, 'cdk_caller')

    def test_http_accepts_a_bare_x_api_key(self):
        creds = resolve_credentials(_StubContext(headers={'X-API-Key': 'cdk_bare'}), Settings())
        self.assertEqual(creds.api_key, 'cdk_bare')

    def test_http_accepts_a_jwt_bearer(self):
        creds = resolve_credentials(_StubContext(headers={'authorization': 'Bearer header.payload.sig'}), Settings())
        self.assertIsNone(creds.api_key)
        self.assertEqual(creds.apply(None)['Authorization'], 'Bearer header.payload.sig')

    def test_http_without_a_header_raises(self):
        with self.assertRaises(AuthError) as ctx:
            resolve_credentials(_StubContext(headers={}), Settings(api_key='cdk_ignored'))
        self.assertIn('Authorization', str(ctx.exception))

    def test_hosted_mode_never_falls_back_to_a_server_wide_credential(self):
        """
        Spec 7.3: in Streamable HTTP mode there is no server-wide credential.

        Deciding that by "is a Starlette request in flight" leaves the property
        circumstantial rather than structural: an SDK context anomaly, or any
        future path that reaches a tool outside a request, would silently act
        as whoever owns the server's environment instead of as the caller.
        Nothing stops an operator putting CONSULTANCY_API_KEY in .env.mcp, so
        the transport decides, and it decides before the fallback is reached.
        """
        hosted = Settings(transport='streamable-http', api_key='cdk_server_owner',
                          username='owner', password='pw')
        for label, ctx in (('no context', None),
                           ('context that raises', _StubContext(raises=ValueError('no request'))),
                           ('context with request=None', _StubContext(headers=None))):
            with self.subTest(context=label):
                with self.assertRaises(AuthError) as exc:
                    resolve_credentials(ctx, hosted)
                message = str(exc.exception)
                self.assertIn('per-request Authorization header', message)
                self.assertNotIn('cdk_server_owner', message)

    def test_http_with_a_malformed_header_raises_auth_error(self):
        with self.assertRaises(AuthError):
            resolve_credentials(_StubContext(headers={'authorization': 'Bearer a b c'}), Settings())


class HttpAppTests(QuietLogsMixin, SimpleTestCase):
    def test_health_is_open_and_mcp_requires_bearer(self):
        app = create_http_app(Settings(transport='streamable-http'))
        with TestClient(app) as client:
            self.assertEqual(client.get('/health').status_code, 200)
            self.assertEqual(client.get('/health').json()['status'], 'ok')
            response = client.post('/mcp', json={'jsonrpc': '2.0', 'id': 1, 'method': 'initialize'})
            self.assertEqual(response.status_code, 401)
            self.assertIn('Bearer', response.headers.get('www-authenticate', ''))

    def test_health_reports_read_only(self):
        app = create_http_app(Settings(transport='streamable-http', read_only=True))
        with TestClient(app) as client:
            self.assertIs(client.get('/health').json()['read_only'], True)

    def test_a_bearer_gets_past_the_middleware(self):
        """
        The 401 is the middleware's alone. A request carrying a bearer must
        reach the protocol layer and be judged on its own terms there — the
        SDK answers 421 for the TestClient's host — but never 401.
        """
        app = create_http_app(Settings(transport='streamable-http'))
        with TestClient(app) as client:
            response = client.post('/mcp', json={'jsonrpc': '2.0', 'id': 1, 'method': 'initialize'},
                                   headers={'Authorization': 'Bearer cdk_x'})
            self.assertNotEqual(response.status_code, 401)


class ServerSmokeTests(McpTestCase):
    """
    The whole assembled server, not one tool module: what every module has to
    hold true together. Tools registered by a module are covered in that
    module's own test file.
    """

    def test_server_builds_and_registers_whoami(self):
        tools = self.tool_names(self.admin)
        self.assertIn('whoami', tools)
        self.assertTrue(tools['whoami'].annotations.readOnlyHint)

    def test_catalog_names_the_tools_the_later_tasks_must_register(self):
        names = set(load_catalog().all_tool_names())
        for name in ('list_enquiries', 'get_enquiry', 'create_enquiry', 'update_enquiry',
                     'delete_enquiry', 'accept_transfer', 'download_document'):
            self.assertIn(name, names)

    def test_read_only_hides_every_write_tool(self):
        """The names come from the catalog, not from a list that could drift."""
        tools = self.tool_names(self.admin, read_only=True)
        self.assertIn('whoami', tools)
        write_tools = {n for n in load_catalog().all_tool_names()
                       if n.startswith(('create_', 'update_', 'delete_'))}
        self.assertTrue(write_tools, 'catalog produced no write tool names')
        self.assertEqual(set(), write_tools & set(tools))

    def test_read_only_mode_registers_nothing_that_writes(self):
        """
        The single read-only guard for EVERY tool module, generated or
        hand-written: read_only=True is a promise made to the operator who set
        it, so it is asserted over the live registry rather than per module.
        A tool that writes must not be registered, and a tool that is
        registered must say it only reads.
        """
        tools = self.tool_names(self.admin, read_only=True)
        self.assertGreater(len(tools), 50, 'read-only mode should still expose the read surface')
        for name, tool in sorted(tools.items()):
            with self.subTest(tool=name):
                self.assertFalse(name.startswith(('create_', 'update_', 'delete_')),
                                 f'{name} is registered in read-only mode')
                self.assertIsNotNone(tool.annotations, f'{name} has no annotations')
                self.assertIs(tool.annotations.readOnlyHint, True,
                              f'{name} is registered in read-only mode without readOnlyHint')

    def test_whoami_uses_the_key_owner(self):
        me = self.call('whoami', self.emp_k1)
        self.assertEqual(me['user']['username'], 'emp_k1')
        self.assertEqual(me['role'], 'EMPLOYEE')

    def test_whoami_reports_the_caller_scope_and_auth(self):
        me = self.call('whoami', self.mgr_k)
        self.assertEqual(me['company'], 'Acme Consultancy')
        self.assertEqual(me['branch'], 'Kohima')
        self.assertIsInstance(me['capabilities'], list)
        self.assertTrue(me['auth'].startswith('api key cdk_'))


class ClientForTests(McpTestCase):
    def _state(self, user, **overrides):
        settings = Settings(api_url='http://testserver/api/', api_key=self.key_for(user), **overrides)
        return ServerState(settings=settings, catalog=load_catalog(), transport=DjangoTestTransport())

    def test_api_error_becomes_a_tool_error_carrying_the_hint(self):
        client = client_for(None, self._state(self.emp_k1))
        with self.assertRaises(ToolError) as ctx:
            run_api(lambda: client.get(f'enquiries/{self.enq_d1.pk}/'))
        text = str(ctx.exception)
        self.assertIn('404', text)
        self.assertIn('scope', text)

    def test_missing_credentials_become_a_tool_error(self):
        state = ServerState(settings=Settings(), catalog=load_catalog(), transport=DjangoTestTransport())
        with self.assertRaises(ToolError) as ctx:
            client_for(None, state)
        self.assertIn('CONSULTANCY_API_KEY', str(ctx.exception))

    def test_run_api_passes_a_success_through(self):
        client = client_for(None, self._state(self.emp_k1))
        row = run_api(lambda: client.get(f'enquiries/{self.enq_k1.pk}/'))
        self.assertEqual(row['candidate_name'], 'kohima-one')

    def test_non_api_errors_are_not_swallowed(self):
        with self.assertRaises(ZeroDivisionError):
            run_api(lambda: 1 / 0)
        with self.assertRaises(ApiError):
            raise ApiError(500, 'boom')


class HostedModeCredentialTests(McpTestCase):
    """
    The same invariant, proved through the assembled server rather than the
    one function: a hosted server holding an API key in its settings must
    still refuse a tool call that arrives without a caller header.
    """

    def _hosted_call(self, name, key_owner, **arguments):
        settings = Settings(api_url='http://testserver/api/', api_key=self.key_for(key_owner),
                            transport='streamable-http')
        server = build_server(settings, transport=DjangoTestTransport(), catalog=CATALOG)

        async def go():
            async with create_connected_server_and_client_session(server) as session:
                return await session.call_tool(name, arguments)

        return _run(go())

    def test_a_tool_without_a_request_refuses_instead_of_acting_as_the_key_owner(self):
        result = self._hosted_call('whoami', self.admin)
        self.assertTrue(result.isError, 'a hosted call with no caller header must not succeed')
        text = ''.join(c.text for c in result.content if getattr(c, 'type', '') == 'text')
        self.assertIn('per-request Authorization header', text)
        self.assertNotIn(self.key_for(self.admin), text)

    def test_stdio_with_the_same_key_still_works(self):
        """The guard is about the transport, not about the key being present."""
        self.assertEqual(self.call('whoami', self.admin)['user']['username'], 'admin')


class TransportSecurityTests(QuietLogsMixin, SimpleTestCase):
    """
    DNS-rebinding protection, which decides whether the hosted deployment works
    at all.

    FastMCP turns host validation on by itself whenever it binds a loopback
    address, and allows only loopback Host headers. Behind nginx the Host is
    `console.nexxteducation.in`, so without CONSULTANCY_MCP_ALLOWED_HOSTS every
    proxied request would answer 421 and the server would look dead while the
    process was healthy.
    """

    INITIALIZE = {
        'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
        'params': {'protocolVersion': '2025-06-18', 'capabilities': {},
                   'clientInfo': {'name': 'test', 'version': '1'}},
    }
    HEADERS = {'Authorization': 'Bearer cdk_x', 'Accept': 'application/json, text/event-stream',
               'Content-Type': 'application/json'}

    def _client(self, **settings):
        """One TestClient per app: the SDK's session manager runs once per instance."""
        client = TestClient(create_http_app(Settings(transport='streamable-http', **settings)))
        self.enterContext(client)
        return client

    def _post(self, client, host, **extra):
        return client.post('/mcp', json=self.INITIALIZE, headers={**self.HEADERS, 'Host': host, **extra})

    def test_a_configured_host_is_served_and_any_other_is_refused(self):
        client = self._client(allowed_hosts=('console.nexxteducation.in', 'console.nexxteducation.in:443'))
        allowed = self._post(client, 'console.nexxteducation.in')
        self.assertEqual(allowed.status_code, 200, allowed.text)
        self.assertEqual(allowed.json()['result']['serverInfo']['name'], 'consultancy-dev')
        self.assertEqual(self._post(client, 'console.nexxteducation.in:443').status_code, 200)
        refused = self._post(client, 'attacker.example.com')
        self.assertEqual(refused.status_code, 421)

    def test_loopback_still_works_when_nothing_is_configured(self):
        """The default is the SDK's: local clients yes, everyone else no."""
        client = self._client()
        self.assertEqual(self._post(client, '127.0.0.1:8765').status_code, 200)
        self.assertEqual(self._post(client, 'localhost:8765').status_code, 200)
        self.assertEqual(self._post(client, 'console.nexxteducation.in').status_code, 421)

    def test_an_origin_must_be_configured_before_a_browser_client_is_let_in(self):
        """
        A missing Origin is fine (that is every non-browser client), a
        configured one passes, and an unknown one is refused with 403 —
        a different answer from the Host check, so the operator can tell which
        list needs the entry.
        """
        client = self._client(allowed_hosts=('console.nexxteducation.in',),
                              allowed_origins=('https://claude.ai',))
        host = 'console.nexxteducation.in'
        self.assertEqual(self._post(client, host).status_code, 200)
        self.assertEqual(self._post(client, host, Origin='https://claude.ai').status_code, 200)
        self.assertEqual(self._post(client, host, Origin='https://attacker.example.com').status_code, 403)
