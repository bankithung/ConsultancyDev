"""Who is calling? stdio: the environment. HTTP: the request's Authorization header."""

from __future__ import annotations

from .client import Credentials
from .config import Settings


class AuthError(Exception):
    pass


def _http_request(ctx):
    """
    The Starlette request behind this call, or None when there is not one.

    FastMCP's Context.request_context is a property that RAISES when no
    request is in flight, and in stdio mode the context exists but its
    `request` is None. Both mean the same thing here: no caller header. What
    happens next is the transport's decision, not this function's — stdio
    reads the environment, hosted mode refuses.
    """
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
        # Over HTTP the server is multi-tenant: the CALLER's header decides who
        # we act as, and any key in the server's own environment is ignored.
        header = request.headers.get('authorization') or request.headers.get('x-api-key')
        if not header:
            raise AuthError('Missing Authorization header. Send "Authorization: Bearer <your cdk_ API key>".')
        if not header.lower().startswith('bearer '):
            header = f'Bearer {header}'
        try:
            return Credentials.from_header(header)
        except ValueError as exc:
            raise AuthError(str(exc)) from exc
    # Spec 7.3: over Streamable HTTP there is no server-wide credential. The
    # check is on the TRANSPORT, not on "was a request in flight", so the
    # property is structural: an SDK context anomaly or a future path that
    # reaches a tool outside a request cannot fall through to the operator's
    # own key and quietly act as them for every affected call. Below this line
    # the process is stdio, where the model, the server and the credential all
    # belong to one person.
    if not settings.stdio:
        raise AuthError('Hosted mode requires a per-request Authorization header.')
    if settings.api_key:
        return Credentials.from_api_key(settings.api_key)
    if settings.username and settings.password:
        return Credentials.from_password(settings.username, settings.password)
    raise AuthError(
        'No credentials configured. Set CONSULTANCY_API_KEY (create one on your Profile page under '
        '"AI access keys"), or CONSULTANCY_USERNAME and CONSULTANCY_PASSWORD.'
    )
