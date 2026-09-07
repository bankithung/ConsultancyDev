"""Real authorization-code/PKCE flow, delegated permissions and revocation."""
import base64
import hashlib
from urllib.parse import urlencode, urlsplit, parse_qs
from datetime import timedelta
from django.test import TestCase, override_settings, Client
from django.core.cache import cache
from django.utils import timezone
from oauth2_provider.models import Application, AccessToken
from core.models import User, Role
from core.services import provision_company, revoke_all_tokens

ORIGIN = 'https://console.nexxteducation.in'
CALLBACK = 'https://chatgpt.com/connector/oauth/eohYyzsZlamh'
PASSWORD = 'Testing!2026xyz'

@override_settings(ALLOWED_HOSTS=['console.nexxteducation.in', 'testserver'])
class McpOAuthTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        company, branch = provision_company('OAuth test company')
        cls.user = User.objects.create_user(username='oauth-admin', password=PASSWORD, company=company, branch=branch, role=Role.COMPANY_ADMIN)
        cls.app = Application.objects.create(name='ChatGPT', client_id='test-chatgpt', client_type='public', authorization_grant_type='authorization-code', redirect_uris=CALLBACK)

    def setUp(self):
        cache.clear()
        self.client = Client(HTTP_HOST='console.nexxteducation.in')
        self.client.force_login(self.user)

    def auth_params(self, **overrides):
        verifier = 'a' * 64
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
        params = dict(client_id=self.app.client_id, redirect_uri=CALLBACK, response_type='code', scope='crm', state='test-state', code_challenge=challenge, code_challenge_method='S256', resource=ORIGIN + '/mcp')
        params.update(overrides)
        return params

    def test_branded_consent_preserves_access_description_and_cancellation(self):
        self.app.client_id = 'consultancy-chatgpt'
        self.app.save(update_fields=['client_id'])
        params = self.auth_params()
        page = self.client.get('/oauth/authorize/', params, secure=True)
        self.assertContains(page, 'ChatGPT logo')
        self.assertContains(page, 'Create, edit and delete records')
        self.assertContains(page, 'Limited to your company and role permissions.')
        denied = self.client.post('/oauth/authorize/', params, secure=True)
        self.assertEqual(denied.status_code, 302)
        self.assertEqual(parse_qs(urlsplit(denied['Location']).query)['error'], ['access_denied'])
        self.assertFalse(AccessToken.objects.filter(user=self.user).exists())

    def code(self):
        params = self.auth_params()
        page = self.client.get('/oauth/authorize/', params, secure=True)
        self.assertEqual(page.status_code, 200)
        self.assertContains(page, 'Allow connection')
        response = self.client.post('/oauth/authorize/', {**params, 'allow': 'Authorize'}, secure=True)
        self.assertEqual(response.status_code, 302)
        query = parse_qs(urlsplit(response['Location']).query)
        self.assertEqual(query['state'], ['test-state'])
        return query['code'][0]

    def exchange(self, code, **overrides):
        data = dict(grant_type='authorization_code', code=code, client_id=self.app.client_id, redirect_uri=CALLBACK, code_verifier='a' * 64, resource=ORIGIN + '/mcp')
        data.update(overrides)
        return self.client.post('/oauth/token/', urlencode(data), content_type='application/x-www-form-urlencoded', secure=True)

    def token(self):
        response = self.exchange(self.code())
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def me(self, token):
        return self.client.get('/api/users/me/', HTTP_AUTHORIZATION='Bearer ' + token, secure=True)

    def test_discovery(self):
        metadata = self.client.get('/.well-known/oauth-authorization-server', secure=True).json()
        self.assertEqual(metadata['issuer'], ORIGIN)
        self.assertEqual(metadata['authorization_endpoint'], ORIGIN + '/oauth/authorize/')
        self.assertEqual(metadata['token_endpoint_auth_methods_supported'], ['none'])
        self.assertEqual(metadata['code_challenge_methods_supported'], ['S256'])
        resource = self.client.get('/.well-known/oauth-protected-resource/mcp', secure=True).json()
        self.assertEqual(resource['resource'], ORIGIN + '/mcp')

    def test_code_flow_identity_and_no_key_minting(self):
        token = self.token()['access_token']
        self.assertTrue(token.startswith('cdo_'))
        self.assertEqual(self.me(token).json()['username'], self.user.username)
        response = self.client.post('/api/api-keys/', {'name': 'forbidden'}, HTTP_AUTHORIZATION='Bearer ' + token, secure=True)
        self.assertEqual(response.status_code, 403)
        self.assertNotEqual(AccessToken.objects.get().token, token)

    def test_wrong_pkce_and_replayed_code_rejected(self):
        code = self.code()
        self.assertEqual(self.exchange(code, code_verifier='b' * 64).status_code, 400)
        self.assertEqual(self.exchange(code).status_code, 200)
        self.assertEqual(self.exchange(code).status_code, 400)

    def test_redirect_and_resource_rejected(self):
        for params in [self.auth_params(redirect_uri='https://attacker.example/callback'), self.auth_params(resource='https://attacker.example')]:
            response = self.client.get('/oauth/authorize/', params, secure=True)
            self.assertEqual(response.status_code, 400)
            self.assertNotIn('Location', response)
        self.assertEqual(self.exchange(self.code(), resource='https://attacker.example').status_code, 400)

    def test_missing_pkce_rejected(self):
        params = self.auth_params()
        params.pop('code_challenge')
        response = self.client.get('/oauth/authorize/', params, secure=True)
        self.assertNotIn('Allow connection', response.content.decode())

    def test_inactive_and_expired_access_rejected(self):
        token = self.token()['access_token']
        self.user.is_active_employee = False
        self.user.save()
        self.assertEqual(self.me(token).status_code, 401)
        self.user.is_active_employee = True
        self.user.save()
        AccessToken.objects.update(expires=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.me(token).status_code, 401)

    def test_refresh_rotation_and_revoke(self):
        token = self.token()
        data = dict(grant_type='refresh_token', refresh_token=token['refresh_token'], client_id=self.app.client_id, resource=ORIGIN + '/mcp')
        response = self.client.post('/oauth/token/', urlencode(data), content_type='application/x-www-form-urlencoded', secure=True)
        self.assertEqual(response.status_code, 200, response.content)
        current = response.json()
        self.assertNotEqual(current['refresh_token'], token['refresh_token'])
        revoke_all_tokens(self.user)
        self.assertEqual(self.me(current['access_token']).status_code, 401)
        data['refresh_token'] = current['refresh_token']
        self.assertEqual(self.client.post('/oauth/token/', urlencode(data), content_type='application/x-www-form-urlencoded', secure=True).status_code, 400)

    def test_user_can_disconnect(self):
        token = self.token()['access_token']
        response = self.client.post('/oauth/connections/', {'application_id': self.app.pk}, secure=True)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(self.me(token).status_code, 401)

    def test_company_scope_is_preserved(self):
        company, branch = provision_company('Other OAuth company')
        outsider = User.objects.create_user(username='outsider', company=company, branch=branch)
        token = self.token()['access_token']
        response = self.client.get(f'/api/users/{outsider.pk}/', HTTP_AUTHORIZATION='Bearer ' + token, secure=True)
        self.assertEqual(response.status_code, 404)

    def test_cannot_disconnect_another_users_connection(self):
        token = self.token()['access_token']
        other = User.objects.create_user(username='other', company=self.user.company, branch=self.user.branch)
        self.client.force_login(other)
        self.client.post('/oauth/connections/', {'application_id': self.app.pk}, secure=True)
        self.assertEqual(self.me(token).status_code, 200)

    def test_csrf_required_for_consent(self):
        client = Client(enforce_csrf_checks=True, HTTP_HOST='console.nexxteducation.in')
        client.force_login(self.user)
        self.assertEqual(client.post('/oauth/authorize/', {**self.auth_params(), 'allow': 'Authorize'}, secure=True).status_code, 403)

    def test_login_for_company_admin_and_denied_inactive(self):
        self.client.logout()
        response = self.client.post('/oauth/login/', {'username': self.user.username, 'password': PASSWORD, 'next': '/oauth/connections/'}, secure=True)
        self.assertEqual(response.status_code, 302)
        self.client.logout()
        self.user.is_active_employee = False
        self.user.save()
        response = self.client.post('/oauth/login/', {'username': self.user.username, 'password': PASSWORD}, secure=True)
        self.assertContains(response, 'This account is not active')
