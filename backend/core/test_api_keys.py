"""
Personal API keys: the credential an MCP client (or any script) uses to act as
one specific user. A key inherits the user's role, company and branch and is
revoked by the user, by an admin, or by anything that calls revoke_all_tokens.
"""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from core import services
from core.models import ApiKey, Branch, Role

User = get_user_model()
PASSWORD = 'Testing!2026xyz'

RF = {
    'DEFAULT_AUTHENTICATION_CLASSES': (
        'core.authentication.ApiKeyAuthentication',
        'rest_framework_simplejwt.authentication.JWTAuthentication',
    ),
    'DEFAULT_PERMISSION_CLASSES': ('rest_framework.permissions.IsAuthenticated',),
    'DEFAULT_PAGINATION_CLASS': 'core.pagination.StandardPagination',
    'PAGE_SIZE': 25,
    'DEFAULT_FILTER_BACKENDS': (
        'django_filters.rest_framework.DjangoFilterBackend',
        'rest_framework.filters.SearchFilter',
        'rest_framework.filters.OrderingFilter',
    ),
    'EXCEPTION_HANDLER': 'core.exception_handler.api_exception_handler',
}


def mk(username, role, company, branch):
    user = User.objects.create(
        username=username, role=role, company=company, branch=branch,
        email=f'{username}@example.com',
    )
    user.set_password(PASSWORD)
    user.save()
    return user


@override_settings(REST_FRAMEWORK=RF)
class ApiKeyModelTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        services.ensure_default_plans()
        cls.company, cls.head_office = services.provision_company('Acme Consultancy')
        cls.emp = mk('emp', Role.EMPLOYEE, cls.company, cls.head_office)

    def setUp(self):
        cache.clear()

    def test_issue_returns_plaintext_once_and_stores_only_hash(self):
        key, raw = ApiKey.issue(self.emp, 'laptop')
        self.assertTrue(raw.startswith('cdk_'))
        self.assertEqual(len(raw), 4 + 40)
        self.assertEqual(key.prefix, raw[:12])
        self.assertEqual(key.key_hash, ApiKey.hash_key(raw))
        self.assertNotIn(raw, key.key_hash)
        self.assertTrue(key.is_valid)

    def test_revoked_or_expired_keys_are_not_valid(self):
        key, _ = ApiKey.issue(self.emp, 'a')
        key.revoked_at = timezone.now()
        self.assertFalse(key.is_valid)
        key2, _ = ApiKey.issue(self.emp, 'b', expires_at=timezone.now() - timedelta(seconds=1))
        self.assertFalse(key2.is_valid)

    def test_revoke_all_tokens_revokes_keys(self):
        key, _ = ApiKey.issue(self.emp, 'a')
        services.revoke_all_tokens(self.emp)
        key.refresh_from_db()
        self.assertIsNotNone(key.revoked_at)


@override_settings(REST_FRAMEWORK=RF)
class ApiKeyAuthenticationTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        services.ensure_default_plans()
        cls.company, cls.head_office = services.provision_company('Acme Consultancy')
        cls.emp = mk('emp', Role.EMPLOYEE, cls.company, cls.head_office)
        cls.admin = mk('admin', Role.COMPANY_ADMIN, cls.company, cls.head_office)

    def setUp(self):
        cache.clear()

    def client_with(self, raw, header='Bearer'):
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f'{header} {raw}')
        return client

    def test_bearer_api_key_authenticates_as_its_user(self):
        _, raw = ApiKey.issue(self.emp, 'k')
        response = self.client_with(raw).get('/api/users/me/')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['username'], 'emp')

    def test_x_api_key_header_also_works(self):
        _, raw = ApiKey.issue(self.emp, 'k')
        client = APIClient()
        client.credentials(HTTP_X_API_KEY=raw)
        self.assertEqual(client.get('/api/users/me/').status_code, 200)

    def test_unknown_key_is_401(self):
        response = self.client_with('cdk_' + 'x' * 40).get('/api/users/me/')
        self.assertEqual(response.status_code, 401)

    def test_revoked_key_is_401(self):
        key, raw = ApiKey.issue(self.emp, 'k')
        key.revoked_at = timezone.now()
        key.save(update_fields=['revoked_at'])
        self.assertEqual(self.client_with(raw).get('/api/users/me/').status_code, 401)

    def test_expired_key_is_401(self):
        _, raw = ApiKey.issue(self.emp, 'k', expires_at=timezone.now() - timedelta(minutes=1))
        self.assertEqual(self.client_with(raw).get('/api/users/me/').status_code, 401)

    def test_deactivated_user_key_is_refused(self):
        _, raw = ApiKey.issue(self.emp, 'k')
        self.emp.is_active_employee = False
        self.emp.save(update_fields=['is_active_employee'])
        self.assertEqual(self.client_with(raw).get('/api/users/me/').status_code, 401)

    def test_last_used_is_stamped(self):
        key, raw = ApiKey.issue(self.emp, 'k')
        self.assertIsNone(key.last_used_at)
        self.client_with(raw).get('/api/users/me/')
        key.refresh_from_db()
        self.assertIsNotNone(key.last_used_at)

    def test_jwt_login_still_works(self):
        client = APIClient()
        response = client.post('/api/auth/login/', {'username': 'emp', 'password': PASSWORD}, format='json')
        self.assertEqual(response.status_code, 200)
        client.credentials(HTTP_AUTHORIZATION=f'Bearer {response.data["access"]}')
        self.assertEqual(client.get('/api/users/me/').status_code, 200)

    def test_key_scope_matches_user_scope(self):
        """An employee's key sees only the employee's rows, like their JWT would."""
        from core.models import Enquiry
        Enquiry.objects.create(
            company=self.company, branch=self.head_office, created_by=self.admin, owner=self.admin,
            school_name='S', stream='Science', candidate_name='admin-owned', course_interested='B',
            mobile='9', email='a@example.com', father_name='F', mother_name='M', permanent_address='A',
        )
        _, raw = ApiKey.issue(self.emp, 'k')
        response = self.client_with(raw).get('/api/enquiries/')
        self.assertEqual(response.data['count'], 0)


@override_settings(REST_FRAMEWORK=RF)
class ApiKeyEndpointTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        services.ensure_default_plans()
        cls.company, cls.head_office = services.provision_company('Acme Consultancy')
        cls.rival, cls.rival_branch = services.provision_company('Rival Consultancy')
        cls.emp = mk('emp', Role.EMPLOYEE, cls.company, cls.head_office)
        cls.emp2 = mk('emp2', Role.EMPLOYEE, cls.company, cls.head_office)
        cls.admin = mk('admin', Role.COMPANY_ADMIN, cls.company, cls.head_office)
        cls.rival_admin = mk('rival_admin', Role.COMPANY_ADMIN, cls.rival, cls.rival_branch)
        cls.dev = mk('dev', Role.DEV_ADMIN, None, None)

    def setUp(self):
        cache.clear()

    def auth(self, user):
        client = APIClient()
        response = client.post('/api/auth/login/', {'username': user.username, 'password': PASSWORD}, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        client.credentials(HTTP_AUTHORIZATION=f'Bearer {response.data["access"]}')
        return client

    def test_create_returns_plaintext_once(self):
        client = self.auth(self.emp)
        response = client.post('/api/api-keys/', {'name': 'Claude Desktop'}, format='json')
        self.assertEqual(response.status_code, 201, response.data)
        self.assertTrue(response.data['key'].startswith('cdk_'))
        self.assertEqual(response.data['prefix'], response.data['key'][:12])
        self.assertNotIn('key_hash', response.data)
        listed = client.get('/api/api-keys/')
        self.assertEqual(listed.data['count'], 1)
        self.assertNotIn('key', listed.data['results'][0])
        self.assertNotIn('key_hash', listed.data['results'][0])

    def test_name_is_required(self):
        response = self.auth(self.emp).post('/api/api-keys/', {}, format='json')
        self.assertEqual(response.status_code, 400)
        self.assertIn('name', response.data['fields'])

    def test_expires_at_in_the_past_is_rejected(self):
        past = (timezone.now() - timedelta(days=1)).isoformat()
        response = self.auth(self.emp).post('/api/api-keys/', {'name': 'x', 'expires_at': past}, format='json')
        self.assertEqual(response.status_code, 400)

    def test_users_only_see_their_own_keys(self):
        ApiKey.issue(self.emp2, 'other')
        response = self.auth(self.emp).get('/api/api-keys/')
        self.assertEqual(response.data['count'], 0)

    def test_employee_cannot_list_another_users_keys(self):
        ApiKey.issue(self.emp2, 'other')
        response = self.auth(self.emp).get(f'/api/api-keys/?user={self.emp2.pk}')
        self.assertEqual(response.status_code, 403)

    def test_company_admin_can_list_and_revoke_staff_keys(self):
        key, _ = ApiKey.issue(self.emp, 'k')
        client = self.auth(self.admin)
        response = client.get(f'/api/api-keys/?user={self.emp.pk}')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['count'], 1)
        revoked = client.post(f'/api/api-keys/{key.pk}/revoke/')
        self.assertEqual(revoked.status_code, 200, revoked.data)
        key.refresh_from_db()
        self.assertIsNotNone(key.revoked_at)

    def test_company_admin_cannot_reach_other_tenant(self):
        key, _ = ApiKey.issue(self.rival_admin, 'k')
        client = self.auth(self.admin)
        self.assertEqual(client.get(f'/api/api-keys/?user={self.rival_admin.pk}').status_code, 403)
        self.assertEqual(client.post(f'/api/api-keys/{key.pk}/revoke/').status_code, 404)

    def test_dev_admin_can_list_any_user(self):
        ApiKey.issue(self.rival_admin, 'k')
        response = self.auth(self.dev).get(f'/api/api-keys/?user={self.rival_admin.pk}')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['count'], 1)

    def test_revoke_own_key_stops_it_working(self):
        client = self.auth(self.emp)
        created = client.post('/api/api-keys/', {'name': 'k'}, format='json')
        raw = created.data['key']
        keyed = APIClient()
        keyed.credentials(HTTP_AUTHORIZATION=f'Bearer {raw}')
        self.assertEqual(keyed.get('/api/users/me/').status_code, 200)
        self.assertEqual(client.post(f'/api/api-keys/{created.data["id"]}/revoke/').status_code, 200)
        self.assertEqual(keyed.get('/api/users/me/').status_code, 401)

    def test_revoke_twice_is_idempotent(self):
        client = self.auth(self.emp)
        created = client.post('/api/api-keys/', {'name': 'k'}, format='json')
        url = f'/api/api-keys/{created.data["id"]}/revoke/'
        self.assertEqual(client.post(url).status_code, 200)
        self.assertEqual(client.post(url).status_code, 200)

    def test_api_key_cannot_mint_or_manage_keys(self):
        """A leaked key must not be able to create a replacement for itself."""
        _, raw = ApiKey.issue(self.emp, 'k')
        keyed = APIClient()
        keyed.credentials(HTTP_AUTHORIZATION=f'Bearer {raw}')
        self.assertEqual(keyed.post('/api/api-keys/', {'name': 'clone'}, format='json').status_code, 403)
        self.assertEqual(keyed.get('/api/api-keys/').status_code, 403)
