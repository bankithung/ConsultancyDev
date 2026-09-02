import json as jsonlib
import os

os.environ.setdefault('DJANGO_ALLOW_ASYNC_UNSAFE', 'true')

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import SimpleTestCase, TestCase, override_settings

from core import services
from core.models import ApiKey, Enquiry, Role
from mcp_server.client import ApiClient, ApiError, Credentials, Response, hint_for
from mcp_server.testing import DjangoTestTransport

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
    user = User.objects.create(username=username, role=role, company=company, branch=branch, email=f'{username}@example.com')
    user.set_password(PASSWORD)
    user.save()
    return user


def enquiry(owner, branch, name):
    return Enquiry.objects.create(
        company=owner.company, branch=branch, created_by=owner, owner=owner,
        school_name='School', stream='Science', candidate_name=name, course_interested='BTech',
        mobile='9000000000', email=f'{name}@example.com', father_name='F', mother_name='M', permanent_address='Addr',
    )


class StubTransport:
    """Replays a scripted list of Responses and records what it was asked for."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, method, path, *, params=None, json=None, data=None, files=None, headers=None):
        self.calls.append({
            'method': method, 'path': path, 'params': params, 'json': json,
            'data': data, 'files': files, 'headers': dict(headers or {}),
        })
        # The last scripted response repeats, so a retry needs no extra entry.
        return self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]


def body(status, payload, headers=None):
    return Response(status, headers or {}, jsonlib.dumps(payload).encode('utf-8'))


@override_settings(REST_FRAMEWORK=RF)
class ApiClientTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        services.ensure_default_plans()
        cls.company, cls.head_office = services.provision_company('Acme Consultancy')
        cls.admin = mk('admin', Role.COMPANY_ADMIN, cls.company, cls.head_office)
        cls.emp = mk('emp', Role.EMPLOYEE, cls.company, cls.head_office)
        for i in range(30):
            enquiry(cls.admin, cls.head_office, f'cand-{i:02d}')
        Enquiry.objects.filter(candidate_name='cand-00').update(status='Closed')
        Enquiry.objects.filter(candidate_name='cand-01').update(status='Contacted')

    def setUp(self):
        cache.clear()
        _, raw = ApiKey.issue(self.admin, 'test')
        self.client_ = ApiClient(DjangoTestTransport(), Credentials.from_api_key(raw))

    def test_response_json_handles_empty_body(self):
        self.assertIsNone(Response(204, {}, b'').json())
        self.assertEqual(Response(200, {}, b'{"a": 1}').json(), {'a': 1})

    def test_get_me(self):
        me = self.client_.get('users/me/')
        self.assertEqual(me['username'], 'admin')

    def test_trailing_slash_is_added(self):
        me = self.client_.get('users/me')
        self.assertEqual(me['username'], 'admin')

    def test_list_params_are_repeated_keys(self):
        page = self.client_.get('enquiries/', params={'status': ['Closed', 'Contacted'], 'page_size': 50})
        self.assertEqual(page['count'], 2)

    def test_list_pages_walks_all_pages(self):
        rows = self.client_.list_pages('enquiries/', params={'page_size': 10}, all_pages=True)
        self.assertEqual(len(rows), 30)

    def test_list_pages_single_page_returns_envelope(self):
        page = self.client_.list_pages('enquiries/', params={'page_size': 10})
        self.assertEqual(page['count'], 30)
        self.assertEqual(len(page['results']), 10)

    def test_list_pages_respects_max_pages(self):
        rows = self.client_.list_pages('enquiries/', params={'page_size': 10}, all_pages=True, max_pages=2)
        self.assertEqual(len(rows), 20)

    def test_404_becomes_api_error(self):
        # DRF turns Http404 into NotFound(*exc.args), so the envelope carries
        # Django's "No <Model> matches the given query." rather than a flat
        # "Not found." — the client preserves whatever the backend said.
        with self.assertRaises(ApiError) as ctx:
            self.client_.get('enquiries/999999/')
        self.assertEqual(ctx.exception.status, 404)
        self.assertEqual(ctx.exception.error, 'No Enquiry matches the given query.')
        self.assertIn('visibility scope', ctx.exception.hint)

    def test_404_from_a_plain_http404_keeps_the_flat_envelope(self):
        # The other 404 shape: core.exception_handler's Http404 branch, which
        # answers {"error": "Not found."} for anything DRF did not translate.
        transport = StubTransport(Response(404, {}, b'{"error": "Not found."}'))
        with self.assertRaises(ApiError) as ctx:
            ApiClient(transport, Credentials.from_api_key('cdk_x')).get('enquiries/1/')
        self.assertEqual(ctx.exception.error, 'Not found.')

    def test_validation_error_keeps_fields(self):
        with self.assertRaises(ApiError) as ctx:
            self.client_.post('enquiries/', json={'school_name': 'x'})
        self.assertEqual(ctx.exception.status, 400)
        self.assertIn('mobile', ctx.exception.fields)

    def test_employee_delete_gets_approval_hint(self):
        row = Enquiry.objects.filter(candidate_name='cand-02').first()
        row.owner = self.emp
        row.save()
        _, raw = ApiKey.issue(self.emp, 'k')
        emp_client = ApiClient(DjangoTestTransport(), Credentials.from_api_key(raw))
        with self.assertRaises(ApiError) as ctx:
            emp_client.delete(f'enquiries/{row.pk}/')
        self.assertEqual(ctx.exception.status, 403)
        self.assertIn('create_approval_request', ctx.exception.hint)

    def test_password_credentials_log_in_and_refresh(self):
        creds = Credentials.from_password('admin', PASSWORD)
        client = ApiClient(DjangoTestTransport(), creds)
        self.assertEqual(client.get('users/me/')['username'], 'admin')
        self.assertTrue(creds.refresh(client.transport))
        self.assertEqual(client.get('users/me/')['username'], 'admin')

    def test_bad_password_is_401_api_error(self):
        client = ApiClient(DjangoTestTransport(), Credentials.from_password('admin', 'wrong'))
        with self.assertRaises(ApiError) as ctx:
            client.get('users/me/')
        self.assertEqual(ctx.exception.status, 401)

    def test_from_header_parses_bearer(self):
        creds = Credentials.from_header('Bearer cdk_abc')
        self.assertEqual(creds.apply(None), {'Authorization': 'Bearer cdk_abc'})
        with self.assertRaises(ValueError):
            Credentials.from_header('Basic xyz')

    def test_multipart_upload_reaches_document_viewset(self):
        data = {'file_name': 'note.pdf', 'type': 'Other'}
        files = {'file': ('note.pdf', b'%PDF-1.4 test', 'application/pdf')}
        doc = self.client_.post('documents/', data=data, files=files)
        self.assertEqual(doc['file_name'], 'note.pdf')
        self.assertTrue(doc['is_encrypted'])
        raw = self.client_.raw_get(f'documents/{doc["id"]}/download/')
        self.assertEqual(raw.status, 200)
        self.assertEqual(raw.content, b'%PDF-1.4 test')


class HintTests(TestCase):
    def test_hints(self):
        self.assertIn('create_approval_request', hint_for(403, 'Your role cannot delete records directly. Raise an approval request instead.', 'DELETE', 'enquiries/1/', None))
        self.assertIn('throttle', hint_for(429, 'Request was throttled.', 'GET', 'enquiries/', None).lower())
        self.assertIn('reference', hint_for(409, 'That operation conflicts with existing data.', 'POST', 'registrations/', None).lower())
        self.assertIn('one of registration or enquiry', hint_for(400, 'Validation failed', 'POST', 'documents/', {'non_field_errors': ['A document belongs to one student.']}))
        self.assertEqual(hint_for(200, '', 'GET', 'x/', None), '')


class ErrorTranslationTests(SimpleTestCase):
    """Statuses the live viewsets cannot be coaxed into producing on demand."""

    def setUp(self):
        self.creds = Credentials.from_api_key('cdk_stub')

    def test_api_key_goes_out_as_a_bearer_header(self):
        transport = StubTransport(body(200, {'ok': True}))
        ApiClient(transport, self.creds).get('users/me/')
        self.assertEqual(transport.calls[0]['headers'], {'Authorization': 'Bearer cdk_stub'})

    def test_409_conflict_is_translated_with_a_reference_hint(self):
        transport = StubTransport(body(409, {'error': 'That operation conflicts with existing data.'}))
        with self.assertRaises(ApiError) as ctx:
            ApiClient(transport, self.creds).post('registrations/', json={})
        self.assertEqual(ctx.exception.status, 409)
        self.assertEqual(ctx.exception.error, 'That operation conflicts with existing data.')
        self.assertIn('reference', ctx.exception.hint.lower())

    def test_429_is_retried_once_and_then_raised(self):
        throttled = body(429, {'error': 'Request was throttled.'}, {'Retry-After': '0'})
        transport = StubTransport(throttled, throttled)
        with self.assertLogs('mcp_server.client', level='WARNING'):
            with self.assertRaises(ApiError) as ctx:
                ApiClient(transport, self.creds).get('enquiries/')
        self.assertEqual(ctx.exception.status, 429)
        self.assertIn('throttle', ctx.exception.hint.lower())
        self.assertEqual(len(transport.calls), 2)

    def test_429_retry_that_succeeds_returns_the_body(self):
        transport = StubTransport(
            body(429, {'error': 'Request was throttled.'}, {'Retry-After': '0'}),
            body(200, {'count': 0, 'results': []}),
        )
        with self.assertLogs('mcp_server.client', level='WARNING'):
            page = ApiClient(transport, self.creds).get('enquiries/')
        self.assertEqual(page['count'], 0)
        self.assertEqual(len(transport.calls), 2)

    def test_401_on_a_jwt_session_refreshes_and_replays(self):
        creds = Credentials.from_password('admin', PASSWORD)
        transport = StubTransport(
            body(200, {'access': 'a1', 'refresh': 'r1'}),   # first login
            body(401, {'error': 'Given token not valid.'}),  # expired access
            body(200, {'access': 'a2', 'refresh': 'r2'}),   # refresh
            body(200, {'username': 'admin'}),                # replay
        )
        self.assertEqual(ApiClient(transport, creds).get('users/me/')['username'], 'admin')
        self.assertEqual(creds.access, 'a2')
        self.assertEqual(transport.calls[-1]['headers'], {'Authorization': 'Bearer a2'})

    def test_401_is_not_retried_for_an_api_key(self):
        transport = StubTransport(body(401, {'error': 'Invalid API key.'}))
        with self.assertRaises(ApiError) as ctx:
            ApiClient(transport, self.creds).get('users/me/')
        self.assertEqual(ctx.exception.status, 401)
        self.assertEqual(len(transport.calls), 1)

    def test_bare_error_body_becomes_fields(self):
        transport = StubTransport(body(400, {'mobile': ['This field is required.']}))
        with self.assertRaises(ApiError) as ctx:
            ApiClient(transport, self.creds).post('enquiries/', json={})
        self.assertEqual(ctx.exception.error, 'HTTP 400')
        self.assertIn('mobile', ctx.exception.fields)

    def test_non_json_error_body_still_raises(self):
        transport = StubTransport(Response(500, {}, b'<html>gateway</html>'))
        with self.assertRaises(ApiError) as ctx:
            ApiClient(transport, self.creds).get('enquiries/')
        self.assertEqual(ctx.exception.error, 'HTTP 500')
        self.assertIsNone(ctx.exception.fields)

    def test_query_string_in_the_path_is_refused(self):
        transport = StubTransport(body(200, {}))
        with self.assertRaises(ValueError):
            ApiClient(transport, self.creds).get('enquiries/?status=New')

    def test_str_and_to_dict_carry_status_error_and_hint(self):
        err = ApiError(404, 'Not found.', method='GET', path='enquiries/9/')
        self.assertTrue(str(err).startswith('404 Not found.'))
        self.assertIn(' — ', str(err))
        self.assertEqual(err.to_dict()['request'], 'GET enquiries/9/')
        self.assertEqual(err.to_dict()['status'], 404)

    def test_list_pages_returns_a_bare_array_untouched(self):
        transport = StubTransport(body(200, [{'id': 1}, {'id': 2}]))
        rows = ApiClient(transport, self.creds).list_pages('role-permissions/', all_pages=True)
        self.assertEqual(rows, [{'id': 1}, {'id': 2}])

    def test_credentials_reject_an_empty_pair(self):
        with self.assertRaises(ValueError):
            Credentials()

    def test_from_header_accepts_a_jwt(self):
        creds = Credentials.from_header('Bearer eyJhbGciOi.body.sig')
        self.assertFalse(creds.uses_api_key)
        self.assertEqual(creds.apply(None), {'Authorization': 'Bearer eyJhbGciOi.body.sig'})
