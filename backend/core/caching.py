"""
Short-TTL caching for the read endpoints that cost the most queries.

TENANT ISOLATION IS THE ENTIRE DIFFICULTY HERE, and it is not a performance
concern — it is an authorization one. Every figure the analytics endpoints and
`payments/stats` return has already been narrowed by
`core.permissions.scope_queryset`. A cache key that omits WHO ASKED will hand
one company's revenue to another company's dashboard: same class of bug as a
missing permission check, just with a slower fuse and no audit trail. So the
key is built in exactly one place, `scoped_cache_key`, and it is built from
the caller.

WHAT MAKES THE KEY SAFE. `scope_signature` includes `user.pk`. Every input
`scope_queryset` consults — company, branch, role and the transfer table — is
reachable only from that one user row, so
two different users can never collide on a key. That is a structural
guarantee, not a careful-enumeration one.

WHAT THE TTL BOUNDS. Because the key is per-user, staleness can only ever
affect the SAME user's own view. Two things lag by up to
`settings.SCOPED_CACHE_SECONDS`:

  * a write (a new payment, a new enquiry) does not move that user's dashboard
    counters until the entry expires;
  * a change to that user's own scope that is not visible on their user row —
    accepting a record transfer — takes effect on the next miss rather than instantly. Changes
    that ARE on the row (company, branch, role, deactivation) are in the
    signature and take effect immediately.

The upgrade path, if either becomes unacceptable, is a per-company generation
counter bumped by a post_save signal and mixed into the key. That is real
machinery; a 30-second TTL is not, and it is what a dashboard needs.

WORKS WITH LocMemCache. Keys stay distinct per process, so correctness holds
with the default backend (settings.py CACHES) — only the hit rate suffers,
since each gunicorn worker keeps its own copy. Set REDIS_CACHE_URL to share.
"""

import hashlib
from functools import wraps
from urllib.parse import urlencode

from django.conf import settings
from django.core.cache import cache
from rest_framework.response import Response

# Bumped by hand if the shape of a cached payload changes, so a deploy cannot
# serve a new serializer's readers an old serializer's dict.
CACHE_SCHEMA_VERSION = 'v1'

DEFAULT_TIMEOUT_SECONDS = 30


def cache_seconds():
    """Read at call time, so `override_settings` works in tests."""
    return int(getattr(settings, 'SCOPED_CACHE_SECONDS', DEFAULT_TIMEOUT_SECONDS))


def scope_signature(user):
    """
    Everything about the caller that can change WHAT THEY MAY SEE.

    `user.pk` alone would be sufficient for isolation (see the module
    docstring). The other four are here so that re-parenting an account,
    moving it between branches, changing its role or deactivating it takes
    effect on the next request instead of after the TTL — a demoted user
    continuing to read manager-level aggregates for 30 seconds is not a
    trade worth making to save four attribute reads.
    """
    if user is None or not user.is_authenticated:
        return 'anonymous'
    return ':'.join((
        str(user.pk),
        str(getattr(user, 'company_id', None) or '-'),
        str(getattr(user, 'branch_id', None) or '-'),
        str(getattr(user, 'role', None) or '-'),
        '1' if getattr(user, 'is_active_employee', True) else '0',
    ))


def scoped_cache_key(prefix, request):
    """
    `prefix` identifies the endpoint; everything else identifies the caller
    and the exact question they asked.

    Query parameters are included with `.lists()` rather than `.items()`
    because these are QueryDicts: `?branch=1&branch=2` and `?branch=2` differ
    in meaning, and `.items()` would flatten them to the same key.
    """
    query = urlencode(sorted(request.query_params.lists()), doseq=True)
    material = f'{prefix}|{scope_signature(request.user)}|{query}'
    digest = hashlib.sha256(material.encode()).hexdigest()
    # The prefix stays in clear text so a cache dump is still readable; the
    # caller identity is hashed so keys stay short and bounded.
    return f'{CACHE_SCHEMA_VERSION}:scoped:{prefix}:{digest}'


def cached_scoped_response(prefix, timeout=None):
    """
    Cache a DRF handler's payload per caller.

    ONLY FOR HAND-BUILT PAYLOADS — plain dicts and lists, which is what every
    endpoint this decorates returns. Do not put it on a handler that returns
    serializer output: `ReturnDict`/`ReturnList` hold a reference to the
    serializer, and pickling that into the cache is at best wasteful and at
    worst broken.

    Only 200s are stored. A 4xx is cheap to recompute and caching one would
    mean a permission or validation outcome outlived the state that produced
    it. Note that permission failures never reach here at all: DRF runs
    `check_permissions` in `initial()`, before the handler.

    Every response carries `X-Cache: HIT|MISS`, which is what makes the
    behaviour observable in a browser's network tab and assertable in tests.
    """
    def decorator(handler):
        @wraps(handler)
        def wrapper(self, request, *args, **kwargs):
            ttl = cache_seconds() if timeout is None else timeout
            if ttl <= 0:                    # SCOPED_CACHE_SECONDS=0 disables it
                response = handler(self, request, *args, **kwargs)
                response['X-Cache'] = 'DISABLED'
                return response

            key = scoped_cache_key(prefix, request)
            payload = cache.get(key)
            if payload is not None:
                response = Response(payload)
                response['X-Cache'] = 'HIT'
                return response

            response = handler(self, request, *args, **kwargs)
            if response.status_code == 200:
                cache.set(key, response.data, ttl)
            response['X-Cache'] = 'MISS'
            return response
        return wrapper
    return decorator
