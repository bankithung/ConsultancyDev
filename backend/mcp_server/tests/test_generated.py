"""
The generated CRUD and action tools, exercised end to end against the real
viewsets: what the generator emits, what it refuses to send, and what each
role actually sees.
"""

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError

from core.models import ApiKey, Enquiry, Role, Task
from mcp_server.config import Settings
from mcp_server.server import ServerState
from mcp_server.testing import DjangoTestTransport
from mcp_server.tools.generated import register_generated_tools, validate_payload

from .base import CATALOG, McpTestCase

User = get_user_model()

# A tab and a newline: whitespace that is not a space, spelled out so the
# literal survives an editor that trims trailing whitespace.
BLANKS_TAB_NEWLINE = chr(9) + chr(10)


def _expected_names(catalog, read_only=False):
    """Every tool name the catalog says the generator owes, from `verbs`."""
    names = set()
    for r in catalog.raw['resources']:
        for name in catalog.tool_names_for(r):
            if read_only and name.startswith(('create_', 'update_', 'delete_')):
                continue
            names.add(name)
        for action in r['actions']:
            if action['skip_generated'] or (read_only and action['method'] != 'GET'):
                continue
            names.add(action['tool_name'])
    return names


def _generated_server(read_only=False):
    """Just the generated tools, with nothing else registered over them."""
    mcp = FastMCP(name='generated-only')
    state = ServerState(
        settings=Settings(api_url='http://testserver/api/', api_key='cdk_x', read_only=read_only),
        catalog=CATALOG, transport=DjangoTestTransport(),
    )
    register_generated_tools(mcp, state)
    return mcp


class ValidatePayloadTests(SimpleTestCase):
    """Pure functions over the catalog: no database, no server."""

    def test_unknown_field_is_rejected_with_valid_names(self):
        with self.assertRaises(ToolError) as ctx:
            validate_payload(CATALOG, 'enquiries', {'candidate': 'x'}, partial=False)
        message = str(ctx.exception)
        self.assertIn('candidate', message)
        self.assertIn('candidate_name', message)

    def test_missing_required_is_rejected_on_create_only(self):
        with self.assertRaises(ToolError) as ctx:
            validate_payload(CATALOG, 'enquiries', {'candidate_name': 'x'}, partial=False)
        self.assertIn('mobile', str(ctx.exception))
        cleaned = validate_payload(CATALOG, 'enquiries', {'candidate_name': 'x'}, partial=True)
        self.assertEqual(cleaned, {'candidate_name': 'x'})

    def test_read_only_fields_are_stripped_and_reported(self):
        cleaned = validate_payload(CATALOG, 'enquiries', {'candidate_name': 'x', 'company': 9}, partial=True)
        self.assertNotIn('company', cleaned)
        self.assertEqual(cleaned['_stripped'], ['company'])

    def test_a_blank_required_write_only_field_counts_as_missing(self):
        """
        `password` is required so create_user cannot make an account nobody
        can log into. Presence alone does not achieve that: the API declares
        the field allow_blank and falls back to set_unusable_password() for
        anything falsy, so "" would produce exactly the record the requirement
        exists to prevent.
        """
        for blank in ('', '   ', BLANKS_TAB_NEWLINE):
            with self.subTest(password=repr(blank)):
                with self.assertRaises(ToolError) as ctx:
                    validate_payload(CATALOG, 'users', {'username': 'x', 'password': blank}, partial=False)
                message = str(ctx.exception)
                self.assertIn('Missing required field', message)
                self.assertIn('password', message)
                self.assertIn('blank string', message)

    def test_only_write_only_strings_are_judged_on_their_value(self):
        """
        Narrow on purpose. A blank on an ordinary required field is the API's
        business — it answers 400 with its own message, which is more accurate
        than anything guessed here — and the rule is create-only, so an update
        is untouched.
        """
        cleaned = validate_payload(CATALOG, 'users',
                                   {'username': '', 'password': 'Real!2026xyz'}, partial=False)
        self.assertEqual(cleaned['username'], '')
        self.assertEqual(validate_payload(CATALOG, 'users', {'password': ''}, partial=True),
                         {'password': ''})

    def test_a_non_object_payload_is_refused(self):
        with self.assertRaises(ToolError) as ctx:
            validate_payload(CATALOG, 'enquiries', ['candidate_name'], partial=True)
        self.assertIn('JSON object', str(ctx.exception))


class GeneratedRegistrationTests(SimpleTestCase):
    """What the generator emits, judged against the catalog rather than a list."""

    def test_names_are_exactly_the_catalog_verbs_and_actions(self):
        names = {t.name for t in _generated_server()._tool_manager.list_tools()}
        self.assertEqual(names, _expected_names(CATALOG))

    def test_names_account_for_every_name_the_catalog_publishes(self):
        """
        Catalog.all_tool_names() is what the resources and the docs advertise.
        The generator owes all of it except the actions flagged
        skip_generated, which another module implements by hand.
        """
        names = {t.name for t in _generated_server()._tool_manager.list_tools()}
        published = set(CATALOG.all_tool_names())
        hand_written = {a['tool_name'] for r in CATALOG.raw['resources']
                        for a in r['actions'] if a['skip_generated']}
        self.assertEqual(hand_written, {'download_document'})
        self.assertEqual(names, published - hand_written)

    def test_read_only_mode_emits_only_reads(self):
        names = {t.name for t in _generated_server(read_only=True)._tool_manager.list_tools()}
        self.assertEqual(names, _expected_names(CATALOG, read_only=True))
        self.assertFalse({n for n in names if n.startswith(('create_', 'update_', 'delete_'))})
        self.assertIn('list_enquiries', names)
        self.assertIn('transfer_inbox', names)
        self.assertNotIn('accept_transfer', names)

    def test_routes_the_viewsets_cannot_serve_get_no_tool(self):
        names = {t.name for t in _generated_server()._tool_manager.list_tools()}
        # api-keys/ lists but has no detail route, and its POST is unusable
        # from a tool: the probed serializer is read-only throughout, and the
        # viewset refuses any api-keys call made with API-key credentials.
        self.assertIn('list_api_keys', names)
        self.assertNotIn('get_api_key', names)
        self.assertNotIn('create_api_key', names)
        self.assertNotIn('delete_api_key', names)
        # installments/ routes POST, but `enrollment` is read-only so it 409s.
        self.assertIn('update_installment', names)
        self.assertNotIn('create_installment', names)
        # notifications/ and plans/ are ReadOnlyModelViewSets.
        self.assertNotIn('create_notification', names)
        self.assertNotIn('create_plan', names)
        # documents/{id}/download/ is flagged skip_generated: it streams bytes.
        self.assertNotIn('download_document', names)

    def test_every_tool_carries_annotations_that_match_its_verb(self):
        for tool in _generated_server()._tool_manager.list_tools():
            with self.subTest(tool=tool.name):
                self.assertIsNotNone(tool.annotations)
                if tool.name.startswith(('list_', 'get_')):
                    self.assertIs(tool.annotations.readOnlyHint, True)
                if tool.name.startswith(('create_', 'update_', 'delete_')):
                    self.assertIs(tool.annotations.readOnlyHint, False)
                self.assertTrue(tool.description, 'every tool needs a description')
        by_name = {t.name: t for t in _generated_server()._tool_manager.list_tools()}
        self.assertIs(by_name['delete_enquiry'].annotations.destructiveHint, True)
        self.assertIs(by_name['update_enquiry'].annotations.idempotentHint, True)
        self.assertIs(by_name['revoke_api_key'].annotations.destructiveHint, True)
        self.assertIs(by_name['transfer_inbox'].annotations.readOnlyHint, True)

    def test_action_annotations_come_from_the_catalog_not_the_name(self):
        """
        set_user_active reads as a harmless toggle and revokes every token and
        API key the target holds, so the catalog declares what an action does
        and the name heuristic is only the fallback.
        """
        by_name = {t.name: t for t in _generated_server()._tool_manager.list_tools()}
        self.assertIs(by_name['set_user_active'].annotations.destructiveHint, True)
        self.assertIs(by_name['set_user_active'].annotations.idempotentHint, True)
        self.assertIs(by_name['reorder_tasks'].annotations.destructiveHint, False)
        self.assertIs(by_name['mark_notification_read'].annotations.idempotentHint, True)
        self.assertIs(by_name['accept_transfer'].annotations.destructiveHint, False)
        self.assertIs(by_name['reject_transfer'].annotations.destructiveHint, True)

    def test_schemas_expose_the_documented_parameters_and_nothing_else(self):
        """
        The closure state must not reach the wire. FastMCP builds the input
        schema from the signature, so a `_r=r` default argument would either
        be rejected outright or advertised to the model as a parameter.
        """
        by_name = {t.name: t for t in _generated_server()._tool_manager.list_tools()}
        expected = {
            'list_enquiries': {'filters', 'search', 'ordering', 'page', 'page_size', 'all_pages'},
            'get_enquiry': {'id'},
            'create_enquiry': {'data'},
            'update_enquiry': {'id', 'data'},
            'delete_enquiry': {'id', 'confirm'},
            'accept_transfer': {'id'},
            'set_user_active': {'id', 'body'},
            'reorder_tasks': {'body'},
            'appointments_calendar': {'query', 'page', 'page_size', 'all_pages'},
            'transfer_inbox': {'page', 'page_size', 'all_pages'},
            'unread_notification_count': set(),
        }
        for name, params in expected.items():
            with self.subTest(tool=name):
                self.assertEqual(set(by_name[name].parameters.get('properties', {})), params)
        for tool in by_name.values():
            for param in tool.parameters.get('properties', {}):
                self.assertFalse(param.startswith('_'), f'{tool.name} leaks {param}')
                self.assertNotIn('ctx', param)

    def test_descriptions_carry_the_field_and_filter_knowledge(self):
        by_name = {t.name: t for t in _generated_server()._tool_manager.list_tools()}
        create = by_name['create_enquiry'].description
        self.assertIn('candidate_name', create)
        self.assertIn('mobile:string*', create)
        self.assertIn('New|Contacted|Converted|Closed', create)
        listing = by_name['list_enquiries'].description
        self.assertIn('status[](New|Contacted|Converted|Closed)', listing)
        self.assertIn('owner[]', listing)
        self.assertIn('candidate_name', listing)
        self.assertIn('create_enrollment', by_name['update_installment'].description)
        self.assertIn('month', by_name['appointments_calendar'].description)


class GeneratedCrudTests(McpTestCase):
    def test_list_is_scoped_per_role(self):
        self.assertEqual({r['candidate_name'] for r in self.call('list_enquiries', self.emp_k1)['results']},
                         {'kohima-one'})
        self.assertEqual({r['candidate_name'] for r in self.call('list_enquiries', self.mgr_k)['results']},
                         {'kohima-one', 'kohima-two'})
        self.assertEqual({r['candidate_name'] for r in self.call('list_enquiries', self.head)['results']},
                         {'kohima-one', 'kohima-two'})
        self.assertEqual(self.call('list_enquiries', self.admin)['count'], 3)
        self.assertEqual(self.call('list_enquiries', self.dev)['count'], 4)
        self.assertEqual(self.call('list_enquiries', self.rival_admin)['count'], 1)

    def test_list_filters_search_ordering_and_all_pages(self):
        Enquiry.objects.filter(pk=self.enq_k1.pk).update(status='Closed')
        closed = self.call('list_enquiries', self.admin, filters={'status': ['Closed']})
        self.assertEqual(closed['count'], 1)
        found = self.call('list_enquiries', self.admin, search='dimapur')
        self.assertEqual(found['count'], 1)
        ordered = self.call('list_enquiries', self.admin, ordering='school_name', page_size=1)
        self.assertEqual(len(ordered['results']), 1)
        rows = self.call('list_enquiries', self.admin, page_size=1, all_pages=True)
        self.assertEqual(len(rows), 3)

    def test_unknown_filter_param_is_rejected(self):
        text = self.call_raises('list_enquiries', self.admin, filters={'colour': 'red'})
        self.assertIn('colour', text)
        self.assertIn('status', text)

    def test_get_create_update_delete_round_trip(self):
        created = self.call('create_enquiry', self.mgr_k, data={
            'school_name': 'S', 'stream': 'Science', 'candidate_name': 'new-one', 'course_interested': 'MBBS',
            'mobile': '9111111111', 'email': 'new@example.com', 'father_name': 'F', 'mother_name': 'M',
            'permanent_address': 'A',
        })
        self.assertEqual(created['owner'], self.mgr_k.pk)
        fetched = self.call('get_enquiry', self.mgr_k, id=created['id'])
        self.assertEqual(fetched['candidate_name'], 'new-one')
        updated = self.call('update_enquiry', self.mgr_k, id=created['id'], data={'status': 'Contacted'})
        self.assertEqual(updated['status'], 'Contacted')
        text = self.call_raises('delete_enquiry', self.mgr_k, id=created['id'])
        self.assertIn('confirm', text)
        self.assertTrue(Enquiry.objects.filter(pk=created['id']).exists())
        result = self.call('delete_enquiry', self.mgr_k, id=created['id'], confirm=True)
        self.assertEqual(result['deleted'], created['id'])
        self.assertFalse(Enquiry.objects.filter(pk=created['id']).exists())

    def test_create_validates_before_it_reaches_the_api(self):
        text = self.call_raises('create_enquiry', self.mgr_k, data={'candidate': 'x'})
        self.assertIn('Unknown field', text)
        self.assertIn('candidate_name', text)
        text = self.call_raises('create_enquiry', self.mgr_k, data={'candidate_name': 'x'})
        self.assertIn('Missing required field', text)
        self.assertIn('mobile', text)

    def test_read_only_fields_are_dropped_rather_than_sent(self):
        created = self.call('create_enquiry', self.emp_k1, data={
            'school_name': 'S', 'stream': 'Science', 'candidate_name': 'stamped', 'course_interested': 'MBBS',
            'mobile': '9222222222', 'email': 'stamped@example.com', 'father_name': 'F', 'mother_name': 'M',
            'permanent_address': 'A', 'company': self.rival.pk, 'owner': self.rival_admin.pk,
        })
        self.assertEqual(created['company'], self.company.pk)
        self.assertEqual(created['owner'], self.emp_k1.pk)

    def test_an_update_of_only_read_only_fields_is_refused(self):
        text = self.call_raises('update_enquiry', self.mgr_k, id=self.enq_k1.pk, data={'company': self.rival.pk})
        self.assertIn('read-only', text)

    def test_get_outside_scope_is_a_404_with_a_scope_hint(self):
        text = self.call_raises('get_enquiry', self.emp_k1, id=self.enq_d1.pk)
        self.assertIn('404', text)
        self.assertIn('scope', text)

    def test_employee_delete_is_refused_with_approval_hint(self):
        text = self.call_raises('delete_enquiry', self.emp_k1, id=self.enq_k1.pk, confirm=True)
        self.assertIn('create_approval_request', text)
        self.assertTrue(Enquiry.objects.filter(pk=self.enq_k1.pk).exists())

    def test_create_registration_creates_payment_and_reference(self):
        reg = self.call('create_registration', self.emp_k1, data={
            'student_name': 'Reg One', 'mobile': '9', 'email': 'r@example.com', 'father_name': 'F', 'mother_name': 'M',
            'permanent_address': 'A', 'registration_fee': '1500.00', 'payment_status': 'Paid', 'enquiry': self.enq_k1.pk,
        })
        self.assertTrue(reg['registration_no'].startswith('REG-'))
        payments = self.call('list_payments', self.emp_k1)
        self.assertEqual(payments['count'], 1)
        self.assertEqual(payments['results'][0]['status'], 'Success')

    def test_read_only_viewsets_have_no_write_tools(self):
        tools = self.tool_names(self.admin)
        self.assertNotIn('create_plan', tools)
        self.assertNotIn('create_notification', tools)
        self.assertIn('list_plans', tools)


class GeneratedActionTests(McpTestCase):
    def test_transfer_inbox_accept_flow(self):
        transfer = self.call('create_transfer', self.emp_k1, data={
            'entity_type': 'enquiry', 'entity_id': self.enq_k1.pk, 'to_user': self.emp_k2.pk, 'note': 'take over',
        })
        self.assertEqual(transfer['status'], 'PENDING')
        inbox = self.call('transfer_inbox', self.emp_k2)
        self.assertEqual(inbox['count'], 1)
        accepted = self.call('accept_transfer', self.emp_k2, id=transfer['id'])
        self.assertEqual(accepted['status'], 'ACCEPTED')
        self.assertEqual(self.call('list_enquiries', self.emp_k1)['count'], 0)
        self.assertEqual(self.call('list_enquiries', self.emp_k2)['count'], 2)

    def test_reorder_tasks_and_calendar(self):
        t1 = self.call('create_task', self.mgr_k,
                       data={'title': 'a', 'assigned_to': self.mgr_k.pk, 'due_date': '2026-09-10T10:00:00Z'})
        t2 = self.call('create_task', self.mgr_k,
                       data={'title': 'b', 'assigned_to': self.mgr_k.pk, 'due_date': '2026-09-11T10:00:00Z'})
        result = self.call('reorder_tasks', self.mgr_k, body={'ids': [t2['id'], t1['id']], 'status': 'Done'})
        self.assertEqual(result['reordered'], 2)
        self.assertIsNotNone(Task.objects.get(pk=t1['id']).completed_at)
        self.call('create_appointment', self.mgr_k, data={
            'student_name': 'S', 'counselor': self.mgr_k.pk, 'date': '2026-09-15T09:00:00Z', 'type': 'In-Person',
        })
        rows = self.call('appointments_calendar', self.mgr_k, query={'month': 9, 'year': 2026})
        self.assertEqual(len(rows), 1)

    def test_notification_and_approval_counts(self):
        self.assertEqual(self.call('unread_notification_count', self.admin)['count'], 0)
        self.assertEqual(self.call('approval_pending_count', self.admin)['count'], 0)

    def test_detail_action_without_a_body_posts_nothing(self):
        transfer = self.call('create_transfer', self.emp_k1, data={
            'entity_type': 'enquiry', 'entity_id': self.enq_k1.pk, 'to_user': self.emp_k2.pk, 'note': 'no',
        })
        rejected = self.call('reject_transfer', self.emp_k2, id=transfer['id'])
        self.assertEqual(rejected['status'], 'REJECTED')

    def test_set_user_active_needs_manage_users(self):
        text = self.call_raises('set_user_active', self.mgr_k, id=self.emp_k1.pk, body={'is_active': False})
        self.assertIn('403', text)
        result = self.call('set_user_active', self.admin, id=self.emp_k1.pk, body={'is_active': False})
        self.assertFalse(result['is_active_employee'])

    def test_revoke_api_key_is_refused_for_key_auth(self):
        key, _ = ApiKey.issue(self.admin, 'other')
        text = self.call_raises('revoke_api_key', self.admin, id=key.pk)
        self.assertIn('403', text)


class CallerDependentSerializerTests(McpTestCase):
    """
    users/ and companies/ pick their serializer by WHO is asking, so the
    catalog records the ADMIN shape (core.mcp_catalog.FIELD_OVERRIDES) and lets
    the API judge the caller. These tests pin both halves: the writes an admin
    can now make, and what the API actually answers when someone else tries.

    Recording the narrow anonymous shape instead did not merely under-describe
    the API. validate_payload is a hard client-side gate, so no role or branch
    change was possible through any tool, and create_user dropped `password`
    as an unknown field and then succeeded without it.
    """

    NEW_PASSWORD = 'Hired!2026xyz'

    def test_create_user_with_password_role_and_branch_makes_a_usable_account(self):
        created = self.call('create_user', self.admin, data={
            'username': 'newhire', 'email': 'newhire@example.com', 'first_name': 'New',
            'role': 'BRANCH_MANAGER', 'branch': self.kohima.pk, 'password': self.NEW_PASSWORD,
        })
        self.assertEqual(created['role'], 'BRANCH_MANAGER')
        self.assertEqual(created['branch'], self.kohima.pk)
        self.assertNotIn('password', created, 'the field is write-only')

        # The password has to WORK, not merely be accepted: the defect this
        # replaces was an account the API reported as created and nobody could
        # log into.
        stored = User.objects.get(pk=created['id'])
        self.assertTrue(stored.has_usable_password())
        self.assertEqual(stored.company_id, self.company.pk)
        response = self.client.post('/api/auth/login/',
                                    {'username': 'newhire', 'password': self.NEW_PASSWORD},
                                    content_type='application/json')
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()['user']['username'], 'newhire')

    def test_create_user_without_a_password_is_refused_and_creates_nothing(self):
        """
        Stricter than the API on purpose. UserAdminSerializer.create falls back
        to set_unusable_password(), so the call would 201 with a seat consumed
        by an account nobody can ever use.
        """
        before = User.objects.count()
        text = self.call_raises('create_user', self.admin, data={
            'username': 'nopass', 'email': 'nopass@example.com',
            'role': 'EMPLOYEE', 'branch': self.kohima.pk,
        })
        self.assertIn('Missing required field', text)
        self.assertIn('password', text)
        self.assertFalse(User.objects.filter(username='nopass').exists())
        self.assertEqual(User.objects.count(), before)

    def test_create_user_with_a_blank_password_is_refused_and_creates_nothing(self):
        """
        The same defect as an absent password, through an input an AI client
        told "password is required" with nothing to put there is quite likely
        to send.
        """
        for index, blank in enumerate(('', '   ', BLANKS_TAB_NEWLINE)):
            with self.subTest(password=repr(blank)):
                before = User.objects.count()
                text = self.call_raises('create_user', self.admin, data={
                    'username': f'blank{index}', 'email': f'blank{index}@example.com',
                    'role': 'EMPLOYEE', 'branch': self.kohima.pk, 'password': blank,
                })
                self.assertIn('Missing required field', text)
                self.assertIn('password', text)
                self.assertIn('blank string', text)
                self.assertFalse(User.objects.filter(username=f'blank{index}').exists())
                self.assertEqual(User.objects.count(), before)

    def test_update_user_role_and_branch_work_for_a_company_admin(self):
        updated = self.call('update_user', self.admin, id=self.emp_k1.pk,
                            data={'role': 'BRANCH_MANAGER', 'branch': self.dimapur.pk})
        self.assertEqual(updated['role'], 'BRANCH_MANAGER')
        self.assertEqual(updated['branch'], self.dimapur.pk)
        self.emp_k1.refresh_from_db()
        self.assertEqual(self.emp_k1.role, Role.BRANCH_MANAGER)
        self.assertEqual(self.emp_k1.branch_id, self.dimapur.pk)

    def test_a_role_change_a_caller_may_not_make_is_refused_by_the_api(self):
        """
        The refusal is the server's, not the tool's — which is the whole point
        of recording the admin shape. It arrives in three different ways, so
        all three are pinned rather than assumed:

        a manager who CAN see the row but lacks manageUsers is refused by
        perform_update with 403; an employee cannot see anyone else's row at
        all, so UserViewSet.get_queryset makes it a 404 before authorization is
        even reached; and on their OWN row the request succeeds with `role`
        silently dropped by UserSerializer, which is why the resource note
        tells a caller to read the answer back.
        """
        text = self.call_raises('update_user', self.mgr_k, id=self.emp_k1.pk,
                                data={'role': 'BRANCH_MANAGER'})
        self.assertIn('403', text)
        self.assertIn('your own profile', text)

        text = self.call_raises('update_user', self.emp_k1, id=self.emp_k2.pk,
                                data={'role': 'BRANCH_MANAGER'})
        self.assertIn('404', text)

        on_self = self.call('update_user', self.emp_k1, id=self.emp_k1.pk,
                            data={'role': 'COMPANY_ADMIN', 'phone': '9123456780'})
        self.assertEqual(on_self['role'], 'EMPLOYEE')
        self.assertEqual(on_self['phone'], '9123456780')

        for user in (self.emp_k1, self.emp_k2):
            user.refresh_from_db()
            self.assertEqual(user.role, Role.EMPLOYEE)

    def test_update_company_is_active_works_for_a_dev_admin(self):
        updated = self.call('update_company', self.dev, id=self.company.pk, data={'is_active': False})
        self.assertIs(updated['is_active'], False)
        self.company.refresh_from_db()
        self.assertFalse(self.company.is_active)

    def test_update_company_is_active_is_dropped_for_a_company_admin(self):
        """
        Not a 403. CompanyProfileSerializer lists is_active in
        read_only_fields, and DRF drops a read-only field silently, so the call
        answers 200 with the flag unchanged. The tool returns exactly what the
        API returned, so the unchanged value is visible in the answer — which
        is what the resource note tells a caller to read back.
        """
        updated = self.call('update_company', self.admin, id=self.company.pk,
                            data={'is_active': False, 'phone': '9999999999'})
        self.assertIs(updated['is_active'], True)
        self.assertEqual(updated['phone'], '9999999999')
        self.company.refresh_from_db()
        self.assertTrue(self.company.is_active)

    def test_the_descriptions_carry_the_admin_shape_and_the_caller_rule(self):
        tools = self.tool_names(self.admin)
        create_user = tools['create_user'].description
        self.assertIn('password:string*', create_user)
        self.assertIn('role:choice[', create_user)
        self.assertIn('branch:id(id of Branch)', create_user)
        self.assertIn('403', create_user)
        update_company = tools['update_company'].description
        self.assertIn('is_active:boolean', update_company)
        self.assertIn('DEV_ADMIN', update_company)
