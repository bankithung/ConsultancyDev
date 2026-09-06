"""
Root URL configuration.

Auth now lives under /api/auth/ (login, refresh, logout) rather than the bare
SimpleJWT views, so logout can blacklist the refresh token and login can return
the user object alongside the tokens.
"""

from django.contrib import admin
from django.urls import include, path
from core import oauth
from oauth2_provider import views as oauth_views
from oauth2_provider.urls import metadata_urlpatterns

oauth_patterns = ([
    path('authorize/', oauth.McpAuthorizeView.as_view(), name='authorize'),
    path('token/', oauth_views.TokenView.as_view(), name='token'),
    path('revoke_token/', oauth_views.RevokeTokenView.as_view(), name='revoke-token'),
], 'oauth2_provider')

urlpatterns = [
    path('', include(metadata_urlpatterns)),
    path('oauth/', include(oauth_patterns)),
    path('oauth/login/', oauth.McpLoginView.as_view(), name='mcp-login'),
    path('oauth/connections/', oauth.connections, name='mcp-connections'),
    path('admin/', admin.site.urls),
    path('api/', include('core.urls')),
]
