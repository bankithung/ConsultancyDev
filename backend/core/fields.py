"""
Application-level encryption for PII at rest.

Disk-level encryption protects against a stolen drive; it does nothing against
a leaked database dump, an over-broad SELECT, or a compromised read replica.
Passport numbers and dates of birth are encrypted here so that reading the row
is not the same as reading the value.

Trade-off, stated plainly: encrypted columns cannot be filtered, sorted, or
searched by the database. Only fields we never query by are encrypted. Where an
exact-match lookup is still needed, store a separate HMAC blind index alongside
(see `blind_index`) and query that instead.
"""

import base64
import hashlib
import hmac

from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.db import models
from django.utils import timezone

_fernet_cache = None


def _fernet():
    global _fernet_cache
    if _fernet_cache is None:
        key = settings.FIELD_ENCRYPTION_KEY
        if not key:
            raise ImproperlyConfigured('FIELD_ENCRYPTION_KEY is not configured.')
        if isinstance(key, str):
            key = key.encode()
        try:
            _fernet_cache = Fernet(key)
        except (ValueError, TypeError) as exc:
            raise ImproperlyConfigured(
                'FIELD_ENCRYPTION_KEY must be a valid 32-byte url-safe base64 '
                'Fernet key.'
            ) from exc
    return _fernet_cache


def encrypt_bytes(raw: bytes) -> bytes:
    return _fernet().encrypt(raw)


def decrypt_bytes(token: bytes) -> bytes:
    return _fernet().decrypt(token)


def blind_index(value: str) -> str:
    """
    Deterministic keyed hash for equality lookups on an encrypted field.

    Keyed with the encryption key so an attacker with only the database cannot
    brute-force the (low-entropy) plaintext space offline.
    """
    if value is None:
        return ''
    key = settings.FIELD_ENCRYPTION_KEY
    if isinstance(key, str):
        key = key.encode()
    digest = hmac.new(key, value.strip().lower().encode(), hashlib.sha256)
    return digest.hexdigest()


class EncryptedTextField(models.TextField):
    """
    Transparently Fernet-encrypts on save and decrypts on load.

    Values that fail to decrypt are returned as-is rather than raising, so a
    key rotation or a pre-encryption legacy row degrades to "unreadable value"
    instead of taking down every query that touches the table.
    """

    description = 'Text encrypted at rest with Fernet'

    def get_prep_value(self, value):
        if value is None or value == '':
            return value
        if not isinstance(value, str):
            value = str(value)
        return encrypt_bytes(value.encode()).decode()

    def from_db_value(self, value, expression, connection):
        return self._decrypt(value)

    def to_python(self, value):
        if isinstance(value, str) and value.startswith('gAAAAA'):
            return self._decrypt(value)
        return value

    @staticmethod
    def _decrypt(value):
        if value is None or value == '':
            return value
        try:
            return decrypt_bytes(value.encode()).decode()
        except (InvalidToken, ValueError, TypeError):
            # Legacy plaintext row, or a key that no longer matches.
            return value


class EncryptedDateField(EncryptedTextField):
    """A date stored encrypted. Returns a `datetime.date` to callers."""

    description = 'Date encrypted at rest with Fernet'

    def get_prep_value(self, value):
        if value is None or value == '':
            return value
        if hasattr(value, 'isoformat'):
            value = value.isoformat()
        return super().get_prep_value(value)

    def from_db_value(self, value, expression, connection):
        raw = super().from_db_value(value, expression, connection)
        return self._parse(raw)

    def to_python(self, value):
        if value is None or value == '':
            return None
        if hasattr(value, 'year'):
            return value
        return self._parse(super().to_python(value))

    @staticmethod
    def _parse(raw):
        if not raw or hasattr(raw, 'year'):
            return raw
        try:
            return timezone.datetime.fromisoformat(raw).date()
        except (ValueError, TypeError):
            return None


def encrypted_key_fingerprint() -> str:
    """Short, non-reversible identifier of the active key, for diagnostics."""
    key = settings.FIELD_ENCRYPTION_KEY
    if isinstance(key, str):
        key = key.encode()
    return base64.urlsafe_b64encode(hashlib.sha256(key).digest())[:8].decode()
