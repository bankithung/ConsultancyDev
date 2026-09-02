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
from dataclasses import dataclass
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
        # A JWT handed to us by the caller: no password to re-login with, so
        # __init__'s "needs a credential" check is satisfied and then cleared.
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
