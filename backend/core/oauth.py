"""OAuth delegation for the hosted MCP resource, backed by Django OAuth Toolkit."""
import secrets

from django.conf import settings
from django.contrib.auth.forms import AuthenticationForm
from django.contrib.auth.views import LoginView
from django.contrib.auth.decorators import login_required
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.http import JsonResponse, HttpResponse
from django.shortcuts import render, redirect
from django.views.decorators.http import require_http_methods
from oauth2_provider.contrib.rest_framework import OAuth2Authentication
from oauth2_provider.models import AccessToken, RefreshToken, Grant
from oauth2_provider.oauth2_validators import OAuth2Validator
from oauth2_provider.views import AuthorizationView
from oauthlib.oauth2 import InvalidRequestError
from rest_framework.exceptions import AuthenticationFailed


class InvalidTargetError(InvalidRequestError):
    error = 'invalid_target'


def access_token_generator(request):
    return 'cdo_' + secrets.token_urlsafe(48)


def account_active(user):
    return bool(user and user.is_active and user.is_active_employee and
                (user.is_dev_admin or (user.company_id and user.company.is_active)))


def resource_matches(request_uri, audiences):
    # The API is the implementation of this same MCP resource. No other
    # resource, origin or API may accept these delegated tokens.
    origin = settings.MCP_OAUTH_ORIGIN
    return audiences == [origin + '/mcp'] and (
        request_uri == origin + '/mcp' or request_uri.startswith(origin + '/api/')
    )


class McpOAuthValidator(OAuth2Validator):
    def _check_and_set_request_resource(self, request):
        super()._check_and_set_request_resource(request)
        resource = settings.MCP_OAUTH_ORIGIN + '/mcp'
        if not request.resource:
            request.resource = [resource]
        if request.resource != [resource]:
            raise InvalidTargetError(description='Tokens are limited to the consultancy MCP resource.')

    def validate_bearer_token(self, token, scopes, request):
        valid = super().validate_bearer_token(token, ['crm', *(scopes or [])], request)
        return bool(valid and account_active(request.user) and
                    request.access_token.resource == [settings.MCP_OAUTH_ORIGIN + '/mcp'])

    def validate_refresh_token(self, refresh_token, client, request, *args, **kwargs):
        return bool(super().validate_refresh_token(refresh_token, client, request, *args, **kwargs)
                    and account_active(request.user))


class McpOAuthAuthentication(OAuth2Authentication):
    def authenticate(self, request):
        header = request.META.get('HTTP_AUTHORIZATION', '')
        parts = header.split()
        if len(parts) != 2 or parts[0].lower() != 'bearer' or not parts[1].startswith('cdo_'):
            return None
        result = super().authenticate(request)
        if result is None:
            raise AuthenticationFailed('OAuth access expired, revoked, or invalid. Reconnect your account.')
        return result


class McpLoginForm(AuthenticationForm):
    def confirm_login_allowed(self, user):
        super().confirm_login_allowed(user)
        if not account_active(user):
            raise ValidationError('This account is not active.', code='inactive')


class McpLoginView(LoginView):
    template_name = 'core/oauth/login.html'
    authentication_form = McpLoginForm
    next_page = '/oauth/connections/'

    def post(self, request, *args, **kwargs):
        # nginx supplies X-Real-IP; never trust a client-supplied forwarding chain.
        address = request.META.get('HTTP_X_REAL_IP', request.META.get('REMOTE_ADDR', 'unknown'))
        key = 'oauth-login:' + address
        cache.add(key, 0, timeout=300)
        try:
            attempts = cache.incr(key)
        except ValueError:
            cache.set(key, 1, timeout=300)
            attempts = 1
        if attempts > 20:
            return HttpResponse('Too many sign-in attempts. Try again in five minutes.', status=429)
        return super().post(request, *args, **kwargs)


class McpAuthorizeView(AuthorizationView):
    login_url = '/oauth/login/'
    template_name = 'core/oauth/authorize.html'

    def dispatch(self, request, *args, **kwargs):
        resource = settings.MCP_OAUTH_ORIGIN + '/mcp'
        params = request.GET if request.method == 'GET' else request.POST
        resources = params.getlist('resource')
        if resources and resources != [resource]:
            return JsonResponse({'error': 'invalid_target'}, status=400)
        if request.user.is_authenticated and not account_active(request.user):
            return HttpResponse('This account is not active.', status=403)
        if request.method == 'GET':
            request.GET = request.GET.copy()
            request.GET['resource'] = resource
            request.GET['approval_prompt'] = 'force'
        return super().dispatch(request, *args, **kwargs)


@login_required(login_url='/oauth/login/')
@require_http_methods(['GET', 'POST'])
def connections(request):
    if request.method == 'POST':
        application_id = request.POST.get('application_id', '')
        if not application_id.isdigit():
            return HttpResponse('Invalid connection.', status=400)
        # Scope every operation to the signed-in user.
        RefreshToken.objects.filter(user=request.user, application_id=application_id).delete()
        AccessToken.objects.filter(user=request.user, application_id=application_id).delete()
        Grant.objects.filter(user=request.user, application_id=application_id).delete()
        return redirect('/oauth/connections/')
    apps = AccessToken.objects.filter(user=request.user).values('application_id', 'application__name').distinct()
    return render(request, 'core/oauth/connections.html', {'connections': apps})
