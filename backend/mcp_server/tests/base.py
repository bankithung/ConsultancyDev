"""
Shared fixture for driving the MCP server in-process against the real API.

The server talks to Django through DjangoTestTransport, and the MCP client is
the SDK's in-memory session, so a test exercises the same code path a real
client does: JSON-RPC in, tool function, HTTP-shaped call, viewset, back.
"""

import asyncio
import json
import logging
import os

# FastMCP runs a tool inside an event loop while DjangoTestTransport uses the
# ORM synchronously, which Django refuses unless this is set. It must land
# before django.* is imported, so it stays above the imports below.
os.environ.setdefault('DJANGO_ALLOW_ASYNC_UNSAFE', 'true')

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import connections
from django.test import TestCase, override_settings
from mcp.shared.memory import create_connected_server_and_client_session

from core import services
from core.models import ApiKey, Branch, Enquiry, Role
from mcp_server.catalog import load_catalog
from mcp_server.config import Settings
from mcp_server.server import build_server
from mcp_server.testing import DjangoTestTransport

User = get_user_model()
PASSWORD = 'Testing!2026xyz'

# Parsed once for the whole suite. Every tool call builds a server, and a
# server would otherwise re-read and re-parse catalog.json (a quarter of a
# megabyte) each time. The Catalog is read-only, so one instance is safe to share.
CATALOG = load_catalog()

# The project's real REST_FRAMEWORK minus the throttles: a test that walks
# pages would otherwise trip the burst bucket and fail on timing.
RF = {
    'DEFAULT_AUTHENTICATION_CLASSES': (
        'core.authentication.ApiKeyAuthentication',
        'rest_framework_simplejwt.authentication.JWTAuthentication',
    ),
    'DEFAULT_PERMISSION_CLASSES': ('rest_framework.permissions.IsAuthenticated',),
    'DEFAULT_PAGINATION_CLASS': 'core.pagination.StandardPagination',
    'PAGE_SIZE': 25,
    'DEFAULT_FILTER_BACKENDS': (
        'django_filters.rest_framework.DjangoFilterBackend',
        'rest_framework.filters.SearchFilter',
        'rest_framework.filters.OrderingFilter',
    ),
    'EXCEPTION_HANDLER': 'core.exception_handler.api_exception_handler',
}


# Building a server logs a one-line summary and the SDK narrates every request
# at INFO, all of it through the project's root console handler. A suite that
# starts a server per call would bury its own result in that. `core` and
# `core.security` are here for the same reason from the other end: a tool call
# runs the real viewset, which announces every transfer, registration and
# activation change it applies. Both carry an explicit level in settings.LOGGING,
# so quietening the parent alone would not reach `core.security`.
NOISY_LOGGERS = ('mcp', 'mcp_server', 'httpx', 'core', 'core.security')


class QuietLogsMixin:
    """
    Raise the MCP and HTTP loggers to ERROR for the duration of the class.

    Levels rather than logging.disable(): disable() is global and would also
    gag assertLogs in any test that wants to prove something WAS logged, while
    assertLogs sets the level it needs itself and so still works over this.
    """

    _saved_log_levels: dict[str, int] = {}

    @classmethod
    def setUpClass(cls):
        cls._saved_log_levels = {name: logging.getLogger(name).level for name in NOISY_LOGGERS}
        for name in NOISY_LOGGERS:
            logging.getLogger(name).setLevel(logging.ERROR)
        try:
            super().setUpClass()
        except Exception:
            cls._restore_log_levels()
            raise

    @classmethod
    def _restore_log_levels(cls):
        for name, level in cls._saved_log_levels.items():
            logging.getLogger(name).setLevel(level)

    @classmethod
    def tearDownClass(cls):
        try:
            super().tearDownClass()
        finally:
            cls._restore_log_levels()


def _run(coro):
    """
    Run a coroutine with Django's database connections pinned to the ones the
    test's transaction is already using.

    Django keeps connections in an asgiref Local. That Local is thread-local
    while no loop is running, but switches to CONTEXTVAR storage the moment one
    is — so `connections['default']` inside asyncio.run() is a second, empty
    connection to the same sqlite database, and its first write blocks forever
    on the lock TestCase's atomic block is holding: "database table is locked".
    Rebinding the aliases inside the loop keeps every ORM call the tools make
    on the test's own connection, so tool writes are rolled back with the test.
    The rebinding dies with the loop's context and never leaks outward.
    """
    outer = {alias: connections[alias] for alias in connections}

    async def bound():
        for alias, connection in outer.items():
            connections[alias] = connection
        return await coro

    return asyncio.run(bound())


@override_settings(REST_FRAMEWORK=RF)
class McpTestCase(QuietLogsMixin, TestCase):
    @classmethod
    def setUpTestData(cls):
        services.ensure_default_plans()
        cls.company, cls.head_office = services.provision_company('Acme Consultancy')
        cls.kohima = Branch.objects.create(company=cls.company, name='Kohima', code='KOH')
        cls.dimapur = Branch.objects.create(company=cls.company, name='Dimapur', code='DMP')
        cls.rival, cls.rival_branch = services.provision_company('Rival Consultancy')

        def mk(username, role, company, branch):
            user = User.objects.create(username=username, role=role, company=company, branch=branch,
                                       email=f'{username}@example.com', first_name=username.title())
            user.set_password(PASSWORD)
            user.save()
            return user

        cls.dev = mk('dev', Role.DEV_ADMIN, None, None)
        cls.admin = mk('admin', Role.COMPANY_ADMIN, cls.company, cls.head_office)
        cls.head = mk('head', Role.HEAD_MANAGER, cls.company, cls.head_office)
        cls.mgr_k = mk('mgr_k', Role.BRANCH_MANAGER, cls.company, cls.kohima)
        cls.mgr_d = mk('mgr_d', Role.BRANCH_MANAGER, cls.company, cls.dimapur)
        cls.emp_k1 = mk('emp_k1', Role.EMPLOYEE, cls.company, cls.kohima)
        cls.emp_k2 = mk('emp_k2', Role.EMPLOYEE, cls.company, cls.kohima)
        cls.emp_d1 = mk('emp_d1', Role.EMPLOYEE, cls.company, cls.dimapur)
        cls.rival_admin = mk('rival_admin', Role.COMPANY_ADMIN, cls.rival, cls.rival_branch)
        cls.head.managed_managers.set([cls.mgr_k])

        def enquiry(owner, branch, name):
            return Enquiry.objects.create(
                company=owner.company, branch=branch, created_by=owner, owner=owner,
                school_name='School', stream='Science', candidate_name=name, course_interested='BTech',
                mobile='9000000000', email=f'{name}@example.com', father_name='F', mother_name='M',
                permanent_address='Addr',
            )

        cls.enq_k1 = enquiry(cls.emp_k1, cls.kohima, 'kohima-one')
        cls.enq_k2 = enquiry(cls.emp_k2, cls.kohima, 'kohima-two')
        cls.enq_d1 = enquiry(cls.emp_d1, cls.dimapur, 'dimapur-one')
        cls.enq_rival = enquiry(cls.rival_admin, cls.rival_branch, 'rival-one')

    def setUp(self):
        super().setUp()
        cache.clear()
        self._keys = {}

    def key_for(self, user):
        if user.pk not in self._keys:
            _, raw = ApiKey.issue(user, 'test')
            self._keys[user.pk] = raw
        return self._keys[user.pk]

    def server_for(self, user, read_only=False, **settings_overrides):
        settings = Settings(api_url='http://testserver/api/', api_key=self.key_for(user), read_only=read_only,
                            **settings_overrides)
        return build_server(settings, transport=DjangoTestTransport(), catalog=CATALOG)

    @staticmethod
    def _unwrap(result):
        if result.structuredContent is not None:
            sc = result.structuredContent
            return sc['result'] if isinstance(sc, dict) and set(sc) == {'result'} else sc
        text = ''.join(c.text for c in result.content if getattr(c, 'type', '') == 'text')
        try:
            return json.loads(text)
        except ValueError:
            return text

    def call(self, name, user, **arguments):
        async def go():
            async with create_connected_server_and_client_session(self.server_for(user)) as session:
                return await session.call_tool(name, arguments)
        result = _run(go())
        if result.isError:
            text = ''.join(c.text for c in result.content if getattr(c, 'type', '') == 'text')
            raise AssertionError(f'tool {name} errored: {text}')
        return self._unwrap(result)

    def call_raises(self, name, user, **arguments):
        async def go():
            async with create_connected_server_and_client_session(self.server_for(user)) as session:
                return await session.call_tool(name, arguments)
        result = _run(go())
        self.assertTrue(result.isError, f'expected {name} to error')
        return ''.join(c.text for c in result.content if getattr(c, 'type', '') == 'text')

    def tool_names(self, user, read_only=False):
        async def go():
            server = self.server_for(user, read_only=read_only)
            async with create_connected_server_and_client_session(server) as session:
                listing = await session.list_tools()
                return {t.name: t for t in listing.tools}
        return _run(go())

    def read_resource(self, uri, user):
        async def go():
            async with create_connected_server_and_client_session(self.server_for(user)) as session:
                result = await session.read_resource(uri)
                return ''.join(getattr(c, 'text', '') for c in result.contents)
        return _run(go())

    def get_prompt(self, name, user, **arguments):
        async def go():
            async with create_connected_server_and_client_session(self.server_for(user)) as session:
                result = await session.get_prompt(name, arguments)
                return [m.content.text for m in result.messages if getattr(m.content, 'type', '') == 'text']
        return _run(go())

    def list_prompts(self, user):
        async def go():
            async with create_connected_server_and_client_session(self.server_for(user)) as session:
                return {p.name for p in (await session.list_prompts()).prompts}
        return _run(go())

    def prompt_listing(self, user):
        """The advertised prompts by name, with their descriptions and declared arguments."""
        async def go():
            async with create_connected_server_and_client_session(self.server_for(user)) as session:
                return {p.name: p for p in (await session.list_prompts()).prompts}
        return _run(go())

    def list_resources(self, user):
        async def go():
            async with create_connected_server_and_client_session(self.server_for(user)) as session:
                fixed = {str(r.uri) for r in (await session.list_resources()).resources}
                templates = {t.uriTemplate for t in (await session.list_resource_templates()).resourceTemplates}
                return fixed, templates
        return _run(go())

    def resource_listing(self, user):
        """The advertised fixed resources as {uri: mime_type}."""
        async def go():
            async with create_connected_server_and_client_session(self.server_for(user)) as session:
                return {str(r.uri): r.mimeType for r in (await session.list_resources()).resources}
        return _run(go())
