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
