"""
ASGI entrypoint.

Plain Django ASGI. The Channels/WebSocket router that previously lived here was
removed with the real-time messaging feature; it authenticated via session
cookies while the client sent a JWT query parameter, so every socket was closed
as anonymous.

Serving via ASGI (uvicorn/daphne) or WSGI (gunicorn) are both fine now that no
long-lived connections are involved.
"""

import os

from django.core.asgi import get_asgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')

application = get_asgi_application()
