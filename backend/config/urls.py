"""
Root URL configuration.

Auth now lives under /api/auth/ (login, refresh, logout) rather than the bare
SimpleJWT views, so logout can blacklist the refresh token and login can return
the user object alongside the tokens.
"""

from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/', include('core.urls')),
]
