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


def _csv(raw: str | None) -> tuple[str, ...]:
    """A comma-separated env list -> tuple (a Settings field must stay hashable)."""
    return tuple(part.strip() for part in (raw or '').split(',') if part.strip())


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
    # Extra Host / Origin header values accepted in streamable-http mode. Empty
    # means loopback only, which is what a client on this machine sends. Behind
    # a reverse proxy the Host is the public name, so it must be listed here or
    # every proxied request answers 421. See server.transport_security_for.
    allowed_hosts: tuple[str, ...] = ()
    allowed_origins: tuple[str, ...] = ()

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
        allowed_hosts=_csv(source.get('CONSULTANCY_MCP_ALLOWED_HOSTS')),
        allowed_origins=_csv(source.get('CONSULTANCY_MCP_ALLOWED_ORIGINS')),
    )
    if overrides:
        clean = {k: v for k, v in overrides.items() if v is not None}
        if 'api_url' in clean:
            clean['api_url'] = _normalise_url(clean['api_url'])
        settings = replace(settings, **clean)
    if settings.transport not in TRANSPORTS:
        raise ValueError(f'Unknown transport {settings.transport!r}; expected one of {TRANSPORTS}')
    return settings
