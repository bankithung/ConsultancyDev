"""
The MCP catalog is generated from the running code and committed. These tests
keep the committed file honest and make sure nothing registered on the router
is missing from it.
"""

import json
from pathlib import Path

from django.test import SimpleTestCase

from core import mcp_catalog
from core.models import Capability, Role
from core.urls import router

CATALOG_PATH = Path(__file__).resolve().parent.parent / 'mcp_server' / 'catalog.json'
TOOLS_DOC_PATH = Path(__file__).resolve().parent.parent.parent / 'docs' / 'mcp' / 'tools.md'


def _without_generated_at(markdown):
    """Compare the content, not the timestamp, if one is ever added."""
    return [line for line in markdown.splitlines() if not line.lower().startswith('generated at')]


class CatalogBuildTests(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.catalog = mcp_catalog.build_catalog()
        cls.by_prefix = {r['prefix']: r for r in cls.catalog['resources']}

    def test_every_router_prefix_is_in_the_catalog(self):
        registered = {prefix for prefix, _, _ in router.registry}
        self.assertEqual(registered, set(self.by_prefix))

    def test_every_prefix_has_names(self):
        for prefix in self.by_prefix:
            with self.subTest(prefix=prefix):
                self.assertIn(prefix, mcp_catalog.RESOURCE_NAMES)
                plural, singular = mcp_catalog.RESOURCE_NAMES[prefix]
                self.assertRegex(plural, r'^[a-z_]+$')
                self.assertRegex(singular, r'^[a-z_]+$')

    def test_enquiry_fields_and_filters(self):
        enq = self.by_prefix['enquiries']
        names = {f['name'] for f in enq['fields']}
        self.assertIn('candidate_name', names)
        self.assertIn('date_of_birth', names)
        status = next(f for f in enq['fields'] if f['name'] == 'status')
        self.assertEqual([c['value'] for c in status['choices']], ['New', 'Contacted', 'Converted', 'Closed'])
        company = next(f for f in enq['fields'] if f['name'] == 'company')
        self.assertTrue(company['read_only'])
        params = {f['param']: f for f in enq['filters']}
        self.assertEqual(params['status']['kind'], 'multi')
        self.assertEqual(params['owner']['kind'], 'multi_id')
        self.assertEqual(params['preferred_locations']['kind'], 'json_any')
        self.assertEqual(enq['search_fields'], ['candidate_name', 'school_name', 'mobile', 'email', 'course_interested'])
        self.assertEqual(enq['entity_type'], 'enquiry')

    def test_plain_filterset_fields_are_single_exact(self):
        docs = self.by_prefix['documents']
        params = {f['param']: f for f in docs['filters']}
        self.assertEqual(params['registration']['kind'], 'exact')
        self.assertFalse(self.by_prefix['plans']['list_paginated'])

    def test_write_only_fields_are_marked(self):
        enr = self.by_prefix['enrollments']
        f = next(x for x in enr['fields'] if x['name'] == 'installments_count')
        self.assertTrue(f['write_only'])
        doc = self.by_prefix['documents']
        self.assertTrue(next(x for x in doc['fields'] if x['name'] == 'file')['write_only'])

    def test_methods_reflect_viewset_type(self):
        self.assertEqual(self.by_prefix['plans']['methods'], ['GET'])
        self.assertIn('DELETE', self.by_prefix['enquiries']['methods'])
        self.assertEqual(self.by_prefix['notifications']['methods'], ['GET'])

    def test_every_resource_carries_the_six_verbs(self):
        expected = {'list', 'retrieve', 'create', 'update', 'partial_update', 'destroy'}
        for prefix, resource in self.by_prefix.items():
            with self.subTest(prefix=prefix):
                self.assertEqual(set(resource['verbs']), expected)
                for name, present in resource['verbs'].items():
                    self.assertIsInstance(present, bool, f'{prefix}.{name} must be a boolean')

    def test_verbs_report_the_handlers_each_viewset_defines(self):
        # `methods` cannot say "list but no retrieve": api-keys/ has no detail
        # route, so a generator reading GET alone would emit a get_api_key tool
        # pointing at a URL that does not resolve. `create` is routed here but
        # switched off by VERB_OVERRIDES (see test_api_keys_cannot_be_created).
        self.assertEqual(self.by_prefix['api-keys']['verbs'], {
            'list': True, 'retrieve': False, 'create': False,
            'update': False, 'partial_update': False, 'destroy': False,
        })
        # A full ModelViewSet defines all six.
        self.assertEqual(self.by_prefix['enquiries']['verbs'], {
            'list': True, 'retrieve': True, 'create': True,
            'update': True, 'partial_update': True, 'destroy': True,
        })
        # Append-only in behaviour, but the routes exist and answer 403 from
        # perform_update/perform_destroy, so the handlers are still defined.
        self.assertEqual(self.by_prefix['follow-up-comments']['verbs'], {
            'list': True, 'retrieve': True, 'create': True,
            'update': True, 'partial_update': True, 'destroy': True,
        })
        # ReadOnlyModelViewSet: both reads, no writes.
        self.assertEqual(self.by_prefix['notifications']['verbs'], {
            'list': True, 'retrieve': True, 'create': False,
            'update': False, 'partial_update': False, 'destroy': False,
        })

    def test_installments_cannot_be_created(self):
        # InstallmentSerializer marks `enrollment` read-only, so a POST can
        # never name its parent and the unique (enrollment, number) constraint
        # answers 409. The verb is switched off at the source so no
        # create_installment tool is ever generated; schedules come from
        # create_enrollment's installments_count.
        installments = self.by_prefix['installments']
        self.assertFalse(installments['verbs']['create'])
        self.assertTrue(installments['verbs']['list'])
        self.assertTrue(installments['verbs']['partial_update'])
        enrollment = next(f for f in installments['fields'] if f['name'] == 'enrollment')
        self.assertTrue(enrollment['read_only'], 'the override exists because this field is read-only')
        notes = ' '.join(installments['notes'])
        self.assertIn('create_enrollment', notes)
        self.assertIn('installments_count', notes)

    def test_api_keys_cannot_be_created(self):
        # The catalog probes ApiKeySerializer, whose read_only_fields are its
        # fields, so a generated create would strip the whole payload and POST
        # {} against ApiKeyCreateSerializer, which requires `name`. And
        # ApiKeyViewSet.initial() answers 403 to every api-keys call made with
        # API-key credentials, which is how the MCP server usually authenticates.
        keys = self.by_prefix['api-keys']
        self.assertFalse(keys['verbs']['create'])
        self.assertTrue(keys['verbs']['list'])
        self.assertTrue(all(f['read_only'] for f in keys['fields']),
                        'the override exists because the probed serializer is read-only throughout')
        notes = ' '.join(keys['notes'])
        self.assertIn('403', notes)
        self.assertIn('password', notes)
        self.assertIn('revoke_api_key', notes)

    def test_actions_declare_destructiveness_and_idempotence(self):
        # A tool annotation must not be guessed from the tool's name:
        # set_user_active revokes every token and key the target holds.
        actions = {(r['prefix'], a['name']): a for r in self.catalog['resources'] for a in r['actions']}
        for key, action in actions.items():
            with self.subTest(action=key):
                self.assertIsInstance(action['destructive'], bool)
                self.assertIsInstance(action['idempotent'], bool)
        for key in (('users', 'set_active'), ('api-keys', 'revoke'), ('transfers', 'reject'),
                    ('approval-requests', 'reject'), ('signup-requests', 'reject')):
            self.assertTrue(actions[key]['destructive'], key)
        for key in (('users', 'set_active'), ('api-keys', 'revoke'),
                    ('notifications', 'mark_read'), ('notifications', 'mark_all_read')):
            self.assertTrue(actions[key]['idempotent'], key)
        for key in (('tasks', 'reorder'), ('transfers', 'accept'), ('users', 'me')):
            self.assertFalse(actions[key]['destructive'], key)

    def _field(self, prefix, name):
        return next(f for f in self.by_prefix[prefix]['fields'] if f['name'] == name)

    def test_companies_is_active_is_recorded_writable_with_the_caller_rule_in_the_notes(self):
        # The catalog probes as an anonymous caller, so CompanyViewSet hands it
        # CompanyProfileSerializer and `is_active` comes back read-only. A note
        # alone was not enough: generated.py turns `fields` into a hard
        # client-side gate, so update_company refused the one write the note
        # advertised. FIELD_OVERRIDES records the DEV_ADMIN shape instead.
        is_active = self._field('companies', 'is_active')
        self.assertFalse(is_active['read_only'], 'the DEV_ADMIN shape is what the tools must send')
        self.assertFalse(is_active['required'])
        notes = ' '.join(self.by_prefix['companies']['notes'])
        self.assertIn('is_active', notes)
        self.assertIn('DEV_ADMIN', notes)

    def test_users_fields_record_the_admin_shape(self):
        # UserViewSet.get_serializer_class picks by WHO is asking, so the
        # anonymous probe saw UserSerializer: role, branch and
        # managed_managers read-only, and no `password` field at all. That made
        # every role or branch change impossible through a tool, and made
        # create_user drop `password` as an unknown field and then succeed,
        # saving an account with an unusable password and the model's default
        # role. The admin shape is recorded here and the API decides.
        for name, related in (('role', None), ('branch', 'Branch'), ('managed_managers', 'User')):
            with self.subTest(field=name):
                field = self._field('users', name)
                self.assertFalse(field['read_only'])
                self.assertFalse(field['required'], 'the serializer does not require it')
                if related:
                    self.assertEqual(field['related_model'], related)
        password = self._field('users', 'password')
        self.assertTrue(password['write_only'])
        self.assertFalse(password['read_only'])
        self.assertTrue(password['required'],
                        'create_user must ask for it; validate_payload(partial=True) skips it on update')
        self.assertEqual(password['type'], 'string')

    def test_users_notes_explain_who_the_recorded_shape_belongs_to(self):
        notes = ' '.join(self.by_prefix['users']['notes'])
        self.assertIn('UserAdminSerializer', notes)
        self.assertIn('password', notes)
        # All three server answers a non-admin can get, because none of them is
        # a client-side refusal any more.
        self.assertIn('403', notes)
        self.assertIn('404', notes)
        self.assertIn('silently dropped', notes)

    def test_field_overrides_are_declared_only_for_caller_dependent_resources(self):
        """
        Every override has to name a registered prefix, and every field it
        patches has to be one the probe really produced — otherwise a rename in
        a serializer would leave a stale entry silently describing a field that
        no longer exists. The one exception is a field the narrow serializer
        does not have at all, which must therefore carry the whole entry.
        """
        self.assertEqual(set(mcp_catalog.FIELD_OVERRIDES), {'users', 'companies'})
        shape = set(self._field('enquiries', 'candidate_name'))
        viewsets = {prefix: viewset for prefix, viewset, _ in router.registry}
        for prefix, overrides in mcp_catalog.FIELD_OVERRIDES.items():
            probed = {f['name'] for f in mcp_catalog._serializer_fields(viewsets[prefix])}
            for name, patch in overrides.items():
                with self.subTest(prefix=prefix, field=name):
                    if name in probed:
                        self.assertTrue(set(patch) <= shape, f'{name} patches unknown keys')
                    else:
                        self.assertEqual(set(patch), shape,
                                         f'{name} is not on the probed serializer, so it must be complete')

    def test_every_field_entry_has_the_same_shape(self):
        """Consumers index into a field rather than testing for keys, so an
        overridden or appended entry must look exactly like a probed one."""
        shape = set(self._field('enquiries', 'candidate_name'))
        for prefix, resource in self.by_prefix.items():
            for field in resource['fields']:
                with self.subTest(prefix=prefix, field=field.get('name')):
                    self.assertEqual(set(field), shape)

    def test_every_custom_action_is_listed_with_a_tool_name(self):
        expected = {
            ('users', 'me'), ('users', 'change_password'), ('users', 'set_active'), ('users', 'counselors'),
            ('subscriptions', 'mine'), ('payments', 'stats'), ('documents', 'download'),
            ('documents', 'expiring_soon'), ('tasks', 'reorder'), ('appointments', 'calendar'),
            ('student-documents', 'return_docs'), ('notifications', 'mark_read'),
            ('notifications', 'mark_all_read'), ('notifications', 'unread_count'),
            ('transfers', 'accept'), ('transfers', 'reject'), ('transfers', 'inbox'), ('transfers', 'outbox'),
            ('signup-requests', 'approve'), ('signup-requests', 'reject'),
            ('approval-requests', 'pending_count'), ('approval-requests', 'my_requests'),
            ('approval-requests', 'approve'), ('approval-requests', 'reject'),
            ('api-keys', 'revoke'),
        }
        found = {(r['prefix'], a['name']) for r in self.catalog['resources'] for a in r['actions']}
        self.assertTrue(expected <= found, expected - found)
        tool_names = [a['tool_name'] for r in self.catalog['resources'] for a in r['actions']]
        self.assertEqual(len(tool_names), len(set(tool_names)), 'tool names must be unique')
        for name in tool_names:
            self.assertRegex(name, r'^[a-z][a-z0-9_]*$')

    def test_enums_roles_and_rules(self):
        enums = self.catalog['enums']
        self.assertEqual([e['value'] for e in enums['Role']], [r.value for r in Role])
        self.assertEqual({e['value'] for e in enums['Capability']}, {c.value for c in Capability})
        self.assertEqual([e['value'] for e in enums['VisaTracking.current_stage']],
                         ['Documents', 'Applied', 'Biometrics', 'Interview', 'Decision', 'Approved', 'Rejected'])
        roles = self.catalog['roles']
        self.assertEqual(roles['rank']['DEV_ADMIN'], 5)
        self.assertEqual(roles['defaults']['manageCompanies'], ['DEV_ADMIN'])
        self.assertEqual(set(roles['protected']), {'manageCompanies'})
        self.assertEqual(roles['admin_essentials'], [])
        # Sorted, because MUTABLE_FIELDS holds sets: see the note in the builder.
        self.assertEqual(self.catalog['approvals']['mutable_fields']['payment'], ['method', 'reference', 'status'])
        self.assertEqual(set(self.catalog['transfers']['transferable']),
                         {'enquiry', 'registration', 'enrollment', 'document', 'task', 'follow_up', 'visa_tracking'})
        self.assertIn('VisaTracking.passport_no', self.catalog['encrypted_fields'])
        self.assertEqual(self.catalog['conventions']['pagination']['max_page_size'], 200)

    def test_standalone_endpoints(self):
        paths = {e['path'] for e in self.catalog['standalone_endpoints']}
        for p in ('auth/login/', 'auth/refresh/', 'auth/logout/', 'role-permissions/', 'role-permissions/mine/',
                  'analytics/overview/', 'analytics/funnel/', 'analytics/revenue/', 'analytics/branches/',
                  'analytics/visa-pipeline/', 'analytics/sources/', 'health/'):
            self.assertIn(p, paths)

    def test_catalog_is_json_serialisable(self):
        json.dumps(self.catalog)

    def test_markdown_render_lists_every_tool(self):
        md = mcp_catalog.render_tools_markdown(self.catalog)
        self.assertIn('| `list_enquiries` |', md)
        self.assertIn('| `download_document` |', md)

    def test_markdown_omits_tools_the_viewset_cannot_route(self):
        md = mcp_catalog.render_tools_markdown(self.catalog)
        self.assertIn('| `list_api_keys` |', md)
        # api-keys/ has no detail route, so there is no such tool to advertise,
        # and POST is unusable from a tool (see test_api_keys_cannot_be_created).
        self.assertNotIn('get_api_key', md)
        self.assertNotIn('create_api_key', md)
        # notifications/ is read-only: reads yes, writes no.
        self.assertIn('| `get_notification` |', md)
        self.assertNotIn('create_notification', md)
        self.assertNotIn('delete_notification', md)


class CatalogFreshnessTests(SimpleTestCase):
    def test_committed_catalog_matches_code(self):
        self.assertTrue(CATALOG_PATH.exists(), 'Run: python manage.py export_mcp_catalog')
        committed = json.loads(CATALOG_PATH.read_text(encoding='utf-8'))
        current = mcp_catalog.build_catalog()
        committed.pop('generated_at', None)
        current.pop('generated_at', None)
        self.assertEqual(
            committed, current,
            'mcp_server/catalog.json is stale. Run: python manage.py export_mcp_catalog',
        )

    def test_committed_tools_doc_matches_the_renderer(self):
        """
        docs/mcp/tools.md is generated (`export_mcp_catalog --docs`) and read by
        people, not by code, so nothing else would ever notice it going stale.
        """
        self.assertTrue(
            TOOLS_DOC_PATH.exists(),
            'Run: python manage.py export_mcp_catalog --docs ../docs/mcp/tools.md',
        )
        committed = _without_generated_at(TOOLS_DOC_PATH.read_text(encoding='utf-8'))
        current = _without_generated_at(mcp_catalog.render_tools_markdown(mcp_catalog.build_catalog()))
        self.assertEqual(
            committed, current,
            'docs/mcp/tools.md is stale. Run: python manage.py export_mcp_catalog --docs ../docs/mcp/tools.md',
        )
