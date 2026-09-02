# MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Model Context Protocol server that gives any MCP-capable AI client complete, generated knowledge of the ConsultancyDev CRM and the ability to perform every API operation as an authenticated user, without exceeding that user's role, tenant or ownership scope.

**Architecture:** A Python package `backend/mcp_server/` built on the official `mcp` SDK (FastMCP) acts as an HTTP client of the existing Django REST API. Its tool, resource and prompt surface is generated from a catalog JSON that a new management command introspects from the DRF router, serializers, filtersets, capability matrix and enums. Users authenticate with new personal API keys (a new `ApiKey` model plus DRF authentication class); the server runs over stdio for local clients and Streamable HTTP for hosted ones.

**Tech Stack:** Python 3.11 (production) / 3.13 (local), Django 6.0.7, DRF 3.17.1, `mcp==1.26.0`, `httpx==0.28.1`, Starlette/uvicorn (pulled in by `mcp`), Next.js 16 + React 19 + TanStack Query for the one frontend card.

**Spec:** `docs/superpowers/specs/2026-09-02-mcp-server-design.md`

## Global Constraints

- Python code must run on 3.11: no `type X = ...` aliases, no PEP 695 generics, no `itertools.batched`. `X | None` unions are fine.
- In stdio mode **nothing may be written to stdout** except protocol frames. All logging goes to `stderr` via `logging` configured with `stream=sys.stderr`.
- Every tool name is `snake_case`, ASCII, and unique across the server.
- Every API path the server calls ends with a trailing slash (`/api/enquiries/`, `/api/documents/3/download/`). `DefaultRouter` 301-redirects otherwise, and a POST body is lost on redirect.
- Multi-value query parameters are sent as **repeated keys** (`?status=New&status=Contacted`), never comma-separated.
- API key plaintext is returned exactly once on creation; `key_hash` is never serialised anywhere.
- The backend error envelope is `{"error": "<message>"}` or `{"error": "Validation failed", "fields": {...}}`. The MCP layer preserves both and adds a `hint`.
- Tests run with Django's runner only: `cd backend && python manage.py test <label>`. There is no pytest.
- Tests must set `os.environ.setdefault('DJANGO_ALLOW_ASYNC_UNSAFE', 'true')` before driving the MCP server in-process, because FastMCP runs tool functions inside an event loop while the Django test transport uses the ORM synchronously.
- Commit after every task from the inner repo root `C:\Users\Asus\Music\Projects\ConsultancyDev\ConsultancyDev`, with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Pinned versions: `mcp==1.26.0`, `httpx==0.28.1` (both already installed locally; `pip show mcp httpx` confirms).
- The catalog file `backend/mcp_server/catalog.json` is generated and **committed**; `core/test_mcp_catalog.py` fails when it is stale. Generate it with the default upload settings (no `MAX_DOCUMENT_SIZE_BYTES` / `ALLOWED_DOCUMENT_EXTENSIONS` overrides in `.env`), because those values are embedded in `conventions.uploads`.

### File map (what each file owns)

```
backend/
  requirements.txt                          + mcp, httpx
  config/settings.py                        + ApiKeyAuthentication first in DEFAULT_AUTHENTICATION_CLASSES
  core/models.py                            + ApiKey model
  core/migrations/0011_api_key.py           new
  core/authentication.py                    new: ApiKeyAuthentication
  core/serializers.py                       + ApiKeySerializer, ApiKeyCreateSerializer
  core/views.py                             + ApiKeyViewSet
  core/urls.py                              + router.register('api-keys', ...)
  core/services.py                          revoke_all_tokens also revokes API keys
  core/mcp_catalog.py                       new: build_catalog(), render_tools_markdown(), ACTION_OVERLAY
  core/management/commands/export_mcp_catalog.py   new
  core/test_api_keys.py                     new
  core/test_mcp_catalog.py                  new
  mcp_server/__init__.py                    version string
  mcp_server/__main__.py                    CLI
  mcp_server/config.py                      Settings, load_settings
  mcp_server/client.py                      Response, Transport, HttpxTransport, ApiError, Credentials, ApiClient, hint_for
  mcp_server/testing.py                     DjangoTestTransport
  mcp_server/catalog.py                     Catalog, load_catalog, CATALOG_PATH
  mcp_server/catalog.json                   generated
  mcp_server/auth.py                        resolve_credentials, AuthError
  mcp_server/server.py                      ServerState, build_server, client_for, create_http_app, BearerRequiredMiddleware
  mcp_server/tools/__init__.py
  mcp_server/tools/generated.py             register_generated_tools
  mcp_server/tools/analytics.py             register_analytics_tools
  mcp_server/tools/auth_tools.py            register_auth_tools
  mcp_server/tools/documents.py             register_document_tools
  mcp_server/tools/workflows.py             register_workflow_tools, ENQUIRY_TO_REGISTRATION
  mcp_server/resources.py                   register_resources
  mcp_server/prompts.py                     register_prompts
  mcp_server/knowledge/*.md                 15 curated docs
  mcp_server/tests/__init__.py
  mcp_server/tests/base.py                  McpTestCase
  mcp_server/tests/test_config.py, test_client.py, test_server.py, test_generated.py,
  mcp_server/tests/test_analytics_auth.py, test_documents.py, test_workflows.py,
  mcp_server/tests/test_resources_prompts.py, test_stdio_smoke.py
consultancy-dev/
  lib/types.ts                              + ApiKey, ApiKeyCreated
  lib/apiClient.ts                          + apiKeys
  app/app/profile/components/ApiKeysCard.tsx  new
  app/app/profile/page.tsx                  mounts ApiKeysCard
deploy/consultancy-mcp.service              new
deploy/nginx.console.nexxteducation.in.conf + location /mcp/
docs/mcp/README.md, clients.md, tools.md, security.md   new
.mcp.json                                   new (repo root)
```

---

### Task 1: Dependencies, package skeleton and settings parsing

**Files:**
- Modify: `backend/requirements.txt`
- Create: `backend/mcp_server/__init__.py`
- Create: `backend/mcp_server/config.py`
- Create: `backend/mcp_server/tests/__init__.py`
- Create: `backend/mcp_server/tests/test_config.py`

**Interfaces:**
- Produces: `mcp_server.config.Settings` (frozen dataclass: `api_url: str`, `api_key: str | None`, `username: str | None`, `password: str | None`, `read_only: bool`, `max_download_bytes: int`, `transport: str`, `host: str`, `port: int`, `timeout_seconds: float`) and `load_settings(env: Mapping[str, str] | None = None, overrides: dict | None = None) -> Settings`.
- Produces: `Settings.has_credentials` property, `Settings.stdio` property (`transport == 'stdio'`).

- [ ] **Step 1: Pin the dependencies**

Append to `backend/requirements.txt`:

```text

# Model Context Protocol server (backend/mcp_server). httpx is the HTTP client
# it uses to talk to /api/; uvicorn and starlette arrive as mcp dependencies.
mcp==1.26.0
httpx==0.28.1
```

Run: `cd backend && pip install -r requirements.txt`
Expected: `Requirement already satisfied: mcp==1.26.0` and `httpx==0.28.1` (both are installed locally already).

- [ ] **Step 2: Write the failing config test**

`backend/mcp_server/tests/__init__.py` is an empty file.

`backend/mcp_server/tests/test_config.py`:

```python
from django.test import SimpleTestCase

from mcp_server.config import Settings, load_settings


class LoadSettingsTests(SimpleTestCase):
    def test_defaults_when_env_is_empty(self):
        s = load_settings(env={})
        self.assertEqual(s.api_url, 'http://127.0.0.1:8000/api/')
        self.assertIsNone(s.api_key)
        self.assertFalse(s.read_only)
        self.assertEqual(s.max_download_bytes, 5 * 1024 * 1024)
        self.assertEqual(s.transport, 'stdio')
        self.assertTrue(s.stdio)
        self.assertFalse(s.has_credentials)

    def test_trailing_slash_is_forced_on_api_url(self):
        s = load_settings(env={'CONSULTANCY_API_URL': 'https://console.example.com/api'})
        self.assertEqual(s.api_url, 'https://console.example.com/api/')

    def test_api_key_and_flags_are_read(self):
        s = load_settings(env={
            'CONSULTANCY_API_KEY': 'cdk_abc',
            'CONSULTANCY_MCP_READ_ONLY': 'yes',
            'CONSULTANCY_MCP_MAX_DOWNLOAD_BYTES': '1024',
        })
        self.assertEqual(s.api_key, 'cdk_abc')
        self.assertTrue(s.read_only)
        self.assertEqual(s.max_download_bytes, 1024)
        self.assertTrue(s.has_credentials)

    def test_username_password_count_as_credentials(self):
        s = load_settings(env={'CONSULTANCY_USERNAME': 'admin', 'CONSULTANCY_PASSWORD': 'x'})
        self.assertTrue(s.has_credentials)

    def test_overrides_win_over_env(self):
        s = load_settings(env={'CONSULTANCY_API_URL': 'http://a/api/'}, overrides={'api_url': 'http://b/api/', 'transport': 'streamable-http', 'port': 9000})
        self.assertEqual(s.api_url, 'http://b/api/')
        self.assertEqual(s.transport, 'streamable-http')
        self.assertEqual(s.port, 9000)
        self.assertFalse(s.stdio)

    def test_bad_int_falls_back_to_default(self):
        s = load_settings(env={'CONSULTANCY_MCP_MAX_DOWNLOAD_BYTES': 'lots'})
        self.assertEqual(s.max_download_bytes, 5 * 1024 * 1024)
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && python manage.py test mcp_server.tests.test_config`
Expected: `ModuleNotFoundError: No module named 'mcp_server'` (or `ImportError` for `config`).

- [ ] **Step 4: Implement the package and config module**

`backend/mcp_server/__init__.py`:

```python
"""
ConsultancyDev MCP server.

An MCP (Model Context Protocol) server that exposes the CRM's REST API to AI
clients. It never touches the ORM: every tool is an HTTP call to /api/ made as
the authenticated user, so role, tenant and ownership rules stay where they are
enforced.
"""

__version__ = '1.0.0'
```

`backend/mcp_server/config.py`:

```python
"""Environment-driven settings for the MCP server. No Django imports here."""

from __future__ import annotations

import os
from dataclasses import dataclass, replace
from typing import Any, Mapping

DEFAULT_API_URL = 'http://127.0.0.1:8000/api/'
DEFAULT_MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024
TRANSPORTS = ('stdio', 'streamable-http')


def _bool(raw: str | None, default: bool = False) -> bool:
    if raw is None:
        return default
    return raw.strip().lower() in ('1', 'true', 'yes', 'on')


def _int(raw: str | None, default: int) -> int:
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _float(raw: str | None, default: float) -> float:
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    api_url: str = DEFAULT_API_URL
    api_key: str | None = None
    username: str | None = None
    password: str | None = None
    read_only: bool = False
    max_download_bytes: int = DEFAULT_MAX_DOWNLOAD_BYTES
    transport: str = 'stdio'
    host: str = '127.0.0.1'
    port: int = 8765
    timeout_seconds: float = 30.0

    @property
    def stdio(self) -> bool:
        return self.transport == 'stdio'

    @property
    def has_credentials(self) -> bool:
        return bool(self.api_key) or bool(self.username and self.password)


def _normalise_url(url: str) -> str:
    url = url.strip()
    return url if url.endswith('/') else url + '/'


def load_settings(env: Mapping[str, str] | None = None, overrides: dict[str, Any] | None = None) -> Settings:
    """
    Build Settings from environment variables, then apply explicit overrides
    (CLI flags). `env` defaults to os.environ; pass a dict in tests.
    """
    source = os.environ if env is None else env
    settings = Settings(
        api_url=_normalise_url(source.get('CONSULTANCY_API_URL', DEFAULT_API_URL)),
        api_key=source.get('CONSULTANCY_API_KEY') or None,
        username=source.get('CONSULTANCY_USERNAME') or None,
        password=source.get('CONSULTANCY_PASSWORD') or None,
        read_only=_bool(source.get('CONSULTANCY_MCP_READ_ONLY'), False),
        max_download_bytes=_int(source.get('CONSULTANCY_MCP_MAX_DOWNLOAD_BYTES'), DEFAULT_MAX_DOWNLOAD_BYTES),
        transport=source.get('CONSULTANCY_MCP_TRANSPORT', 'stdio'),
        host=source.get('CONSULTANCY_MCP_HOST', '127.0.0.1'),
        port=_int(source.get('CONSULTANCY_MCP_PORT'), 8765),
        timeout_seconds=_float(source.get('CONSULTANCY_MCP_TIMEOUT_SECONDS'), 30.0),
    )
    if overrides:
        clean = {k: v for k, v in overrides.items() if v is not None}
        if 'api_url' in clean:
            clean['api_url'] = _normalise_url(clean['api_url'])
        settings = replace(settings, **clean)
    if settings.transport not in TRANSPORTS:
        raise ValueError(f'Unknown transport {settings.transport!r}; expected one of {TRANSPORTS}')
    return settings
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && python manage.py test mcp_server.tests.test_config`
Expected: `Ran 6 tests ... OK`

- [ ] **Step 6: Commit**

```bash
git add backend/requirements.txt backend/mcp_server/__init__.py backend/mcp_server/config.py backend/mcp_server/tests/__init__.py backend/mcp_server/tests/test_config.py
git commit -m "Add mcp_server package skeleton and settings parsing

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: ApiKey model, migration, DRF authentication class

**Files:**
- Modify: `backend/core/models.py` (append after `RecordTransfer`, line ~1243)
- Create: `backend/core/migrations/0011_api_key.py`
- Create: `backend/core/authentication.py`
- Modify: `backend/config/settings.py:214-217` (REST_FRAMEWORK auth classes)
- Modify: `backend/core/services.py:87-112` (`revoke_all_tokens`)
- Create: `backend/core/test_api_keys.py`

**Interfaces:**
- Produces: `core.models.ApiKey` with fields `user`, `name`, `prefix`, `key_hash`, `created_at`, `last_used_at`, `expires_at`, `revoked_at`; classmethod `ApiKey.issue(user, name, expires_at=None) -> tuple[ApiKey, str]`; staticmethod `ApiKey.hash_key(raw: str) -> str`; property `is_valid`; constant `ApiKey.KEY_PREFIX = 'cdk_'`.
- Produces: `core.authentication.ApiKeyAuthentication` returning `(user, api_key)`.
- Consumes: `core.services.revoke_all_tokens(user)` (existing) which now also revokes keys.

- [ ] **Step 1: Write the failing tests**

`backend/core/test_api_keys.py`:

```python
"""
Personal API keys: the credential an MCP client (or any script) uses to act as
one specific user. A key inherits the user's role, company and branch and is
revoked by the user, by an admin, or by anything that calls revoke_all_tokens.
"""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from core import services
from core.models import ApiKey, Branch, Role

User = get_user_model()
PASSWORD = 'Testing!2026xyz'

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


def mk(username, role, company, branch):
    user = User.objects.create(
        username=username, role=role, company=company, branch=branch,
        email=f'{username}@example.com',
    )
    user.set_password(PASSWORD)
    user.save()
    return user


@override_settings(REST_FRAMEWORK=RF)
class ApiKeyModelTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        services.ensure_default_plans()
        cls.company, cls.head_office = services.provision_company('Acme Consultancy')
        cls.emp = mk('emp', Role.EMPLOYEE, cls.company, cls.head_office)

    def setUp(self):
        cache.clear()

    def test_issue_returns_plaintext_once_and_stores_only_hash(self):
        key, raw = ApiKey.issue(self.emp, 'laptop')
        self.assertTrue(raw.startswith('cdk_'))
        self.assertEqual(len(raw), 4 + 40)
        self.assertEqual(key.prefix, raw[:12])
        self.assertEqual(key.key_hash, ApiKey.hash_key(raw))
        self.assertNotIn(raw, key.key_hash)
        self.assertTrue(key.is_valid)

    def test_revoked_or_expired_keys_are_not_valid(self):
        key, _ = ApiKey.issue(self.emp, 'a')
        key.revoked_at = timezone.now()
        self.assertFalse(key.is_valid)
        key2, _ = ApiKey.issue(self.emp, 'b', expires_at=timezone.now() - timedelta(seconds=1))
        self.assertFalse(key2.is_valid)

    def test_revoke_all_tokens_revokes_keys(self):
        key, _ = ApiKey.issue(self.emp, 'a')
        services.revoke_all_tokens(self.emp)
        key.refresh_from_db()
        self.assertIsNotNone(key.revoked_at)


@override_settings(REST_FRAMEWORK=RF)
class ApiKeyAuthenticationTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        services.ensure_default_plans()
        cls.company, cls.head_office = services.provision_company('Acme Consultancy')
        cls.emp = mk('emp', Role.EMPLOYEE, cls.company, cls.head_office)
        cls.admin = mk('admin', Role.COMPANY_ADMIN, cls.company, cls.head_office)

    def setUp(self):
        cache.clear()

    def client_with(self, raw, header='Bearer'):
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f'{header} {raw}')
        return client

    def test_bearer_api_key_authenticates_as_its_user(self):
        _, raw = ApiKey.issue(self.emp, 'k')
        response = self.client_with(raw).get('/api/users/me/')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['username'], 'emp')

    def test_x_api_key_header_also_works(self):
        _, raw = ApiKey.issue(self.emp, 'k')
        client = APIClient()
        client.credentials(HTTP_X_API_KEY=raw)
        self.assertEqual(client.get('/api/users/me/').status_code, 200)

    def test_unknown_key_is_401(self):
        response = self.client_with('cdk_' + 'x' * 40).get('/api/users/me/')
        self.assertEqual(response.status_code, 401)

    def test_revoked_key_is_401(self):
        key, raw = ApiKey.issue(self.emp, 'k')
        key.revoked_at = timezone.now()
        key.save(update_fields=['revoked_at'])
        self.assertEqual(self.client_with(raw).get('/api/users/me/').status_code, 401)

    def test_expired_key_is_401(self):
        _, raw = ApiKey.issue(self.emp, 'k', expires_at=timezone.now() - timedelta(minutes=1))
        self.assertEqual(self.client_with(raw).get('/api/users/me/').status_code, 401)

    def test_deactivated_user_key_is_refused(self):
        _, raw = ApiKey.issue(self.emp, 'k')
        self.emp.is_active_employee = False
        self.emp.save(update_fields=['is_active_employee'])
        self.assertEqual(self.client_with(raw).get('/api/users/me/').status_code, 401)

    def test_last_used_is_stamped(self):
        key, raw = ApiKey.issue(self.emp, 'k')
        self.assertIsNone(key.last_used_at)
        self.client_with(raw).get('/api/users/me/')
        key.refresh_from_db()
        self.assertIsNotNone(key.last_used_at)

    def test_jwt_login_still_works(self):
        client = APIClient()
        response = client.post('/api/auth/login/', {'username': 'emp', 'password': PASSWORD}, format='json')
        self.assertEqual(response.status_code, 200)
        client.credentials(HTTP_AUTHORIZATION=f'Bearer {response.data["access"]}')
        self.assertEqual(client.get('/api/users/me/').status_code, 200)

    def test_key_scope_matches_user_scope(self):
        """An employee's key sees only the employee's rows, like their JWT would."""
        from core.models import Enquiry
        Enquiry.objects.create(
            company=self.company, branch=self.head_office, created_by=self.admin, owner=self.admin,
            school_name='S', stream='Science', candidate_name='admin-owned', course_interested='B',
            mobile='9', email='a@example.com', father_name='F', mother_name='M', permanent_address='A',
        )
        _, raw = ApiKey.issue(self.emp, 'k')
        response = self.client_with(raw).get('/api/enquiries/')
        self.assertEqual(response.data['count'], 0)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python manage.py test core.test_api_keys`
Expected: `ImportError: cannot import name 'ApiKey' from 'core.models'`.

- [ ] **Step 3: Add the model**

Append to the end of `backend/core/models.py`:

```python


# ===========================================================================
#  Personal API keys
# ===========================================================================

class ApiKey(models.Model):
    """
    A long-lived credential that lets a script or an MCP client act as ONE
    user. It carries no permissions of its own: authentication resolves to the
    user, and every authorization decision is then the user's role, company
    and branch exactly as for a JWT session.

    Only the sha256 of the key is stored. `prefix` (the first 12 characters)
    exists so a user can recognise a key in a list without the hash ever being
    shown.
    """

    KEY_PREFIX = 'cdk_'
    KEY_RANDOM_LENGTH = 40

    user = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='api_keys',
    )
    name = models.CharField(max_length=80)
    prefix = models.CharField(max_length=12, db_index=True)
    key_hash = models.CharField(max_length=64, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)
    last_used_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [models.Index(fields=['user', 'revoked_at'])]

    def __str__(self):
        return f'{self.name} ({self.prefix}...)'

    @staticmethod
    def hash_key(raw):
        import hashlib
        return hashlib.sha256(raw.encode('utf-8')).hexdigest()

    @classmethod
    def generate_raw(cls):
        import secrets
        alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
        body = ''.join(secrets.choice(alphabet) for _ in range(cls.KEY_RANDOM_LENGTH))
        return cls.KEY_PREFIX + body

    @classmethod
    def issue(cls, user, name, expires_at=None):
        """Create a key and return (instance, plaintext). The plaintext is never stored."""
        raw = cls.generate_raw()
        instance = cls.objects.create(
            user=user, name=name, prefix=raw[:12], key_hash=cls.hash_key(raw), expires_at=expires_at,
        )
        return instance, raw

    @property
    def is_valid(self):
        if self.revoked_at is not None:
            return False
        if self.expires_at is not None and self.expires_at <= timezone.now():
            return False
        return True

    def revoke(self):
        if self.revoked_at is None:
            self.revoked_at = timezone.now()
            self.save(update_fields=['revoked_at'])
```

- [ ] **Step 4: Write the migration**

`backend/core/migrations/0011_api_key.py`:

```python
from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0010_link_documents_to_students'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='ApiKey',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=80)),
                ('prefix', models.CharField(db_index=True, max_length=12)),
                ('key_hash', models.CharField(max_length=64, unique=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('last_used_at', models.DateTimeField(blank=True, null=True)),
                ('expires_at', models.DateTimeField(blank=True, null=True)),
                ('revoked_at', models.DateTimeField(blank=True, null=True)),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='api_keys', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-created_at'],
                'indexes': [models.Index(fields=['user', 'revoked_at'], name='core_apikey_user_id_revoked_idx')],
            },
        ),
    ]
```

Run: `cd backend && python manage.py makemigrations --check --dry-run core`
Expected: `No changes detected in app 'core'`. If Django reports a differing index name, replace `name='core_apikey_user_id_revoked_idx'` with the name it prints and re-run until clean.

- [ ] **Step 5: Write the authentication class**

`backend/core/authentication.py`:

```python
"""
API-key authentication for scripts and MCP clients.

Accepts `Authorization: Bearer cdk_...` or `X-API-Key: cdk_...`. Anything that
does not start with the key prefix is ignored (returns None) so SimpleJWT keeps
handling ordinary bearer tokens. A matching but revoked, expired, or
deactivated-user key is a hard 401 rather than a fall-through: a client holding
a dead key should be told so, not silently treated as anonymous.
"""

from datetime import timedelta

from django.utils import timezone
from rest_framework import authentication, exceptions

from .models import ApiKey

LAST_USED_STAMP_INTERVAL = timedelta(minutes=1)


class ApiKeyAuthentication(authentication.BaseAuthentication):
    keyword = 'Bearer'

    def _raw_key(self, request):
        header = authentication.get_authorization_header(request).decode('latin-1')
        if header:
            parts = header.split()
            if len(parts) == 2 and parts[0].lower() == self.keyword.lower():
                candidate = parts[1]
                if candidate.startswith(ApiKey.KEY_PREFIX):
                    return candidate
        alt = request.META.get('HTTP_X_API_KEY', '')
        if alt.startswith(ApiKey.KEY_PREFIX):
            return alt.strip()
        return None

    def authenticate(self, request):
        raw = self._raw_key(request)
        if raw is None:
            return None
        try:
            key = ApiKey.objects.select_related('user', 'user__company', 'user__branch').get(
                key_hash=ApiKey.hash_key(raw),
            )
        except ApiKey.DoesNotExist:
            raise exceptions.AuthenticationFailed('Invalid API key.')
        if not key.is_valid:
            raise exceptions.AuthenticationFailed('This API key has been revoked or has expired.')
        user = key.user
        if not user.is_active or not getattr(user, 'is_active_employee', True):
            raise exceptions.AuthenticationFailed('This account is not active.')
        now = timezone.now()
        if key.last_used_at is None or now - key.last_used_at > LAST_USED_STAMP_INTERVAL:
            ApiKey.objects.filter(pk=key.pk).update(last_used_at=now)
            key.last_used_at = now
        return (user, key)

    def authenticate_header(self, request):
        return 'Bearer realm="api"'
```

- [ ] **Step 6: Wire settings and revoke_all_tokens**

In `backend/config/settings.py`, change the `DEFAULT_AUTHENTICATION_CLASSES` tuple to:

```python
    'DEFAULT_AUTHENTICATION_CLASSES': (
        # API keys first: they only claim `cdk_...` tokens and return None for
        # everything else, so JWT bearer tokens fall through unchanged.
        'core.authentication.ApiKeyAuthentication',
        'rest_framework_simplejwt.authentication.JWTAuthentication',
    ),
```

In `backend/core/services.py`, replace the body of `revoke_all_tokens` (keep the docstring) so it ends with key revocation:

```python
def revoke_all_tokens(user):
    """
    Blacklist every outstanding refresh token for a user, and revoke every
    personal API key.

    Identity claims (role/company/branch) are stamped onto the refresh token
    and copied forward by rotation without re-reading the user, so a demoted
    admin would otherwise keep admin-level UI routing for the whole
    REFRESH_TOKEN_LIFETIME — up to a week. The server still refused their
    requests, but "revoke this person's access" has to visibly take effect
    when it is done, not a week later. API keys are long-lived by design, so
    the same call revokes them too.

    Called whenever role, branch, company or active status changes.
    """
    from rest_framework_simplejwt.token_blacklist.models import (
        BlacklistedToken, OutstandingToken,
    )
    from .models import ApiKey

    revoked = 0
    for token in OutstandingToken.objects.filter(user=user):
        _, created = BlacklistedToken.objects.get_or_create(token=token)
        revoked += int(created)
    keys = ApiKey.objects.filter(user=user, revoked_at__isnull=True).update(revoked_at=timezone.now())
    if revoked or keys:
        logger.info('Revoked %s token(s) and %s API key(s) for user %s', revoked, keys, user.pk)
    return revoked
```

Check the original function's final line (`return revoked` or nothing) and keep the same return type.

- [ ] **Step 7: Run tests**

Run: `cd backend && python manage.py test core.test_api_keys`
Expected: `Ran 12 tests ... OK`

Run: `cd backend && python manage.py test core.test_authorization core.tests.AuthLifecycleTests`
Expected: OK (JWT paths unchanged).

- [ ] **Step 8: Commit**

```bash
git add backend/core/models.py backend/core/migrations/0011_api_key.py backend/core/authentication.py backend/config/settings.py backend/core/services.py backend/core/test_api_keys.py
git commit -m "Add personal API keys with DRF authentication class

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: API key endpoints

**Files:**
- Modify: `backend/core/serializers.py` (append)
- Modify: `backend/core/views.py` (append before `HealthView`, line ~1643)
- Modify: `backend/core/urls.py` (import + `router.register`)
- Modify: `backend/core/test_api_keys.py` (append endpoint tests)
- Modify: `backend/core/test_authorization.py` (add `api-keys/` to the exemption/ungoverned list so `test_every_registered_endpoint_has_a_rule` passes)

**Interfaces:**
- Produces: `GET /api/api-keys/` (paginated, own keys; company admin may pass `?user=<id>` for a user in their company; dev admin any user), `POST /api/api-keys/ {name, expires_at?}` → 201 `{id, name, prefix, created_at, last_used_at, expires_at, revoked_at, key}`, `POST /api/api-keys/{id}/revoke/` → 200 serialised key.
- Produces: `core.serializers.ApiKeySerializer`, `ApiKeyCreateSerializer`; `core.views.ApiKeyViewSet`.

- [ ] **Step 1: Append endpoint tests to `backend/core/test_api_keys.py`**

```python


@override_settings(REST_FRAMEWORK=RF)
class ApiKeyEndpointTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        services.ensure_default_plans()
        cls.company, cls.head_office = services.provision_company('Acme Consultancy')
        cls.rival, cls.rival_branch = services.provision_company('Rival Consultancy')
        cls.emp = mk('emp', Role.EMPLOYEE, cls.company, cls.head_office)
        cls.emp2 = mk('emp2', Role.EMPLOYEE, cls.company, cls.head_office)
        cls.admin = mk('admin', Role.COMPANY_ADMIN, cls.company, cls.head_office)
        cls.rival_admin = mk('rival_admin', Role.COMPANY_ADMIN, cls.rival, cls.rival_branch)
        cls.dev = mk('dev', Role.DEV_ADMIN, None, None)

    def setUp(self):
        cache.clear()

    def auth(self, user):
        client = APIClient()
        response = client.post('/api/auth/login/', {'username': user.username, 'password': PASSWORD}, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        client.credentials(HTTP_AUTHORIZATION=f'Bearer {response.data["access"]}')
        return client

    def test_create_returns_plaintext_once(self):
        client = self.auth(self.emp)
        response = client.post('/api/api-keys/', {'name': 'Claude Desktop'}, format='json')
        self.assertEqual(response.status_code, 201, response.data)
        self.assertTrue(response.data['key'].startswith('cdk_'))
        self.assertEqual(response.data['prefix'], response.data['key'][:12])
        self.assertNotIn('key_hash', response.data)
        listed = client.get('/api/api-keys/')
        self.assertEqual(listed.data['count'], 1)
        self.assertNotIn('key', listed.data['results'][0])
        self.assertNotIn('key_hash', listed.data['results'][0])

    def test_name_is_required(self):
        response = self.auth(self.emp).post('/api/api-keys/', {}, format='json')
        self.assertEqual(response.status_code, 400)
        self.assertIn('name', response.data['fields'])

    def test_expires_at_in_the_past_is_rejected(self):
        past = (timezone.now() - timedelta(days=1)).isoformat()
        response = self.auth(self.emp).post('/api/api-keys/', {'name': 'x', 'expires_at': past}, format='json')
        self.assertEqual(response.status_code, 400)

    def test_users_only_see_their_own_keys(self):
        ApiKey.issue(self.emp2, 'other')
        response = self.auth(self.emp).get('/api/api-keys/')
        self.assertEqual(response.data['count'], 0)

    def test_employee_cannot_list_another_users_keys(self):
        ApiKey.issue(self.emp2, 'other')
        response = self.auth(self.emp).get(f'/api/api-keys/?user={self.emp2.pk}')
        self.assertEqual(response.status_code, 403)

    def test_company_admin_can_list_and_revoke_staff_keys(self):
        key, _ = ApiKey.issue(self.emp, 'k')
        client = self.auth(self.admin)
        response = client.get(f'/api/api-keys/?user={self.emp.pk}')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['count'], 1)
        revoked = client.post(f'/api/api-keys/{key.pk}/revoke/')
        self.assertEqual(revoked.status_code, 200, revoked.data)
        key.refresh_from_db()
        self.assertIsNotNone(key.revoked_at)

    def test_company_admin_cannot_reach_other_tenant(self):
        key, _ = ApiKey.issue(self.rival_admin, 'k')
        client = self.auth(self.admin)
        self.assertEqual(client.get(f'/api/api-keys/?user={self.rival_admin.pk}').status_code, 403)
        self.assertEqual(client.post(f'/api/api-keys/{key.pk}/revoke/').status_code, 404)

    def test_dev_admin_can_list_any_user(self):
        ApiKey.issue(self.rival_admin, 'k')
        response = self.auth(self.dev).get(f'/api/api-keys/?user={self.rival_admin.pk}')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['count'], 1)

    def test_revoke_own_key_stops_it_working(self):
        client = self.auth(self.emp)
        created = client.post('/api/api-keys/', {'name': 'k'}, format='json')
        raw = created.data['key']
        keyed = APIClient()
        keyed.credentials(HTTP_AUTHORIZATION=f'Bearer {raw}')
        self.assertEqual(keyed.get('/api/users/me/').status_code, 200)
        self.assertEqual(client.post(f'/api/api-keys/{created.data["id"]}/revoke/').status_code, 200)
        self.assertEqual(keyed.get('/api/users/me/').status_code, 401)

    def test_revoke_twice_is_idempotent(self):
        client = self.auth(self.emp)
        created = client.post('/api/api-keys/', {'name': 'k'}, format='json')
        url = f'/api/api-keys/{created.data["id"]}/revoke/'
        self.assertEqual(client.post(url).status_code, 200)
        self.assertEqual(client.post(url).status_code, 200)

    def test_api_key_cannot_mint_or_manage_keys(self):
        """A leaked key must not be able to create a replacement for itself."""
        _, raw = ApiKey.issue(self.emp, 'k')
        keyed = APIClient()
        keyed.credentials(HTTP_AUTHORIZATION=f'Bearer {raw}')
        self.assertEqual(keyed.post('/api/api-keys/', {'name': 'clone'}, format='json').status_code, 403)
        self.assertEqual(keyed.get('/api/api-keys/').status_code, 403)
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python manage.py test core.test_api_keys.ApiKeyEndpointTests`
Expected: 404s / failures because `/api/api-keys/` does not exist.

- [ ] **Step 3: Add serializers**

Append to `backend/core/serializers.py` (the `ApiKey` name must be added to the `from .models import (...)` list at the top of the file):

```python


# ===========================================================================
#  Personal API keys
# ===========================================================================

class ApiKeySerializer(serializers.ModelSerializer):
    """Read shape. Never includes the hash; the plaintext exists only in the create response."""

    is_valid = serializers.BooleanField(read_only=True)
    user_name = serializers.CharField(source='user.username', read_only=True)

    class Meta:
        model = ApiKey
        fields = (
            'id', 'user', 'user_name', 'name', 'prefix', 'created_at', 'last_used_at',
            'expires_at', 'revoked_at', 'is_valid',
        )
        read_only_fields = fields


class ApiKeyCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=80)
    expires_at = serializers.DateTimeField(required=False, allow_null=True)

    def validate_expires_at(self, value):
        from django.utils import timezone
        if value is not None and value <= timezone.now():
            raise serializers.ValidationError('Expiry must be in the future.')
        return value
```

- [ ] **Step 4: Add the viewset**

In `backend/core/views.py` add `ApiKey` to the `from .models import (...)` list, `ApiKeyCreateSerializer, ApiKeySerializer` to the `from .serializers import (...)` list, then insert before `class HealthView`:

```python
# ===========================================================================
#  Personal API keys
# ===========================================================================

class ApiKeyViewSet(viewsets.GenericViewSet):
    """
    List, mint and revoke personal API keys.

    Three rules:
      * A key is only ever created for the CALLER. There is no "create a key
        for user X" — an admin who wants to act as a user asks them for a key.
      * A session authenticated BY an API key cannot manage keys at all, so a
        leaked key cannot mint a longer-lived replacement for itself.
      * `?user=<id>` lists (and `revoke` reaches) another user's keys only for
        company admins inside their own company and for dev admins.
    """

    serializer_class = ApiKeySerializer
    permission_classes = [IsAuthenticatedAndActive]
    ordering_fields = ('created_at', 'name', 'last_used_at')

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        if isinstance(getattr(request, 'auth', None), ApiKey):
            raise PermissionDenied('API keys cannot be managed with an API key. Sign in with your password.')

    def _target_user(self):
        """The user whose keys the caller is asking about, after the scope check."""
        request = self.request
        raw = request.query_params.get('user')
        if not raw:
            return request.user
        try:
            target_id = int(raw)
        except (TypeError, ValueError):
            raise ValidationError({'user': 'user must be a number.'})
        if target_id == request.user.id:
            return request.user
        if request.user.is_dev_admin:
            return User.objects.filter(pk=target_id).first() or request.user
        if request.user.is_company_admin:
            target = User.objects.filter(pk=target_id, company_id=request.user.company_id).first()
            if target is None:
                raise PermissionDenied('That user is not in your company.')
            return target
        raise PermissionDenied('You can only see your own API keys.')

    def get_queryset(self):
        user = self.request.user
        qs = ApiKey.objects.select_related('user')
        if self.action == 'list':
            return qs.filter(user=self._target_user())
        # Detail actions: own keys, plus company staff for admins, everything for dev admins.
        if user.is_dev_admin:
            return qs
        if user.is_company_admin:
            return qs.filter(user__company_id=user.company_id)
        return qs.filter(user=user)

    def list(self, request):
        qs = self.filter_queryset(self.get_queryset())
        page = self.paginate_queryset(qs)
        if page is not None:
            return self.get_paginated_response(self.get_serializer(page, many=True).data)
        return Response(self.get_serializer(qs, many=True).data)

    def create(self, request):
        serializer = ApiKeyCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        key, raw = ApiKey.issue(
            request.user, serializer.validated_data['name'],
            expires_at=serializer.validated_data.get('expires_at'),
        )
        security_log.info('API key %s created by %s', key.prefix, request.user.username)
        data = ApiKeySerializer(key).data
        data['key'] = raw
        return Response(data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['post'])
    def revoke(self, request, pk=None):
        key = self.get_object()
        key.revoke()
        security_log.info('API key %s revoked by %s', key.prefix, request.user.username)
        return Response(ApiKeySerializer(key).data)
```

- [ ] **Step 5: Register the route**

In `backend/core/urls.py` add `ApiKeyViewSet` to the `from .views import (...)` list and, under `# People`, add:

```python
router.register(r'api-keys', ApiKeyViewSet, basename='apikey')
```

- [ ] **Step 6: Satisfy the endpoint-coverage test**

Open `backend/core/test_authorization.py` and find the `UNGOVERNED` dict (line ~240; keys are router prefixes without slashes, values are the reason string). Add:

```python
    'api-keys': (
        'Own keys only; a company admin may list and revoke staff keys via '
        '?user=. Covered end to end by core.test_api_keys.'
    ),
```

- [ ] **Step 7: Run tests**

Run: `cd backend && python manage.py test core.test_api_keys core.test_authorization`
Expected: OK (23 api-key tests + the authorization suite).

- [ ] **Step 8: Commit**

```bash
git add backend/core/serializers.py backend/core/views.py backend/core/urls.py backend/core/test_api_keys.py backend/core/test_authorization.py
git commit -m "Add /api/api-keys/ endpoints for personal API keys

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Catalog builder and `export_mcp_catalog` command

**Files:**
- Create: `backend/core/mcp_catalog.py`
- Create: `backend/core/management/commands/export_mcp_catalog.py`
- Create: `backend/core/test_mcp_catalog.py`
- Create (generated): `backend/mcp_server/catalog.json`

**Interfaces:**
- Produces: `core.mcp_catalog.build_catalog() -> dict` with top-level keys `schema_version` (int, 1), `generated_at` (ISO string), `resources` (list of resource dicts), `standalone_endpoints` (list), `enums` (dict name→list of `{value,label}`), `roles` (dict), `approvals` (dict), `transfers` (dict), `conventions` (dict), `encrypted_fields` (list of `"Model.field"`).
- Produces: `core.mcp_catalog.render_tools_markdown(catalog: dict) -> str`.
- Produces: `core.mcp_catalog.ACTION_OVERLAY: dict[tuple[str, str], dict]` keyed by `(router_prefix, action_name)`.
- Produces: `core.mcp_catalog.RESOURCE_NAMES: dict[str, tuple[str, str]]` mapping router prefix → `(plural_snake, singular_snake)`.
- Resource dict shape (every key always present):

```json
{
  "prefix": "enquiries", "name": "enquiries", "singular": "enquiry",
  "model": "Enquiry", "entity_type": "enquiry",
  "methods": ["GET", "POST", "PATCH", "PUT", "DELETE"],
  "list_paginated": true,
  "permission_classes": ["ScopedObjectPermission", "SubscriptionActive"],
  "read_capability": null, "write_capability": null,
  "read_roles": ["DEV_ADMIN", "COMPANY_ADMIN", "HEAD_MANAGER", "BRANCH_MANAGER", "EMPLOYEE"],
  "write_roles": ["DEV_ADMIN", "COMPANY_ADMIN", "HEAD_MANAGER", "BRANCH_MANAGER", "EMPLOYEE"],
  "delete_requires_capability": "deleteRecords",
  "fields": [{"name": "candidate_name", "type": "string", "required": false, "read_only": false,
              "write_only": false, "choices": null, "max_length": 255, "related_model": null, "help": ""}],
  "filters": [{"param": "status", "kind": "multi", "lookup": "status__in", "choices": ["New","Contacted","Converted","Closed"]}],
  "search_fields": ["candidate_name", "school_name", "mobile", "email", "course_interested"],
  "ordering_fields": ["created_at", "status", "school_name"],
  "actions": [{"name": "download", "tool_name": "download_document", "method": "GET", "detail": true,
               "path": "documents/{id}/download/", "description": "...", "body": {...}, "response": "..."}],
  "notes": ["Creating a registration also creates a Payment row ..."]
}
```

- [ ] **Step 1: Write the failing tests**

`backend/core/test_mcp_catalog.py`:

```python
"""
The MCP catalog is generated from the running code and committed. These tests
keep the committed file honest and make sure nothing registered on the router
is missing from it.
"""

import json
from pathlib import Path

from django.test import SimpleTestCase

from core import mcp_catalog
from core.models import Capability, Role
from core.urls import router

CATALOG_PATH = Path(__file__).resolve().parent.parent / 'mcp_server' / 'catalog.json'


class CatalogBuildTests(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.catalog = mcp_catalog.build_catalog()
        cls.by_prefix = {r['prefix']: r for r in cls.catalog['resources']}

    def test_every_router_prefix_is_in_the_catalog(self):
        registered = {prefix for prefix, _, _ in router.registry}
        self.assertEqual(registered, set(self.by_prefix))

    def test_every_prefix_has_names(self):
        for prefix in self.by_prefix:
            with self.subTest(prefix=prefix):
                self.assertIn(prefix, mcp_catalog.RESOURCE_NAMES)
                plural, singular = mcp_catalog.RESOURCE_NAMES[prefix]
                self.assertRegex(plural, r'^[a-z_]+$')
                self.assertRegex(singular, r'^[a-z_]+$')

    def test_enquiry_fields_and_filters(self):
        enq = self.by_prefix['enquiries']
        names = {f['name'] for f in enq['fields']}
        self.assertIn('candidate_name', names)
        self.assertIn('date_of_birth', names)
        status = next(f for f in enq['fields'] if f['name'] == 'status')
        self.assertEqual([c['value'] for c in status['choices']], ['New', 'Contacted', 'Converted', 'Closed'])
        company = next(f for f in enq['fields'] if f['name'] == 'company')
        self.assertTrue(company['read_only'])
        params = {f['param']: f for f in enq['filters']}
        self.assertEqual(params['status']['kind'], 'multi')
        self.assertEqual(params['owner']['kind'], 'multi_id')
        self.assertEqual(params['preferred_locations']['kind'], 'json_any')
        self.assertEqual(enq['search_fields'], ['candidate_name', 'school_name', 'mobile', 'email', 'course_interested'])
        self.assertEqual(enq['entity_type'], 'enquiry')

    def test_plain_filterset_fields_are_single_exact(self):
        docs = self.by_prefix['documents']
        params = {f['param']: f for f in docs['filters']}
        self.assertEqual(params['registration']['kind'], 'exact')
        self.assertFalse(self.by_prefix['plans']['list_paginated'])

    def test_write_only_fields_are_marked(self):
        enr = self.by_prefix['enrollments']
        f = next(x for x in enr['fields'] if x['name'] == 'installments_count')
        self.assertTrue(f['write_only'])
        doc = self.by_prefix['documents']
        self.assertTrue(next(x for x in doc['fields'] if x['name'] == 'file')['write_only'])

    def test_methods_reflect_viewset_type(self):
        self.assertEqual(self.by_prefix['plans']['methods'], ['GET'])
        self.assertIn('DELETE', self.by_prefix['enquiries']['methods'])
        self.assertEqual(self.by_prefix['notifications']['methods'], ['GET'])

    def test_every_custom_action_is_listed_with_a_tool_name(self):
        expected = {
            ('users', 'me'), ('users', 'change_password'), ('users', 'set_active'), ('users', 'counselors'),
            ('subscriptions', 'mine'), ('payments', 'stats'), ('documents', 'download'),
            ('documents', 'expiring_soon'), ('tasks', 'reorder'), ('appointments', 'calendar'),
            ('student-documents', 'return_docs'), ('notifications', 'mark_read'),
            ('notifications', 'mark_all_read'), ('notifications', 'unread_count'),
            ('transfers', 'accept'), ('transfers', 'reject'), ('transfers', 'inbox'), ('transfers', 'outbox'),
            ('signup-requests', 'approve'), ('signup-requests', 'reject'),
            ('approval-requests', 'pending_count'), ('approval-requests', 'my_requests'),
            ('approval-requests', 'approve'), ('approval-requests', 'reject'),
            ('api-keys', 'revoke'),
        }
        found = {(r['prefix'], a['name']) for r in self.catalog['resources'] for a in r['actions']}
        self.assertTrue(expected <= found, expected - found)
        tool_names = [a['tool_name'] for r in self.catalog['resources'] for a in r['actions']]
        self.assertEqual(len(tool_names), len(set(tool_names)), 'tool names must be unique')
        for name in tool_names:
            self.assertRegex(name, r'^[a-z][a-z0-9_]*$')

    def test_enums_roles_and_rules(self):
        enums = self.catalog['enums']
        self.assertEqual([e['value'] for e in enums['Role']], [r.value for r in Role])
        self.assertEqual({e['value'] for e in enums['Capability']}, {c.value for c in Capability})
        self.assertEqual([e['value'] for e in enums['VisaTracking.current_stage']],
                         ['Documents', 'Applied', 'Biometrics', 'Interview', 'Decision', 'Approved', 'Rejected'])
        roles = self.catalog['roles']
        self.assertEqual(roles['rank']['DEV_ADMIN'], 5)
        self.assertEqual(roles['defaults']['manageCompanies'], ['DEV_ADMIN'])
        self.assertEqual(roles['protected']['manageUsers']['floor'], 'COMPANY_ADMIN')
        self.assertEqual(roles['admin_essentials'], ['manageSettings', 'manageUsers'])
        self.assertEqual(self.catalog['approvals']['mutable_fields']['payment'], ['status', 'method', 'reference'])
        self.assertEqual(set(self.catalog['transfers']['transferable']),
                         {'enquiry', 'registration', 'enrollment', 'document', 'task', 'follow_up', 'visa_tracking'})
        self.assertIn('VisaTracking.passport_no', self.catalog['encrypted_fields'])
        self.assertEqual(self.catalog['conventions']['pagination']['max_page_size'], 200)

    def test_standalone_endpoints(self):
        paths = {e['path'] for e in self.catalog['standalone_endpoints']}
        for p in ('auth/login/', 'auth/refresh/', 'auth/logout/', 'role-permissions/', 'role-permissions/mine/',
                  'analytics/overview/', 'analytics/funnel/', 'analytics/revenue/', 'analytics/branches/',
                  'analytics/visa-pipeline/', 'analytics/sources/', 'health/'):
            self.assertIn(p, paths)

    def test_catalog_is_json_serialisable(self):
        json.dumps(self.catalog)

    def test_markdown_render_lists_every_tool(self):
        md = mcp_catalog.render_tools_markdown(self.catalog)
        self.assertIn('| `list_enquiries` |', md)
        self.assertIn('| `download_document` |', md)


class CatalogFreshnessTests(SimpleTestCase):
    def test_committed_catalog_matches_code(self):
        self.assertTrue(CATALOG_PATH.exists(), 'Run: python manage.py export_mcp_catalog')
        committed = json.loads(CATALOG_PATH.read_text(encoding='utf-8'))
        current = mcp_catalog.build_catalog()
        committed.pop('generated_at', None)
        current.pop('generated_at', None)
        self.assertEqual(
            committed, current,
            'mcp_server/catalog.json is stale. Run: python manage.py export_mcp_catalog',
        )
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python manage.py test core.test_mcp_catalog`
Expected: `ModuleNotFoundError: No module named 'core.mcp_catalog'`.

- [ ] **Step 3: Write the builder**

`backend/core/mcp_catalog.py`:

```python
"""
Build the MCP catalog: a JSON description of every API resource, field, filter,
action, enum and authorization rule, generated from the code that enforces it.

The MCP server reads the committed `mcp_server/catalog.json`; the test in
core/test_mcp_catalog.py fails when the file no longer matches this builder.
"""

from __future__ import annotations

import datetime as dt

from django.conf import settings
from django.db import models
from django_filters import rest_framework as df
from rest_framework import serializers as drf_serializers
from rest_framework.request import Request
from rest_framework.test import APIRequestFactory

from . import capabilities, services
from .filters import JSONContainsAnyFilter, MultiValueFilter, MultiValueIdFilter
from .models import (
    ApprovalRequest, Appointment, Capability, Commission, Document, Enquiry, FollowUp,
    Notification, Payment, RecordTransfer, Refund, Registration, Role, SignupRequest,
    StudentDocument, Subscription, Template, VisaTracking,
)
from .permissions import (
    CanManageAgents, CanManageCommissions, CanManageOwnCompany, CanManageRefunds,
    ReadOnlyOrCompanyAdmin, ReadOnlyOrManager, ScopedObjectPermission,
)
from .urls import router
from .views import ApprovalRequestViewSet

SCHEMA_VERSION = 1

# router prefix -> (plural snake_case, singular snake_case). Every registered
# prefix must be here; the test enforces it.
RESOURCE_NAMES = {
    'companies': ('companies', 'company'),
    'branches': ('branches', 'branch'),
    'plans': ('plans', 'plan'),
    'subscriptions': ('subscriptions', 'subscription'),
    'users': ('users', 'user'),
    'api-keys': ('api_keys', 'api_key'),
    'enquiries': ('enquiries', 'enquiry'),
    'registrations': ('registrations', 'registration'),
    'enrollments': ('enrollments', 'enrollment'),
    'installments': ('installments', 'installment'),
    'payments': ('payments', 'payment'),
    'documents': ('documents', 'document'),
    'tasks': ('tasks', 'task'),
    'appointments': ('appointments', 'appointment'),
    'universities': ('universities', 'university'),
    'templates': ('templates', 'template'),
    'notifications': ('notifications', 'notification'),
    'agents': ('agents', 'agent'),
    'commissions': ('commissions', 'commission'),
    'refunds': ('refunds', 'refund'),
    'visa-tracking': ('visa_tracking', 'visa_tracking'),
    'follow-ups': ('follow_ups', 'follow_up'),
    'follow-up-comments': ('follow_up_comments', 'follow_up_comment'),
    'student-remarks': ('student_remarks', 'student_remark'),
    'student-documents': ('student_documents', 'student_document'),
    'transfers': ('transfers', 'transfer'),
    'signup-requests': ('signup_requests', 'signup_request'),
    'approval-requests': ('approval_requests', 'approval_request'),
}

ALL = [r.value for r in Role]
ADMINS = ['DEV_ADMIN', 'COMPANY_ADMIN']
MANAGERS_UP = ADMINS + ['HEAD_MANAGER', 'BRANCH_MANAGER']

# Read/write rule per permission class, expressed as (read_capability,
# write_capability, read_roles, write_roles). Capability-backed rules list the
# DEFAULT roles; the live matrix may widen or narrow them per company.
PERMISSION_RULES = {
    'ScopedObjectPermission': (None, None, ALL, ALL),
    'IsAuthenticatedAndActive': (None, None, ALL, ALL),
    'CanManageOwnCompany': ('manageSettings', 'manageSettings', ADMINS, ADMINS),
    'ReadOnlyOrCompanyAdmin': (None, 'manageBranches', ALL, ADMINS),
    'ReadOnlyOrManager': (None, None, ALL, MANAGERS_UP),
    'CanManageAgents': ('manageCommissions', 'manageCommissions', ADMINS, ADMINS),
    'CanManageCommissions': ('viewEarnings', 'manageCommissions', ADMINS + ['HEAD_MANAGER'], ADMINS),
    'CanManageRefunds': (None, 'manageRefunds', ALL, MANAGERS_UP),
    'AllowAny': (None, None, ALL + ['ANONYMOUS'], ALL + ['ANONYMOUS']),
    'IsDevAdmin': ('manageCompanies', 'manageCompanies', ['DEV_ADMIN'], ['DEV_ADMIN']),
}

# Hand-written knowledge about custom actions that introspection cannot see:
# the tool name the MCP server exposes, the request body and the response.
# Keyed by (router prefix, action method name).
ACTION_OVERLAY = {
    ('users', 'me'): {
        'tool_name': 'get_me', 'description': 'The calling user (UserSerializer).',
        'body': {}, 'response': 'User object',
    },
    ('users', 'change_password'): {
        'tool_name': 'change_password',
        'description': 'Change the caller\'s own password. The current password is verified.',
        'body': {'current_password': 'string, required', 'new_password': 'string, required (Django validators apply)'},
        'response': '{"status": "Password updated."}',
    },
    ('users', 'set_active'): {
        'tool_name': 'set_user_active',
        'description': 'Activate or deactivate a staff account (is_active_employee). Needs manageUsers. Deactivation revokes all of that user\'s tokens and API keys. You cannot target yourself.',
        'body': {'is_active': 'boolean, required'}, 'response': 'User object',
    },
    ('users', 'counselors'): {
        'tool_name': 'list_counselors',
        'description': 'Counselor performance rows (EMPLOYEE and BRANCH_MANAGER accounts in scope). UNPAGINATED bare array.',
        'body': {}, 'response': '[{id, name, email, avatar, branch, totalEnquiries, converted, registrations, enrollments, conversionRate}]',
    },
    ('subscriptions', 'mine'): {
        'tool_name': 'get_my_subscription', 'description': 'The caller\'s company subscription, or 404 when none.',
        'body': {}, 'response': 'Subscription object',
    },
    ('payments', 'stats'): {
        'tool_name': 'payment_stats',
        'description': 'Revenue aggregates over the caller\'s scope. Cached for SCOPED_CACHE_SECONDS (default 30 s); the X-Cache header says HIT or MISS.',
        'body': {}, 'response': '{"totalRevenue", "thisMonthRevenue", "pendingAmount", "transactionCount"}',
    },
    ('documents', 'download'): {
        'tool_name': 'download_document',
        'description': 'Stream the decrypted file. Handled by the documents tool module, not generated.',
        'body': {}, 'response': 'binary file', 'skip_generated': True,
    },
    ('documents', 'expiring_soon'): {
        'tool_name': 'documents_expiring_soon',
        'description': 'Documents whose expiry_date is on or before today + days (default 30). Paginated.',
        'body': {}, 'query': {'days': 'integer, default 30'}, 'response': 'paginated Document list',
    },
    ('tasks', 'reorder'): {
        'tool_name': 'reorder_tasks',
        'description': 'Persist kanban order. Writes `position` in the given order; when `status` is supplied it is applied to tasks whose status differs, and moving to Done sets completed_at. Ids outside the caller\'s scope are skipped.',
        'body': {'ids': 'list of task ids in order, required', 'status': 'string, optional'},
        'response': '{"reordered": n, "requested": m}',
    },
    ('appointments', 'calendar'): {
        'tool_name': 'appointments_calendar',
        'description': 'Appointments in one calendar month, after the normal filters/search. UNPAGINATED bare array.',
        'body': {}, 'query': {'month': 'integer 1-12, required', 'year': 'integer, required'}, 'response': '[Appointment]',
    },
    ('student-documents', 'return_docs'): {
        'tool_name': 'return_student_documents',
        'description': 'Mark physical documents Returned (returned_at=now, current_holder cleared). Skips rows already Returned.',
        'body': {'document_ids': 'list of student-document ids, required'},
        'response': '{"returned": n, "requested": m, "ids": [...]}',
    },
    ('notifications', 'mark_read'): {
        'tool_name': 'mark_notification_read', 'description': 'Mark one notification read.',
        'body': {}, 'response': 'Notification object',
    },
    ('notifications', 'mark_all_read'): {
        'tool_name': 'mark_all_notifications_read', 'description': 'Mark every unread notification read.',
        'body': {}, 'response': '{"updated": n}',
    },
    ('notifications', 'unread_count'): {
        'tool_name': 'unread_notification_count', 'description': 'Count of unread notifications.',
        'body': {}, 'response': '{"count": n}',
    },
    ('transfers', 'accept'): {
        'tool_name': 'accept_transfer',
        'description': 'Accept a PENDING transfer addressed to the caller. Moves owner (and branch, and assigned_to where present) to the caller.',
        'body': {}, 'response': 'RecordTransfer object',
    },
    ('transfers', 'reject'): {
        'tool_name': 'reject_transfer', 'description': 'Reject a PENDING transfer addressed to the caller.',
        'body': {}, 'response': 'RecordTransfer object',
    },
    ('transfers', 'inbox'): {
        'tool_name': 'transfer_inbox', 'description': 'PENDING transfers addressed to the caller. Paginated.',
        'body': {}, 'response': 'paginated RecordTransfer list',
    },
    ('transfers', 'outbox'): {
        'tool_name': 'transfer_outbox', 'description': 'Transfers the caller has sent, any status. Paginated.',
        'body': {}, 'response': 'paginated RecordTransfer list',
    },
    ('signup-requests', 'approve'): {
        'tool_name': 'approve_signup_request',
        'description': 'DEV_ADMIN. Provision the company (Head Office branch, active subscription) and its COMPANY_ADMIN account.',
        'body': {}, 'response': '{"status": "approved", "company": id, "user": id}',
    },
    ('signup-requests', 'reject'): {
        'tool_name': 'reject_signup_request', 'description': 'DEV_ADMIN. Reject a pending signup request.',
        'body': {'reason': 'string'}, 'response': '{"status": "rejected"}',
    },
    ('approval-requests', 'pending_count'): {
        'tool_name': 'approval_pending_count', 'description': 'Count of approval requests in the caller\'s queue.',
        'body': {}, 'response': '{"count": n}',
    },
    ('approval-requests', 'my_requests'): {
        'tool_name': 'my_approval_requests', 'description': 'Approval requests the caller raised. Paginated.',
        'body': {}, 'response': 'paginated ApprovalRequest list',
    },
    ('approval-requests', 'approve'): {
        'tool_name': 'approve_approval_request',
        'description': 'Needs reviewApprovals. Re-checks the reviewer\'s write scope on the live target. DELETE deletes it; UPDATE applies only allowlisted fields (see approvals.mutable_fields).',
        'body': {'note': 'string, optional review note'}, 'response': 'ApprovalRequest object',
    },
    ('approval-requests', 'reject'): {
        'tool_name': 'reject_approval_request', 'description': 'Needs reviewApprovals.',
        'body': {'note': 'string, optional'}, 'response': 'ApprovalRequest object',
    },
    ('api-keys', 'revoke'): {
        'tool_name': 'revoke_api_key',
        'description': 'Revoke a personal API key. Not callable when authenticated with an API key.',
        'body': {}, 'response': 'ApiKey object',
    },
}

RESOURCE_NOTES = {
    'registrations': [
        'Creating a registration also creates a Payment (type Registration, amount = registration_fee, '
        'status Success when payment_status is "Paid" case-insensitively, else Pending).',
        'registration_no is server-assigned as REG-<year>-NNN when omitted.',
        'There is no convert endpoint: to convert an enquiry, create a registration with `enquiry` set.',
    ],
    'enrollments': [
        'enrollment_no is server-assigned as ENR-<year>-NNN when omitted.',
        'Pass installments_count (and optionally installment_amount) to have the server build Installment rows '
        'that sum exactly to total_fees, due monthly from start_date. Never build schedules client-side.',
        'student must be a Registration id in the caller\'s company; university may be a shared (company=null) row.',
    ],
    'installments': ['Read-only in practice: POST cannot work because `enrollment` is read-only on the serializer.'],
    'payments': ['Only status Success counts as revenue. metadata is a free JSON object for method detail.'],
    'documents': [
        'Uploads are multipart/form-data with a write-only `file` field; JSON is accepted for metadata-only writes.',
        'A document links to at most one of registration / enquiry; student_name is derived from that link.',
        'Files are encrypted at rest; download only via documents/{id}/download/.',
    ],
    'student-documents': ['Custody of PHYSICAL originals, distinct from uploaded scans (documents).'],
    'follow-up-comments': ['Append-only: update and delete return 403.'],
    'student-remarks': ['Append-only: update and delete return 403.'],
    'universities': ['Rows with company=null are a shared catalogue visible to every tenant.'],
    'notifications': ['Read-only; created by server signals (currently: new enrollment).'],
    'agents': ['total_earned, pending_amount, students_referred are recomputed by signals from commissions.'],
    'commissions': ['agent and commission_amount (>= 0.01) are required on create.'],
    'visa-tracking': ['passport_no is encrypted; it cannot be filtered or searched.'],
    'transfers': [
        'Manager-level senders apply immediately (requires_acceptance=false); employee-to-employee stays PENDING until accepted.',
        'A transfer MOVES ownership: the sender loses access.',
    ],
    'approval-requests': [
        'Employees (no deleteRecords) delete or update restricted fields by raising a request here.',
        'entity_type must be one of the transfers/approvals allowlist; `appointment` is accepted by the model but rejected at validation.',
    ],
    'users': [
        'Serializer depends on the CALLER: admins get UserAdminSerializer (role, branch, password, managed_managers writable).',
        'Head/branch managers may only create EMPLOYEE accounts in their own branches.',
    ],
    'branches': ['The default branch cannot be deleted; a branch with users cannot be deleted.'],
    'api-keys': ['Keys are created only for the caller; the plaintext is returned once.'],
}

ANALYTICS = [
    ('analytics/overview/', 'IsAuthenticatedAndActive', {}, 'object: enquiries, registrations, enrollments, converted, conversionRate, revenueThisMonth, totalRevenue, pendingPayments and month-over-month trends'),
    ('analytics/funnel/', 'IsManagerOrAbove (viewAnalytics)', {}, '{"stages": [{stage, count, rate}], "dropOff": {...}}'),
    ('analytics/revenue/', 'IsManagerOrAbove (viewAnalytics)', {'months': 'int 1-36, default 12'}, '{"series": [{month, label, revenue, transactions, registrationFees, enrollmentFees, otherFees, commissions}]}'),
    ('analytics/branches/', 'IsManagerOrAbove (viewAnalytics)', {}, 'bare array of {id, name, city, staff, enquiries, registrations, enrollments, revenue, conversionRate}'),
    ('analytics/visa-pipeline/', 'IsAuthenticatedAndActive', {}, '{"pipeline": [{stage, count}], "total": n}'),
    ('analytics/sources/', 'IsManagerOrAbove (viewAnalytics)', {}, 'bare array of {source, total, converted, conversionRate}'),
]


def _choices(field):
    choices = getattr(field, 'choices', None)
    if not choices:
        return None
    out = []
    items = choices.items() if hasattr(choices, 'items') else choices
    for value, label in items:
        out.append({'value': value, 'label': str(label)})
    return out


def _field_type(field):
    mapping = (
        (drf_serializers.BooleanField, 'boolean'),
        (drf_serializers.IntegerField, 'integer'),
        (drf_serializers.DecimalField, 'decimal'),
        (drf_serializers.FloatField, 'number'),
        (drf_serializers.DateTimeField, 'datetime'),
        (drf_serializers.DateField, 'date'),
        (drf_serializers.TimeField, 'time'),
        (drf_serializers.FileField, 'file'),
        (drf_serializers.JSONField, 'json'),
        (drf_serializers.ListField, 'list'),
        (drf_serializers.ManyRelatedField, 'list_of_ids'),
        (drf_serializers.PrimaryKeyRelatedField, 'id'),
        (drf_serializers.EmailField, 'email'),
        (drf_serializers.URLField, 'url'),
        (drf_serializers.ChoiceField, 'choice'),
        (drf_serializers.CharField, 'string'),
        (drf_serializers.BaseSerializer, 'object'),
        (drf_serializers.SerializerMethodField, 'computed'),
    )
    for klass, name in mapping:
        if isinstance(field, klass):
            return name
    return 'string'


def _related_model(field):
    qs = getattr(field, 'queryset', None)
    if qs is None and isinstance(field, drf_serializers.ManyRelatedField):
        qs = getattr(field.child_relation, 'queryset', None)
    if qs is not None:
        return qs.model.__name__
    return None


def _fake_request(viewset_class):
    factory = APIRequestFactory()
    request = Request(factory.get('/'))
    request.user = _AnonymousProbe()
    return request


class _AnonymousProbe:
    """Enough of a user for serializer __init__ scoping to run without a database."""
    is_authenticated = False
    company_id = None
    is_dev_admin = False
    can_manage_users = False
    role = None


def _serializer_fields(viewset_class):
    view = viewset_class()
    view.action = 'create'
    view.request = _fake_request(viewset_class)
    view.format_kwarg = None
    try:
        serializer_class = view.get_serializer_class()
    except Exception:
        serializer_class = viewset_class.serializer_class
    serializer = serializer_class(context={'request': view.request, 'view': view})
    out = []
    for name, field in serializer.fields.items():
        out.append({
            'name': name,
            'type': _field_type(field),
            'required': bool(getattr(field, 'required', False)) and not field.read_only,
            'read_only': bool(field.read_only),
            'write_only': bool(getattr(field, 'write_only', False)),
            'choices': _choices(field) if isinstance(field, drf_serializers.ChoiceField) else None,
            'max_length': getattr(field, 'max_length', None),
            'related_model': _related_model(field),
            'help': str(getattr(field, 'help_text', '') or ''),
        })
    return out


def _model_choices_for(model, field_name):
    try:
        f = model._meta.get_field(field_name)
    except Exception:
        return None
    if getattr(f, 'choices', None):
        return [c[0] for c in f.choices]
    return None


def _filters(viewset_class):
    out = []
    fs = getattr(viewset_class, 'filterset_class', None)
    if fs is not None:
        for param, flt in fs.base_filters.items():
            if isinstance(flt, JSONContainsAnyFilter):
                kind = 'json_any'
            elif isinstance(flt, MultiValueIdFilter):
                kind = 'multi_id'
            elif isinstance(flt, MultiValueFilter):
                kind = 'multi'
            elif isinstance(flt, df.BooleanFilter):
                kind = 'boolean'
            else:
                kind = 'exact'
            lookup = f'{flt.field_name}__in' if kind in ('multi', 'multi_id') else flt.field_name
            out.append({
                'param': param, 'kind': kind, 'lookup': lookup,
                'choices': _model_choices_for(fs._meta.model, flt.field_name) if kind == 'multi' else None,
            })
        return out
    model = viewset_class.queryset.model
    for name in getattr(viewset_class, 'filterset_fields', ()) or ():
        out.append({'param': name, 'kind': 'exact', 'lookup': name, 'choices': _model_choices_for(model, name)})
    return out


def _methods(viewset_class):
    verbs = []
    if hasattr(viewset_class, 'list') or hasattr(viewset_class, 'retrieve'):
        verbs.append('GET')
    if hasattr(viewset_class, 'create'):
        verbs.append('POST')
    if hasattr(viewset_class, 'partial_update'):
        verbs.append('PATCH')
    if hasattr(viewset_class, 'update'):
        verbs.append('PUT')
    if hasattr(viewset_class, 'destroy'):
        verbs.append('DELETE')
    return verbs


def _permission_summary(viewset_class):
    names = [p.__name__ for p in getattr(viewset_class, 'permission_classes', [])]
    names = [n for n in names if n != 'SubscriptionActive'] or ['IsAuthenticatedAndActive']
    rule = PERMISSION_RULES.get(names[0], PERMISSION_RULES['IsAuthenticatedAndActive'])
    return names, rule


def _actions(prefix, viewset_class):
    out = []
    for attr in dir(viewset_class):
        fn = getattr(viewset_class, attr, None)
        mapping = getattr(fn, 'mapping', None)
        if not mapping or not hasattr(fn, 'detail'):
            continue
        url_path = getattr(fn, 'url_path', attr)
        method = sorted(m.upper() for m in mapping)[0]
        overlay = ACTION_OVERLAY.get((prefix, attr), {})
        path = f'{prefix}/{{id}}/{url_path}/' if fn.detail else f'{prefix}/{url_path}/'
        out.append({
            'name': attr,
            'tool_name': overlay.get('tool_name', f'{attr}_{RESOURCE_NAMES[prefix][1]}'),
            'method': method,
            'detail': bool(fn.detail),
            'path': path,
            'description': overlay.get('description', (fn.__doc__ or '').strip()),
            'body': overlay.get('body', {}),
            'query': overlay.get('query', {}),
            'response': overlay.get('response', ''),
            'skip_generated': overlay.get('skip_generated', False),
        })
    out.sort(key=lambda a: a['name'])
    return out


def _resource(prefix, viewset_class):
    plural, singular = RESOURCE_NAMES[prefix]
    names, (read_cap, write_cap, read_roles, write_roles) = _permission_summary(viewset_class)
    model = viewset_class.queryset.model if getattr(viewset_class, 'queryset', None) is not None else None
    is_scoped = issubclass(viewset_class, __import__('core.views', fromlist=['ScopedModelViewSet']).ScopedModelViewSet)
    return {
        'prefix': prefix,
        'name': plural,
        'singular': singular,
        'model': model.__name__ if model is not None else None,
        'entity_type': getattr(viewset_class, 'entity_type', None),
        'methods': _methods(viewset_class),
        'list_paginated': getattr(viewset_class, 'pagination_class', 'default') is not None,
        'permission_classes': names,
        'read_capability': read_cap,
        'write_capability': write_cap,
        'read_roles': list(read_roles),
        'write_roles': list(write_roles),
        'delete_requires_capability': 'deleteRecords' if is_scoped else None,
        'fields': _serializer_fields(viewset_class),
        'filters': _filters(viewset_class),
        'search_fields': list(getattr(viewset_class, 'search_fields', ()) or ()),
        'ordering_fields': list(getattr(viewset_class, 'ordering_fields', ()) or ()),
        'actions': _actions(prefix, viewset_class),
        'notes': RESOURCE_NOTES.get(prefix, []),
    }


def _enum(name, choices, out):
    out[name] = [{'value': c[0], 'label': str(c[1])} for c in choices]


def _enums():
    out = {}
    _enum('Role', Role.choices, out)
    _enum('Capability', Capability.choices, out)
    _enum('Subscription.status', Subscription.Status.choices, out)
    _enum('Enquiry.status', Enquiry.Status.choices, out)
    _enum('Payment.status', Payment.Status.choices, out)
    _enum('Document.status', Document.Status.choices, out)
    _enum('Appointment.type', Appointment.TYPE_CHOICES, out)
    _enum('Appointment.status', Appointment.STATUS_CHOICES, out)
    _enum('Template.category', Template.CATEGORY_CHOICES, out)
    _enum('Notification.type', Notification.TYPE_CHOICES, out)
    _enum('Commission.status', Commission.STATUS_CHOICES, out)
    _enum('Refund.status', Refund.Status.choices, out)
    _enum('VisaTracking.current_stage', VisaTracking.STAGE_CHOICES, out)
    _enum('FollowUp.outcome_status', FollowUp.Outcome.choices, out)
    _enum('FollowUp.admission_possibility', FollowUp.Likelihood.choices, out)
    _enum('SignupRequest.status', SignupRequest.STATUS_CHOICES, out)
    _enum('ApprovalRequest.action', ApprovalRequest.Action.choices, out)
    _enum('ApprovalRequest.status', ApprovalRequest.Status.choices, out)
    _enum('ApprovalRequest.entity_type', ApprovalRequest.ENTITY_CHOICES, out)
    _enum('RecordTransfer.status', RecordTransfer.Status.choices, out)
    _enum('RecordTransfer.entity_type', RecordTransfer.ENTITY_CHOICES, out)
    _enum('StudentDocument.status', StudentDocument.Status.choices, out)
    return out


def _roles():
    return {
        'rank': {r.value: rank for r, rank in capabilities.ROLE_RANK.items()},
        'defaults': {cap.value: [r.value for r in roles] for cap, roles in capabilities.DEFAULTS.items()},
        'protected': {
            cap.value: {'floor': floor.value, 'reason': reason}
            for cap, (floor, reason) in capabilities.PROTECTED.items()
        },
        'admin_essentials': [c.value for c in capabilities.ADMIN_ESSENTIALS],
        'visibility': {
            'DEV_ADMIN': 'everything, all companies',
            'COMPANY_ADMIN': 'everything in own company',
            'HEAD_MANAGER': 'records in the branches of the branch managers assigned to them (managed_managers), plus own branch',
            'BRANCH_MANAGER': 'records in own branch',
            'EMPLOYEE': 'records they OWN (owner field), plus records transferred to them and accepted',
        },
    }


def _conventions():
    # Production rates, not the DEBUG-relaxed ones, so the committed catalog
    # does not depend on the generating machine's .env.
    from config.settings import _throttle_rates
    rates = _throttle_rates(False)
    return {
        'base_path': '/api/',
        'trailing_slash_required': True,
        'auth': {
            'api_key': 'Authorization: Bearer cdk_... (or X-API-Key)',
            'jwt': 'POST auth/login/ {username,password} -> {access, refresh, user}; access lifetime minutes; POST auth/refresh/ {refresh} rotates both',
        },
        'pagination': {
            'style': 'page number', 'page_param': 'page', 'page_size_param': 'page_size',
            'default_page_size': 25, 'max_page_size': 200,
            'envelope': ['count', 'pages', 'page', 'page_size', 'next', 'previous', 'results'],
            'bare_array_endpoints': ['users/counselors/', 'appointments/calendar/', 'analytics/branches/', 'analytics/sources/', 'plans/'],
        },
        'errors': {
            'shape': '{"error": "<message>"} or {"error": "Validation failed", "fields": {...}}',
            '409': 'That operation conflicts with existing data.',
        },
        'multi_value_query_params': 'repeat the key: ?status=New&status=Contacted (never comma-separated)',
        'search_param': 'search', 'ordering_param': 'ordering (prefix - for descending)',
        'throttle_rates': dict(rates),
        'cache_header': 'X-Cache: HIT | MISS | DISABLED on analytics and payments/stats',
        'uploads': {
            'max_bytes': settings.MAX_DOCUMENT_SIZE_BYTES,
            'allowed_extensions': list(settings.ALLOWED_DOCUMENT_EXTENSIONS),
            'content_type': 'multipart/form-data',
        },
    }


def build_catalog():
    resources = []
    for prefix, viewset_class, _basename in router.registry:
        resources.append(_resource(prefix, viewset_class))
    resources.sort(key=lambda r: r['prefix'])

    standalone = [
        {'path': 'auth/login/', 'method': 'POST', 'permission': 'AllowAny', 'throttle': 'login 8/min',
         'body': {'username': 'string', 'password': 'string'}, 'response': '{"access", "refresh", "user"}; 403 when deactivated'},
        {'path': 'auth/refresh/', 'method': 'POST', 'permission': 'AllowAny', 'throttle': '',
         'body': {'refresh': 'string'}, 'response': '{"access", "refresh"} (rotation)'},
        {'path': 'auth/logout/', 'method': 'POST', 'permission': 'IsAuthenticatedAndActive', 'throttle': '',
         'body': {'refresh': 'string'}, 'response': '205 empty'},
        {'path': 'role-permissions/', 'method': 'GET', 'permission': 'CanManageSettings (manageSettings)', 'throttle': '',
         'body': {}, 'query': {'company': 'DEV_ADMIN only'}, 'response': '{company, company_name, roles[], capabilities[], matrix{role:{capability:{allowed, source, editable, can_grant, can_revoke, reason}}}}'},
        {'path': 'role-permissions/', 'method': 'PUT', 'permission': 'CanManageSettings (manageSettings)', 'throttle': '',
         'body': {'changes': '[{role, capability, allowed: true|false|null}]', 'company': 'DEV_ADMIN only'},
         'response': 'same as GET; whole batch refused if any cell is refused'},
        {'path': 'role-permissions/', 'method': 'DELETE', 'permission': 'CanManageSettings (manageSettings)', 'throttle': '',
         'body': {}, 'query': {'company': 'DEV_ADMIN only'}, 'response': 'defaults restored; same payload as GET'},
        {'path': 'role-permissions/mine/', 'method': 'GET', 'permission': 'IsAuthenticatedAndActive', 'throttle': '',
         'body': {}, 'response': '{"role": "...", "capabilities": [...]}'},
        {'path': 'health/', 'method': 'GET', 'permission': 'AllowAny', 'throttle': 'anon',
         'body': {}, 'response': '{"status": "ok"} or 503 {"status": "degraded"}'},
    ]
    for path, permission, query, response in ANALYTICS:
        standalone.append({'path': path, 'method': 'GET', 'permission': permission, 'throttle': '',
                           'body': {}, 'query': query, 'response': response})

    return {
        'schema_version': SCHEMA_VERSION,
        'generated_at': dt.datetime.now(dt.timezone.utc).isoformat(),
        'resources': resources,
        'standalone_endpoints': standalone,
        'enums': _enums(),
        'roles': _roles(),
        'approvals': {
            'entity_types': [c[0] for c in ApprovalRequest.ENTITY_CHOICES],
            'resolvable_entity_types': sorted(services.ENTITY_MODELS.keys()),
            'mutable_fields': {k: list(v) for k, v in ApprovalRequestViewSet.MUTABLE_FIELDS.items()},
            'review_capability': 'reviewApprovals',
            'direct_delete_capability': 'deleteRecords',
        },
        'transfers': {
            'transferable': sorted(services.TRANSFERABLE),
            'immediate_for_roles': MANAGERS_UP,
            'requires_acceptance_for_roles': ['EMPLOYEE'],
        },
        'conventions': _conventions(),
        'encrypted_fields': ['Enquiry.date_of_birth', 'Registration.date_of_birth', 'VisaTracking.passport_no'],
    }


def render_tools_markdown(catalog):
    """A human-readable table of every tool the MCP server will expose."""
    lines = ['# ConsultancyDev MCP tools', '', 'Generated from `mcp_server/catalog.json`. Do not edit by hand.', '',
             '| Tool | Kind | API | Capability |', '|---|---|---|---|']
    for r in catalog['resources']:
        cap = r['write_capability'] or r['read_capability'] or ''
        if 'GET' in r['methods']:
            lines.append(f"| `list_{r['name']}` | list | GET {r['prefix']}/ | {r['read_capability'] or ''} |")
            lines.append(f"| `get_{r['singular']}` | read | GET {r['prefix']}/{{id}}/ | {r['read_capability'] or ''} |")
        if 'POST' in r['methods']:
            lines.append(f"| `create_{r['singular']}` | write | POST {r['prefix']}/ | {cap} |")
        if 'PATCH' in r['methods']:
            lines.append(f"| `update_{r['singular']}` | write | PATCH {r['prefix']}/{{id}}/ | {cap} |")
        if 'DELETE' in r['methods']:
            lines.append(f"| `delete_{r['singular']}` | destructive | DELETE {r['prefix']}/{{id}}/ | {r['delete_requires_capability'] or cap} |")
        for a in r['actions']:
            lines.append(f"| `{a['tool_name']}` | action | {a['method']} {a['path']} | |")
    for name in ('analytics_overview', 'analytics_funnel', 'analytics_revenue', 'analytics_branches',
                 'analytics_visa_pipeline', 'analytics_sources', 'health'):
        lines.append(f'| `{name}` | analytics | GET | |')
    for name in ('whoami', 'my_capabilities', 'explain_permission', 'upload_document', 'download_document',
                 'student_360', 'convert_enquiry_to_registration', 'enroll_student', 'record_payment',
                 'search_everything', 'daily_briefing', 'get_role_permissions', 'update_role_permissions',
                 'reset_role_permissions'):
        lines.append(f'| `{name}` | composite | multiple | |')
    return '\n'.join(lines) + '\n'
```

Note on `ApprovalRequestViewSet.MUTABLE_FIELDS`: confirm with `grep -n "MUTABLE_FIELDS" backend/core/views.py`. If it is a module-level constant rather than a class attribute, import it as `from .views import MUTABLE_FIELDS` and reference it directly.

- [ ] **Step 4: Write the management command**

`backend/core/management/commands/export_mcp_catalog.py`:

```python
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
```

- [ ] **Step 5: Generate the catalog and run tests**

Run: `cd backend && python manage.py export_mcp_catalog`
Expected: `Wrote ...\mcp_server\catalog.json (28 resources)`

Run: `cd backend && python manage.py test core.test_mcp_catalog`
Expected: `Ran 12 tests ... OK`. If `test_enquiry_fields_and_filters` fails on `status` choices, the serializer's `status` is a `ChoiceField`; check `_choices` handles the `choices` dict DRF builds (it does via `.items()`).

- [ ] **Step 6: Commit**

```bash
git add backend/core/mcp_catalog.py backend/core/management/commands/export_mcp_catalog.py backend/core/test_mcp_catalog.py backend/mcp_server/catalog.json
git commit -m "Add MCP catalog builder and export_mcp_catalog command

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: ApiClient with injectable transport, error translation and test transport

**Files:**
- Create: `backend/mcp_server/client.py`
- Create: `backend/mcp_server/testing.py`
- Create: `backend/mcp_server/tests/test_client.py`

**Interfaces:**
- Produces: `mcp_server.client.Response` (dataclass: `status: int`, `headers: dict[str, str]`, `content: bytes`; method `json() -> Any` returning `None` on empty/non-JSON bodies).
- Produces: `mcp_server.client.Transport` Protocol: `request(self, method: str, path: str, *, params=None, json=None, data=None, files=None, headers=None) -> Response`. `path` is relative to the API base and always ends with `/`. `params` values may be lists (repeated keys). `files` is `dict[str, tuple[filename, bytes, content_type]]`.
- Produces: `HttpxTransport(base_url: str, timeout: float)`.
- Produces: `ApiError(Exception)` with attributes `status: int`, `error: str`, `fields: dict | list | None`, `hint: str`, `path: str`, `method: str`; `str(err)` is `"<status> <error> — <hint>"` when a hint exists.
- Produces: `Credentials` with classmethods `from_api_key(raw)`, `from_password(username, password)`, `from_header(value)`; method `apply(transport) -> dict[str,str]` returning the auth header (logs in over `transport` on first use for password credentials); method `refresh(transport) -> bool`.
- Produces: `ApiClient(transport, credentials)` with `get(path, params=None)`, `post(path, json=None, data=None, files=None)`, `patch(path, json)`, `put(path, json)`, `delete(path)`, `raw_get(path, params=None) -> Response`, `list_pages(path, params=None, all_pages=False, max_pages=20) -> dict | list`.
- Produces: `hint_for(status, error, method, path, fields) -> str`.
- Produces: `mcp_server.testing.DjangoTestTransport(api_client=None)` implementing `Transport` over `rest_framework.test.APIClient` with base `/api/`.

- [ ] **Step 1: Write the failing tests**

`backend/mcp_server/tests/test_client.py`:

```python
import os

os.environ.setdefault('DJANGO_ALLOW_ASYNC_UNSAFE', 'true')

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase, override_settings

from core import services
from core.models import ApiKey, Enquiry, Role
from mcp_server.client import ApiClient, ApiError, Credentials, Response, hint_for
from mcp_server.testing import DjangoTestTransport

User = get_user_model()
PASSWORD = 'Testing!2026xyz'

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


def mk(username, role, company, branch):
    user = User.objects.create(username=username, role=role, company=company, branch=branch, email=f'{username}@example.com')
    user.set_password(PASSWORD)
    user.save()
    return user


def enquiry(owner, branch, name):
    return Enquiry.objects.create(
        company=owner.company, branch=branch, created_by=owner, owner=owner,
        school_name='School', stream='Science', candidate_name=name, course_interested='BTech',
        mobile='9000000000', email=f'{name}@example.com', father_name='F', mother_name='M', permanent_address='Addr',
    )


@override_settings(REST_FRAMEWORK=RF)
class ApiClientTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        services.ensure_default_plans()
        cls.company, cls.head_office = services.provision_company('Acme Consultancy')
        cls.admin = mk('admin', Role.COMPANY_ADMIN, cls.company, cls.head_office)
        cls.emp = mk('emp', Role.EMPLOYEE, cls.company, cls.head_office)
        for i in range(30):
            enquiry(cls.admin, cls.head_office, f'cand-{i:02d}')
        Enquiry.objects.filter(candidate_name='cand-00').update(status='Closed')
        Enquiry.objects.filter(candidate_name='cand-01').update(status='Contacted')

    def setUp(self):
        cache.clear()
        _, raw = ApiKey.issue(self.admin, 'test')
        self.client_ = ApiClient(DjangoTestTransport(), Credentials.from_api_key(raw))

    def test_response_json_handles_empty_body(self):
        self.assertIsNone(Response(204, {}, b'').json())
        self.assertEqual(Response(200, {}, b'{"a": 1}').json(), {'a': 1})

    def test_get_me(self):
        me = self.client_.get('users/me/')
        self.assertEqual(me['username'], 'admin')

    def test_trailing_slash_is_added(self):
        me = self.client_.get('users/me')
        self.assertEqual(me['username'], 'admin')

    def test_list_params_are_repeated_keys(self):
        page = self.client_.get('enquiries/', params={'status': ['Closed', 'Contacted'], 'page_size': 50})
        self.assertEqual(page['count'], 2)

    def test_list_pages_walks_all_pages(self):
        rows = self.client_.list_pages('enquiries/', params={'page_size': 10}, all_pages=True)
        self.assertEqual(len(rows), 30)

    def test_list_pages_single_page_returns_envelope(self):
        page = self.client_.list_pages('enquiries/', params={'page_size': 10})
        self.assertEqual(page['count'], 30)
        self.assertEqual(len(page['results']), 10)

    def test_list_pages_respects_max_pages(self):
        rows = self.client_.list_pages('enquiries/', params={'page_size': 10}, all_pages=True, max_pages=2)
        self.assertEqual(len(rows), 20)

    def test_404_becomes_api_error(self):
        with self.assertRaises(ApiError) as ctx:
            self.client_.get('enquiries/999999/')
        self.assertEqual(ctx.exception.status, 404)
        self.assertEqual(ctx.exception.error, 'Not found.')

    def test_validation_error_keeps_fields(self):
        with self.assertRaises(ApiError) as ctx:
            self.client_.post('enquiries/', json={'school_name': 'x'})
        self.assertEqual(ctx.exception.status, 400)
        self.assertIn('mobile', ctx.exception.fields)

    def test_employee_delete_gets_approval_hint(self):
        row = Enquiry.objects.filter(candidate_name='cand-02').first()
        row.owner = self.emp
        row.save()
        _, raw = ApiKey.issue(self.emp, 'k')
        emp_client = ApiClient(DjangoTestTransport(), Credentials.from_api_key(raw))
        with self.assertRaises(ApiError) as ctx:
            emp_client.delete(f'enquiries/{row.pk}/')
        self.assertEqual(ctx.exception.status, 403)
        self.assertIn('create_approval_request', ctx.exception.hint)

    def test_password_credentials_log_in_and_refresh(self):
        creds = Credentials.from_password('admin', PASSWORD)
        client = ApiClient(DjangoTestTransport(), creds)
        self.assertEqual(client.get('users/me/')['username'], 'admin')
        self.assertTrue(creds.refresh(client.transport))
        self.assertEqual(client.get('users/me/')['username'], 'admin')

    def test_bad_password_is_401_api_error(self):
        client = ApiClient(DjangoTestTransport(), Credentials.from_password('admin', 'wrong'))
        with self.assertRaises(ApiError) as ctx:
            client.get('users/me/')
        self.assertEqual(ctx.exception.status, 401)

    def test_from_header_parses_bearer(self):
        creds = Credentials.from_header('Bearer cdk_abc')
        self.assertEqual(creds.apply(None), {'Authorization': 'Bearer cdk_abc'})
        with self.assertRaises(ValueError):
            Credentials.from_header('Basic xyz')

    def test_multipart_upload_reaches_document_viewset(self):
        data = {'file_name': 'note.pdf', 'type': 'Other'}
        files = {'file': ('note.pdf', b'%PDF-1.4 test', 'application/pdf')}
        doc = self.client_.post('documents/', data=data, files=files)
        self.assertEqual(doc['file_name'], 'note.pdf')
        self.assertTrue(doc['is_encrypted'])
        raw = self.client_.raw_get(f'documents/{doc["id"]}/download/')
        self.assertEqual(raw.status, 200)
        self.assertEqual(raw.content, b'%PDF-1.4 test')


class HintTests(TestCase):
    def test_hints(self):
        self.assertIn('create_approval_request', hint_for(403, 'Your role cannot delete records directly. Raise an approval request instead.', 'DELETE', 'enquiries/1/', None))
        self.assertIn('throttle', hint_for(429, 'Request was throttled.', 'GET', 'enquiries/', None).lower())
        self.assertIn('reference', hint_for(409, 'That operation conflicts with existing data.', 'POST', 'registrations/', None).lower())
        self.assertIn('one of registration or enquiry', hint_for(400, 'Validation failed', 'POST', 'documents/', {'non_field_errors': ['A document belongs to one student.']}))
        self.assertEqual(hint_for(200, '', 'GET', 'x/', None), '')
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python manage.py test mcp_server.tests.test_client`
Expected: `ModuleNotFoundError: No module named 'mcp_server.client'`.

- [ ] **Step 3: Implement `client.py`**

`backend/mcp_server/client.py`:

```python
"""
HTTP layer between the MCP tools and /api/.

`Transport` is the only thing that knows how bytes move: HttpxTransport for
real servers, DjangoTestTransport (mcp_server/testing.py) for tests. ApiClient
adds credentials, path normalisation, repeated-key query params, pagination
walking, one retry on 429, and translation of the backend error envelope into
ApiError with a hint from the knowledge layer.
"""

from __future__ import annotations

import json as jsonlib
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Mapping, Protocol

import httpx

logger = logging.getLogger('mcp_server.client')

API_KEY_PREFIX = 'cdk_'


@dataclass
class Response:
    status: int
    headers: dict[str, str]
    content: bytes

    def json(self) -> Any:
        if not self.content:
            return None
        try:
            return jsonlib.loads(self.content.decode('utf-8'))
        except (UnicodeDecodeError, ValueError):
            return None


class Transport(Protocol):
    def request(
        self, method: str, path: str, *, params: Mapping[str, Any] | None = None,
        json: Any = None, data: Mapping[str, Any] | None = None,
        files: Mapping[str, tuple[str, bytes, str]] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Response: ...


class HttpxTransport:
    def __init__(self, base_url: str, timeout: float = 30.0):
        self.base_url = base_url if base_url.endswith('/') else base_url + '/'
        self._client = httpx.Client(base_url=self.base_url, timeout=timeout, follow_redirects=False)

    def request(self, method, path, *, params=None, json=None, data=None, files=None, headers=None) -> Response:
        r = self._client.request(
            method, path.lstrip('/'), params=_flatten_params(params), json=json,
            data=data, files=files, headers=dict(headers or {}),
        )
        return Response(r.status_code, dict(r.headers), r.content)

    def close(self):
        self._client.close()


def _flatten_params(params: Mapping[str, Any] | None) -> list[tuple[str, str]]:
    """Lists become repeated keys; None/'' are dropped; booleans become 'true'/'false'."""
    out: list[tuple[str, str]] = []
    for key, value in (params or {}).items():
        if value is None or value == '' or value == []:
            continue
        values = value if isinstance(value, (list, tuple, set)) else [value]
        for item in values:
            if item is None or item == '':
                continue
            if isinstance(item, bool):
                item = 'true' if item else 'false'
            out.append((key, str(item)))
    return out


class ApiError(Exception):
    def __init__(self, status: int, error: str, *, fields=None, method: str = '', path: str = '', hint: str = ''):
        self.status = status
        self.error = error
        self.fields = fields
        self.method = method
        self.path = path
        self.hint = hint or hint_for(status, error, method, path, fields)
        super().__init__(str(self))

    def __str__(self):
        base = f'{self.status} {self.error}'
        if self.fields:
            base += f' fields={jsonlib.dumps(self.fields, default=str)}'
        if self.hint:
            base += f' — {self.hint}'
        return base

    def to_dict(self):
        return {'status': self.status, 'error': self.error, 'fields': self.fields, 'hint': self.hint,
                'request': f'{self.method} {self.path}'}


def hint_for(status: int, error: str, method: str, path: str, fields) -> str:
    text = (error or '').lower()
    if status == 403 and 'approval' in text:
        return ('Your role cannot delete directly. Call create_approval_request with '
                'action="DELETE" (or "UPDATE" with pending_changes) and a manager will review it.')
    if status == 403 and 'own profile' in text:
        return 'Only admins edit other users. Use get_me / update_user on your own id, or ask a company admin.'
    if status == 403:
        return 'Check my_capabilities and explain_permission: this action needs a capability or scope your role lacks.'
    if status == 404:
        return ('Not found OR outside your visibility scope (the API never reveals which). '
                'Employees see records they own or that were transferred to them.')
    if status == 409:
        return ('Conflict: a unique value collides (e.g. registration_no/enrollment_no reference, '
                'company+name, username). Omit server-assigned references to let the server allocate them.')
    if status == 429:
        return 'Throttled (user_burst 120/min, user 5000/hour in production). Wait and retry; use page_size up to 200 and avoid all_pages loops.'
    if status == 401:
        return 'Not authenticated: the API key is missing, revoked, expired, or the user is deactivated.'
    if status == 400 and fields:
        flat = jsonlib.dumps(fields, default=str).lower()
        if 'one student' in flat or ('registration' in flat and 'enquiry' in flat):
            return 'A document links to exactly one of registration or enquiry, never both.'
        if 'does not exist' in flat:
            return 'The related record must be in your company and visible to you.'
        if 'installments_count' in flat or 'installment' in flat:
            return 'Pass installments_count (>=0) and optionally installment_amount; the server builds the schedule.'
        return 'Fix the listed fields. Read consultancy://schema/<resource> for types, choices and required fields.'
    if status == 400 and 'not linked to a company' in text:
        return 'A DEV_ADMIN has no company; create tenant records as a company user.'
    if status >= 500:
        return 'Server error. Retry once; if it persists report the request to the backend owner.'
    return ''


class Credentials:
    """Either a personal API key or a username/password pair that logs in for a JWT."""

    def __init__(self, *, api_key: str | None = None, username: str | None = None, password: str | None = None):
        self.api_key = api_key
        self.username = username
        self.password = password
        self.access: str | None = None
        self.refresh_token: str | None = None
        if not api_key and not (username and password):
            raise ValueError('Credentials need an API key or a username and password.')

    @classmethod
    def from_api_key(cls, raw: str) -> 'Credentials':
        return cls(api_key=raw)

    @classmethod
    def from_password(cls, username: str, password: str) -> 'Credentials':
        return cls(username=username, password=password)

    @classmethod
    def from_header(cls, value: str) -> 'Credentials':
        parts = (value or '').split()
        if len(parts) != 2 or parts[0].lower() != 'bearer':
            raise ValueError('Expected "Authorization: Bearer <token>".')
        token = parts[1]
        if token.startswith(API_KEY_PREFIX):
            return cls(api_key=token)
        creds = cls(api_key='placeholder')
        creds.api_key = None
        creds.access = token
        return creds

    @property
    def uses_api_key(self) -> bool:
        return bool(self.api_key)

    def describe(self) -> str:
        if self.api_key:
            return f'api key {self.api_key[:12]}...'
        if self.username:
            return f'password login for {self.username}'
        return 'bearer token'

    def _login(self, transport: Transport) -> None:
        r = transport.request('POST', 'auth/login/', json={'username': self.username, 'password': self.password})
        body = r.json() or {}
        if r.status != 200:
            raise ApiError(r.status, body.get('error', 'Login failed.'), method='POST', path='auth/login/')
        self.access = body['access']
        self.refresh_token = body.get('refresh')

    def refresh(self, transport: Transport) -> bool:
        if not self.refresh_token:
            if self.username and self.password:
                self._login(transport)
                return True
            return False
        r = transport.request('POST', 'auth/refresh/', json={'refresh': self.refresh_token})
        body = r.json() or {}
        if r.status != 200:
            if self.username and self.password:
                self._login(transport)
                return True
            return False
        self.access = body['access']
        self.refresh_token = body.get('refresh', self.refresh_token)
        return True

    def apply(self, transport: Transport | None) -> dict[str, str]:
        if self.api_key:
            return {'Authorization': f'Bearer {self.api_key}'}
        if self.access is None:
            if transport is None:
                raise ValueError('A transport is required to log in.')
            self._login(transport)
        return {'Authorization': f'Bearer {self.access}'}


class ApiClient:
    def __init__(self, transport: Transport, credentials: Credentials):
        self.transport = transport
        self.credentials = credentials

    @staticmethod
    def _norm(path: str) -> str:
        path = path.lstrip('/')
        if '?' in path:
            raise ValueError('Pass query parameters via params=, not in the path.')
        return path if path.endswith('/') else path + '/'

    def request(self, method: str, path: str, *, params=None, json=None, data=None, files=None) -> Response:
        path = self._norm(path)
        headers = self.credentials.apply(self.transport)
        r = self.transport.request(method, path, params=params, json=json, data=data, files=files, headers=headers)
        if r.status == 401 and not self.credentials.uses_api_key and self.credentials.refresh(self.transport):
            headers = self.credentials.apply(self.transport)
            r = self.transport.request(method, path, params=params, json=json, data=data, files=files, headers=headers)
        if r.status == 429:
            wait = 1.0
            try:
                wait = min(float(r.headers.get('Retry-After', '1')), 5.0)
            except ValueError:
                pass
            logger.warning('429 on %s %s; retrying after %.1fs', method, path, wait)
            time.sleep(wait)
            r = self.transport.request(method, path, params=params, json=json, data=data, files=files, headers=headers)
        if r.status >= 400:
            body = r.json()
            if isinstance(body, dict):
                error = body.get('error') or body.get('detail') or f'HTTP {r.status}'
                fields = body.get('fields')
                if fields is None and 'error' not in body and 'detail' not in body:
                    fields = body
            else:
                error = f'HTTP {r.status}'
                fields = None
            raise ApiError(r.status, str(error), fields=fields, method=method, path=path)
        return r

    def raw_get(self, path: str, params=None) -> Response:
        return self.request('GET', path, params=params)

    def get(self, path: str, params=None) -> Any:
        return self.request('GET', path, params=params).json()

    def post(self, path: str, json=None, data=None, files=None) -> Any:
        return self.request('POST', path, json=json, data=data, files=files).json()

    def patch(self, path: str, json=None) -> Any:
        return self.request('PATCH', path, json=json).json()

    def put(self, path: str, json=None) -> Any:
        return self.request('PUT', path, json=json).json()

    def delete(self, path: str) -> Any:
        return self.request('DELETE', path).json()

    def list_pages(self, path: str, params=None, all_pages: bool = False, max_pages: int = 20) -> Any:
        """
        One page (the envelope, or a bare array for unpaginated endpoints), or
        with all_pages=True every row up to max_pages pages.
        """
        params = dict(params or {})
        first = self.get(path, params=params)
        if not all_pages or not isinstance(first, dict) or 'results' not in first:
            return first
        rows = list(first['results'])
        page = int(first.get('page', 1))
        pages = int(first.get('pages', 1))
        while page < pages and page < max_pages:
            page += 1
            params['page'] = page
            rows.extend(self.get(path, params=params)['results'])
        return rows
```

- [ ] **Step 4: Implement `testing.py`**

`backend/mcp_server/testing.py`:

```python
"""
A Transport that drives the Django test client, so MCP tools are exercised
against the real viewsets, serializers and permissions inside `manage.py test`.
Never imported by the runtime server.
"""

from __future__ import annotations

import json as jsonlib
from io import BytesIO
from typing import Any, Mapping

from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient

from .client import Response, _flatten_params


class DjangoTestTransport:
    def __init__(self, api_client: APIClient | None = None, base: str = '/api/'):
        self.api_client = api_client or APIClient()
        self.base = base

    def request(self, method: str, path: str, *, params: Mapping[str, Any] | None = None,
                json: Any = None, data: Mapping[str, Any] | None = None,
                files: Mapping[str, tuple[str, bytes, str]] | None = None,
                headers: Mapping[str, str] | None = None) -> Response:
        url = self.base + path.lstrip('/')
        extra = {f'HTTP_{k.upper().replace("-", "_")}': v for k, v in (headers or {}).items()}
        query = _flatten_params(params)
        if query:
            url += '?' + '&'.join(f'{k}={_q(v)}' for k, v in query)
        call = getattr(self.api_client, method.lower())
        if files:
            payload = dict(data or {})
            for key, (name, content, content_type) in files.items():
                payload[key] = SimpleUploadedFile(name, content, content_type=content_type)
            response = call(url, payload, format='multipart', **extra)
        elif json is not None:
            response = call(url, jsonlib.dumps(json), content_type='application/json', **extra)
        elif data is not None:
            response = call(url, dict(data), format='multipart', **extra)
        else:
            response = call(url, **extra)
        content = b''.join(response.streaming_content) if getattr(response, 'streaming', False) else response.content
        return Response(response.status_code, {k: v for k, v in response.items()}, content)


def _q(value: str) -> str:
    from urllib.parse import quote
    return quote(str(value), safe='')
```

- [ ] **Step 5: Run tests**

Run: `cd backend && python manage.py test mcp_server.tests.test_client`
Expected: `Ran 16 tests ... OK`. If `test_list_params_are_repeated_keys` fails with count 30, check that the `override_settings` includes `DjangoFilterBackend` (it does above) and that `EnquiryFilter` is the viewset's `filterset_class`.

- [ ] **Step 6: Commit**

```bash
git add backend/mcp_server/client.py backend/mcp_server/testing.py backend/mcp_server/tests/test_client.py
git commit -m "Add MCP ApiClient with injectable transport and Django test transport

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Catalog loader, server construction, credential resolution, CLI

**Files:**
- Create: `backend/mcp_server/catalog.py`
- Create: `backend/mcp_server/auth.py`
- Create: `backend/mcp_server/server.py`
- Create: `backend/mcp_server/__main__.py`
- Create: `backend/mcp_server/tools/__init__.py`
- Create: `backend/mcp_server/tests/base.py`
- Create: `backend/mcp_server/tests/test_server.py`

**Interfaces:**
- Produces: `mcp_server.catalog.CATALOG_PATH`, `load_catalog(path=None) -> Catalog`; `Catalog` with attributes `raw: dict`, `resources: dict[str, dict]` keyed by plural `name`, `by_prefix: dict[str, dict]`, `enums`, `roles`, `approvals`, `transfers`, `conventions`, `standalone_endpoints`, `encrypted_fields`; methods `resource(name) -> dict` (KeyError with the valid names when unknown), `writable_fields(name) -> list[dict]`, `field_names(name) -> set[str]`, `filter_params(name) -> list[dict]`, `all_tool_names() -> list[str]` (the generated tool names), `schema_markdown(name) -> str`, `api_reference_markdown() -> str`.
- Produces: `mcp_server.auth.AuthError(Exception)`, `resolve_credentials(ctx, settings) -> Credentials`: in HTTP mode reads `ctx.request_context.request.headers['authorization']`; in stdio mode builds from settings; raises `AuthError` with a helpful message otherwise.
- Produces: `mcp_server.server.ServerState` (dataclass: `settings: Settings`, `catalog: Catalog`, `transport: Transport`), `build_server(settings: Settings, transport: Transport | None = None) -> FastMCP`, `client_for(ctx, state) -> ApiClient`, `create_http_app(settings) -> Starlette`, `BearerRequiredMiddleware`.
- Produces: `mcp_server.tests.base.McpTestCase` with class attributes `company, head_office, kohima, dimapur, rival, rival_branch, dev, admin, head, mgr_k, mgr_d, emp_k1, emp_k2, emp_d1, rival_admin`; methods `key_for(user) -> str`, `server_for(user, read_only=False) -> FastMCP`, `call(name, user, **arguments) -> Any` (parsed structured content, or the text block parsed as JSON, or raw text), `call_raises(name, user, **arguments) -> str` (the error text of an `isError` result), `tool_names(user) -> set[str]`, `read_resource(uri, user) -> str`, `get_prompt(name, user, **arguments) -> list[str]`.
- Tool functions register as `def fn(ctx: Context, ...)` and obtain a client with `client_for(ctx, state)`; the `state` is captured by closure in each `register_*` function.

- [ ] **Step 1: Write the failing tests**

`backend/mcp_server/tests/base.py`:

```python
"""
Shared fixture for driving the MCP server in-process against the real API.

The server talks to Django through DjangoTestTransport, and the MCP client is
the SDK's in-memory session, so a test exercises the same code path a real
client does: JSON-RPC in, tool function, HTTP-shaped call, viewset, back.
"""

import asyncio
import json
import os

os.environ.setdefault('DJANGO_ALLOW_ASYNC_UNSAFE', 'true')

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase, override_settings
from mcp.shared.memory import create_connected_server_and_client_session

from core import services
from core.models import ApiKey, Branch, Enquiry, Role
from mcp_server.config import Settings
from mcp_server.server import build_server
from mcp_server.testing import DjangoTestTransport

User = get_user_model()
PASSWORD = 'Testing!2026xyz'

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


def _run(coro):
    return asyncio.run(coro)


@override_settings(REST_FRAMEWORK=RF)
class McpTestCase(TestCase):
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
        settings = Settings(api_url='http://testserver/api/', api_key=self.key_for(user), read_only=read_only, **settings_overrides)
        return build_server(settings, transport=DjangoTestTransport())

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
            async with create_connected_server_and_client_session(self.server_for(user, read_only=read_only)) as session:
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

    def list_resources(self, user):
        async def go():
            async with create_connected_server_and_client_session(self.server_for(user)) as session:
                fixed = {str(r.uri) for r in (await session.list_resources()).resources}
                templates = {t.uriTemplate for t in (await session.list_resource_templates()).resourceTemplates}
                return fixed, templates
        return _run(go())
```

`backend/mcp_server/tests/test_server.py`:

```python
import os

os.environ.setdefault('DJANGO_ALLOW_ASYNC_UNSAFE', 'true')

from django.test import SimpleTestCase
from starlette.testclient import TestClient

from mcp_server.auth import AuthError, resolve_credentials
from mcp_server.catalog import load_catalog
from mcp_server.config import Settings
from mcp_server.server import build_server, create_http_app

from .base import McpTestCase


class CatalogLoaderTests(SimpleTestCase):
    def test_loads_committed_catalog(self):
        cat = load_catalog()
        self.assertIn('enquiries', cat.resources)
        self.assertEqual(cat.resources['enquiries']['singular'], 'enquiry')
        self.assertEqual(cat.by_prefix['visa-tracking']['name'], 'visa_tracking')
        self.assertIn('candidate_name', cat.field_names('enquiries'))
        self.assertNotIn('company', {f['name'] for f in cat.writable_fields('enquiries')})
        self.assertIn('status', {f['param'] for f in cat.filter_params('enquiries')})
        with self.assertRaises(KeyError):
            cat.resource('nope')
        self.assertIn('list_enquiries', cat.all_tool_names())
        self.assertIn('download_document', cat.all_tool_names())

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


class HttpAppTests(SimpleTestCase):
    def test_health_is_open_and_mcp_requires_bearer(self):
        app = create_http_app(Settings(transport='streamable-http'))
        with TestClient(app) as client:
            self.assertEqual(client.get('/health').status_code, 200)
            self.assertEqual(client.get('/health').json()['status'], 'ok')
            response = client.post('/mcp', json={'jsonrpc': '2.0', 'id': 1, 'method': 'initialize'})
            self.assertEqual(response.status_code, 401)
            self.assertIn('Bearer', response.headers.get('www-authenticate', ''))


class ServerSmokeTests(McpTestCase):
    def test_tools_resources_prompts_are_registered(self):
        tools = self.tool_names(self.admin)
        for name in ('whoami', 'list_enquiries', 'get_enquiry', 'create_enquiry', 'update_enquiry',
                     'delete_enquiry', 'accept_transfer', 'analytics_overview', 'upload_document',
                     'download_document', 'student_360', 'daily_briefing', 'get_role_permissions'):
            self.assertIn(name, tools)
        self.assertTrue(tools['list_enquiries'].annotations.readOnlyHint)
        self.assertTrue(tools['delete_enquiry'].annotations.destructiveHint)
        fixed, templates = self.list_resources(self.admin)
        self.assertIn('consultancy://catalog', fixed)
        self.assertIn('consultancy://schema/{resource}', templates)
        self.assertIn('daily_briefing', self.list_prompts(self.admin))

    def test_read_only_mode_hides_write_tools(self):
        tools = self.tool_names(self.admin, read_only=True)
        self.assertIn('list_enquiries', tools)
        self.assertNotIn('create_enquiry', tools)
        self.assertNotIn('delete_enquiry', tools)
        self.assertNotIn('accept_transfer', tools)
        self.assertNotIn('upload_document', tools)
        self.assertIn('download_document', tools)

    def test_whoami_uses_the_key_owner(self):
        me = self.call('whoami', self.emp_k1)
        self.assertEqual(me['user']['username'], 'emp_k1')
        self.assertEqual(me['role'], 'EMPLOYEE')

    def test_api_error_is_tool_error_with_hint(self):
        text = self.call_raises('get_enquiry', self.emp_k1, id=self.enq_d1.pk)
        self.assertIn('404', text)
        self.assertIn('scope', text)
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python manage.py test mcp_server.tests.test_server`
Expected: `ModuleNotFoundError: No module named 'mcp_server.catalog'`.

- [ ] **Step 3: Implement `catalog.py`**

`backend/mcp_server/catalog.py`:

```python
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
            raise KeyError(f'Unknown resource {name!r}. Valid: {", ".join(sorted(self.resources))}')

    def writable_fields(self, name: str) -> list[dict]:
        return [f for f in self.resource(name)['fields'] if not f['read_only']]

    def field_names(self, name: str) -> set[str]:
        return {f['name'] for f in self.resource(name)['fields']}

    def filter_params(self, name: str) -> list[dict]:
        return list(self.resource(name)['filters'])

    def all_tool_names(self) -> list[str]:
        names: list[str] = []
        for r in self.raw['resources']:
            if 'GET' in r['methods']:
                names += [f"list_{r['name']}", f"get_{r['singular']}"]
            if 'POST' in r['methods']:
                names.append(f"create_{r['singular']}")
            if 'PATCH' in r['methods']:
                names.append(f"update_{r['singular']}")
            if 'DELETE' in r['methods']:
                names.append(f"delete_{r['singular']}")
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
            lines.append(f"Delete needs capability `{r['delete_requires_capability']}`; others raise an approval request.")
        lines += ['', '## Fields', '', '| name | type | required | read_only | choices / related | notes |', '|---|---|---|---|---|---|']
        for f in r['fields']:
            extra = ''
            if f['choices']:
                extra = ', '.join(c['value'] for c in f['choices'])
            elif f['related_model']:
                extra = f"id of {f['related_model']}"
            note = 'write-only' if f['write_only'] else ''
            if f['max_length']:
                note = (note + ' ' if note else '') + f"max {f['max_length']}"
            lines.append(f"| {f['name']} | {f['type']} | {'yes' if f['required'] else ''} | {'yes' if f['read_only'] else ''} | {extra} | {note} |")
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
```

- [ ] **Step 4: Implement `auth.py`**

`backend/mcp_server/auth.py`:

```python
"""Who is calling? stdio: the environment. HTTP: the request's Authorization header."""

from __future__ import annotations

from .client import Credentials
from .config import Settings


class AuthError(Exception):
    pass


def _http_request(ctx):
    if ctx is None:
        return None
    try:
        rc = ctx.request_context
    except (ValueError, AttributeError):
        return None
    return getattr(rc, 'request', None)


def resolve_credentials(ctx, settings: Settings) -> Credentials:
    request = _http_request(ctx)
    if request is not None:
        header = request.headers.get('authorization') or request.headers.get('x-api-key')
        if not header:
            raise AuthError('Missing Authorization header. Send "Authorization: Bearer <your cdk_ API key>".')
        if not header.lower().startswith('bearer '):
            header = f'Bearer {header}'
        try:
            return Credentials.from_header(header)
        except ValueError as exc:
            raise AuthError(str(exc))
    if settings.api_key:
        return Credentials.from_api_key(settings.api_key)
    if settings.username and settings.password:
        return Credentials.from_password(settings.username, settings.password)
    raise AuthError(
        'No credentials configured. Set CONSULTANCY_API_KEY (create one on your Profile page under '
        '"AI access keys"), or CONSULTANCY_USERNAME and CONSULTANCY_PASSWORD.'
    )
```

- [ ] **Step 5: Implement `server.py`, `tools/__init__.py`, `__main__.py`**

`backend/mcp_server/tools/__init__.py` is empty.

`backend/mcp_server/server.py`:

```python
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
        raise ToolError(str(exc))
    return ApiClient(state.transport, credentials)


def run_api(fn):
    """Run an API-calling callable and turn ApiError into a ToolError with the hint attached."""
    try:
        return fn()
    except ApiError as exc:
        raise ToolError(str(exc))


def build_server(settings: Settings, transport: Transport | None = None) -> FastMCP:
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
```

`backend/mcp_server/__main__.py`:

```python
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
```

- [ ] **Step 6: Create placeholder registration modules so the server builds**

These are replaced by real implementations in Tasks 7 to 11; create them now with a minimal `whoami` in `auth_tools.py` and no-op functions elsewhere so `test_server.py` can run up to the tools it expects. Write:

`backend/mcp_server/tools/auth_tools.py` (final version lands in Task 8; this minimal version is enough for `whoami`):

```python
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
```

`backend/mcp_server/tools/generated.py`, `analytics.py`, `documents.py`, `workflows.py`, `resources.py`, `prompts.py`: each with a single `def register_...(mcp, state): pass` (prompts: `def register_prompts(mcp): pass`), matching the names imported in `build_server`.

- [ ] **Step 7: Run the tests that can pass now**

Run: `cd backend && python manage.py test mcp_server.tests.test_server.CatalogLoaderTests mcp_server.tests.test_server.CredentialResolutionTests mcp_server.tests.test_server.HttpAppTests mcp_server.tests.test_server.ServerSmokeTests.test_whoami_uses_the_key_owner`
Expected: OK. (`test_tools_resources_prompts_are_registered`, `test_read_only_mode_hides_write_tools` and `test_api_error_is_tool_error_with_hint` pass after Tasks 7 to 11.)

If `HttpAppTests` fails because the SDK's streamable app returns 406 or 400 before the middleware, check the middleware order: `add_middleware` wraps the outside, so it runs first; if the SDK app is a `Starlette` with a `lifespan`, the `TestClient` context manager is required (it is used above).

- [ ] **Step 8: Commit**

```bash
git add backend/mcp_server/catalog.py backend/mcp_server/auth.py backend/mcp_server/server.py backend/mcp_server/__main__.py backend/mcp_server/tools backend/mcp_server/resources.py backend/mcp_server/prompts.py backend/mcp_server/tests/base.py backend/mcp_server/tests/test_server.py
git commit -m "Add MCP server construction, catalog loader, auth resolution and CLI

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Generated CRUD and action tools

**Files:**
- Replace: `backend/mcp_server/tools/generated.py`
- Create: `backend/mcp_server/tests/test_generated.py`

**Interfaces:**
- Produces: `register_generated_tools(mcp, state)` registering, per catalog resource: `list_<name>(ctx, filters: dict | None, search: str | None, ordering: str | None, page: int, page_size: int, all_pages: bool)`, `get_<singular>(ctx, id: int)`, `create_<singular>(ctx, data: dict)`, `update_<singular>(ctx, id: int, data: dict)`, `delete_<singular>(ctx, id: int, confirm: bool)`, and one tool per catalog action (`tool_name`), skipping actions flagged `skip_generated`. Action tools take `id: int` when `detail`, `body: dict | None` when the overlay declares a body, and `query: dict | None` when it declares query params; list-style GET actions additionally take `page`, `page_size`, `all_pages`.
- Produces: helper `validate_payload(catalog, resource_name, data, partial) -> dict` (raises `ToolError` listing unknown fields and, when not partial, missing required fields; silently drops read-only fields and reports them in the returned `_stripped` list which the tool removes before sending).
- Write tools are not registered when `state.settings.read_only` is true.

- [ ] **Step 1: Write the failing tests**

`backend/mcp_server/tests/test_generated.py`:

```python
from core.models import ApiKey, Enquiry, Registration, RecordTransfer, Task
from mcp.server.fastmcp.exceptions import ToolError

from mcp_server.catalog import load_catalog
from mcp_server.tools.generated import validate_payload

from .base import McpTestCase


class ValidatePayloadTests(McpTestCase):
    def test_unknown_field_is_rejected_with_valid_names(self):
        cat = load_catalog()
        with self.assertRaises(ToolError) as ctx:
            validate_payload(cat, 'enquiries', {'candidate': 'x'}, partial=False)
        self.assertIn('candidate_name', str(ctx.exception))

    def test_missing_required_is_rejected_on_create_only(self):
        cat = load_catalog()
        with self.assertRaises(ToolError) as ctx:
            validate_payload(cat, 'enquiries', {'candidate_name': 'x'}, partial=False)
        self.assertIn('mobile', str(ctx.exception))
        cleaned = validate_payload(cat, 'enquiries', {'candidate_name': 'x'}, partial=True)
        self.assertEqual(cleaned, {'candidate_name': 'x'})

    def test_read_only_fields_are_stripped(self):
        cat = load_catalog()
        cleaned = validate_payload(cat, 'enquiries', {'candidate_name': 'x', 'company': 9}, partial=True)
        self.assertNotIn('company', cleaned)


class GeneratedCrudTests(McpTestCase):
    def test_list_is_scoped_per_role(self):
        self.assertEqual({r['candidate_name'] for r in self.call('list_enquiries', self.emp_k1)['results']}, {'kohima-one'})
        self.assertEqual({r['candidate_name'] for r in self.call('list_enquiries', self.mgr_k)['results']}, {'kohima-one', 'kohima-two'})
        self.assertEqual({r['candidate_name'] for r in self.call('list_enquiries', self.head)['results']}, {'kohima-one', 'kohima-two'})
        self.assertEqual(self.call('list_enquiries', self.admin)['count'], 3)
        self.assertEqual(self.call('list_enquiries', self.dev)['count'], 4)
        self.assertEqual(self.call('list_enquiries', self.rival_admin)['count'], 1)

    def test_list_filters_search_ordering_and_all_pages(self):
        Enquiry.objects.filter(pk=self.enq_k1.pk).update(status='Closed')
        closed = self.call('list_enquiries', self.admin, filters={'status': ['Closed']})
        self.assertEqual(closed['count'], 1)
        found = self.call('list_enquiries', self.admin, search='dimapur')
        self.assertEqual(found['count'], 1)
        ordered = self.call('list_enquiries', self.admin, ordering='school_name', page_size=1)
        self.assertEqual(len(ordered['results']), 1)
        rows = self.call('list_enquiries', self.admin, page_size=1, all_pages=True)
        self.assertEqual(len(rows), 3)

    def test_unknown_filter_param_is_rejected(self):
        text = self.call_raises('list_enquiries', self.admin, filters={'colour': 'red'})
        self.assertIn('colour', text)
        self.assertIn('status', text)

    def test_get_create_update_delete_round_trip(self):
        created = self.call('create_enquiry', self.mgr_k, data={
            'school_name': 'S', 'stream': 'Science', 'candidate_name': 'new-one', 'course_interested': 'MBBS',
            'mobile': '9111111111', 'email': 'new@example.com', 'father_name': 'F', 'mother_name': 'M',
            'permanent_address': 'A',
        })
        self.assertEqual(created['owner'], self.mgr_k.pk)
        fetched = self.call('get_enquiry', self.mgr_k, id=created['id'])
        self.assertEqual(fetched['candidate_name'], 'new-one')
        updated = self.call('update_enquiry', self.mgr_k, id=created['id'], data={'status': 'Contacted'})
        self.assertEqual(updated['status'], 'Contacted')
        text = self.call_raises('delete_enquiry', self.mgr_k, id=created['id'])
        self.assertIn('confirm', text)
        result = self.call('delete_enquiry', self.mgr_k, id=created['id'], confirm=True)
        self.assertEqual(result['deleted'], created['id'])
        self.assertFalse(Enquiry.objects.filter(pk=created['id']).exists())

    def test_employee_delete_is_refused_with_approval_hint(self):
        text = self.call_raises('delete_enquiry', self.emp_k1, id=self.enq_k1.pk, confirm=True)
        self.assertIn('create_approval_request', text)

    def test_create_registration_creates_payment_and_reference(self):
        reg = self.call('create_registration', self.emp_k1, data={
            'student_name': 'Reg One', 'mobile': '9', 'email': 'r@example.com', 'father_name': 'F', 'mother_name': 'M',
            'permanent_address': 'A', 'registration_fee': '1500.00', 'payment_status': 'Paid', 'enquiry': self.enq_k1.pk,
        })
        self.assertTrue(reg['registration_no'].startswith('REG-'))
        payments = self.call('list_payments', self.emp_k1)
        self.assertEqual(payments['count'], 1)
        self.assertEqual(payments['results'][0]['status'], 'Success')

    def test_read_only_viewsets_have_no_write_tools(self):
        tools = self.tool_names(self.admin)
        self.assertNotIn('create_plan', tools)
        self.assertNotIn('create_notification', tools)
        self.assertIn('list_plans', tools)


class GeneratedActionTests(McpTestCase):
    def test_transfer_inbox_accept_flow(self):
        transfer = self.call('create_transfer', self.emp_k1, data={
            'entity_type': 'enquiry', 'entity_id': self.enq_k1.pk, 'to_user': self.emp_k2.pk, 'note': 'take over',
        })
        self.assertEqual(transfer['status'], 'PENDING')
        inbox = self.call('transfer_inbox', self.emp_k2)
        self.assertEqual(inbox['count'], 1)
        accepted = self.call('accept_transfer', self.emp_k2, id=transfer['id'])
        self.assertEqual(accepted['status'], 'ACCEPTED')
        self.assertEqual(self.call('list_enquiries', self.emp_k1)['count'], 0)
        self.assertEqual(self.call('list_enquiries', self.emp_k2)['count'], 2)

    def test_reorder_tasks_and_calendar(self):
        t1 = self.call('create_task', self.mgr_k, data={'title': 'a', 'assigned_to': self.mgr_k.pk, 'due_date': '2026-09-10T10:00:00Z'})
        t2 = self.call('create_task', self.mgr_k, data={'title': 'b', 'assigned_to': self.mgr_k.pk, 'due_date': '2026-09-11T10:00:00Z'})
        result = self.call('reorder_tasks', self.mgr_k, body={'ids': [t2['id'], t1['id']], 'status': 'Done'})
        self.assertEqual(result['reordered'], 2)
        self.assertIsNotNone(Task.objects.get(pk=t1['id']).completed_at)
        self.call('create_appointment', self.mgr_k, data={
            'student_name': 'S', 'counselor': self.mgr_k.pk, 'date': '2026-09-15T09:00:00Z', 'type': 'In-Person',
        })
        rows = self.call('appointments_calendar', self.mgr_k, query={'month': 9, 'year': 2026})
        self.assertEqual(len(rows), 1)

    def test_notification_and_approval_counts(self):
        self.assertEqual(self.call('unread_notification_count', self.admin)['count'], 0)
        self.assertEqual(self.call('approval_pending_count', self.admin)['count'], 0)

    def test_set_user_active_needs_manage_users(self):
        text = self.call_raises('set_user_active', self.mgr_k, id=self.emp_k1.pk, body={'is_active': False})
        self.assertIn('403', text)
        result = self.call('set_user_active', self.admin, id=self.emp_k1.pk, body={'is_active': False})
        self.assertFalse(result['is_active_employee'])

    def test_revoke_api_key_is_refused_for_key_auth(self):
        key, _ = ApiKey.issue(self.admin, 'other')
        text = self.call_raises('revoke_api_key', self.admin, id=key.pk)
        self.assertIn('403', text)
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python manage.py test mcp_server.tests.test_generated`
Expected: ImportError for `validate_payload`, then tool-not-found errors.

- [ ] **Step 3: Implement `generated.py`**

`backend/mcp_server/tools/generated.py`:

```python
"""
Tools generated from the catalog: list/get/create/update/delete per resource
plus one tool per custom @action. Every argument that reaches the API is
validated against the catalog first, so an AI client gets "unknown field X;
valid: ..." instead of a bare 400.
"""

from __future__ import annotations

import json
from typing import Any

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations

from ..catalog import Catalog
from ..server import ServerState, client_for, run_api

UNIVERSAL_PARAMS = {'page', 'page_size', 'search', 'ordering'}


def validate_payload(catalog: Catalog, resource_name: str, data: dict | None, partial: bool) -> dict:
    """Drop read-only fields, reject unknown ones, require required ones on create."""
    r = catalog.resource(resource_name)
    if not isinstance(data, dict):
        raise ToolError('`data` must be a JSON object of field values.')
    fields = {f['name']: f for f in r['fields']}
    unknown = sorted(k for k in data if k not in fields)
    if unknown:
        writable = ', '.join(f['name'] for f in r['fields'] if not f['read_only'])
        raise ToolError(f'Unknown field(s) for {resource_name}: {", ".join(unknown)}. Writable fields: {writable}.')
    cleaned = {k: v for k, v in data.items() if not fields[k]['read_only']}
    if not partial:
        missing = sorted(n for n, f in fields.items() if f['required'] and n not in cleaned)
        if missing:
            raise ToolError(f'Missing required field(s) for {resource_name}: {", ".join(missing)}.')
    return cleaned


def validate_filters(catalog: Catalog, resource_name: str, filters: dict | None) -> dict:
    r = catalog.resource(resource_name)
    allowed = {f['param'] for f in r['filters']}
    filters = dict(filters or {})
    unknown = sorted(k for k in filters if k not in allowed and k not in UNIVERSAL_PARAMS)
    if unknown:
        raise ToolError(f'Unknown filter(s) for {resource_name}: {", ".join(unknown)}. '
                        f'Valid filters: {", ".join(sorted(allowed)) or "(none)"}; plus search, ordering, page, page_size.')
    return filters


def _describe_fields(r: dict) -> str:
    parts = []
    for f in r['fields']:
        if f['read_only']:
            continue
        bit = f"{f['name']}:{f['type']}"
        if f['required']:
            bit += '*'
        if f['choices']:
            bit += '[' + '|'.join(c['value'] for c in f['choices']) + ']'
        elif f['related_model']:
            bit += f"(id of {f['related_model']})"
        parts.append(bit)
    return ', '.join(parts)


def _describe_filters(r: dict) -> str:
    parts = []
    for f in r['filters']:
        bit = f['param']
        if f['kind'] in ('multi', 'multi_id', 'json_any'):
            bit += '[]'
        if f.get('choices'):
            bit += '(' + '|'.join(f['choices']) + ')'
        parts.append(bit)
    return ', '.join(parts) or '(none)'


def _access(r: dict) -> str:
    read = r['read_capability'] or 'any active user'
    write = r['write_capability'] or 'scope only'
    return f"Read: {read}. Write: {write}. Roles that write by default: {', '.join(r['write_roles'])}."


def register_generated_tools(mcp: FastMCP, state: ServerState) -> None:
    catalog = state.catalog
    read_only = state.settings.read_only

    for r in catalog.raw['resources']:
        _register_resource(mcp, state, r, read_only)


def _register_resource(mcp: FastMCP, state: ServerState, r: dict, read_only: bool) -> None:
    catalog = state.catalog
    name, singular, prefix = r['name'], r['singular'], r['prefix']
    notes = (' Notes: ' + ' '.join(r['notes'])) if r['notes'] else ''

    if 'GET' in r['methods']:
        def list_tool(ctx: Context, filters: dict[str, Any] | None = None, search: str | None = None,
                      ordering: str | None = None, page: int = 1, page_size: int = 25,
                      all_pages: bool = False, _r=r) -> Any:
            params = validate_filters(catalog, _r['name'], filters)
            if search:
                params['search'] = search
            if ordering:
                params['ordering'] = ordering
            params['page'] = page
            params['page_size'] = max(1, min(int(page_size), 200))
            client = client_for(ctx, state)
            return run_api(lambda: client.list_pages(f"{_r['prefix']}/", params=params, all_pages=all_pages))

        list_tool.__doc__ = (
            f"List {name} (GET /api/{prefix}/). {_access(r)} Filters: {_describe_filters(r)} "
            f"(multi-value filters take a list). Search fields: {', '.join(r['search_fields']) or '(none)'}. "
            f"Ordering: {', '.join(r['ordering_fields']) or '(none)'} (prefix - for descending). "
            f"{'Paginated envelope {count,pages,page,page_size,results}' if r['list_paginated'] else 'Returns a bare array'}; "
            f"all_pages=true returns every row (max 20 pages).{notes}"
        )
        mcp.add_tool(list_tool, name=f'list_{name}', annotations=ToolAnnotations(title=f'List {name}', readOnlyHint=True))

        def get_tool(ctx: Context, id: int, _r=r) -> Any:
            client = client_for(ctx, state)
            return run_api(lambda: client.get(f"{_r['prefix']}/{id}/"))

        get_tool.__doc__ = f"Fetch one {singular} by id (GET /api/{prefix}/{{id}}/). 404 means missing OR outside your scope."
        mcp.add_tool(get_tool, name=f'get_{singular}', annotations=ToolAnnotations(title=f'Get {singular}', readOnlyHint=True))

    if not read_only and 'POST' in r['methods']:
        def create_tool(ctx: Context, data: dict[str, Any], _r=r) -> Any:
            payload = validate_payload(catalog, _r['name'], data, partial=False)
            client = client_for(ctx, state)
            return run_api(lambda: client.post(f"{_r['prefix']}/", json=payload))

        create_tool.__doc__ = (
            f"Create a {singular} (POST /api/{prefix}/). {_access(r)} Fields (* required): {_describe_fields(r)}. "
            f"company/branch/owner/created_by are stamped from you.{notes}"
        )
        mcp.add_tool(create_tool, name=f'create_{singular}', annotations=ToolAnnotations(title=f'Create {singular}', readOnlyHint=False))

    if not read_only and 'PATCH' in r['methods']:
        def update_tool(ctx: Context, id: int, data: dict[str, Any], _r=r) -> Any:
            payload = validate_payload(catalog, _r['name'], data, partial=True)
            if not payload:
                raise ToolError('Nothing to update: every supplied field is read-only or `data` is empty.')
            client = client_for(ctx, state)
            return run_api(lambda: client.patch(f"{_r['prefix']}/{id}/", json=payload))

        update_tool.__doc__ = (
            f"Partially update a {singular} (PATCH /api/{prefix}/{{id}}/). Only send fields that change. "
            f"Fields: {_describe_fields(r)}.{notes}"
        )
        mcp.add_tool(update_tool, name=f'update_{singular}', annotations=ToolAnnotations(title=f'Update {singular}', idempotentHint=True))

    if not read_only and 'DELETE' in r['methods']:
        def delete_tool(ctx: Context, id: int, confirm: bool = False, _r=r) -> dict:
            if not confirm:
                raise ToolError(f'Refusing to delete {_r["singular"]} {id} without confirm=true. Ask the user first.')
            client = client_for(ctx, state)
            run_api(lambda: client.delete(f"{_r['prefix']}/{id}/"))
            return {'deleted': id, 'resource': _r['name']}

        cap = r['delete_requires_capability']
        delete_tool.__doc__ = (
            f"Delete a {singular} (DELETE /api/{prefix}/{{id}}/). Requires confirm=true. "
            + (f"Needs capability {cap}; roles without it must use create_approval_request instead." if cap else '')
        )
        mcp.add_tool(delete_tool, name=f'delete_{singular}', annotations=ToolAnnotations(title=f'Delete {singular}', destructiveHint=True))

    for action in r['actions']:
        if action.get('skip_generated'):
            continue
        _register_action(mcp, state, r, action, read_only)


def _register_action(mcp: FastMCP, state: ServerState, r: dict, action: dict, read_only: bool) -> None:
    method = action['method']
    is_write = method != 'GET'
    if read_only and is_write:
        return
    detail = action['detail']
    has_body = bool(action['body'])
    has_query = bool(action.get('query'))
    is_list = (method == 'GET' and not detail and 'paginated' in (action['response'] or '').lower())
    destructive = any(w in action['tool_name'] for w in ('reject', 'revoke', 'reset', 'delete'))

    def path_for(id_value):
        return action['path'].replace('{id}', str(id_value)) if detail else action['path']

    if detail and has_body:
        def tool(ctx: Context, id: int, body: dict[str, Any] | None = None, _a=action) -> Any:
            client = client_for(ctx, state)
            return run_api(lambda: client.request(_a['method'], path_for(id), json=body or {}).json())
    elif detail:
        def tool(ctx: Context, id: int, _a=action) -> Any:
            client = client_for(ctx, state)
            return run_api(lambda: client.request(_a['method'], path_for(id)).json())
    elif has_body:
        def tool(ctx: Context, body: dict[str, Any], _a=action) -> Any:
            client = client_for(ctx, state)
            return run_api(lambda: client.request(_a['method'], path_for(None), json=body).json())
    elif has_query and method == 'GET':
        def tool(ctx: Context, query: dict[str, Any] | None = None, page: int = 1, page_size: int = 25,
                 all_pages: bool = False, _a=action) -> Any:
            params = dict(query or {})
            params.update({'page': page, 'page_size': max(1, min(int(page_size), 200))})
            client = client_for(ctx, state)
            return run_api(lambda: client.list_pages(path_for(None), params=params, all_pages=all_pages))
    elif is_list:
        def tool(ctx: Context, page: int = 1, page_size: int = 25, all_pages: bool = False, _a=action) -> Any:
            params = {'page': page, 'page_size': max(1, min(int(page_size), 200))}
            client = client_for(ctx, state)
            return run_api(lambda: client.list_pages(path_for(None), params=params, all_pages=all_pages))
    else:
        def tool(ctx: Context, _a=action) -> Any:
            client = client_for(ctx, state)
            return run_api(lambda: client.request(_a['method'], path_for(None), json={} if _a['method'] != 'GET' else None).json())

    desc = f"{action['description']} ({method} /api/{action['path']})."
    if has_body:
        desc += f" body: {json.dumps(action['body'])}."
    if has_query:
        desc += f" query: {json.dumps(action['query'])}."
    if action['response']:
        desc += f" Returns: {action['response']}."
    tool.__doc__ = desc
    mcp.add_tool(tool, name=action['tool_name'],
                 annotations=ToolAnnotations(title=action['tool_name'].replace('_', ' '),
                                             readOnlyHint=not is_write, destructiveHint=destructive))
```

- [ ] **Step 4: Run tests**

Run: `cd backend && python manage.py test mcp_server.tests.test_generated mcp_server.tests.test_server`
Expected: `test_generated` OK (15 tests). In `test_server`, `test_api_error_is_tool_error_with_hint` and `test_read_only_mode_hides_write_tools` now pass; `test_tools_resources_prompts_are_registered` still fails on `analytics_overview` (Task 8).

If FastMCP rejects the `_r=r` default-argument trick because it appears in the tool schema, move to closures: wrap each `def` inside a factory `def make(_r): def tool(...): ...; return tool` and drop the `_r` parameter. FastMCP builds the input schema from the signature, so any extra parameter must be removed from the signature; the factory form is the safe choice.

- [ ] **Step 5: Commit**

```bash
git add backend/mcp_server/tools/generated.py backend/mcp_server/tests/test_generated.py
git commit -m "Generate CRUD and action tools from the MCP catalog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Analytics, auth and permission tools

**Files:**
- Create: `backend/mcp_server/tools/analytics.py` (replace placeholder)
- Replace: `backend/mcp_server/tools/auth_tools.py`
- Create: `backend/mcp_server/tests/test_analytics_auth.py`

**Interfaces:**
- Produces: `register_analytics_tools(mcp, state)` registering `analytics_overview(ctx)`, `analytics_funnel(ctx)`, `analytics_revenue(ctx, months: int = 12)`, `analytics_branches(ctx)`, `analytics_visa_pipeline(ctx)`, `analytics_sources(ctx)`, `health(ctx)`.
- Produces: `register_auth_tools(mcp, state)` registering `whoami(ctx)`, `my_capabilities(ctx)`, `explain_permission(ctx, action: str, resource: str, role: str | None = None)`, `get_role_permissions(ctx, company: int | None = None)`, `update_role_permissions(ctx, changes: list[dict], company: int | None = None)` (write), `reset_role_permissions(ctx, company: int | None = None, confirm: bool = False)` (write, destructive).
- `explain_permission` returns `{"resource", "action", "role", "allowed_by_default", "capability", "floor", "reason", "read_roles", "write_roles", "notes"}` from the catalog only (no API call except `whoami` when `role` is omitted).

- [ ] **Step 1: Write the failing tests**

`backend/mcp_server/tests/test_analytics_auth.py`:

```python
from .base import McpTestCase


class AnalyticsToolTests(McpTestCase):
    def test_overview_is_open_and_scoped(self):
        admin = self.call('analytics_overview', self.admin)
        self.assertEqual(admin['enquiries'], 3)
        emp = self.call('analytics_overview', self.emp_k1)
        self.assertEqual(emp['enquiries'], 1)

    def test_manager_only_analytics(self):
        text = self.call_raises('analytics_funnel', self.emp_k1)
        self.assertIn('403', text)
        funnel = self.call('analytics_funnel', self.mgr_k)
        self.assertEqual(funnel['stages'][0]['stage'], 'Enquiries')
        revenue = self.call('analytics_revenue', self.admin, months=3)
        self.assertEqual(len(revenue['series']), 3)
        branches = self.call('analytics_branches', self.admin)
        self.assertEqual({b['name'] for b in branches}, {'Head Office', 'Kohima', 'Dimapur'})
        self.assertIn('pipeline', self.call('analytics_visa_pipeline', self.emp_k1))
        self.assertIsInstance(self.call('analytics_sources', self.admin), list)

    def test_revenue_months_is_clamped(self):
        text = self.call_raises('analytics_revenue', self.admin, months=0)
        self.assertIn('1', text)

    def test_health(self):
        self.assertEqual(self.call('health', self.admin)['status'], 'ok')


class AuthToolTests(McpTestCase):
    def test_my_capabilities(self):
        caps = self.call('my_capabilities', self.emp_k1)
        self.assertEqual(caps['role'], 'EMPLOYEE')
        self.assertNotIn('deleteRecords', caps['capabilities'])
        self.assertIn('deleteRecords', self.call('my_capabilities', self.mgr_k)['capabilities'])

    def test_explain_permission_from_catalog(self):
        answer = self.call('explain_permission', self.emp_k1, action='delete', resource='enquiries')
        self.assertEqual(answer['role'], 'EMPLOYEE')
        self.assertFalse(answer['allowed_by_default'])
        self.assertEqual(answer['capability'], 'deleteRecords')
        self.assertEqual(answer['floor'], 'BRANCH_MANAGER')
        answer = self.call('explain_permission', self.emp_k1, action='write', resource='commissions', role='HEAD_MANAGER')
        self.assertFalse(answer['allowed_by_default'])
        self.assertEqual(answer['capability'], 'manageCommissions')
        answer = self.call('explain_permission', self.emp_k1, action='read', resource='commissions', role='HEAD_MANAGER')
        self.assertTrue(answer['allowed_by_default'])
        text = self.call_raises('explain_permission', self.emp_k1, action='read', resource='nope')
        self.assertIn('Unknown resource', text)

    def test_role_permissions_round_trip(self):
        grid = self.call('get_role_permissions', self.admin)
        self.assertFalse(grid['matrix']['EMPLOYEE']['viewAnalytics']['allowed'])
        updated = self.call('update_role_permissions', self.admin, changes=[
            {'role': 'EMPLOYEE', 'capability': 'viewAnalytics', 'allowed': True},
        ])
        self.assertTrue(updated['matrix']['EMPLOYEE']['viewAnalytics']['allowed'])
        self.assertEqual(self.call('analytics_funnel', self.emp_k1)['stages'][0]['stage'], 'Enquiries')
        text = self.call_raises('reset_role_permissions', self.admin)
        self.assertIn('confirm', text)
        reset = self.call('reset_role_permissions', self.admin, confirm=True)
        self.assertFalse(reset['matrix']['EMPLOYEE']['viewAnalytics']['allowed'])

    def test_role_permissions_need_manage_settings(self):
        text = self.call_raises('get_role_permissions', self.mgr_k)
        self.assertIn('403', text)
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python manage.py test mcp_server.tests.test_analytics_auth`
Expected: failures with "Unknown tool: analytics_overview" style errors.

- [ ] **Step 3: Implement `analytics.py`**

`backend/mcp_server/tools/analytics.py`:

```python
"""The six analytics endpoints and health. All are scoped server-side and cached ~30 s."""

from __future__ import annotations

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations

from ..server import ServerState, client_for, run_api

CACHE_NOTE = ' Cached per caller for SCOPED_CACHE_SECONDS (default 30 s); a write you just made may not show yet.'


def register_analytics_tools(mcp: FastMCP, state: ServerState) -> None:
    def ro(title):
        return ToolAnnotations(title=title, readOnlyHint=True)

    def analytics_overview(ctx: Context) -> dict:
        """Dashboard counters for the caller's scope: enquiries/registrations/enrollments this month vs last, conversionRate, revenueThisMonth, totalRevenue, pendingPayments. Open to every role (an employee sees only own records)."""
        client = client_for(ctx, state)
        return run_api(lambda: client.get('analytics/overview/'))
    analytics_overview.__doc__ += CACHE_NOTE

    def analytics_funnel(ctx: Context) -> dict:
        """Pipeline funnel {stages:[{stage,count,rate}], dropOff:{enquiryToRegistration, registrationToEnrollment, enrollmentToVisa}}. Needs viewAnalytics (managers and above by default)."""
        client = client_for(ctx, state)
        return run_api(lambda: client.get('analytics/funnel/'))
    analytics_funnel.__doc__ += CACHE_NOTE

    def analytics_revenue(ctx: Context, months: int = 12) -> dict:
        """Monthly revenue series for the last `months` (1..36) calendar months: {series:[{month,label,revenue,transactions,registrationFees,enrollmentFees,otherFees,commissions}]}. Only Success payments count. Needs viewAnalytics."""
        if not 1 <= int(months) <= 36:
            raise ToolError('months must be between 1 and 36.')
        client = client_for(ctx, state)
        return run_api(lambda: client.get('analytics/revenue/', params={'months': int(months)}))
    analytics_revenue.__doc__ += CACHE_NOTE

    def analytics_branches(ctx: Context) -> list:
        """Per-branch table (bare array): {id,name,city,staff,enquiries,registrations,enrollments,revenue,conversionRate}. Managers see only their branches. Needs viewAnalytics."""
        client = client_for(ctx, state)
        return run_api(lambda: client.get('analytics/branches/'))
    analytics_branches.__doc__ += CACHE_NOTE

    def analytics_visa_pipeline(ctx: Context) -> dict:
        """Visa stage counts {pipeline:[{stage,count}] for all seven stages in order, total}. Open to every role."""
        client = client_for(ctx, state)
        return run_api(lambda: client.get('analytics/visa-pipeline/'))
    analytics_visa_pipeline.__doc__ += CACHE_NOTE

    def analytics_sources(ctx: Context) -> list:
        """Enquiry sources by stream (bare array): {source,total,converted,conversionRate}. Needs viewAnalytics."""
        client = client_for(ctx, state)
        return run_api(lambda: client.get('analytics/sources/'))
    analytics_sources.__doc__ += CACHE_NOTE

    def health(ctx: Context) -> dict:
        """Backend health (GET /api/health/, unauthenticated): {status: ok|degraded}."""
        client = client_for(ctx, state)
        r = run_api(lambda: client.transport.request('GET', 'health/'))
        return r.json() or {'status': 'degraded'}

    mcp.add_tool(analytics_overview, name='analytics_overview', annotations=ro('Analytics overview'))
    mcp.add_tool(analytics_funnel, name='analytics_funnel', annotations=ro('Admissions funnel'))
    mcp.add_tool(analytics_revenue, name='analytics_revenue', annotations=ro('Revenue series'))
    mcp.add_tool(analytics_branches, name='analytics_branches', annotations=ro('Branch analytics'))
    mcp.add_tool(analytics_visa_pipeline, name='analytics_visa_pipeline', annotations=ro('Visa pipeline'))
    mcp.add_tool(analytics_sources, name='analytics_sources', annotations=ro('Enquiry sources'))
    mcp.add_tool(health, name='health', annotations=ro('Backend health'))
```

- [ ] **Step 4: Implement `auth_tools.py`**

`backend/mcp_server/tools/auth_tools.py`:

```python
"""Identity, capabilities, the permissions matrix, and "why can't I".."""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations

from ..server import ServerState, client_for, run_api

ACTIONS = ('read', 'write', 'create', 'update', 'delete')


def register_auth_tools(mcp: FastMCP, state: ServerState) -> None:
    catalog = state.catalog
    read_only = state.settings.read_only

    def whoami(ctx: Context) -> dict:
        """Who the server is acting as: user (id, username, name, role, company, branch), the role's live capabilities, and how it authenticated. Call this first."""
        client = client_for(ctx, state)
        me = run_api(lambda: client.get('users/me/'))
        caps = run_api(lambda: client.get('role-permissions/mine/'))
        visibility = catalog.roles['visibility'].get(me['role'], '')
        return {'user': me, 'role': me['role'], 'company': me.get('company_name'), 'branch': me.get('branch_name'),
                'capabilities': caps['capabilities'], 'visibility': visibility,
                'auth': client.credentials.describe(), 'read_only_mode': read_only}

    def my_capabilities(ctx: Context) -> dict:
        """The caller's role and the capabilities it currently holds (company overrides applied): {role, capabilities[]}."""
        client = client_for(ctx, state)
        return run_api(lambda: client.get('role-permissions/mine/'))

    def explain_permission(ctx: Context, action: str, resource: str, role: str | None = None) -> dict:
        """Explain from the catalog whether `role` (default: the caller's) may `action` (read|write|create|update|delete) on `resource` (catalog name, e.g. enquiries, commissions), which capability governs it, its floor and the reason. Live overrides can widen or narrow the default; check my_capabilities for the live answer."""
        action = (action or '').lower()
        if action not in ACTIONS:
            raise ToolError(f'action must be one of {", ".join(ACTIONS)}.')
        try:
            r = catalog.resource(resource)
        except KeyError as exc:
            raise ToolError(str(exc))
        if role is None:
            client = client_for(ctx, state)
            role = run_api(lambda: client.get('users/me/'))['role']
        role = role.upper()
        if role not in catalog.roles['rank']:
            raise ToolError(f'Unknown role {role}. Roles: {", ".join(catalog.roles["rank"])}.')
        if action == 'read':
            capability = r['read_capability']
            roles = r['read_roles']
        elif action == 'delete' and r['delete_requires_capability']:
            capability = r['delete_requires_capability']
            roles = catalog.roles['defaults'].get(capability, [])
        else:
            capability = r['write_capability']
            roles = r['write_roles']
        protected = catalog.roles['protected'].get(capability or '', {})
        notes = list(r['notes'])
        if action != 'read':
            notes.append('Within a tenant, writes also require the record to be in your scope (own branch(es) for managers, own records or transferred-in for employees).')
        if action == 'delete' and capability == 'deleteRecords':
            notes.append('Roles without deleteRecords raise an approval request (create_approval_request action=DELETE).')
        return {
            'resource': r['name'], 'action': action, 'role': role,
            'allowed_by_default': role in roles or role == 'DEV_ADMIN',
            'capability': capability, 'floor': protected.get('floor'), 'reason': protected.get('reason', ''),
            'read_roles': r['read_roles'], 'write_roles': r['write_roles'], 'notes': notes,
        }

    def get_role_permissions(ctx: Context, company: int | None = None) -> dict:
        """The role x capability matrix for your company (DEV_ADMIN may pass company). Needs manageSettings. Each cell: {allowed, source: default|override|platform, editable, can_grant, can_revoke, reason}."""
        client = client_for(ctx, state)
        params = {'company': company} if company else None
        return run_api(lambda: client.get('role-permissions/', params=params))

    def update_role_permissions(ctx: Context, changes: list[dict[str, Any]], company: int | None = None) -> dict:
        """Apply a batch of {role, capability, allowed: true|false|null} changes atomically (null deletes the override). Refused entirely if any cell is refused: DEV_ADMIN rows, grants below a protected floor, grants of a capability you do not hold, or revoking manageSettings/manageUsers from COMPANY_ADMIN. Needs manageSettings."""
        if not isinstance(changes, list) or not changes:
            raise ToolError('changes must be a non-empty list of {role, capability, allowed}.')
        body: dict[str, Any] = {'changes': changes}
        if company:
            body['company'] = company
        client = client_for(ctx, state)
        return run_api(lambda: client.put('role-permissions/', json=body))

    def reset_role_permissions(ctx: Context, company: int | None = None, confirm: bool = False) -> dict:
        """Drop every override and return the company to built-in defaults. Requires confirm=true. Needs manageSettings."""
        if not confirm:
            raise ToolError('Refusing to reset the permissions matrix without confirm=true.')
        client = client_for(ctx, state)
        params = {'company': company} if company else None
        return run_api(lambda: client.delete('role-permissions/') if not params else client.request('DELETE', 'role-permissions/', params=params).json())

    mcp.add_tool(whoami, name='whoami', annotations=ToolAnnotations(title='Who am I', readOnlyHint=True))
    mcp.add_tool(my_capabilities, name='my_capabilities', annotations=ToolAnnotations(title='My capabilities', readOnlyHint=True))
    mcp.add_tool(explain_permission, name='explain_permission', annotations=ToolAnnotations(title='Explain permission', readOnlyHint=True))
    mcp.add_tool(get_role_permissions, name='get_role_permissions', annotations=ToolAnnotations(title='Role permissions', readOnlyHint=True))
    if not read_only:
        mcp.add_tool(update_role_permissions, name='update_role_permissions', annotations=ToolAnnotations(title='Update role permissions'))
        mcp.add_tool(reset_role_permissions, name='reset_role_permissions', annotations=ToolAnnotations(title='Reset role permissions', destructiveHint=True))
```

- [ ] **Step 5: Run tests**

Run: `cd backend && python manage.py test mcp_server.tests.test_analytics_auth mcp_server.tests.test_server`
Expected: `test_analytics_auth` OK (9 tests). `test_server.test_tools_resources_prompts_are_registered` still fails on `upload_document` (Task 9).

- [ ] **Step 6: Commit**

```bash
git add backend/mcp_server/tools/analytics.py backend/mcp_server/tools/auth_tools.py backend/mcp_server/tests/test_analytics_auth.py
git commit -m "Add analytics, identity and permission-matrix MCP tools

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Document upload and download tools

**Files:**
- Replace: `backend/mcp_server/tools/documents.py`
- Create: `backend/mcp_server/tests/test_documents.py`

**Interfaces:**
- Produces: `register_document_tools(mcp, state)` registering `upload_document(ctx, file_name: str, file_base64: str | None = None, file_path: str | None = None, type: str = 'Other', registration: int | None = None, enquiry: int | None = None, expiry_date: str | None = None, status: str = 'IN') -> dict` (write) and `download_document(ctx, id: int, save_to: str | None = None) -> dict` (read).
- `download_document` returns `{"id", "file_name", "content_type", "size", "saved_to"}` when `save_to` is given (stdio only), or `{"id", "file_name", "content_type", "size", "base64"}` when the file is at most `settings.max_download_bytes`, otherwise `{"id", "file_name", "content_type", "size", "base64": null, "note": "..."}`.

- [ ] **Step 1: Write the failing tests**

`backend/mcp_server/tests/test_documents.py`:

```python
import base64
import tempfile
from pathlib import Path

from core.models import Document, Registration

from .base import McpTestCase


class DocumentToolTests(McpTestCase):
    def test_upload_base64_then_download_base64(self):
        content = b'%PDF-1.4 hello'
        doc = self.call('upload_document', self.emp_k1, file_name='offer.pdf',
                        file_base64=base64.b64encode(content).decode(), type='Offer Letter',
                        enquiry=self.enq_k1.pk, expiry_date='2027-01-31')
        self.assertEqual(doc['file_name'], 'offer.pdf')
        self.assertEqual(doc['student_name'], 'kohima-one')
        self.assertTrue(doc['is_encrypted'])
        got = self.call('download_document', self.emp_k1, id=doc['id'])
        self.assertEqual(base64.b64decode(got['base64']), content)
        self.assertEqual(got['size'], len(content))

    def test_upload_from_path_and_download_to_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / 'scan.png'
            src.write_bytes(b'\x89PNG fake')
            doc = self.call('upload_document', self.mgr_k, file_name='scan.png', file_path=str(src), type='Passport')
            target = Path(tmp) / 'out.png'
            got = self.call('download_document', self.mgr_k, id=doc['id'], save_to=str(target))
            self.assertEqual(got['saved_to'], str(target))
            self.assertEqual(target.read_bytes(), b'\x89PNG fake')
            self.assertIsNone(got.get('base64'))

    def test_both_registration_and_enquiry_is_rejected(self):
        reg = Registration.objects.create(
            company=self.company, branch=self.kohima, created_by=self.emp_k1, owner=self.emp_k1,
            student_name='R', registration_no='REG-2026-001', registration_fee=100,
        )
        text = self.call_raises('upload_document', self.emp_k1, file_name='x.pdf',
                                file_base64=base64.b64encode(b'x').decode(), registration=reg.pk, enquiry=self.enq_k1.pk)
        self.assertIn('one of registration or enquiry', text)

    def test_missing_content_is_rejected(self):
        text = self.call_raises('upload_document', self.emp_k1, file_name='x.pdf')
        self.assertIn('file_base64', text)

    def test_disallowed_extension_is_400(self):
        text = self.call_raises('upload_document', self.emp_k1, file_name='x.exe', file_base64=base64.b64encode(b'x').decode())
        self.assertIn('400', text)

    def test_download_out_of_scope_is_404(self):
        doc = self.call('upload_document', self.emp_d1, file_name='d.pdf', file_base64=base64.b64encode(b'x').decode())
        text = self.call_raises('download_document', self.emp_k1, id=doc['id'])
        self.assertIn('404', text)

    def test_large_file_returns_metadata_only(self):
        content = b'x' * 2048
        doc = self.call('upload_document', self.admin, file_name='big.pdf', file_base64=base64.b64encode(content).decode())
        # Rebuild a server whose cap is smaller than the file.
        from mcp_server.config import Settings
        from mcp_server.server import build_server
        from mcp_server.testing import DjangoTestTransport
        import asyncio
        from mcp.shared.memory import create_connected_server_and_client_session
        settings = Settings(api_url='http://testserver/api/', api_key=self.key_for(self.admin), max_download_bytes=1024)
        server = build_server(settings, transport=DjangoTestTransport())

        async def go():
            async with create_connected_server_and_client_session(server) as session:
                return await session.call_tool('download_document', {'id': doc['id']})
        result = asyncio.run(go())
        payload = self._unwrap(result)
        self.assertIsNone(payload['base64'])
        self.assertIn('save_to', payload['note'])

    def test_upload_hidden_in_read_only_mode(self):
        self.assertNotIn('upload_document', self.tool_names(self.admin, read_only=True))
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python manage.py test mcp_server.tests.test_documents`
Expected: "Unknown tool: upload_document".

- [ ] **Step 3: Implement `documents.py`**

`backend/mcp_server/tools/documents.py`:

```python
"""Encrypted document upload (multipart) and download (streamed, decrypted server-side)."""

from __future__ import annotations

import base64
import mimetypes
import os
from pathlib import Path

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations

from ..server import ServerState, client_for, run_api


def register_document_tools(mcp: FastMCP, state: ServerState) -> None:
    settings = state.settings
    allowed = ', '.join(state.catalog.conventions['uploads']['allowed_extensions'])
    max_upload = state.catalog.conventions['uploads']['max_bytes']

    def upload_document(ctx: Context, file_name: str, file_base64: str | None = None, file_path: str | None = None,
                        type: str = 'Other', registration: int | None = None, enquiry: int | None = None,
                        expiry_date: str | None = None, status: str = 'IN') -> dict:
        """Upload a scan as an encrypted Document (POST /api/documents/, multipart). Provide the bytes as file_base64, or (stdio mode only) a local file_path. Link to at most ONE of registration / enquiry; student_name is derived from that link. expiry_date is YYYY-MM-DD; status is IN or OUT (custody of the scan). Allowed extensions and size limit come from the server."""
        if registration and enquiry:
            raise ToolError('A document links to exactly one of registration or enquiry, never both.')
        if file_base64:
            try:
                content = base64.b64decode(file_base64, validate=True)
            except Exception:
                raise ToolError('file_base64 is not valid base64.')
        elif file_path:
            if not settings.stdio:
                raise ToolError('file_path is only available when the server runs locally over stdio; send file_base64.')
            p = Path(os.path.expanduser(file_path))
            if not p.is_file():
                raise ToolError(f'file_path {file_path} does not exist.')
            content = p.read_bytes()
        else:
            raise ToolError('Provide file_base64 (or file_path in stdio mode).')
        if len(content) > max_upload:
            raise ToolError(f'File is {len(content)} bytes; the server limit is {max_upload}.')
        content_type = mimetypes.guess_type(file_name)[0] or 'application/octet-stream'
        data = {'file_name': file_name, 'type': type, 'status': status}
        if registration:
            data['registration'] = str(registration)
        if enquiry:
            data['enquiry'] = str(enquiry)
        if expiry_date:
            data['expiry_date'] = expiry_date
        client = client_for(ctx, state)
        return run_api(lambda: client.post('documents/', data=data, files={'file': (file_name, content, content_type)}))
    upload_document.__doc__ += f' Allowed extensions: {allowed}. Max {max_upload} bytes.'

    def download_document(ctx: Context, id: int, save_to: str | None = None) -> dict:
        """Download the decrypted file for a Document (GET /api/documents/{id}/download/). With save_to (stdio mode only) the file is written there and no bytes are returned; otherwise the content is returned as base64 when it is within the server's size cap, else metadata only."""
        client = client_for(ctx, state)
        response = run_api(lambda: client.raw_get(f'documents/{id}/download/'))
        content = response.content
        content_type = response.headers.get('Content-Type', 'application/octet-stream')
        disposition = response.headers.get('Content-Disposition', '')
        file_name = disposition.split('filename=')[-1].strip('"; ') if 'filename=' in disposition else f'document-{id}'
        meta = {'id': id, 'file_name': file_name, 'content_type': content_type, 'size': len(content)}
        if save_to:
            if not settings.stdio:
                raise ToolError('save_to is only available when the server runs locally over stdio.')
            target = Path(os.path.expanduser(save_to))
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            meta['saved_to'] = str(target)
            return meta
        if len(content) <= settings.max_download_bytes:
            meta['base64'] = base64.b64encode(content).decode('ascii')
        else:
            meta['base64'] = None
            meta['note'] = (f'File is {len(content)} bytes, above the {settings.max_download_bytes}-byte cap. '
                            'Use save_to (stdio) or raise CONSULTANCY_MCP_MAX_DOWNLOAD_BYTES.')
        return meta

    if not settings.read_only:
        mcp.add_tool(upload_document, name='upload_document', annotations=ToolAnnotations(title='Upload document'))
    mcp.add_tool(download_document, name='download_document', annotations=ToolAnnotations(title='Download document', readOnlyHint=True))
```

- [ ] **Step 4: Run tests**

Run: `cd backend && python manage.py test mcp_server.tests.test_documents`
Expected: `Ran 8 tests ... OK`. If `test_upload_from_path_and_download_to_path` fails on `stdio`, the test server's `Settings` default transport is `'stdio'`, which is intended; confirm `settings.stdio` reads `transport == 'stdio'`.

- [ ] **Step 5: Commit**

```bash
git add backend/mcp_server/tools/documents.py backend/mcp_server/tests/test_documents.py
git commit -m "Add document upload and download MCP tools

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Composite workflow tools

**Files:**
- Replace: `backend/mcp_server/tools/workflows.py`
- Create: `backend/mcp_server/tests/test_workflows.py`

**Interfaces:**
- Produces: `register_workflow_tools(mcp, state)` registering `student_360(ctx, registration_id=None, enquiry_id=None, enrollment_id=None)`, `convert_enquiry_to_registration(ctx, enquiry_id, registration_fee, payment_status='Pending', payment_method='Cash', needs_loan=False, overrides=None, mark_converted=True)` (write), `enroll_student(ctx, registration_id, program_name, start_date, duration_months, total_fees, university=None, university_name='', country='', installments_count=0, installment_amount=None, commission_amount=None)` (write), `record_payment(ctx, amount, method='Cash', type='Enrollment', registration=None, enrollment=None, installment=None, student_name=None, reference='', status='Success', metadata=None, date=None)` (write), `search_everything(ctx, query, limit=10)`, `daily_briefing(ctx, date=None)`.
- Produces: `ENQUIRY_TO_REGISTRATION: tuple[tuple[str, str], ...]` (enquiry field → registration field), `build_registration_from_enquiry(enquiry: dict, registration_fee, payment_status, payment_method, needs_loan, overrides) -> dict`, `PAYMENT_METADATA_KEYS: dict[str, tuple[str, ...]]`.

- [ ] **Step 1: Write the failing tests**

`backend/mcp_server/tests/test_workflows.py`:

```python
import datetime as dt

from core.models import Enquiry, Enrollment, Installment, Payment, Registration

from mcp_server.tools.workflows import build_registration_from_enquiry

from .base import McpTestCase


class MappingTests(McpTestCase):
    def test_build_registration_maps_profile_fields(self):
        enquiry = {
            'id': 7, 'candidate_name': 'Asha', 'email': 'a@x.com', 'mobile': '9', 'father_name': 'F', 'mother_name': 'M',
            'permanent_address': 'Addr', 'father_occupation': 'Farmer', 'school_name': 'S', 'stream': 'Science',
            'gender': 'Female', 'date_of_birth': '2006-05-01', 'class12_percentage': '88.50', 'physics_marks': '80.00',
            'gap_year': True, 'gap_year_from': 2024, 'college_dropout': False,
            'preferred_locations': ['Kota', 'Delhi'], 'course_interested': 'MBBS', 'status': 'New',
        }
        reg = build_registration_from_enquiry(enquiry, '1500', 'Paid', 'UPI', False, {'mobile': '8'})
        self.assertEqual(reg['student_name'], 'Asha')
        self.assertEqual(reg['mobile'], '8')
        self.assertEqual(reg['enquiry'], 7)
        self.assertEqual(reg['father_occupation'], 'Farmer')
        self.assertEqual(reg['date_of_birth'], '2006-05-01')
        self.assertEqual(reg['registration_fee'], '1500')
        self.assertEqual(reg['payment_status'], 'Paid')
        self.assertEqual(reg['preferences'], [
            {'courseName': 'MBBS', 'location': 'Kota', 'priority': 1},
            {'courseName': 'MBBS', 'location': 'Delhi', 'priority': 2},
        ])
        self.assertNotIn('status', reg)
        self.assertNotIn('id', reg)


class WorkflowToolTests(McpTestCase):
    def test_convert_enquiry_creates_registration_payment_and_marks_converted(self):
        reg = self.call('convert_enquiry_to_registration', self.emp_k1, enquiry_id=self.enq_k1.pk,
                        registration_fee='2000', payment_status='Paid')
        self.assertTrue(reg['registration_no'].startswith('REG-'))
        self.assertEqual(reg['enquiry'], self.enq_k1.pk)
        self.assertEqual(reg['student_name'], 'kohima-one')
        self.enq_k1.refresh_from_db()
        self.assertEqual(self.enq_k1.status, 'Converted')
        self.assertEqual(Payment.objects.filter(registration_id=reg['id'], status='Success').count(), 1)

    def test_convert_out_of_scope_enquiry_is_404(self):
        text = self.call_raises('convert_enquiry_to_registration', self.emp_k1, enquiry_id=self.enq_d1.pk, registration_fee='1')
        self.assertIn('404', text)

    def test_enroll_student_builds_installments(self):
        reg = self.call('convert_enquiry_to_registration', self.mgr_k, enquiry_id=self.enq_k2.pk, registration_fee='1000')
        enr = self.call('enroll_student', self.mgr_k, registration_id=reg['id'], program_name='MBBS',
                        start_date='2026-10-01', duration_months=60, total_fees='1000', installments_count=3)
        self.assertTrue(enr['enrollment_no'].startswith('ENR-'))
        amounts = [i['amount'] for i in enr['installments']]
        self.assertEqual(len(amounts), 3)
        self.assertEqual(sum(float(a) for a in amounts), 1000.0)
        self.assertEqual(Installment.objects.filter(enrollment_id=enr['id']).count(), 3)

    def test_record_payment_validates_method_metadata(self):
        reg = self.call('convert_enquiry_to_registration', self.mgr_k, enquiry_id=self.enq_k2.pk, registration_fee='1000')
        text = self.call_raises('record_payment', self.mgr_k, amount='500', method='UPI', registration=reg['id'], metadata={'cheque_no': '1'})
        self.assertIn('upi_transaction_id', text)
        pay = self.call('record_payment', self.mgr_k, amount='500', method='UPI', registration=reg['id'],
                        metadata={'upi_transaction_id': 'T123'})
        self.assertEqual(pay['status'], 'Success')
        self.assertEqual(pay['student_name'], 'kohima-two')
        self.assertEqual(pay['metadata']['upi_transaction_id'], 'T123')

    def test_student_360_gathers_everything(self):
        reg = self.call('convert_enquiry_to_registration', self.mgr_k, enquiry_id=self.enq_k2.pk, registration_fee='1000', payment_status='Paid')
        enr = self.call('enroll_student', self.mgr_k, registration_id=reg['id'], program_name='MBBS',
                        start_date='2026-10-01', duration_months=60, total_fees='3000', installments_count=2)
        self.call('create_follow_up', self.mgr_k, data={'enquiry': self.enq_k2.pk, 'scheduled_for': '2026-09-20T10:00:00Z', 'notes': 'call'})
        self.call('create_student_remark', self.mgr_k, data={'registration': reg['id'], 'remark': 'good'})
        self.call('create_student_document', self.mgr_k, data={'registration': reg['id'], 'name': 'Passport'})
        self.call('create_visa_tracking', self.mgr_k, data={'student': reg['id'], 'student_name': 'kohima-two', 'country': 'UK', 'passport_no': 'P123'})
        profile = self.call('student_360', self.mgr_k, registration_id=reg['id'])
        self.assertEqual(profile['registration']['id'], reg['id'])
        self.assertEqual(profile['enquiry']['id'], self.enq_k2.pk)
        self.assertEqual(len(profile['enrollments']), 1)
        self.assertEqual(len(profile['enrollments'][0]['installments']), 2)
        self.assertEqual(len(profile['payments']), 1)
        self.assertEqual(profile['totals']['paid'], 1000.0)
        self.assertEqual(profile['totals']['outstanding_installments'], 3000.0)
        self.assertEqual(len(profile['follow_ups']), 1)
        self.assertEqual(len(profile['remarks']), 1)
        self.assertEqual(len(profile['physical_documents']), 1)
        self.assertEqual(len(profile['visa']), 1)
        self.assertEqual(profile['visa'][0]['passport_no'], 'P123')
        by_enrollment = self.call('student_360', self.mgr_k, enrollment_id=enr['id'])
        self.assertEqual(by_enrollment['registration']['id'], reg['id'])
        by_enquiry = self.call('student_360', self.mgr_k, enquiry_id=self.enq_k2.pk)
        self.assertEqual(by_enquiry['registration']['id'], reg['id'])

    def test_student_360_needs_exactly_one_id(self):
        self.assertIn('exactly one', self.call_raises('student_360', self.mgr_k))

    def test_search_everything_groups_results(self):
        result = self.call('search_everything', self.admin, query='kohima')
        self.assertEqual(len(result['enquiries']), 2)
        self.assertIn('users', result)
        self.assertEqual(result['query'], 'kohima')

    def test_daily_briefing(self):
        self.call('create_follow_up', self.mgr_k, data={'enquiry': self.enq_k2.pk, 'scheduled_for': '2026-09-02T09:00:00Z'})
        self.call('create_appointment', self.mgr_k, data={'student_name': 'S', 'counselor': self.mgr_k.pk, 'date': '2026-09-02T11:00:00Z'})
        briefing = self.call('daily_briefing', self.mgr_k, date='2026-09-02')
        self.assertEqual(briefing['date'], '2026-09-02')
        self.assertEqual(len(briefing['follow_ups_due']), 1)
        self.assertEqual(len(briefing['appointments_today']), 1)
        self.assertIn('overview', briefing)
        self.assertIn('transfer_inbox', briefing)
        self.assertIn('pending_approvals', briefing)
        self.assertIn('expiring_documents', briefing)
        self.assertIn('unread_notifications', briefing)
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python manage.py test mcp_server.tests.test_workflows`
Expected: ImportError for `build_registration_from_enquiry`.

- [ ] **Step 3: Implement `workflows.py`**

`backend/mcp_server/tools/workflows.py`:

```python
"""
Composite tools that do what a person does across several screens. They only
call existing endpoints; no business rule lives here that the API does not
already enforce.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal
from typing import Any

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations

from ..client import ApiClient, ApiError
from ..server import ServerState, client_for, run_api

# Enquiry field -> Registration field. Mirrors the prefill in
# consultancy-dev/app/app/registrations/components/RegistrationForm.tsx, plus
# the profile columns Registration actually has (the web form writes those to
# remarks; the API stores them as columns).
ENQUIRY_TO_REGISTRATION = (
    ('candidate_name', 'student_name'), ('email', 'email'), ('mobile', 'mobile'),
    ('father_name', 'father_name'), ('mother_name', 'mother_name'), ('permanent_address', 'permanent_address'),
    ('date_of_birth', 'date_of_birth'), ('gender', 'gender'), ('caste', 'caste'), ('religion', 'religion'),
    ('father_occupation', 'father_occupation'), ('mother_occupation', 'mother_occupation'),
    ('father_mobile', 'father_mobile'), ('mother_mobile', 'mother_mobile'),
    ('family_place', 'family_place'), ('family_state', 'family_state'),
    ('stream', 'stream'), ('school_name', 'school_name'), ('school_board', 'school_board'),
    ('school_place', 'school_place'), ('school_state', 'school_state'),
    ('class12_passing_year', 'class12_passing_year'), ('class12_percentage', 'class12_percentage'),
    ('class10_school_name', 'class10_school_name'), ('class10_board', 'class10_board'),
    ('class10_passing_year', 'class10_passing_year'), ('class10_place', 'class10_place'),
    ('class10_state', 'class10_state'), ('class10_percentage', 'class10_percentage'),
    ('physics_marks', 'physics_marks'), ('chemistry_marks', 'chemistry_marks'),
    ('biology_marks', 'biology_marks'), ('maths_marks', 'maths_marks'),
    ('pcb_percentage', 'pcb_percentage'), ('pcm_percentage', 'pcm_percentage'),
    ('previous_neet_marks', 'previous_neet_marks'), ('present_neet_marks', 'present_neet_marks'),
    ('gap_year', 'gap_year'), ('gap_year_from', 'gap_year_from'), ('gap_year_to', 'gap_year_to'),
    ('college_dropout', 'college_dropout'),
)

# Method -> metadata keys the payment must carry (mirrors PaymentMetadata in the frontend).
PAYMENT_METADATA_KEYS = {
    'Cheque': ('cheque_no', 'bank_name'),
    'UPI': ('upi_transaction_id',),
    'Card': ('card_last4', 'card_network'),
}


def build_registration_from_enquiry(enquiry: dict, registration_fee, payment_status, payment_method,
                                    needs_loan, overrides: dict | None) -> dict:
    body: dict[str, Any] = {}
    for src, dest in ENQUIRY_TO_REGISTRATION:
        value = enquiry.get(src)
        if value not in (None, ''):
            body[dest] = value
    locations = enquiry.get('preferred_locations') or []
    if isinstance(locations, str):
        locations = [locations]
    course = enquiry.get('course_interested') or ''
    if locations and course:
        body['preferences'] = [{'courseName': course, 'location': loc, 'priority': i + 1} for i, loc in enumerate(locations)]
    body['enquiry'] = enquiry['id']
    body['registration_fee'] = str(registration_fee)
    body['payment_status'] = payment_status
    body['payment_method'] = payment_method
    body['needs_loan'] = bool(needs_loan)
    body.update(overrides or {})
    return body


def _money(value) -> float:
    try:
        return float(Decimal(str(value)))
    except Exception:
        return 0.0


def _safe(fn, default):
    """Run an API read; a 403/404 (scope or capability) yields `default` instead of failing the whole tool."""
    try:
        return fn()
    except ApiError as exc:
        if exc.status in (403, 404):
            return default
        raise


def _rows(client: ApiClient, path: str, params: dict) -> list:
    params = dict(params)
    params.setdefault('page_size', 100)
    return client.list_pages(path, params=params, all_pages=True, max_pages=10)


def _match_student(rows: list, registration_id: int, enrollment_ids: set, student_name: str) -> list:
    name = (student_name or '').strip().lower()
    out = []
    for row in rows:
        if row.get('registration') == registration_id or row.get('enrollment') in enrollment_ids:
            out.append(row)
        elif (row.get('student_name') or '').strip().lower() == name and not row.get('registration') and not row.get('enrollment'):
            out.append(row)
    return out


def register_workflow_tools(mcp: FastMCP, state: ServerState) -> None:
    read_only = state.settings.read_only

    def student_360(ctx: Context, registration_id: int | None = None, enquiry_id: int | None = None,
                    enrollment_id: int | None = None) -> dict:
        """Everything about one student in one call, resolved from exactly one of registration_id / enquiry_id / enrollment_id: enquiry, follow_ups (with comments), registration, remarks, enrollments (with installments), payments, refunds, documents (scans), physical_documents (custody), visa, appointments (matched by name), transfers, approvals and money totals. Sections you lack permission for come back empty."""
        given = [x for x in (registration_id, enquiry_id, enrollment_id) if x]
        if len(given) != 1:
            raise ToolError('Pass exactly one of registration_id, enquiry_id or enrollment_id.')
        client = client_for(ctx, state)
        registration = enquiry = None
        if enrollment_id:
            enrollment = run_api(lambda: client.get(f'enrollments/{enrollment_id}/'))
            registration_id = enrollment['student']
        if registration_id:
            registration = run_api(lambda: client.get(f'registrations/{registration_id}/'))
            enquiry_id = registration.get('enquiry')
            if enquiry_id:
                enquiry = _safe(lambda: client.get(f'enquiries/{enquiry_id}/'), None)
        else:
            enquiry = run_api(lambda: client.get(f'enquiries/{enquiry_id}/'))
            regs = _safe(lambda: _rows(client, 'registrations/', {'search': enquiry['candidate_name']}), [])
            regs = [r for r in regs if r.get('enquiry') == enquiry_id]
            registration = regs[0] if regs else None
            registration_id = registration['id'] if registration else None

        name = (registration or enquiry or {}).get('student_name') or (enquiry or {}).get('candidate_name', '')
        out: dict[str, Any] = {'enquiry': enquiry, 'registration': registration, 'student_name': name}

        follow_ups = _safe(lambda: _rows(client, 'follow-ups/', {'enquiry': enquiry_id}), []) if enquiry_id else []
        for fu in follow_ups:
            fu['comments'] = _safe(lambda fu=fu: _rows(client, 'follow-up-comments/', {'follow_up': fu['id']}), [])
        out['follow_ups'] = follow_ups

        enrollments: list = []
        if registration_id:
            out['remarks'] = _safe(lambda: _rows(client, 'student-remarks/', {'registration': registration_id}), [])
            out['physical_documents'] = _safe(lambda: _rows(client, 'student-documents/', {'registration': registration_id}), [])
            enrollments = [e for e in _safe(lambda: _rows(client, 'enrollments/', {'search': name}), []) if e.get('student') == registration_id]
            out['refunds'] = _safe(lambda: _rows(client, 'refunds/', {'student': registration_id}), [])
        else:
            out['remarks'], out['physical_documents'], out['refunds'] = [], [], []
        out['enrollments'] = enrollments
        enrollment_ids = {e['id'] for e in enrollments}

        payments = _safe(lambda: _rows(client, 'payments/', {'search': name}), []) if name else []
        out['payments'] = _match_student(payments, registration_id, enrollment_ids, name)

        docs = []
        if registration_id:
            docs += _safe(lambda: _rows(client, 'documents/', {'registration': registration_id}), [])
        if enquiry_id:
            docs += _safe(lambda: _rows(client, 'documents/', {'enquiry': enquiry_id}), [])
        out['documents'] = docs

        visa = _safe(lambda: _rows(client, 'visa-tracking/', {'search': name}), []) if name else []
        out['visa'] = [v for v in visa if (registration_id and v.get('student') == registration_id) or (v.get('student_name') or '').strip().lower() == name.strip().lower()]

        appts = _safe(lambda: _rows(client, 'appointments/', {'search': name}), []) if name else []
        out['appointments'] = [a for a in appts if (a.get('student_name') or '').strip().lower() == name.strip().lower()]

        transfers = _safe(lambda: _rows(client, 'transfers/', {}), [])
        ids = {('registration', registration_id), ('enquiry', enquiry_id)} | {('enrollment', e) for e in enrollment_ids}
        out['transfers'] = [t for t in transfers if (t['entity_type'], t['entity_id']) in ids]
        approvals = _safe(lambda: _rows(client, 'approval-requests/', {}), [])
        out['approvals'] = [a for a in approvals if (a['entity_type'], a['entity_id']) in ids]

        paid = sum(_money(p['amount']) for p in out['payments'] if p.get('status') == 'Success')
        pending = sum(_money(p['amount']) for p in out['payments'] if p.get('status') == 'Pending')
        refunded = sum(_money(r['amount']) for r in out['refunds'] if r.get('status') in ('Approved', 'Processed'))
        outstanding = sum(_money(i['amount']) for e in enrollments for i in e.get('installments', []) if i.get('status') != 'Paid')
        out['totals'] = {'paid': paid, 'pending': pending, 'refunded': refunded, 'net': paid - refunded,
                         'total_fees': sum(_money(e.get('total_fees')) for e in enrollments),
                         'outstanding_installments': outstanding}
        return out

    def convert_enquiry_to_registration(ctx: Context, enquiry_id: int, registration_fee: str,
                                        payment_status: str = 'Pending', payment_method: str = 'Cash',
                                        needs_loan: bool = False, overrides: dict[str, Any] | None = None,
                                        mark_converted: bool = True) -> dict:
        """Convert an enquiry into a registration the way the web form does: copy the candidate's details and profile into a new registration linked by `enquiry`, then (by default) set the enquiry status to Converted. The server assigns registration_no and creates the registration-fee Payment (Success when payment_status is "Paid"). `overrides` are registration fields that replace copied values."""
        client = client_for(ctx, state)
        enquiry = run_api(lambda: client.get(f'enquiries/{enquiry_id}/'))
        body = build_registration_from_enquiry(enquiry, registration_fee, payment_status, payment_method, needs_loan, overrides)
        registration = run_api(lambda: client.post('registrations/', json=body))
        if mark_converted and enquiry.get('status') != 'Converted':
            try:
                client.patch(f'enquiries/{enquiry_id}/', json={'status': 'Converted'})
            except ApiError as exc:
                registration['_warning'] = f'Registration created but enquiry status not updated: {exc}'
        return registration

    def enroll_student(ctx: Context, registration_id: int, program_name: str, start_date: str, duration_months: int,
                       total_fees: str, university: int | None = None, university_name: str = '', country: str = '',
                       installments_count: int = 0, installment_amount: str | None = None,
                       commission_amount: str | None = None) -> dict:
        """Create an enrollment for a registration (POST /api/enrollments/). start_date is YYYY-MM-DD. With installments_count > 0 the server builds that many monthly Installment rows summing exactly to total_fees (the last absorbs rounding); installment_amount optionally fixes the per-row amount. Returns the enrollment with its installments."""
        body: dict[str, Any] = {
            'student': registration_id, 'program_name': program_name, 'start_date': start_date,
            'duration_months': int(duration_months), 'total_fees': str(total_fees),
            'university_name': university_name, 'country': country,
        }
        if university:
            body['university'] = university
        if installments_count:
            body['installments_count'] = int(installments_count)
        if installment_amount is not None:
            body['installment_amount'] = str(installment_amount)
        if commission_amount is not None:
            body['commission_amount'] = str(commission_amount)
        client = client_for(ctx, state)
        return run_api(lambda: client.post('enrollments/', json=body))

    def record_payment(ctx: Context, amount: str, method: str = 'Cash', type: str = 'Enrollment',
                       registration: int | None = None, enrollment: int | None = None, installment: int | None = None,
                       student_name: str | None = None, reference: str = '', status: str = 'Success',
                       metadata: dict[str, Any] | None = None, date: str | None = None) -> dict:
        """Record a payment (POST /api/payments/). Link it to a registration and/or enrollment (and an installment when settling one). status: Pending|Success|Failed|Refunded (only Success counts as revenue). method-specific detail goes in metadata: Cheque needs cheque_no and bank_name; UPI needs upi_transaction_id; Card needs card_last4 and card_network. student_name is filled from the linked registration when omitted."""
        required = PAYMENT_METADATA_KEYS.get(method, ())
        missing = [k for k in required if not (metadata or {}).get(k)]
        if missing:
            raise ToolError(f'method {method} needs metadata keys: {", ".join(missing)}.')
        client = client_for(ctx, state)
        if not student_name:
            if registration:
                student_name = run_api(lambda: client.get(f'registrations/{registration}/'))['student_name']
            elif enrollment:
                student_name = run_api(lambda: client.get(f'enrollments/{enrollment}/'))['student_name']
            else:
                raise ToolError('Provide student_name, or a registration/enrollment to derive it from.')
        body: dict[str, Any] = {
            'amount': str(amount), 'method': method, 'type': type, 'status': status, 'reference': reference,
            'student_name': student_name, 'metadata': metadata or {},
        }
        if registration:
            body['registration'] = registration
        if enrollment:
            body['enrollment'] = enrollment
        if installment:
            body['installment'] = installment
        if date:
            body['date'] = date
        return run_api(lambda: client.post('payments/', json=body))

    def search_everything(ctx: Context, query: str, limit: int = 10) -> dict:
        """Search enquiries, registrations, enrollments, payments, documents, visa records, follow-ups, tasks, appointments and users for `query` (each endpoint's own search fields), returning up to `limit` rows per group. Sections you cannot read are empty."""
        if not query or not query.strip():
            raise ToolError('query must not be empty.')
        client = client_for(ctx, state)
        limit = max(1, min(int(limit), 50))
        groups = {
            'enquiries': 'enquiries/', 'registrations': 'registrations/', 'enrollments': 'enrollments/',
            'payments': 'payments/', 'documents': 'documents/', 'visa': 'visa-tracking/',
            'follow_ups': 'follow-ups/', 'tasks': 'tasks/', 'appointments': 'appointments/', 'users': 'users/',
        }
        out: dict[str, Any] = {'query': query}
        for key, path in groups.items():
            page = _safe(lambda path=path: client.get(path, params={'search': query, 'page_size': limit}), {'results': []})
            out[key] = page['results'] if isinstance(page, dict) else page
        return out

    def daily_briefing(ctx: Context, date: str | None = None) -> dict:
        """What needs attention on `date` (YYYY-MM-DD, default today): follow_ups_due (scheduled on or before that day, not Completed), appointments_today, overdue_installments (from enrollments in scope), expiring_documents (next 30 days), pending_approvals, transfer_inbox, unread_notifications count, and the overview analytics."""
        try:
            day = dt.date.fromisoformat(date) if date else dt.date.today()
        except ValueError:
            raise ToolError('date must be YYYY-MM-DD.')
        client = client_for(ctx, state)
        end_of_day = f'{day.isoformat()}T23:59:59Z'

        follow_ups = _safe(lambda: _rows(client, 'follow-ups/', {'ordering': 'scheduled_for'}), [])
        due = [f for f in follow_ups if f.get('scheduled_for', '') <= end_of_day and f.get('status') not in ('Completed', 'Done')]
        appts = _safe(lambda: client.get('appointments/calendar/', params={'month': day.month, 'year': day.year}), [])
        today = [a for a in appts if (a.get('date') or '').startswith(day.isoformat())]
        enrollments = _safe(lambda: _rows(client, 'enrollments/', {'status': 'Active'}), [])
        overdue = []
        for e in enrollments:
            for i in e.get('installments', []):
                if i.get('status') != 'Paid' and (i.get('due_date') or '9999') <= day.isoformat():
                    overdue.append({'enrollment': e['id'], 'enrollment_no': e.get('enrollment_no'),
                                    'student_name': e.get('student_name'), **i})
        expiring = _safe(lambda: client.get('documents/expiring-soon/', params={'days': 30, 'page_size': 100}), {'results': []})
        approvals = _safe(lambda: client.get('approval-requests/', params={'page_size': 50, 'ordering': '-created_at'}), {'results': []})
        pending = [a for a in approvals.get('results', []) if a.get('status') == 'PENDING']
        inbox = _safe(lambda: client.get('transfers/inbox/', params={'page_size': 50}), {'results': []})
        unread = _safe(lambda: client.get('notifications/unread-count/'), {'count': 0})
        overview = _safe(lambda: client.get('analytics/overview/'), {})
        return {
            'date': day.isoformat(), 'follow_ups_due': due, 'appointments_today': today,
            'overdue_installments': overdue, 'expiring_documents': expiring.get('results', []),
            'pending_approvals': pending, 'transfer_inbox': inbox.get('results', []),
            'unread_notifications': unread.get('count', 0), 'overview': overview,
        }

    mcp.add_tool(student_360, name='student_360', annotations=ToolAnnotations(title='Student 360', readOnlyHint=True))
    mcp.add_tool(search_everything, name='search_everything', annotations=ToolAnnotations(title='Search everything', readOnlyHint=True))
    mcp.add_tool(daily_briefing, name='daily_briefing', annotations=ToolAnnotations(title='Daily briefing', readOnlyHint=True))
    if not read_only:
        mcp.add_tool(convert_enquiry_to_registration, name='convert_enquiry_to_registration', annotations=ToolAnnotations(title='Convert enquiry'))
        mcp.add_tool(enroll_student, name='enroll_student', annotations=ToolAnnotations(title='Enroll student'))
        mcp.add_tool(record_payment, name='record_payment', annotations=ToolAnnotations(title='Record payment'))
```

- [ ] **Step 4: Run tests**

Run: `cd backend && python manage.py test mcp_server.tests.test_workflows`
Expected: `Ran 9 tests ... OK`. If `test_student_360_gathers_everything` fails on `totals['paid']`, check that `PaymentSerializer` returns `registration` as an id (it does) and that the registration payment created by `RegistrationViewSet.perform_create` carries `student_name` equal to the registration's.

- [ ] **Step 5: Commit**

```bash
git add backend/mcp_server/tools/workflows.py backend/mcp_server/tests/test_workflows.py
git commit -m "Add composite workflow MCP tools (student_360, convert, enroll, payment, search, briefing)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Resources, prompts and the curated knowledge base

**Files:**
- Replace: `backend/mcp_server/resources.py`
- Replace: `backend/mcp_server/prompts.py`
- Create: `backend/mcp_server/knowledge/` with 15 markdown files listed below
- Create: `backend/mcp_server/tests/test_resources_prompts.py`

**Interfaces:**
- Produces: `register_resources(mcp, state)` registering fixed resources `consultancy://catalog` (JSON), `consultancy://enums` (JSON), `consultancy://roles` (JSON), `consultancy://api-reference` (markdown), `consultancy://knowledge` (markdown index), `consultancy://me` (JSON, live), and templates `consultancy://schema/{resource}` (markdown) and `consultancy://knowledge/{topic}` (markdown).
- Produces: `KNOWLEDGE_DIR = Path(__file__).parent / 'knowledge'`, `list_topics() -> list[str]`, `read_topic(topic) -> str`.
- Produces: `register_prompts(mcp)` registering `daily_briefing`, `onboard_student`, `follow_up_digest`, `pipeline_review`, `permissions_audit`, `troubleshoot_error`.

- [ ] **Step 1: Write the failing tests**

`backend/mcp_server/tests/test_resources_prompts.py`:

```python
import json

from mcp_server.catalog import load_catalog
from mcp_server.resources import list_topics, read_topic

from .base import McpTestCase

EXPECTED_TOPICS = {
    'overview', 'roles-and-visibility', 'pipeline', 'payments-and-installments', 'documents', 'transfers',
    'approvals', 'follow-ups-and-appointments', 'visa-tracking', 'commissions', 'universities-and-templates',
    'notifications', 'analytics', 'api-conventions', 'gotchas',
}


class KnowledgeFilesTests(McpTestCase):
    def test_every_topic_exists_and_is_substantial(self):
        self.assertEqual(set(list_topics()), EXPECTED_TOPICS)
        for topic in EXPECTED_TOPICS:
            text = read_topic(topic)
            self.assertGreaterEqual(len(text.splitlines()), 25, topic)
            self.assertTrue(text.startswith('# '), topic)

    def test_unknown_topic_raises(self):
        with self.assertRaises(KeyError):
            read_topic('nope')


class ResourceTests(McpTestCase):
    def test_fixed_resources(self):
        fixed, templates = self.list_resources(self.admin)
        for uri in ('consultancy://catalog', 'consultancy://enums', 'consultancy://roles',
                    'consultancy://api-reference', 'consultancy://knowledge', 'consultancy://me'):
            self.assertIn(uri, fixed)
        self.assertIn('consultancy://schema/{resource}', templates)
        self.assertIn('consultancy://knowledge/{topic}', templates)

    def test_catalog_resource_matches_file(self):
        served = json.loads(self.read_resource('consultancy://catalog', self.admin))
        self.assertEqual(served['schema_version'], load_catalog().raw['schema_version'])
        self.assertEqual({r['prefix'] for r in served['resources']}, set(load_catalog().by_prefix))

    def test_schema_and_knowledge_templates(self):
        md = self.read_resource('consultancy://schema/enquiries', self.admin)
        self.assertIn('candidate_name', md)
        gotchas = self.read_resource('consultancy://knowledge/gotchas', self.admin)
        self.assertIn('installments', gotchas)
        index = self.read_resource('consultancy://knowledge', self.admin)
        for topic in EXPECTED_TOPICS:
            self.assertIn(topic, index)

    def test_me_resource_is_live(self):
        me = json.loads(self.read_resource('consultancy://me', self.emp_k1))
        self.assertEqual(me['user']['username'], 'emp_k1')

    def test_enums_and_roles(self):
        enums = json.loads(self.read_resource('consultancy://enums', self.admin))
        self.assertIn('VisaTracking.current_stage', enums)
        roles = json.loads(self.read_resource('consultancy://roles', self.admin))
        self.assertIn('protected', roles)


class PromptTests(McpTestCase):
    def test_prompts_render(self):
        names = self.list_prompts(self.admin)
        self.assertEqual(names, {'daily_briefing', 'onboard_student', 'follow_up_digest', 'pipeline_review',
                                 'permissions_audit', 'troubleshoot_error'})
        text = '\n'.join(self.get_prompt('onboard_student', self.admin, enquiry_id='12'))
        self.assertIn('convert_enquiry_to_registration', text)
        self.assertIn('12', text)
        text = '\n'.join(self.get_prompt('troubleshoot_error', self.admin, error='403 Your role cannot delete records directly.'))
        self.assertIn('create_approval_request', text)
        text = '\n'.join(self.get_prompt('daily_briefing', self.admin))
        self.assertIn('daily_briefing', text)
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python manage.py test mcp_server.tests.test_resources_prompts`
Expected: ImportError for `list_topics`.

- [ ] **Step 3: Implement `resources.py`**

`backend/mcp_server/resources.py`:

```python
"""consultancy:// resources: the catalog, schemas, enums, roles, curated knowledge, and `me`."""

from __future__ import annotations

import json
from pathlib import Path

from mcp.server.fastmcp import Context, FastMCP

from .server import ServerState, client_for, run_api

KNOWLEDGE_DIR = Path(__file__).resolve().parent / 'knowledge'


def list_topics() -> list[str]:
    return sorted(p.stem for p in KNOWLEDGE_DIR.glob('*.md'))


def read_topic(topic: str) -> str:
    path = KNOWLEDGE_DIR / f'{topic}.md'
    if not path.is_file() or '/' in topic or '\\' in topic or '..' in topic:
        raise KeyError(f'Unknown knowledge topic {topic!r}. Topics: {", ".join(list_topics())}')
    return path.read_text(encoding='utf-8')


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
        lines = ['# ConsultancyDev knowledge topics', '', 'Read `consultancy://knowledge/<topic>`:', '']
        for topic in list_topics():
            first = read_topic(topic).splitlines()[0].lstrip('# ').strip()
            lines.append(f'- **{topic}** — {first}')
        return '\n'.join(lines) + '\n'

    @mcp.resource('consultancy://schema/{resource}', name='schema', mime_type='text/markdown',
                  description='Fields, filters, actions and notes for one resource (catalog name, e.g. enquiries).')
    def schema_resource(resource: str) -> str:
        try:
            return catalog.schema_markdown(resource)
        except KeyError as exc:
            return f'# Unknown resource\n\n{exc}\n'

    @mcp.resource('consultancy://knowledge/{topic}', name='knowledge', mime_type='text/markdown',
                  description='One curated knowledge topic.')
    def knowledge_resource(topic: str) -> str:
        try:
            return read_topic(topic)
        except KeyError as exc:
            return f'# Unknown topic\n\n{exc}\n'

    @mcp.resource('consultancy://me', name='me', mime_type='application/json',
                  description='The authenticated user, role, scope and live capabilities.')
    def me_resource(ctx: Context) -> str:
        client = client_for(ctx, state)
        me = run_api(lambda: client.get('users/me/'))
        caps = run_api(lambda: client.get('role-permissions/mine/'))
        return json.dumps({'user': me, 'role': me['role'], 'capabilities': caps['capabilities'],
                           'visibility': catalog.roles['visibility'].get(me['role'], '')}, indent=2)
```

If FastMCP refuses a `Context` parameter on a resource function in this SDK version, change `me_resource` to obtain the context with `mcp.get_context()` inside the body instead of a parameter.

- [ ] **Step 4: Implement `prompts.py`**

`backend/mcp_server/prompts.py`:

```python
"""Guided workflows as MCP prompts. Each returns a single user message the client can send."""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.prompts.base import UserMessage


def register_prompts(mcp: FastMCP) -> None:
    @mcp.prompt(name='daily_briefing', description='Start-of-day summary for the signed-in user.')
    def daily_briefing(date: str = '') -> list[UserMessage]:
        when = f' for {date}' if date else ' for today'
        return [UserMessage(
            f'Call `whoami`, then `daily_briefing`{when}. Summarise: follow-ups due (group by enquiry, flag overdue), '
            'appointments today in time order, overdue installments with amounts, documents expiring within 30 days, '
            'pending approvals and transfers waiting on me, unread notifications. End with the three most urgent actions.'
        )]

    @mcp.prompt(name='onboard_student', description='Take an enquiry through registration, documents and enrollment.')
    def onboard_student(enquiry_id: str) -> list[UserMessage]:
        return [UserMessage(
            f'Onboard enquiry {enquiry_id}. Steps: 1) `get_enquiry` id={enquiry_id} and `student_360` enquiry_id={enquiry_id}; '
            'confirm the candidate, contact details and preferred locations with me. 2) Ask for the registration fee and payment '
            'status, then `convert_enquiry_to_registration`. 3) List the documents on hand (`upload_document` for scans, '
            '`create_student_document` for physical originals). 4) When a program is chosen, `enroll_student` with '
            'installments_count so the server builds the schedule. 5) Record any payment with `record_payment`. '
            'Read consultancy://knowledge/pipeline first and confirm before each write.'
        )]

    @mcp.prompt(name='follow_up_digest', description='Review and plan follow-ups for the leads I own.')
    def follow_up_digest(days: str = '7') -> list[UserMessage]:
        return [UserMessage(
            f'Use `list_follow_ups` (ordering=scheduled_for, all_pages=true) and `list_enquiries` to build a digest for the next {days} days: '
            'which leads are Interested or Thinking (outcome_status), which have High admission_possibility, which enquiries have NO follow-up scheduled. '
            'Propose the next action per lead; only create follow-ups with `create_follow_up` after I approve.'
        )]

    @mcp.prompt(name='pipeline_review', description='Weekly pipeline and revenue review for managers.')
    def pipeline_review(months: str = '3') -> list[UserMessage]:
        return [UserMessage(
            f'Run `analytics_overview`, `analytics_funnel`, `analytics_revenue` months={months}, `analytics_branches`, '
            '`analytics_visa_pipeline` and `analytics_sources`. Present: funnel drop-off with the weakest stage, revenue trend, '
            'branch comparison, visa stage distribution, top sources by conversion. Note that figures are cached ~30 s and scoped to my role.'
        )]

    @mcp.prompt(name='permissions_audit', description='Explain and review the role permission matrix.')
    def permissions_audit() -> list[UserMessage]:
        return [UserMessage(
            'Read consultancy://roles and call `get_role_permissions`. List every override (source=override) and whether it widens or narrows the default, '
            'flag any capability granted at or near its protected floor, and explain what each role can see (visibility). '
            'Do not call `update_role_permissions` or `reset_role_permissions` unless I explicitly ask.'
        )]

    @mcp.prompt(name='troubleshoot_error', description='Explain an API/tool error and what to do next.')
    def troubleshoot_error(error: str) -> list[UserMessage]:
        return [UserMessage(
            f'A tool returned this error:\n\n{error}\n\nUsing consultancy://knowledge/api-conventions and consultancy://knowledge/gotchas, explain the cause and the fix. '
            'Common cases: 403 on delete means raise `create_approval_request`; 404 can mean out of scope; 409 is a unique-value collision '
            '(omit server-assigned references); 400 with fields means fix those fields (check consultancy://schema/<resource>); 429 means slow down.'
        )]
```

- [ ] **Step 5: Write the fifteen knowledge files**

Create `backend/mcp_server/knowledge/` and write each file with exactly the content below.

`overview.md`:

```markdown
# ConsultancyDev: what the system is and how to work it

ConsultancyDev is a CRM for an education and immigration consultancy: medical and engineering admissions in India (NEET, PCB/PCM streams), university placement abroad, and visa tracking. A Django REST API at `/api/` is the only backend; a Next.js console is one client of it, and this MCP server is another.

## Tenancy and people

- A **Company** is a tenant. It owns **Branches** (e.g. Head Office, Kohima, Dimapur). Every operational record carries `company`, `branch`, `created_by` (immutable author) and `owner` (current custodian).
- Five **roles**: DEV_ADMIN (platform operator, no company), COMPANY_ADMIN, HEAD_MANAGER (oversees a configurable set of branch managers), BRANCH_MANAGER, EMPLOYEE. See `roles-and-visibility`.
- Capabilities (manageUsers, deleteRecords, reviewApprovals, ...) are granted to a ROLE per company through the permissions matrix; never to an individual.

## The pipeline

1. **Enquiry**: a lead (candidate, school, marks, preferred locations). Status New, Contacted, Converted, Closed.
2. **Follow-ups**: calls/visits scheduled against an enquiry, with outcome and admission likelihood, and an append-only comment thread.
3. **Registration**: the student signs up. Server assigns `registration_no` (REG-YYYY-NNN) and creates the registration-fee **Payment**.
4. **Enrollment**: a program at a university. Server assigns `enrollment_no` (ENR-YYYY-NNN) and builds **Installments** from `installments_count`.
5. **Payments** and **Refunds** move money; only Success payments count as revenue.
6. Around the student: uploaded scans (**Documents**), custody of paper originals (**Student documents**), **Visa tracking** stages, **Appointments**, **Tasks**, **Remarks**.

## Working rules an AI client must respect

- You act AS one user. Everything you see and change is limited to that user's scope. `whoami` tells you who.
- Read `consultancy://schema/<resource>` before creating or updating: it lists required fields, choices and read-only fields.
- Conversion from enquiry to registration is not an endpoint; it is a registration create with `enquiry` set (`convert_enquiry_to_registration` does it).
- Employees cannot delete directly and cannot edit some fields freely: they raise an **approval request** for a manager.
- Transfers **move** ownership; the sender loses the record.
- Never fabricate reference numbers, amounts or statuses; ask when unsure and confirm before writes.
- Multi-value filters are lists (repeated query keys). Comma-separated values match nothing.

## Where to look

- `consultancy://catalog` — machine-readable everything.
- `consultancy://api-reference` — the same as prose.
- `consultancy://knowledge/<topic>` — this series: pipeline, payments-and-installments, documents, transfers, approvals, follow-ups-and-appointments, visa-tracking, commissions, universities-and-templates, notifications, analytics, api-conventions, gotchas.
```

`roles-and-visibility.md`:

```markdown
# Roles, capabilities and who sees what

## Roles (rank)

| Role | Rank | Sees |
|---|---|---|
| DEV_ADMIN | 5 | Everything across all companies. Has no company; records it creates land with company NULL and are invisible to tenants. |
| COMPANY_ADMIN | 4 | Everything in its own company. |
| HEAD_MANAGER | 3 | The union of the branches of the branch managers assigned to it (`managed_managers`), plus its own branch. |
| BRANCH_MANAGER | 2 | Its own branch. |
| EMPLOYEE | 1 | Records it **owns** (`owner` field) plus records transferred to it and accepted. Never `created_by`. |

A Django superuser counts as DEV_ADMIN regardless of role. A manager with no branch sees only records it owns. A non-dev-admin with no company sees nothing.

## Write scope

- DEV_ADMIN: anything. COMPANY_ADMIN: anything in the company.
- HEAD/BRANCH_MANAGER: records whose branch is in their branch set, or that they own.
- EMPLOYEE: records they own, or transferred to them (for transferable entity types).

`users/`: an employee sees only their own row; a branch manager their branch plus self; a head manager their branches plus self.

## Capabilities (defaults, before company overrides)

| Capability | Default roles | Floor (cannot go below) |
|---|---|---|
| manageCompanies | DEV_ADMIN | DEV_ADMIN |
| manageBranches | admins | COMPANY_ADMIN |
| manageUsers | admins | COMPANY_ADMIN |
| viewAnalytics | managers and up | none |
| viewEarnings | admins + HEAD_MANAGER | HEAD_MANAGER |
| manageCommissions | admins | HEAD_MANAGER |
| manageSettings | admins | COMPANY_ADMIN |
| reviewApprovals | managers and up | BRANCH_MANAGER |
| manageCounselors | everyone | none |
| manageRefunds | managers and up | none |
| deleteRecords | managers and up | BRANCH_MANAGER |

"admins" = DEV_ADMIN, COMPANY_ADMIN. "managers and up" adds HEAD_MANAGER and BRANCH_MANAGER.

- A row in the company matrix decides; no row means the default. `allowed: null` in an update deletes the override.
- manageSettings and manageUsers can never be revoked from COMPANY_ADMIN.
- DEV_ADMIN always holds everything and is not configurable.
- The live answer for the caller is `my_capabilities` (`role-permissions/mine/`); `explain_permission` explains the default and the floor.

## Hiring rules

- Company admins create any role except DEV_ADMIN (only a dev admin can mint one) and set `branch` and `managed_managers`.
- Head and branch managers may create only EMPLOYEE accounts, only in branches they run (403 otherwise).
- Users edit only their own profile unless they hold manageUsers. Password changes go through `change_password`.
- Changing a user's role, branch, company, password or active flag revokes all their tokens and API keys.

## Cross-tenant rules

- Another company's record answers 404, not 403, so existence is not revealed.
- `role-permissions/?company=` is honoured only for DEV_ADMIN.
- Shared universities (company = null) are visible to all tenants and, by a known gap, writable by any manager of any tenant.
```

`pipeline.md`:

```markdown
# The admissions pipeline, step by step

## 1. Enquiry (`enquiries/`)

Required on create: `school_name`, `stream`, `course_interested`, `mobile`, `email`, `father_name`, `mother_name`, `permanent_address`. Everything else is optional: `candidate_name`, parents' occupations and mobiles, `preferred_locations` (JSON list of place names), `other_location`, profile (`gender`, `date_of_birth` encrypted, `caste`, `religion`, `family_place`, `family_state`), class 12 and class 10 schooling, subject marks and derived `pcb_percentage` / `pcm_percentage` (the web form computes these as the mean of the three subjects; compute them the same way if you set marks), NEET marks, gap-year flags, `payment_amount`.

Status: New, Contacted, Converted, Closed. `date` and `created_at` are server-set. Filters: status, stream, course_interested, gender, caste, school_board, family_state, preferred_locations, branch, owner, created_by (multi-value). Search: candidate_name, school_name, mobile, email, course_interested.

## 2. Follow-ups (`follow-ups/`) and comments (`follow-up-comments/`)

See `follow-ups-and-appointments`.

## 3. Registration (`registrations/`)

Required: `student_name`, `registration_fee` (decimal, >= 0). Usual: `mobile`, `email`, `date_of_birth`, parents, `permanent_address`, `needs_loan`, `payment_status` (free text, default "Pending"; "Paid" makes the auto payment Success), `payment_method` (default Cash), `preferences` (JSON list of `{courseName, location, priority}`), `enquiry` (FK, optional but set it when converting), and the same profile/schooling/marks block as Enquiry.

Side effects on create: `registration_no` = REG-YYYY-NNN per company (omit it); a **Payment** row of type Registration and amount `registration_fee` is created (status Success when payment_status is "paid" case-insensitively, else Pending).

Conversion: `convert_enquiry_to_registration` copies the enquiry into a registration, links `enquiry`, then PATCHes the enquiry to Converted. There is no server-side convert endpoint.

## 4. Enrollment (`enrollments/`)

Required: `student` (registration id in your company), `program_name`, `start_date` (YYYY-MM-DD), `duration_months`, `total_fees`. Optional: `university` (id, own or shared catalogue), `university_name`, `country`, `commission_amount`, `status` (free text, default Active).

Write-only helpers: `installments_count` (>= 0) and `installment_amount`. The server builds Installment rows that sum exactly to `total_fees` (the last absorbs rounding), due monthly from `start_date`. `enrollment_no` = ENR-YYYY-NNN when omitted. Creating an enrollment notifies company admins and the branch manager.

## 5. Installments (`installments/`)

Read-only in practice (`enrollment` is read-only on the serializer, so POST fails with 409). Fields: number, due_date, amount, status (default Pending), paid_at. Mark one paid by `update_installment` with `{"status": "Paid", "paid_at": "..."}` and record the money with `record_payment` linking `installment`.

## 6. Payments and refunds

See `payments-and-installments`.

## Ownership through the pipeline

Each record is owned by whoever created it (or received it by transfer). A registration created from an employee's enquiry is owned by that employee. Managers see the whole branch regardless.

## Typical sequences

- New lead: `create_enquiry` → `create_follow_up` (scheduled_for) → after the call `update_follow_up` {status, outcome_status, admission_possibility, notes}.
- Signing up: `convert_enquiry_to_registration` → `upload_document` / `create_student_document` → `enroll_student` → `record_payment`.
- Checking on a student: `student_360`.
```

`payments-and-installments.md`:

```markdown
# Payments, installments, refunds and revenue

## Payment (`payments/`)

Fields: `registration` (id or null), `enrollment` (id or null), `installment` (id or null), `student_name` (writable text), `amount` (decimal >= 0), `date` (datetime, default now), `type` (free text; the app writes "Registration" and "Enrollment"), `status` (Pending, Success, Failed, Refunded; default Pending), `method` (free text, default Cash; the console offers Cash, UPI, Card, Cheque, Bank Transfer), `reference` (<= 120 chars), `metadata` (JSON object).

- **Only Success counts as revenue** in `payment_stats` and analytics. Pending counts as pending.
- The web console folds method detail (cheque number, bank, UPI id, card last 4) into `reference`; the API also accepts structured `metadata`. `record_payment` requires: Cheque → cheque_no, bank_name; UPI → upi_transaction_id; Card → card_last4, card_network.
- There is **no registration/enrollment filter** on `payments/`: per-student payment views search by `student_name` and match the FK client-side. `student_360` does this for you.
- Filters: status, type, method, branch, owner, created_by (multi-value). Search: student_name, reference, type. Ordering: date, amount, status.
- `payment_stats` returns `{totalRevenue, thisMonthRevenue, pendingAmount, transactionCount}` over your scope, cached ~30 s.

## Registration fee payment

Created automatically when a registration is created: type Registration, amount = registration_fee, status Success only when `payment_status` was "Paid" (any case). To take a registration fee later, PATCH the registration `payment_status` and record a payment against it.

## Installments (`installments/`)

Built by the server from `installments_count` on enrollment create; never construct schedules yourself. Amounts sum exactly to `total_fees`; due dates step whole calendar months from `start_date`. Settle one by `record_payment` with `enrollment` and `installment` set, then `update_installment` {status: "Paid", paid_at}. `paymentArrangement` in the console is derived: more than one installment = Installments, else Full payment.

## Refund (`refunds/`)

Fields: `student` (registration id, required), `payment` (id or null), `amount` (>= 0), `reason`, `status` (Pending, Approved, Processed, Rejected), `processed_at`. Reading is open to the tenant (scoped); writing needs manageRefunds (managers and up by default). A refund is considered settled at Approved or Processed. Filters: status, student, payment, branch, owner, created_by.

## Totals a client must compute

- paid = sum of Success payments; pending = sum of Pending; refunded = sum of Approved/Processed refunds; net = paid − refunded.
- Net income on the payments screen = `payment_stats.totalRevenue` − Processed refunds.
- `student_360.totals` returns paid, pending, refunded, net, total_fees, outstanding_installments.

## Money formats

Decimals travel as strings ("1500.00"). Send strings or numbers; read them as decimals. Currency is INR throughout; there is no currency field on payments.
```

`documents.md`:

```markdown
# Documents: uploaded scans versus physical originals

Two separate concepts share the word "document".

## Document (`documents/`): an uploaded scan

- Create with multipart/form-data: write-only `file`, plus `file_name`, `type` (free text; the console uses values such as Passport, Aadhaar, Marksheet, Photo, Offer Letter, Visa, Other), `status` (IN or OUT: custody of the scan, default IN), `expiry_date` (date or null), and **at most one of** `registration` / `enquiry`. `student_name` is derived from the link and any client value is ignored. Metadata-only writes can be JSON.
- Server validates extension (pdf, png, jpg, jpeg, webp, doc, docx, xls, xlsx by default) and size (10 MB by default), stores a sha256 checksum, encrypts with Fernet under PRIVATE_MEDIA_ROOT (never web-served). `file_size` is the plaintext length.
- Download only through `documents/{id}/download/` (tool `download_document`), which re-checks scope, decrypts and streams with `Cache-Control: private, no-store`. 404 "File is not available." when missing or undecryptable.
- Replace the file by PATCH with a new `file`: the old blob is deleted after the new one is stored.
- Filters: status, branch, type, registration, enquiry (single-value exact). Search: file_name, student_name, type. Ordering: uploaded_at, expiry_date.
- `documents_expiring_soon` (`?days=30`): documents with expiry_date on or before today + days, ordered by expiry. The console shows expiry state against a 90-day window separately from IN/OUT.
- Transferable (`entity_type` document) and approval-eligible (mutable fields: type, status, expiry_date).

## Student document (`student-documents/`): custody of a paper original

- Fields: `registration` (required), `name` (e.g. Passport, 10th Marksheet), `document_number`, `status` (Received, With staff, Submitted, Returned, Lost; default Received), `received_at` (default now), `returned_at` (read-only), `remarks`, `current_holder` (user id; defaults to the creator: "whoever takes it in is holding it").
- `return_student_documents` {document_ids: [...]}: sets Returned, returned_at=now, clears current_holder for in-scope rows not already Returned. Logged to the security log.
- Filters: registration, status, current_holder. Search: name, document_number, registration__student_name.
- Not transferable and not approval-eligible; hand over by PATCHing `current_holder` and appending to `remarks`.

## How the console links documents

- The registration form lists scans already uploaded under the candidate's name (search by name, then exact case-insensitive match) so the counsellor can see what is on hand.
- Linking an orphan scan to a registration is `update_document` {registration: id}.
- There is no document audit log endpoint; the console synthesises one from uploads and transfers.
```

`transfers.md`:

```markdown
# Record transfers: handing a record to a colleague

## What a transfer is

A **RecordTransfer** moves custody of one record from `from_user` to `to_user`. On acceptance the record's `owner` becomes the recipient, its `branch` moves to the recipient's branch when different, and `assigned_to` is updated where the model has it (tasks, follow-ups). `created_by` never changes. **The sender loses access** (employees see only what they own).

## Transferable entity types

enquiry, registration, enrollment, document, task, follow_up, visa_tracking. Payments, appointments, templates, comments and remarks cannot be transferred.

## Creating one (`create_transfer`)

Body: `entity_type`, `entity_id`, `to_user` (a user in your company, not yourself), `note`. The actor must be able to WRITE the target; otherwise the API answers as if the record did not exist ("That record does not exist.").

- Dev admins, company admins, head managers and branch managers: `requires_acceptance = false`; the transfer is applied immediately and comes back ACCEPTED.
- Employee to employee: stays PENDING until the recipient accepts, so nobody can silently push work onto a colleague.

## Resolving one

- `accept_transfer` / `reject_transfer`: recipient only, and only while PENDING. Anyone else gets 403 "Only the recipient can accept a transfer."; a resolved one gets 400.
- A transfer whose target has since been deleted is marked CANCELLED when applied.

## Listing

- `transfer_inbox`: PENDING transfers addressed to me. `transfer_outbox`: everything I sent.
- `list_transfers` filters: status, entity_type, from_user, to_user. Managers see transfers in their branches plus their own; employees only their own.

## Visibility lag

Accepting a transfer is not part of the cached scope signature, so analytics and `payment_stats` may lag by up to 30 s. Lists are never cached.

## Known edge

`list_transfers` is a full ModelViewSet: a transfer visible to you can be PATCHed or DELETEd (status is read-only, so it cannot be flipped). Prefer accept/reject; do not delete transfer history.

## Physical documents

Custody of paper originals is not a transfer: PATCH `current_holder` on the student document and note the handover in `remarks`.
```

`approvals.md`:

```markdown
# Approval requests: how employees delete and change restricted fields

## Why they exist

Deleting directly needs the `deleteRecords` capability (managers and up by default, floored at BRANCH_MANAGER). Everyone else gets 403 "Your role cannot delete records directly. Raise an approval request instead." The same channel lets an employee propose an update that a manager applies.

## Raising one (`create_approval_request`)

Body: `action` (DELETE or UPDATE), `entity_type` (enquiry, registration, enrollment, payment, document, task, follow_up; `appointment` is listed by the model but rejected at validation, and `visa_tracking` is not accepted), `entity_id`, `message` (why), and for UPDATE `pending_changes` (an object of proposed values; camelCase keys are converted).

- The target is resolved through your visibility scope: an id you cannot see is "That record does not exist." (400).
- The request's branch is stamped from the TARGET, so it lands with the manager who controls that record.
- `entity_name` is filled from the record.

## Reviewing (`approve_approval_request` / `reject_approval_request`)

Needs `reviewApprovals`. The reviewer's full write scope is re-checked against the LIVE target (a cross-branch review is refused with 403 "You cannot act on that record."). Only PENDING requests can be reviewed.

- DELETE: the record is deleted.
- UPDATE: only keys in the allowlist below are applied; anything else is ignored; if nothing applies the API answers 400 "No permitted fields were included in this request."
- Status becomes APPROVED/REJECTED only after the action succeeds, with `reviewed_by`, `reviewed_at`, `review_note` (body key `note`).

## Allowlisted update fields

| entity_type | fields |
|---|---|
| enquiry | status, course_interested, mobile, email, permanent_address |
| registration | student_name, mobile, email, payment_status, registration_fee |
| enrollment | program_name, status, start_date, duration_months |
| payment | status, method, reference |
| document | type, status, expiry_date |
| task | title, description, status, priority, due_date |
| appointment | status, date, notes (unreachable: see above) |
| follow_up | status, priority, notes, scheduled_for |

## Queues

- `approval_pending_count`: requests in my review queue (managers) or mine (employees).
- `my_approval_requests`: what I raised. `list_approval_requests` for managers shows both what they raised and what awaits them.

## Console behaviour to mirror

When an employee edits an enquiry in the console, the form does not save; it raises an UPDATE request with `pending_changes`. Do the same: if `update_x` returns 403 for an employee, offer `create_approval_request`.
```

`follow-ups-and-appointments.md`:

```markdown
# Follow-ups, comments, appointments and tasks

## Follow-up (`follow-ups/`)

A scheduled touchpoint on an enquiry. Fields: `enquiry` (required), `assigned_to` (user id or null), `scheduled_for` (datetime, required), `type` (free text, default Call; the console uses Call, Visit, Email, WhatsApp), `status` (free text, default Pending; the console uses Pending, Completed, Missed), `priority` (free text, default Medium), `notes`, `completed_at`, `outcome_status` (Not reached, Interested, Thinking, Not interested, Converted), `admission_possibility` (High, Medium, Low, Unknown).

- Completing one in the console PATCHes status Completed, completed_at, outcome_status, admission_possibility and APPENDS a `--- Completed <date> ---` block to `notes` rather than overwriting; do the same.
- Filters (multi-value): status, priority, type, outcome_status, admission_possibility, assigned_to, enquiry, branch, owner. Search: enquiry candidate/mobile/email and notes. Ordering: scheduled_for, status, priority, created_at.
- Transferable and approval-eligible (mutable: status, priority, notes, scheduled_for).

## Follow-up comment (`follow-up-comments/`)

Append-only thread between counsellor and manager: `follow_up`, `comment`; `author` is stamped. Update and delete return 403 by design. Filter: follow_up. Ordering: created_at.

## Appointment (`appointments/`)

Fields: `student_name`, `student_email`, `counselor` (user id, required), `date` (datetime, required), `time` (optional time), `duration` (minutes, default 60), `type` (In-Person, Video Call, Phone Call), `status` (Scheduled, Completed, Cancelled), `notes`.

- `appointments_calendar` {month, year} returns an UNPAGINATED array for that month after search/filters; use it for "what is on today".
- Filters (multi-value): status, type, counselor, branch, owner, created_by. Search: student_name, student_email. Ordering: date, status.
- Not transferable; `appointment` approval requests are rejected at validation (known gap), so employees change appointments directly within their scope.
- No link to a registration: appointments are matched to a student by name.

## Task (`tasks/`)

Fields: `title`, `description`, `assigned_to` (user id, required), `due_date` (datetime, required), `priority` (free text, default Medium), `status` (free text, default Todo; the console board uses Todo, In Progress, Done), `completed_at`, `position` (kanban order).

- `reorder_tasks` {ids: [...], status?}: writes `position` in order; with `status` moves the listed tasks to that column and sets completed_at when it is Done. Ids outside scope are skipped.
- Filters: status, assigned_to, priority, branch (single-value). Search: title, description. Ordering: due_date, priority, status, position.
- No due_date filter: overdue counts must be computed over fetched rows.
- Transferable (reassigns `assigned_to`) and approval-eligible.

## Reminders

The console's upcoming-reminders widget combines follow-ups due and appointments for the counselor, filtered client-side. `daily_briefing` reproduces it.
```

`visa-tracking.md`:

```markdown
# Visa tracking

## Record (`visa-tracking/`)

Fields: `student` (registration id or null), `student_name` (text, searchable), `passport_no` (**encrypted**; a blind index exists server-side but is not exposed as a filter), `country`, `visa_type`, `applied_date` (date), `current_stage`, `interview_date`, `expected_decision` (date), `officer`, `notes`, `status` (free text, default "In Progress").

## Stages, in order

Documents → Applied → Biometrics → Interview → Decision → Approved | Rejected.

- The console shows progress as stage index / 6 and success rate as Approved / (Approved + Rejected).
- `analytics_visa_pipeline` returns counts for all seven stages plus a total, scoped to the caller; open to every role.
- The Approved stage is the last funnel step in `analytics_funnel`.

## Rules

- Filters: current_stage, status, branch, country (single-value exact). Search: student_name, country, visa_type. Ordering: created_at, current_stage, interview_date.
- Passport numbers cannot be searched or filtered through the API. Ask for the student's name instead.
- Transferable (`entity_type` visa_tracking). Not approval-eligible (not in the ApprovalRequest entity list), so employees edit their own visa rows directly.
- The console's visa page is hidden from the sidebar but fully functional; it does not send `notes` and hard-codes status, so API-created rows can be richer than console-created ones.

## Typical updates

- Move a stage: `update_visa_tracking` {current_stage: "Interview", interview_date: "2026-10-04T10:00:00Z"}.
- Record the decision: {current_stage: "Approved", status: "Approved"} or {current_stage: "Rejected", status: "Rejected"}.
- Link to the student: set `student` to the registration id so `student_360` picks it up by FK rather than by name.

## Privacy

`passport_no` and dates of birth are encrypted at rest with the company-wide field key; only the API returns them in clear. Do not copy passport numbers into notes, remarks, task titles or follow-up comments, which are stored in plain text.
```

`commissions.md`:

```markdown
# Agents and commissions

## Agent (`agents/`)

A referral partner. Fields: `name`, `email`, `phone`, `commission_type` (free text, default Percentage), `commission_value` (decimal), `status` (free text, default Active), plus read-only aggregates `total_earned` (sum of Paid commissions), `pending_amount` (sum of Pending), `students_referred` (distinct students). The aggregates are recomputed by signals whenever a commission is saved or deleted; there is no manual recompute.

Access: reading AND writing need `manageCommissions` (admins by default; floor HEAD_MANAGER). Search: name, email.

## Commission (`commissions/`)

Fields: `agent` (required), `student` (registration id or null), `enrollment` (id or null), `enrollment_fee`, `commission_amount` (required, >= 0.01: "A commission must be worth more than nothing."), `status` (Pending, Paid), `paid_at`.

- Reading needs `viewEarnings` (admins + head manager by default); writing needs `manageCommissions`.
- Mark paid: `update_commission` {status: "Paid", paid_at: "..."}. PATCH does not re-require agent/amount.
- Ordering: created_at, commission_amount, status. No filterset; use search-free listing and filter client-side or by ordering.

## Earnings screens

- Company earnings (`/app/earnings`) = revenue analytics; DEV_ADMIN sees platform MRR computed from subscriptions (an approximation: historical status changes are not stored).
- Per-employee earnings do not exist: commissions attach to agents, not staff.

## Enrollment commission

`Enrollment.commission_amount` is a separate figure recorded on the enrollment itself (default 0). `analytics_revenue` reports commissions from the Commission table, not from enrollments.

## Subscriptions and plans (related money, currently inert)

`plans/` is a public catalogue (Starter free, Growth 2999, Scale 7999). `subscriptions/` is read-only; `get_my_subscription` returns the company's row. Plan limits (`max_branches`, `max_users`) are advertised but **not enforced**: `allows_branches`, `allows_users`, `is_usable` and the SubscriptionActive permission all return true.
```

`universities-and-templates.md`:

```markdown
# Universities, templates, branches and companies

## University (`universities/`)

A catalogue entry, not a tenant-scoped record: it has `company` (null = shared with every tenant) and no branch/owner. Fields: `name`, `country`, `city`, `ranking`, `programs` (JSON list), `tuition_fee_min`, `tuition_fee_max`, `admission_deadline` (free text), `requirements` (JSON list), `rating` (0-5).

- Reading: everyone in the tenant sees own rows plus shared rows. Writing: managers and up (no capability). Creating always stamps your company.
- Search: name, country, city. Ordering: name, ranking, rating. No filterset: filter by country/program client-side after `all_pages`.
- Known gap: shared rows are writable cross-tenant by any manager; do not edit shared rows unless asked.
- Enrollments reference a university by `university` (id) and also carry `university_name`/`country` text; reporting "students per university" is only possible by scanning enrollments.

## Template (`templates/`)

Message templates: `name` (unique per company), `template_type`, `category` (Email, SMS, WhatsApp), `subject`, `content` (required), `variables` (JSON list of placeholder names), `is_active`. Search: name, subject, content. There is **no send endpoint**; templates are text the staff copy into their own channels. The console page is hidden from the sidebar.

## Branch (`branches/`)

Fields: `name`, `code`, `city`, `address`, `phone`, `is_active`; read-only `is_default`, `company`, `user_count`, `manager_names`. Everyone reads (pickers need the list); writing needs `manageBranches`. Creating additionally requires being a company admin. The default branch cannot be deleted; a branch with users cannot be deleted. Records created by a user without a branch land in the company's default branch. Search: name, code, city. No filterset.

## Company (`companies/`)

Dev admins see and manage all; a company admin sees only their own row (any other id is 404) and may edit name, email, phone, address. Create/destroy are refused for non-dev-admins. Provisioning a company creates a "Head Office" default branch and an active subscription.

## Signup requests (`signup-requests/`)

Anonymous prospects POST {company_name, admin_name, email, phone, plan, username, password, first_name, last_name}; only DEV_ADMIN lists, approves (`approve_signup_request`: provisions company + COMPANY_ADMIN) or rejects. The public signup entry point in the console is currently hidden.

## Reference data the console hard-codes

Country lists, program lists, document type lists, rating scales and preferred-location hubs are literals in the frontend, not API resources. Use the values you see in existing rows; the API accepts free text.
```

`notifications.md`:

```markdown
# Notifications

## What they are

Per-user tray items: `title`, `message`, `type` (info, success, warning, error), `is_read`, `action_url` (a console path such as `/app/enrollments/12`), `created_at`. Read-only over the API except marking read.

## What creates them

Only server signals. Today there is exactly one trigger: a **new enrollment** with a company notifies every active COMPANY_ADMIN of that company plus the BRANCH_MANAGER of the enrollment's branch, titled "New enrollment", message "<enrollment_no> — <program_name>", type success. Registration creation only writes a log line. Nothing notifies on follow-ups due, approvals, transfers or expiring documents; `daily_briefing` covers those by querying.

## Tools

- `list_notifications` (own rows only; ordering created_at desc).
- `unread_notification_count` → {count}. The console polls this every 60 s.
- `mark_notification_read` {id}, `mark_all_notifications_read` → {updated}.

## Limits

- You cannot create a notification for someone else; the endpoint has no create and `user` is not writable (a past hole let anyone plant an action_url in an admin's tray).
- Delivery is polling; the WebSocket layer was removed.
- The "Notify" button on the document-expiry screen is permanently disabled for the same reason.

## When a user asks "did anyone get told?"

Answer from this list: enrollment created → admins and the branch manager, immediately. Anything else → nobody automatically; suggest a task (`create_task` assigned_to the person) or a follow-up comment as the in-app way to leave a message.
```

`analytics.md`:

```markdown
# Analytics and reporting

All six endpoints are scoped by the caller's visibility (an employee's numbers cover only their own records), cached per caller for `SCOPED_CACHE_SECONDS` (default 30 s; the `X-Cache` header says HIT/MISS/DISABLED), and never paginated.

| Tool | Access | Returns |
|---|---|---|
| analytics_overview | every active user | object: enquiries, enquiriesThisMonth/LastMonth/Trend, registrationsThisMonth/LastMonth/Trend, enrollmentsThisMonth/LastMonth/Trend, registrations, enrollments, converted, conversionRate, revenueThisMonth, revenueLastMonth, revenueGrowth, pendingPayments, totalRevenue |
| analytics_visa_pipeline | every active user | {pipeline: [{stage, count}] for all seven stages, total} |
| analytics_funnel | viewAnalytics | {stages: [Enquiries 100%, Registrations, Enrollments, Visas approved], dropOff: {enquiryToRegistration, registrationToEnrollment, enrollmentToVisa}} |
| analytics_revenue months=N | viewAnalytics | {series: [{month "2026-01", label "Jan 2026", revenue, transactions, registrationFees, enrollmentFees, otherFees, commissions}]} for N (1-36) calendar months |
| analytics_branches | viewAnalytics | bare array [{id, name, city, staff, enquiries, registrations, enrollments, revenue, conversionRate}] for active branches in scope |
| analytics_sources | viewAnalytics | bare array [{source (Enquiry.stream, "Unspecified" when blank), total, converted, conversionRate}] |

## Definitions

- Trends are percentage change against the previous calendar month (100.0 when last month was zero and this month is not).
- Revenue counts only payments with status Success. Commissions come from the Commission table.
- conversionRate = converted enquiries / enquiries. Funnel rates are all against the enquiry count.
- `payment_stats` (`payments/stats/`) is the payments-screen aggregate: {totalRevenue, thisMonthRevenue, pendingAmount, transactionCount}.

## What the console adds on top

- Reports page: three charts plus CSV export built client-side from these endpoints.
- Weekly dashboard chart: enrollments are pinned to "today" because they only carry a future start_date.
- Platform MRR (dev admin) is bucketed from subscription period dates; an acknowledged approximation.

## Practical notes

- Right after a write, re-reading analytics may show the old figure for up to 30 s; lists are always live.
- With the in-memory cache (no Redis) each gunicorn worker caches separately, so consecutive calls can disagree briefly.
- A branch manager's "company total" is their branch total; say so when reporting.
```

`api-conventions.md`:

```markdown
# API conventions every call must follow

## Paths and verbs

- Base `/api/`, trailing slash on every path (`enquiries/`, `enquiries/5/`, `documents/5/download/`). Without it the router redirects and POST bodies are lost.
- Standard verbs per resource: GET list, POST create, GET detail, PATCH partial update (preferred), PUT full update, DELETE. Custom actions are POST or GET at `resource/{id}/action/` or `resource/action/`.

## Authentication

- Personal API key: `Authorization: Bearer cdk_...` (or `X-API-Key`). Inherits the user's role/scope. Create on the Profile page or `create_api_key`; revoke with `revoke_api_key` (password session only).
- JWT: POST `auth/login/` {username, password} → {access, refresh, user}; access lives 15 min by default, refresh 7 days with rotation (POST `auth/refresh/` returns a NEW refresh; the old one is blacklisted). POST `auth/logout/` {refresh}.
- Changing a user's role/branch/company/password/active flag revokes all their tokens and keys immediately.

## Pagination

Envelope `{count, pages, page, page_size, next, previous, results}`. `page_size` default 25, max 200. Bare arrays (no envelope): `users/counselors/`, `appointments/calendar/`, `analytics/branches/`, `analytics/sources/`, `plans/`. Objects: the other analytics and `payment_stats`.

## Filtering, search, ordering

- `search=` matches the resource's search fields (see the schema).
- `ordering=field` or `ordering=-field` from the resource's ordering fields.
- Multi-value filters: **repeat the key** (`?status=New&status=Contacted`). In tools pass a list. A comma-joined string matches nothing (values like "SEBA (Board of Secondary Education, Assam)" contain commas).
- Plain filterset fields (documents, tasks, users, visa-tracking, transfers, comments, remarks, student-documents) are single-value exact matches.
- Unknown filter parameters are silently ignored by the API; the MCP tools reject them so a "filtered" list is never secretly unfiltered.
- Encrypted fields (date_of_birth, passport_no) cannot be filtered, searched or sorted.

## Errors

Always `{"error": "<message>"}` or `{"error": "Validation failed", "fields": {"field": ["message"]}}`. 404 for anything outside your scope. 409 for unique collisions. 429 when throttled. Never a DRF `detail` key.

## Throttling (production)

anon 30/min, user burst 120/min, user 5000/hour, login 8/min, signup 5/hour. Locally (DEBUG) far higher. The MCP client retries a 429 once.

## Formats

- Datetimes ISO 8601 with timezone (`2026-09-02T09:00:00Z`); dates `YYYY-MM-DD`; decimals as strings ("1500.00"); booleans true/false; JSON fields as real JSON (lists/objects).
- Server-owned fields on every scoped record: company, branch, created_by, owner, created_at, updated_at. Sending them is ignored.
- Reference numbers (`registration_no`, `enrollment_no`) are assigned when omitted.

## Uploads

`documents/` accepts multipart/form-data with `file`; allowed extensions pdf, png, jpg, jpeg, webp, doc, docx, xls, xlsx; max 10 MB by default.
```

`gotchas.md`:

```markdown
# Gotchas, traps and known gaps

Facts an AI client must know to avoid wrong answers or broken writes.

## Endpoints that do not do what their shape suggests

- `POST installments/` cannot work: `enrollment` is read-only on the serializer, so the create fails with 409. Installments come only from enrollment create (`installments_count`).
- `POST branches/` as DEV_ADMIN answers 500 (a dev admin has no company). Create branches as a company admin.
- `appointment` is a valid approval `entity_type` on the model but is rejected at validation; `visa_tracking` is resolvable but not an approval type.
- `payments/` has no registration/enrollment filter; `documents/` DOES filter by registration and enquiry; `follow-ups/` DOES filter by assigned_to; `tasks/` has no due_date filter; `branches/` and `universities/` have no filterset.
- `installments/` list works but has no filters; read installments nested inside enrollments.
- `users/counselors/`, `appointments/calendar/`, `analytics/branches/`, `analytics/sources/`, `plans/` return bare arrays.

## Authorization edges

- Shared universities (company null) are writable by any manager in any tenant.
- Transfers and approval requests can be PATCHed/DELETEd within scope (status stays read-only). Prefer the accept/reject/approve tools.
- Any Django superuser is treated as DEV_ADMIN.
- Records created by a DEV_ADMIN through scoped viewsets land with company/branch NULL and are invisible to tenants.
- Payments set `entity_type` but are not transferable; comments, remarks, templates, appointments, agents, installments and student documents are never inherited by transfer.
- Login mints a token pair before checking `is_active_employee` (the client never receives it, but last_login updates).

## Data shape traps

- `ApprovalRequest.status` is UPPERCASE on the wire (PENDING, APPROVED, REJECTED, FAILED); the console type says title case.
- Older `Enquiry.preferred_locations` rows may be JSON-encoded strings instead of lists; they read fine but do not match the `preferred_locations` filter.
- `Registration` has real profile columns (gender, marks, schooling...), but the console form writes those details into `student-remarks/` as text. API clients should use the columns; `student_360` shows both.
- Three payment vocabularies coexist in the console (types Registration/Enrollment/Other; methods Cash/UPI/Card/Cheque/Bank Transfer/Online). The API accepts any text.
- Two document type lists coexist (7 vs 10 values). The API accepts any text.
- `Task` and `Payment` types in the console's `lib/types.ts` lag the wire; trust the API.

## Operational

- `select_for_update` is a no-op on SQLite (dev): concurrent registration creates can collide on the reference (409). Retry once.
- Without Redis, throttle counters and the capability cache are per worker; permission changes can take up to 300 s to be seen by other workers.
- Analytics and payment_stats are cached 30 s per caller; accepting a transfer or changing managed_managers is not in the cache key.
- `/api/health/` is throttled at 30/min for anonymous callers.
- `DOCUMENT_URL_TTL_SECONDS` exists but nothing uses it: there are no signed URLs.
- No management command rotates the field encryption key; rotating it requires re-encrypting rows and blobs by hand.

## Console-only features with no API

- No enquiry convert endpoint (client-side flow). No task history. No document audit log. No per-employee earnings. No notification create. No template send. The student portal page is a static mock.

## Safe defaults for an AI client

- Confirm before every delete, reset, reject, revoke or deactivation.
- Omit reference numbers; let the server assign them.
- Never place passport numbers or dates of birth in free-text fields.
- Use `explain_permission` before promising a user that an action will work.
```

- [ ] **Step 6: Run tests**

Run: `cd backend && python manage.py test mcp_server.tests.test_resources_prompts mcp_server.tests.test_server`
Expected: all OK, including `test_tools_resources_prompts_are_registered`.

- [ ] **Step 7: Run the entire suite once**

Run: `cd backend && python manage.py test core mcp_server`
Expected: OK. If `core.test_authorization.test_every_registered_endpoint_has_a_rule` fails, the `api-keys` UNGOVERNED entry from Task 3 is missing.

- [ ] **Step 8: Commit**

```bash
git add backend/mcp_server/resources.py backend/mcp_server/prompts.py backend/mcp_server/knowledge backend/mcp_server/tests/test_resources_prompts.py
git commit -m "Add MCP resources, prompts and curated knowledge base

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Frontend: API keys on the Profile page

**Files:**
- Modify: `consultancy-dev/lib/types.ts` (append)
- Modify: `consultancy-dev/lib/apiClient.ts` (add `apiKeys` block next to `rolePermissions`, line ~1816)
- Create: `consultancy-dev/app/app/profile/components/ApiKeysCard.tsx`
- Modify: `consultancy-dev/app/app/profile/page.tsx` (mount the card in the right column, after "Work information")

**Interfaces:**
- Produces: `ApiKey` and `ApiKeyCreated` types; `apiClient.apiKeys.list(params?) -> Promise<Paginated<ApiKey>>`, `apiClient.apiKeys.create(name, expiresAt?) -> Promise<ApiKeyCreated>`, `apiClient.apiKeys.revoke(id) -> Promise<ApiKey>`.
- Consumes: `Modal` (`components/common/Modal`), `ConfirmDialog` (`components/ui/ConfirmDialog`), `Button`, `Input`, `Label`, `Badge`, `Card`, `CardContent`, `ErrorBanner`, `InlineSpinner`, `toast` from `store/toastStore`, `getApiErrorMessage` from `lib/api`.

- [ ] **Step 1: Add the types**

Append to `consultancy-dev/lib/types.ts`:

```ts

/** Mirrors `ApiKeySerializer`. The hash is never sent; `prefix` identifies a key in lists. */
export interface ApiKey {
  id: number;
  user: number;
  user_name: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  is_valid: boolean;
}

/** The create response: the plaintext `key` is returned exactly once. */
export interface ApiKeyCreated extends ApiKey {
  key: string;
}
```

Add `ApiKey, ApiKeyCreated,` to the `import type { ... } from './types'` list at the top of `lib/apiClient.ts`.

- [ ] **Step 2: Add the client block**

Insert into the `apiClient` object in `consultancy-dev/lib/apiClient.ts`, directly before `rolePermissions: {`:

```ts
  /**
   * Personal API keys for MCP/AI clients and scripts. A key acts as the
   * signed-in user; the plaintext is only ever present on the create response.
   * The endpoint refuses sessions authenticated BY a key, so this is only
   * reachable from a password login.
   */
  apiKeys: {
    list: (params: PageParams = {}): Promise<Paginated<ApiKey>> => fetchPage<ApiKey>('api-keys/', params),
    create: async (name: string, expiresAt?: string | null): Promise<ApiKeyCreated> => {
      const res = await api.post<ApiKeyCreated>('api-keys/', {
        name,
        ...(expiresAt ? { expires_at: expiresAt } : {}),
      });
      return res.data;
    },
    revoke: async (id: number): Promise<ApiKey> => {
      const res = await api.post<ApiKey>(`api-keys/${id}/revoke/`);
      return res.data;
    },
  },

```

- [ ] **Step 3: Create the card component**

`consultancy-dev/app/app/profile/components/ApiKeysCard.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Modal } from '@/components/common/Modal';
import { ErrorBanner, InlineSpinner } from '@/components/common/states';
import { apiClient } from '@/lib/apiClient';
import { API_URL } from '@/lib/api';
import type { ApiKey, ApiKeyCreated } from '@/lib/types';
import { toast } from '@/store/toastStore';

/**
 * "AI access keys": mint, list and revoke personal API keys used by MCP
 * clients (Claude Desktop, Cursor, ChatGPT connectors...) to act as this user.
 *
 * The plaintext key exists only in the create response, so it is shown once in
 * a modal with a copy button and a ready-to-paste client config. Revoking is
 * immediate and irreversible, hence the confirm dialog.
 */

function formatDate(value: string | null): string {
  if (!value) return 'Never';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString();
}

function mcpConfigSnippet(key: string): string {
  const apiUrl = API_URL.replace(/\/$/, '') + '/';
  return JSON.stringify(
    {
      mcpServers: {
        'consultancy-dev': {
          command: 'python',
          args: ['-m', 'mcp_server'],
          cwd: '<path to>/ConsultancyDev/backend',
          env: { CONSULTANCY_API_URL: apiUrl, CONSULTANCY_API_KEY: key },
        },
      },
    },
    null,
    2,
  );
}

export function ApiKeysCard() {
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [copied, setCopied] = useState<'key' | 'config' | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);

  const keys = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => apiClient.apiKeys.list({ page_size: 100 }),
  });

  const create = useMutation({
    mutationFn: () => apiClient.apiKeys.create(name.trim(), expiresAt ? new Date(expiresAt).toISOString() : null),
    onSuccess: (data) => {
      setCreated(data);
      setIsCreateOpen(false);
      setName('');
      setExpiresAt('');
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });

  const revoke = useMutation({
    mutationFn: (id: number) => apiClient.apiKeys.revoke(id),
    onSuccess: () => {
      setRevokeTarget(null);
      toast.success('Key revoked', 'Clients using it will be signed out immediately.');
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });

  const copy = async (what: 'key' | 'config') => {
    if (!created) return;
    const text = what === 'key' ? created.key : mcpConfigSnippet(created.key);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast.error('Could not copy', 'Select the text and copy it manually.');
    }
  };

  const rows = keys.data?.results ?? [];

  return (
    <>
      <Card className="border-slate-200">
        <CardContent className="p-4">
          <div className="mb-1 flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Bot size={14} className="text-slate-400" /> AI access keys
            </h3>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs"
              onClick={() => {
                create.reset();
                setIsCreateOpen(true);
              }}
            >
              <Plus size={12} /> New key
            </Button>
          </div>
          <p className="mb-3 text-xs text-slate-500">
            Let an AI assistant (Claude, ChatGPT, Cursor…) work in the CRM as you through the MCP server.
            A key has exactly your permissions. Revoke it the moment you stop using it.
          </p>

          {keys.isError && <ErrorBanner error={keys.error} />}
          {keys.isLoading && <InlineSpinner />}
          {!keys.isLoading && rows.length === 0 && (
            <p className="rounded-md border border-dashed border-slate-200 p-3 text-center text-xs text-slate-500">
              No keys yet.
            </p>
          )}
          {rows.length > 0 && (
            <ul className="divide-y divide-slate-100">
              {rows.map((key) => (
                <li key={key.id} className="flex items-center gap-3 py-2">
                  <KeyRound size={14} className="shrink-0 text-slate-400" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-slate-800">
                      {key.name} <span className="font-mono text-xs text-slate-400">{key.prefix}…</span>
                    </p>
                    <p className="text-[11px] text-slate-500">
                      Created {formatDate(key.created_at)} · Last used {formatDate(key.last_used_at)}
                      {key.expires_at ? ` · Expires ${formatDate(key.expires_at)}` : ''}
                    </p>
                  </div>
                  {key.is_valid ? (
                    <Badge className="border-transparent bg-green-100 text-green-700 hover:bg-green-100">Active</Badge>
                  ) : (
                    <Badge className="border-transparent bg-slate-100 text-slate-500 hover:bg-slate-100">
                      {key.revoked_at ? 'Revoked' : 'Expired'}
                    </Badge>
                  )}
                  {key.is_valid && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 px-2 text-red-600 hover:bg-red-50 hover:text-red-700"
                      onClick={() => setRevokeTarget(key)}
                      aria-label={`Revoke ${key.name}`}
                    >
                      <Trash2 size={14} />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Modal
        open={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        size="sm"
        title="New AI access key"
        description="Name it after the client that will use it. You will see the key once."
        footer={
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="h-11 sm:w-28" onClick={() => setIsCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="api-key-form"
              className="h-11 bg-slate-900 hover:bg-slate-800 sm:w-40"
              disabled={create.isPending || !name.trim()}
            >
              {create.isPending ? <InlineSpinner /> : 'Create key'}
            </Button>
          </div>
        }
      >
        <form
          id="api-key-form"
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          {create.isError && <ErrorBanner error={create.error} />}
          <div className="space-y-2">
            <Label htmlFor="api-key-name">Name</Label>
            <Input
              id="api-key-name"
              className="h-11"
              placeholder="Claude Desktop on my laptop"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="api-key-expires">Expires (optional)</Label>
            <Input
              id="api-key-expires"
              type="datetime-local"
              className="h-11"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </div>
        </form>
      </Modal>

      <Modal
        open={created !== null}
        onClose={() => setCreated(null)}
        size="md"
        title="Copy your key now"
        description="This is the only time it is shown. Paste it into your AI client's configuration."
        footer={
          <div className="flex justify-end">
            <Button className="h-11 bg-slate-900 hover:bg-slate-800 sm:w-32" onClick={() => setCreated(null)}>
              Done
            </Button>
          </div>
        }
      >
        {created && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Key</Label>
              <div className="flex gap-2">
                <Input readOnly className="h-11 font-mono text-xs" value={created.key} onFocus={(e) => e.target.select()} />
                <Button type="button" variant="outline" className="h-11 w-24 gap-1" onClick={() => copy('key')}>
                  {copied === 'key' ? <Check size={14} /> : <Copy size={14} />} Copy
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>MCP client config (stdio)</Label>
                <Button type="button" size="sm" variant="ghost" className="h-8 gap-1 text-xs" onClick={() => copy('config')}>
                  {copied === 'config' ? <Check size={12} /> : <Copy size={12} />} Copy config
                </Button>
              </div>
              <pre className="max-h-56 overflow-auto rounded-md bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">
                {mcpConfigSnippet(created.key)}
              </pre>
              <p className="text-xs text-slate-500">
                For a hosted connector use the URL <code className="font-mono">{API_URL.replace(/\/api\/?$/, '')}/mcp</code> with
                header <code className="font-mono">Authorization: Bearer &lt;key&gt;</code>. See docs/mcp/clients.md.
              </p>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => revokeTarget && revoke.mutate(revokeTarget.id)}
        title="Revoke this key?"
        description={`"${revokeTarget?.name ?? ''}" will stop working immediately. This cannot be undone.`}
        confirmText="Revoke"
        confirmVariant="destructive"
        isLoading={revoke.isPending}
      />
    </>
  );
}
```

Check `lib/api.ts` exports `API_URL` (line 1 of `apiClient.ts` imports it, so it does). If `Modal` has no `size="md"`, use the size values it accepts (grep `size` in `components/common/Modal.tsx`) and pick the medium one.

- [ ] **Step 4: Mount the card**

In `consultancy-dev/app/app/profile/page.tsx` add the import near the other component imports:

```tsx
import { ApiKeysCard } from './components/ApiKeysCard';
```

and in the right-hand column (`<div className="space-y-4 lg:col-span-2">`) insert `<ApiKeysCard />` directly after the "Work information" `<Card>` closes and before the "Quick actions" card.

- [ ] **Step 5: Verify**

Run: `cd consultancy-dev && npx tsc --noEmit`
Expected: no output (clean).

Run: `cd consultancy-dev && npm run lint`
Expected: no errors. If the lint rule about `setTimeout` in event handlers or unused imports fires, fix the named line.

Run (manual, optional): `cd backend && python manage.py runserver` and `cd consultancy-dev && npm run dev`, sign in as `admin` from `seed_demo`, open `/app/profile`, create a key, copy it, revoke it. The list badge changes to Revoked.

- [ ] **Step 6: Commit**

```bash
git add consultancy-dev/lib/types.ts consultancy-dev/lib/apiClient.ts consultancy-dev/app/app/profile/components/ApiKeysCard.tsx consultancy-dev/app/app/profile/page.tsx
git commit -m "Add AI access keys card to the profile page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Deployment, client docs, repo config and stdio smoke test

**Files:**
- Create: `deploy/consultancy-mcp.service`
- Modify: `deploy/nginx.console.nexxteducation.in.conf` (add `location /mcp/`)
- Create: `docs/mcp/README.md`, `docs/mcp/clients.md`, `docs/mcp/security.md`
- Generate: `docs/mcp/tools.md` via `python manage.py export_mcp_catalog --docs ../docs/mcp/tools.md`
- Create: `.mcp.json` (repo root, next to `backend/`)
- Modify: `backend/.gitignore`-adjacent: nothing; but add `CONSULTANCY_*` variables to `deploy/PRODUCTION_SETUP.md` (append a section)
- Create: `backend/mcp_server/tests/test_stdio_smoke.py`

**Interfaces:**
- Consumes: `python -m mcp_server` CLI from Task 6; the `/health` route and bearer middleware from Task 6.

- [ ] **Step 1: Write the stdio smoke test**

`backend/mcp_server/tests/test_stdio_smoke.py`:

```python
"""
Spawn the real server over stdio and speak MCP to it. No backend is reached:
listing tools needs no API call, and the fake key is never sent anywhere.
"""

import asyncio
import os
import sys
from pathlib import Path

from django.test import SimpleTestCase
from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

BACKEND_DIR = Path(__file__).resolve().parent.parent.parent


class StdioSmokeTests(SimpleTestCase):
    def test_initialize_and_list_tools_over_stdio(self):
        env = dict(os.environ)
        env.update({
            'CONSULTANCY_API_URL': 'http://127.0.0.1:9/api/',
            'CONSULTANCY_API_KEY': 'cdk_' + 'x' * 40,
            'PYTHONUNBUFFERED': '1',
        })
        params = StdioServerParameters(command=sys.executable, args=['-m', 'mcp_server'], cwd=str(BACKEND_DIR), env=env)

        async def go():
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    init = await session.initialize()
                    tools = await session.list_tools()
                    resources = await session.list_resources()
                    prompts = await session.list_prompts()
                    return init, {t.name for t in tools.tools}, {str(r.uri) for r in resources.resources}, {p.name for p in prompts.prompts}

        init, tools, resources, prompts = asyncio.run(asyncio.wait_for(go(), timeout=60))
        self.assertEqual(init.serverInfo.name, 'consultancy-dev')
        for name in ('whoami', 'list_enquiries', 'create_registration', 'student_360', 'analytics_overview', 'upload_document'):
            self.assertIn(name, tools)
        self.assertIn('consultancy://catalog', resources)
        self.assertIn('daily_briefing', prompts)

    def test_read_only_flag_over_stdio(self):
        env = dict(os.environ)
        env.update({'CONSULTANCY_API_KEY': 'cdk_' + 'x' * 40, 'PYTHONUNBUFFERED': '1'})
        params = StdioServerParameters(command=sys.executable, args=['-m', 'mcp_server', '--read-only'], cwd=str(BACKEND_DIR), env=env)

        async def go():
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    return {t.name for t in (await session.list_tools()).tools}

        tools = asyncio.run(asyncio.wait_for(go(), timeout=60))
        self.assertIn('list_enquiries', tools)
        self.assertNotIn('create_enquiry', tools)
```

Run: `cd backend && python manage.py test mcp_server.tests.test_stdio_smoke`
Expected: `Ran 2 tests ... OK`. If it hangs, something wrote to stdout during startup: check that `configure_logging` uses `stream=sys.stderr` and that no `print()` exists in `mcp_server/`.

- [ ] **Step 2: systemd unit and nginx location**

`deploy/consultancy-mcp.service`:

```ini
[Unit]
Description=Consultancy MCP server (Streamable HTTP)
After=network.target consultancy-backend.service
Wants=consultancy-backend.service

[Service]
User=www-data
Group=www-data
WorkingDirectory=/opt/consultancy/backend
EnvironmentFile=/opt/consultancy/backend/.env
# The MCP server never touches the database: it calls the API like any client.
Environment=CONSULTANCY_API_URL=http://127.0.0.1:8000/api/
Environment=CONSULTANCY_MCP_HOST=127.0.0.1
Environment=CONSULTANCY_MCP_PORT=8765
ExecStart=/opt/consultancy/backend/venv/bin/python -m mcp_server --transport streamable-http
Restart=always
RestartSec=3

NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

In `deploy/nginx.console.nexxteducation.in.conf`, add a new upstream after `upstream django_api { ... }`:

```nginx
upstream consultancy_mcp {
    server 127.0.0.1:8765;
}
```

and a new location before `# ---- Next.js frontend ----`:

```nginx
    # ---- MCP server (AI clients). Bearer API key required; see docs/mcp/ ----
    location /mcp {
        proxy_pass http://consultancy_mcp;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Connection "";
        proxy_buffering off;          # server-sent events must stream
        proxy_read_timeout 300s;
    }
    location = /mcp/health {
        proxy_pass http://consultancy_mcp/health;
    }
```

Append to `deploy/PRODUCTION_SETUP.md`:

```markdown

## MCP server (optional, for AI clients)

    cp deploy/consultancy-mcp.service /etc/systemd/system/
    systemctl daemon-reload && systemctl enable --now consultancy-mcp
    curl -s https://console.nexxteducation.in/mcp/health   # {"status":"ok",...}

Variables (all optional): `CONSULTANCY_API_URL` (default http://127.0.0.1:8000/api/), `CONSULTANCY_MCP_HOST`,
`CONSULTANCY_MCP_PORT`, `CONSULTANCY_MCP_READ_ONLY=1` to disable every write tool,
`CONSULTANCY_MCP_MAX_DOWNLOAD_BYTES` (default 5 MB). In hosted mode there is no server-wide credential:
each request carries the user's own `Authorization: Bearer cdk_...` key (created on the Profile page).
```

- [ ] **Step 3: Write the docs**

`docs/mcp/README.md`:

```markdown
# ConsultancyDev MCP server

An [MCP](https://modelcontextprotocol.io) server that lets any AI assistant work inside the CRM **as you**: read and write enquiries, registrations, enrollments, payments, documents, visa records, tasks, follow-ups, approvals, transfers, the permissions matrix and analytics, with your exact role and branch scope.

## How it works

- Runs from `backend/` (`python -m mcp_server`) and calls the REST API over HTTP. It never touches the database, so every permission and workflow rule stays where it is enforced.
- Knows the whole API from a generated catalog (`backend/mcp_server/catalog.json`, regenerated by `python manage.py export_mcp_catalog`) plus curated knowledge documents (`backend/mcp_server/knowledge/`).
- Exposes ~150 tools (see `tools.md`), resources under `consultancy://`, and guided prompts.

## Get a key

Sign in to the console → Profile → **AI access keys** → New key. Copy it once. A key has your permissions; revoke it there when done.

## Run locally (stdio)

    cd backend
    pip install -r requirements.txt
    set CONSULTANCY_API_URL=https://console.nexxteducation.in/api/     # or http://127.0.0.1:8000/api/
    set CONSULTANCY_API_KEY=cdk_...
    python -m mcp_server

Flags: `--read-only`, `--api-url URL`, `--transport streamable-http --host 127.0.0.1 --port 8765`.

## Hosted (Streamable HTTP)

Deployed behind nginx at `https://console.nexxteducation.in/mcp` (see `deploy/consultancy-mcp.service`). Clients send `Authorization: Bearer cdk_...` on every request; `/mcp/health` is open.

## Client setup

See `clients.md` for copy-paste configs (Claude Desktop, Claude Code, Claude.ai, ChatGPT, Cursor, VS Code, Windsurf, Gemini CLI, Codex CLI, generic).

## First conversation

1. `whoami` — confirms who the assistant is acting as.
2. Read `consultancy://knowledge/overview`.
3. Try `daily_briefing`, `student_360`, `search_everything`.

## Safety

- Deletes, resets, rejections, revocations and deactivations require `confirm=true` and are annotated destructive; good clients ask you first.
- `CONSULTANCY_MCP_READ_ONLY=1` removes every write tool.
- Everything is logged by the backend under the user who owns the key.

## Development

    cd backend
    python manage.py test mcp_server core.test_api_keys core.test_mcp_catalog
    python manage.py export_mcp_catalog --docs ../docs/mcp/tools.md   # after API changes
```

`docs/mcp/clients.md`:

````markdown
# Connecting AI clients

Two ways to connect:

- **Local (stdio)**: the client starts `python -m mcp_server` on your machine. Needs Python 3.11+, the backend's `requirements.txt` installed, and your key in the environment. Works with any API URL (local or production).
- **Remote (Streamable HTTP)**: the client talks to `https://console.nexxteducation.in/mcp` with `Authorization: Bearer <key>`.

Replace `<KEY>` with a key from Profile → AI access keys, and `<BACKEND>` with the absolute path to `ConsultancyDev/backend`.

## Claude Desktop (stdio)

`claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "consultancy-dev": {
      "command": "python",
      "args": ["-m", "mcp_server"],
      "cwd": "<BACKEND>",
      "env": {
        "CONSULTANCY_API_URL": "https://console.nexxteducation.in/api/",
        "CONSULTANCY_API_KEY": "<KEY>"
      }
    }
  }
}
```

On Windows use the full interpreter path, e.g. `"command": "C:\\Python311\\python.exe"`.

## Claude Code

Repo-local: the checked-in `.mcp.json` at the repository root already declares the server; set the two variables in your shell (`CONSULTANCY_API_URL`, `CONSULTANCY_API_KEY`) and run `claude` from the repo. Or add it explicitly:

```bash
claude mcp add consultancy-dev -e CONSULTANCY_API_KEY=<KEY> -e CONSULTANCY_API_URL=https://console.nexxteducation.in/api/ -- python -m mcp_server
# remote:
claude mcp add --transport http consultancy-dev https://console.nexxteducation.in/mcp --header "Authorization: Bearer <KEY>"
```

## Claude.ai (remote connector)

Settings → Connectors → Add custom connector: URL `https://console.nexxteducation.in/mcp`. If the connector dialog offers an authentication header, use `Authorization: Bearer <KEY>`; if it only offers OAuth, use a local client instead (OAuth is not implemented yet).

## ChatGPT (connector / Developer mode)

Settings → Connectors → Create: URL `https://console.nexxteducation.in/mcp`, authentication "Custom header" or "API key" with `Authorization: Bearer <KEY>` where available. Deep-research connectors that require `search`/`fetch` tools are not provided; use the general MCP tools.

## Cursor

`~/.cursor/mcp.json` or `.cursor/mcp.json` in the repo:

```json
{
  "mcpServers": {
    "consultancy-dev": {
      "command": "python",
      "args": ["-m", "mcp_server"],
      "cwd": "<BACKEND>",
      "env": { "CONSULTANCY_API_URL": "https://console.nexxteducation.in/api/", "CONSULTANCY_API_KEY": "<KEY>" }
    },
    "consultancy-dev-remote": {
      "url": "https://console.nexxteducation.in/mcp",
      "headers": { "Authorization": "Bearer <KEY>" }
    }
  }
}
```

## VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "consultancy-dev": {
      "type": "stdio",
      "command": "python",
      "args": ["-m", "mcp_server"],
      "cwd": "<BACKEND>",
      "env": { "CONSULTANCY_API_URL": "https://console.nexxteducation.in/api/", "CONSULTANCY_API_KEY": "<KEY>" }
    },
    "consultancy-dev-remote": {
      "type": "http",
      "url": "https://console.nexxteducation.in/mcp",
      "headers": { "Authorization": "Bearer <KEY>" }
    }
  }
}
```

## Windsurf

`~/.codeium/windsurf/mcp_config.json`, same shape as Cursor (`mcpServers` with `command`/`args`/`env` or `serverUrl` + `headers`).

## Gemini CLI

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "consultancy-dev": {
      "command": "python",
      "args": ["-m", "mcp_server"],
      "cwd": "<BACKEND>",
      "env": { "CONSULTANCY_API_URL": "https://console.nexxteducation.in/api/", "CONSULTANCY_API_KEY": "<KEY>" }
    }
  }
}
```

## OpenAI Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.consultancy-dev]
command = "python"
args = ["-m", "mcp_server"]
cwd = "<BACKEND>"
env = { CONSULTANCY_API_URL = "https://console.nexxteducation.in/api/", CONSULTANCY_API_KEY = "<KEY>" }
```

## Any other client / your own agent

- stdio: run `python -m mcp_server` with the two environment variables; speak JSON-RPC over stdin/stdout.
- HTTP: POST JSON-RPC to `https://console.nexxteducation.in/mcp` with `Accept: application/json, text/event-stream` and `Authorization: Bearer <KEY>`; the server is stateless (no session id needed).

Python example with the official SDK:

```python
import asyncio
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async def main():
    async with streamablehttp_client("https://console.nexxteducation.in/mcp", headers={"Authorization": "Bearer <KEY>"}) as (r, w, _):
        async with ClientSession(r, w) as s:
            await s.initialize()
            print(await s.call_tool("whoami", {}))

asyncio.run(main())
```

## Troubleshooting

- "No credentials configured": set `CONSULTANCY_API_KEY` (stdio) or the Authorization header (HTTP).
- 401 from tools: key revoked/expired, or the user was deactivated. Create a new key.
- Tools list is empty of `create_*`: the server runs with `--read-only` / `CONSULTANCY_MCP_READ_ONLY=1`.
- Client hangs at startup (stdio): something printed to stdout; run `python -m mcp_server --version` to check the environment, and make sure `cwd` is the `backend` folder.
````

`docs/mcp/security.md`:

```markdown
# Security notes for the MCP server

## Trust boundary

The MCP server is a client of the REST API. It holds no database credentials and no secret key. Every request it makes carries the end user's personal API key (or a JWT obtained from their password), so the backend authorises each call exactly as it would for the web console: role, company, branch, ownership, capability matrix, approval workflow, audit logging.

## API keys

- Format `cdk_` + 40 random characters (`secrets.choice`, 62-symbol alphabet, ~238 bits). Only the sha256 is stored; the prefix (12 chars) is shown in lists.
- A key inherits the user's `is_active` / `is_active_employee` state and dies with them. `revoke_all_tokens` (role/branch/company/password/active changes) revokes keys too.
- Keys can be minted only from a password-authenticated session, never from a key, so a leaked key cannot create replacements. Company admins can list and revoke their staff's keys; dev admins anyone's.
- Optional `expires_at`. `last_used_at` is stamped at most once a minute.

## Hosted mode

- nginx terminates TLS and proxies `/mcp` to `127.0.0.1:8765`; the server never listens publicly.
- `BearerRequiredMiddleware` rejects requests without a bearer/API-key header before the protocol layer; per-request credentials are forwarded, so one process safely serves many users and holds no ambient credential.
- The server is stateless (`stateless_http=True`): no session affinity, nothing cached across users.
- Backend throttles apply per user (120/min burst, 5000/hour).

## Local mode

- The key lives in the client's config file/environment. Treat it like a password; prefer a key per device with an expiry.
- `file_path` uploads and `save_to` downloads are only enabled over stdio (the user's own machine).

## Destructive operations

- `delete_*`, `reset_role_permissions` require `confirm=true`; `reject_*`, `revoke_api_key`, `set_user_active` are annotated `destructiveHint` so clients can prompt.
- `CONSULTANCY_MCP_READ_ONLY=1` unregisters every write tool for kiosk or analyst deployments.

## PII

- `date_of_birth` and `passport_no` are encrypted at rest and returned in clear only through authenticated reads; documents are encrypted blobs served only via the download action. The MCP server returns them to the AI client that asked; make sure that client's data handling is acceptable to you.
- The knowledge base instructs assistants never to copy passport numbers into free-text fields.

## Logging

- The server logs to stderr (stdio) or the journal (systemd): tool names, status codes, never bodies or keys.
- The backend's `core.security` log records logins, key creation/revocation, downloads and permission changes under the acting user.

## Not implemented

- OAuth 2.1 authorization server / dynamic client registration (needed by some hosted connectors that refuse static headers).
- Rate limiting inside the MCP process (the backend's throttles are the limit).
```

- [ ] **Step 4: Repo-root `.mcp.json`**

`.mcp.json` (at `C:\Users\Asus\Music\Projects\ConsultancyDev\ConsultancyDev\.mcp.json`):

```json
{
  "mcpServers": {
    "consultancy-dev": {
      "command": "python",
      "args": ["-m", "mcp_server"],
      "cwd": "backend",
      "env": {
        "CONSULTANCY_API_URL": "${CONSULTANCY_API_URL:-http://127.0.0.1:8000/api/}",
        "CONSULTANCY_API_KEY": "${CONSULTANCY_API_KEY}"
      }
    }
  }
}
```

- [ ] **Step 5: Generate `tools.md` and run everything**

Run: `cd backend && python manage.py export_mcp_catalog --docs ../docs/mcp/tools.md`
Expected: `Wrote ...catalog.json (28 resources)` and `Wrote ...docs/mcp/tools.md`.

Run: `cd backend && python manage.py test core mcp_server`
Expected: OK, zero failures.

Run: `cd backend && python -m mcp_server --version`
Expected: `1.0.0`.

Run (manual, hosted mode): `cd backend && set CONSULTANCY_API_URL=http://127.0.0.1:8000/api/ && python -m mcp_server --transport streamable-http --port 8765` then in another shell `curl -s http://127.0.0.1:8765/health` → `{"status":"ok","version":"1.0.0","read_only":false}` and `curl -s -X POST http://127.0.0.1:8765/mcp` → 401 with the bearer message.

- [ ] **Step 6: Commit**

```bash
git add deploy/consultancy-mcp.service deploy/nginx.console.nexxteducation.in.conf deploy/PRODUCTION_SETUP.md docs/mcp .mcp.json backend/mcp_server/tests/test_stdio_smoke.py backend/mcp_server/catalog.json
git commit -m "Add MCP deployment unit, client docs, security notes and stdio smoke test

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Spec coverage checklist (self-review)

| Spec section | Task |
|---|---|
| 3 Architecture, package layout, entry point, hosted mode | 1, 6, 13 |
| 4.1 Generated catalog + freshness test | 4 |
| 4.2 Curated knowledge (15 files) | 11 |
| 5.1 Generated CRUD with validation, confirm on delete | 7 |
| 5.2 Custom action tools | 4 (overlay), 7 |
| 5.3 Documents upload/download | 9 |
| 5.4 Composite tools (whoami, student_360, convert, enroll, payment, search, briefing, explain_permission) | 8, 10 |
| 5.5 Annotations and read-only mode | 6, 7, 8, 9, 10 |
| 6 Resources and prompts | 11 |
| 7.1 ApiKey model, auth class, endpoints, revoke_all_tokens | 2, 3 |
| 7.2 Profile card | 12 |
| 7.3 Credential resolution (stdio env / HTTP header) | 6 |
| 8 Error handling with hints, 429 retry, stderr logging | 5, 6 |
| 9 Testing (api keys, catalog, per-role, composite, documents, read-only, stdio smoke) | 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13 |
| 10 requirements, systemd, nginx, docs, `.mcp.json` | 1, 13 |
