"""
Response compression.

Registered in settings.MIDDLEWARE directly after SecurityMiddleware; the
comment there explains the ordering. This module explains the security
question, because "we added gzip" is not a decision anyone should have to
re-derive from the diff.


BREACH: ASSESSED, AND IT DOES NOT APPLY TO THIS API
---------------------------------------------------

BREACH recovers a secret from a compressed response by measuring how the
response LENGTH changes as the attacker varies input that gets reflected into
the same body. It needs all four of these at once:

  (1) the response is compressed,
  (2) the response body contains a secret,
  (3) the body reflects attacker-chosen input, and
  (4) the attacker can make the VICTIM'S browser issue that request, with the
      victim's credentials attached, many thousands of times.

(4) is the load-bearing one, and this API fails it structurally:

  * Authentication is a Bearer JWT in the Authorization header, not an ambient
    cookie. A cross-origin request forged from an attacker's page carries no
    Authorization header, so every replayed request returns 401 with no
    tenant data in it. There is nothing to measure. (CORS_ALLOW_CREDENTIALS is
    True, but that governs cookies and reading responses, not header auth —
    and CORS_ALLOWED_ORIGINS is an explicit allowlist in production.)

  * The endpoints whose bodies genuinely DO carry a secret — /api/auth/login/
    and /api/auth/refresh/ return tokens in the JSON body — require the
    password or the refresh token to be supplied IN THE REQUEST. A third party
    who could already replay those requests would already hold the credential.

  * The cookie-authenticated surface is Django admin, and there BREACH's usual
    target is the CSRF token. Django masks the CSRF token with a fresh random
    salt on every render, so its ciphertext differs each time and the length
    oracle has nothing stable to converge on. SESSION_COOKIE_SAMESITE is 'Lax'
    (settings.py, the not-DEBUG block) and CSRF_COOKIE_SAMESITE defaults to
    'Lax', so cross-site subresource requests do not carry those cookies at
    all — only top-level navigations do, which cannot be used to measure
    response size.

  * Django's own GZipMiddleware already ships the Heal-the-BREACH mitigation:
    `max_random_bytes = 100` pads every compressed response with up to 100
    random bytes, randomising the length and destroying the precision the
    attack depends on.

So gzip is enabled for the API. Two exemptions below are belt-and-braces
rather than necessity, and one is purely about not wasting CPU.
"""

from django.middleware.gzip import GZipMiddleware


class ApiGZipMiddleware(GZipMiddleware):
    """
    GZipMiddleware that declines two classes of response.

    AUTH RESPONSES (`/api/auth/`). These are the only bodies in the API that
    contain a bearer token, and the login response also echoes back a
    caller-supplied username (`LoginView.post` serialises the user it matched
    on `request.data['username']`). That is conditions (2) and (3) of BREACH in
    one body. Condition (4) is unreachable — see the module docstring — so this
    is not a fix for a live hole; it means the reasoning above never has to be
    right for the responses where being wrong would cost a token. These bodies
    are a few hundred bytes; the compression forgone is worth nothing.

    FILE DOWNLOADS (`/download/`). Documents are PDFs, JPEGs and Office files:
    already-compressed formats that gzip cannot shrink. Worse, they are served
    as a streaming FileResponse, and GZipMiddleware DELETES Content-Length when
    it compresses a stream (django/middleware/gzip.py) because it cannot know
    the final size — so the browser loses its progress bar and the client
    cannot detect a truncated download, in exchange for no saved bytes. The
    non-streaming branch of GZipMiddleware discards compression that does not
    shrink the body; the streaming branch has no such check, which is exactly
    why this path needs an explicit opt-out.
    """

    EXEMPT_PREFIXES = ('/api/auth/',)
    EXEMPT_SUFFIXES = ('/download/',)

    def is_exempt(self, path):
        """Split out from process_response so it is directly testable."""
        return path.startswith(self.EXEMPT_PREFIXES) or path.endswith(self.EXEMPT_SUFFIXES)

    def process_response(self, request, response):
        if self.is_exempt(request.path):
            # Returned before super() runs, so these responses get no
            # `Vary: Accept-Encoding` either. That is correct: neither is
            # cacheable (auth responses are POSTs, downloads set
            # `Cache-Control: private, no-store`), so there is no shared cache
            # that could key on an encoding we never vary by.
            return response
        return super().process_response(request, response)
