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
        self.assertEqual(roles['protected']['manageUsers']['floor'], 'COMPANY_ADMIN')
        self.assertEqual(roles['admin_essentials'], ['manageSettings', 'manageUsers'])
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
