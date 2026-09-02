"""
A Transport that drives the Django test client, so MCP tools are exercised
against the real viewsets, serializers and permissions inside `manage.py test`.
Never imported by the runtime server.
"""

from __future__ import annotations

import json as jsonlib
from typing import Any, Mapping
from urllib.parse import quote

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
            url += '?' + '&'.join(f'{_q(k)}={_q(v)}' for k, v in query)
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
    return quote(str(value), safe='')
