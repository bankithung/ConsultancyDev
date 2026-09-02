"""
The analytics, identity and permission-matrix tools.

Every assertion here runs through the real viewsets, so the role gates being
checked are the API's own rather than a restatement of them: an employee is
refused `analytics_funnel` because `IsManagerOrAbove` refuses them, and the
permission grid answers because `CanManageSettings` let the caller through.
"""

from decimal import Decimal

from django.utils import timezone
from mcp.shared.memory import create_connected_server_and_client_session

from core.models import Agent, Commission, Payment
from mcp_server.config import Settings
from mcp_server.server import build_server

from .base import CATALOG, McpTestCase, _run

ANALYTICS_TOOLS = (
    'analytics_overview', 'analytics_funnel', 'analytics_revenue', 'analytics_branches',
    'analytics_visa_pipeline', 'analytics_sources', 'health',
)
MANAGER_ONLY = ('analytics_funnel', 'analytics_revenue', 'analytics_branches', 'analytics_sources')


def month_start_back(now, back):
    """
    `now` moved back whole calendar months, on the 15th.

    Whole months rather than 30-day steps, for the same reason the revenue
    view steps that way: three 30-day hops from the 31st land twice in the
    same bucket. The 15th exists in every month and sits far enough from
    either boundary that a timezone shift cannot move it into a neighbour.
    """
    year, month = now.year, now.month - back
    while month <= 0:
        month += 12
        year -= 1
    return now.replace(year=year, month=month, day=15, hour=12, minute=0, second=0, microsecond=0)


class _DeadTransport:
    """A backend that cannot be reached, so a tool that needs one must say so."""

    base_url = 'http://unreachable.invalid/api/'

    def request(self, *args, **kwargs):
        raise OSError('backend is down')


class AnalyticsToolTests(McpTestCase):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        # One successful payment in each of the last three calendar months.
        # The revenue series is built from the payments that exist, not padded
        # to the requested width, so a window is only observable if it has rows.
        now = timezone.now()
        cls.payments = [
            Payment.objects.create(
                company=cls.company, branch=cls.kohima, created_by=cls.emp_k1, owner=cls.emp_k1,
                student_name='kohima-one', amount=Decimal('1000.00'), date=month_start_back(now, back),
                type='Registration', status=Payment.Status.SUCCESS,
            )
            for back in range(3)
        ]

    def test_overview_is_open_to_every_role_and_scoped_to_the_caller(self):
        admin = self.call('analytics_overview', self.admin)
        self.assertEqual(admin['enquiries'], 3)
        self.assertEqual(admin['conversionRate'], 0.0)
        self.assertEqual(self.call('analytics_overview', self.emp_k1)['enquiries'], 1)
        self.assertEqual(self.call('analytics_overview', self.mgr_k)['enquiries'], 2)
        self.assertEqual(self.call('analytics_overview', self.rival_admin)['enquiries'], 1)

    def test_manager_only_analytics_refuse_an_employee(self):
        for name in MANAGER_ONLY:
            with self.subTest(tool=name):
                self.assertIn('403', self.call_raises(name, self.emp_k1))

    def test_open_analytics_answer_an_employee(self):
        self.assertIn('enquiries', self.call('analytics_overview', self.emp_k1))
        self.assertIn('pipeline', self.call('analytics_visa_pipeline', self.emp_k1))

    def test_funnel_reports_the_stages_in_order(self):
        funnel = self.call('analytics_funnel', self.mgr_k)
        self.assertEqual([s['stage'] for s in funnel['stages']],
                         ['Enquiries', 'Registrations', 'Enrollments', 'Visas approved'])
        self.assertEqual(funnel['stages'][0]['count'], 2)
        self.assertEqual(funnel['dropOff']['enquiryToRegistration'], 2)

    def test_revenue_series_covers_the_requested_window(self):
        revenue = self.call('analytics_revenue', self.admin, months=3)
        self.assertEqual(len(revenue['series']), 3)
        self.assertEqual({row['transactions'] for row in revenue['series']}, {1})
        self.assertEqual(len(self.call('analytics_revenue', self.admin, months=1)['series']), 1)

    def test_revenue_months_is_refused_outside_one_to_thirty_six(self):
        for bad in (0, -1, 37):
            with self.subTest(months=bad):
                self.assertIn('between 1 and 36', self.call_raises('analytics_revenue', self.admin, months=bad))

    def test_branches_is_a_bare_array_scoped_to_the_caller(self):
        branches = self.call('analytics_branches', self.admin)
        self.assertIsInstance(branches, list)
        self.assertEqual({b['name'] for b in branches}, {'Head Office', 'Kohima', 'Dimapur'})
        kohima = next(b for b in branches if b['name'] == 'Kohima')
        self.assertEqual(kohima['enquiries'], 2)
        self.assertEqual({b['name'] for b in self.call('analytics_branches', self.mgr_k)}, {'Kohima'})

    def test_sources_is_a_bare_array_of_streams(self):
        sources = self.call('analytics_sources', self.admin)
        self.assertIsInstance(sources, list)
        self.assertEqual(sources[0]['source'], 'Science')
        self.assertEqual(sources[0]['total'], 3)
        self.assertEqual(sources[0]['converted'], 0)

    def test_visa_pipeline_lists_every_stage_even_when_empty(self):
        pipeline = self.call('analytics_visa_pipeline', self.emp_k1)
        self.assertEqual([row['stage'] for row in pipeline['pipeline']],
                         ['Documents', 'Applied', 'Biometrics', 'Interview', 'Decision', 'Approved', 'Rejected'])
        self.assertEqual(pipeline['total'], 0)

    def test_health_reports_ok(self):
        self.assertEqual(self.call('health', self.admin)['status'], 'ok')

    def test_every_analytics_tool_is_registered_and_read_only(self):
        tools = self.tool_names(self.admin)
        for name in ANALYTICS_TOOLS:
            with self.subTest(tool=name):
                self.assertIn(name, tools)
                self.assertIs(tools[name].annotations.readOnlyHint, True)
                self.assertIn(name, self.tool_names(self.admin, read_only=True))

    def test_analytics_descriptions_warn_about_the_cache(self):
        tools = self.tool_names(self.admin)
        self.assertIn('Cached', tools['analytics_overview'].description)


class IdentityToolTests(McpTestCase):
    def test_whoami_reports_identity_capabilities_and_visibility(self):
        me = self.call('whoami', self.emp_k1)
        self.assertEqual(me['user']['username'], 'emp_k1')
        self.assertEqual(me['role'], 'EMPLOYEE')
        self.assertEqual(me['company'], 'Acme Consultancy')
        self.assertEqual(me['branch'], 'Kohima')
        self.assertIn('records they OWN', me['visibility'])
        self.assertNotIn('deleteRecords', me['capabilities'])
        self.assertTrue(me['auth'].startswith('api key cdk_'))
        self.assertIs(me['read_only_mode'], False)

    def test_whoami_does_not_collide_with_the_generated_get_me(self):
        """
        `get_me` is the users/me/ action the generator already registers.
        `whoami` is a different answer — identity plus live capabilities plus
        scope — and must not be registered a second time under that name.
        """
        tools = self.tool_names(self.admin)
        self.assertIn('get_me', tools)
        self.assertIn('whoami', tools)

    def test_my_capabilities_reflects_the_callers_role(self):
        caps = self.call('my_capabilities', self.emp_k1)
        self.assertEqual(caps['role'], 'EMPLOYEE')
        self.assertNotIn('deleteRecords', caps['capabilities'])
        self.assertIn('manageCounselors', caps['capabilities'])
        self.assertIn('deleteRecords', self.call('my_capabilities', self.mgr_k)['capabilities'])
        self.assertIn('manageSettings', self.call('my_capabilities', self.admin)['capabilities'])


class ExplainPermissionTests(McpTestCase):
    def _call_on(self, server, name, **arguments):
        async def go():
            async with create_connected_server_and_client_session(server) as session:
                return await session.call_tool(name, arguments)
        return _run(go())

    def _offline_server(self, user):
        settings = Settings(api_url='http://unreachable.invalid/api/', api_key=self.key_for(user))
        return build_server(settings, transport=_DeadTransport(), catalog=CATALOG)

    def test_delete_defaults_to_the_callers_role_and_names_the_floor(self):
        answer = self.call('explain_permission', self.emp_k1, action='delete', resource='enquiries')
        self.assertEqual(answer['resource'], 'enquiries')
        self.assertEqual(answer['action'], 'delete')
        self.assertEqual(answer['role'], 'EMPLOYEE')
        self.assertFalse(answer['allowed_by_default'])
        self.assertEqual(answer['capability'], 'deleteRecords')
        self.assertEqual(answer['floor'], 'BRANCH_MANAGER')
        self.assertIn('audit trail', answer['reason'])
        self.assertIn('create_approval_request', ' '.join(answer['notes']))

    def test_a_delete_clears_the_write_gate_as_well_as_the_delete_gate(self):
        """
        DELETE is not a safe method, so a viewset's write permission class runs
        before `deleteRecords` is ever consulted. `commissions` and `agents` are
        gated on `manageCommissions`, which by default stops at company admin —
        a head manager holds `deleteRecords` and is still refused.
        """
        for resource in ('commissions', 'agents'):
            with self.subTest(resource=resource):
                head = self.call('explain_permission', self.emp_k1, action='delete', resource=resource,
                                 role='HEAD_MANAGER')
                self.assertFalse(head['allowed_by_default'])
                self.assertIn('manageCommissions', head['capability'])
                self.assertIn('deleteRecords', head['capability'])
                self.assertEqual(head['floor'], 'BRANCH_MANAGER')
                self.assertTrue(any('manageCommissions' in note and 'narrower' in note for note in head['notes']),
                                f'notes must name the narrower gate: {head["notes"]}')

                for role in ('BRANCH_MANAGER', 'EMPLOYEE'):
                    self.assertFalse(
                        self.call('explain_permission', self.emp_k1, action='delete', resource=resource,
                                  role=role)['allowed_by_default'])
                self.assertTrue(
                    self.call('explain_permission', self.emp_k1, action='delete', resource=resource,
                              role='COMPANY_ADMIN')['allowed_by_default'])

    def test_the_delete_answer_matches_what_the_api_does(self):
        """The claim above, checked against the viewset rather than restated."""
        agent = Agent.objects.create(company=self.company, branch=self.head_office,
                                     created_by=self.admin, owner=self.admin, name='Referrer')
        commission = Commission.objects.create(company=self.company, branch=self.head_office,
                                               created_by=self.admin, owner=self.admin, agent=agent,
                                               commission_amount=Decimal('500.00'))
        self.assertTrue(self.call('my_capabilities', self.head)['capabilities'].count('deleteRecords'),
                        'the head manager must hold deleteRecords for this to prove anything')
        self.assertIn('403', self.call_raises('delete_commission', self.head, id=commission.pk, confirm=True))
        self.assertEqual(self.call('delete_commission', self.admin, id=commission.pk, confirm=True)['deleted'],
                         commission.pk)

    def test_a_delete_with_no_separate_write_gate_reports_one_capability(self):
        answer = self.call('explain_permission', self.emp_k1, action='delete', resource='enquiries',
                           role='BRANCH_MANAGER')
        self.assertEqual(answer['capability'], 'deleteRecords')
        self.assertTrue(answer['allowed_by_default'])

    def test_the_approval_route_is_only_offered_where_it_exists(self):
        """`create_approval_request` takes a fixed list of entity types; commissions is not one of them."""
        enquiries = self.call('explain_permission', self.emp_k1, action='delete', resource='enquiries')
        self.assertIn('create_approval_request', ' '.join(enquiries['notes']))
        commissions = self.call('explain_permission', self.emp_k1, action='delete', resource='commissions',
                                role='HEAD_MANAGER')
        self.assertNotIn('create_approval_request', ' '.join(commissions['notes']))

    def test_read_and_write_are_governed_by_different_capabilities(self):
        write = self.call('explain_permission', self.emp_k1, action='write', resource='commissions',
                          role='HEAD_MANAGER')
        self.assertFalse(write['allowed_by_default'])
        self.assertEqual(write['capability'], 'manageCommissions')
        self.assertEqual(write['floor'], 'HEAD_MANAGER')
        self.assertEqual(write['write_roles'], ['DEV_ADMIN', 'COMPANY_ADMIN'])

        read = self.call('explain_permission', self.emp_k1, action='read', resource='commissions',
                         role='HEAD_MANAGER')
        self.assertTrue(read['allowed_by_default'])
        self.assertEqual(read['capability'], 'viewEarnings')
        self.assertEqual(read['read_roles'], ['DEV_ADMIN', 'COMPANY_ADMIN', 'HEAD_MANAGER'])

    def test_create_and_update_follow_the_write_rule(self):
        for action in ('create', 'update', 'write'):
            with self.subTest(action=action):
                answer = self.call('explain_permission', self.emp_k1, action=action, resource='enquiries')
                self.assertTrue(answer['allowed_by_default'])
                self.assertIn('scope', ' '.join(answer['notes']))

    def test_a_resource_whose_rules_vary_by_action_carries_its_notes(self):
        """
        The catalog's read_roles/write_roles are viewset-level approximations
        for `users` and `signup_requests`; the per-action truth lives in their
        notes, so the answer is misleading without them.
        """
        users = self.call('explain_permission', self.emp_k1, action='create', resource='users',
                          role='BRANCH_MANAGER')
        self.assertTrue(any('vary BY ACTION' in note for note in users['notes']))

        signups = self.call('explain_permission', self.emp_k1, action='read', resource='signup_requests')
        self.assertTrue(any('DEV_ADMIN only' in note for note in signups['notes']))

    def test_a_platform_admin_is_allowed_everywhere(self):
        answer = self.call('explain_permission', self.dev, action='delete', resource='enquiries')
        self.assertEqual(answer['role'], 'DEV_ADMIN')
        self.assertTrue(answer['allowed_by_default'])

    def test_bad_input_is_refused_with_the_valid_values(self):
        unknown_resource = self.call_raises('explain_permission', self.emp_k1, action='read', resource='nope')
        self.assertIn('Unknown resource', unknown_resource)
        self.assertIn('enquiries', unknown_resource)

        bad_action = self.call_raises('explain_permission', self.emp_k1, action='frobnicate', resource='enquiries')
        self.assertIn('action must be one of', bad_action)

        bad_role = self.call_raises('explain_permission', self.emp_k1, action='read', resource='enquiries',
                                    role='WIZARD')
        self.assertIn('Unknown role', bad_role)
        self.assertIn('EMPLOYEE', bad_role)

    def test_answers_from_the_catalog_alone_when_the_role_is_given(self):
        """
        With `role` supplied the answer needs no API call, which is what lets
        it work while the backend is down. Without it the tool must ask who
        the caller is, and say plainly that it could not.
        """
        server = self._offline_server(self.emp_k1)
        result = self._call_on(server, 'explain_permission',
                               action='delete', resource='enquiries', role='EMPLOYEE')
        self.assertFalse(result.isError)
        self.assertEqual(self._unwrap(result)['floor'], 'BRANCH_MANAGER')

        needs_the_api = self._call_on(self._offline_server(self.emp_k1), 'explain_permission',
                                      action='delete', resource='enquiries')
        self.assertTrue(needs_the_api.isError)
        self.assertIn('Could not reach', ''.join(c.text for c in needs_the_api.content))


class RolePermissionMatrixTests(McpTestCase):
    GRANT = [{'role': 'EMPLOYEE', 'capability': 'viewAnalytics', 'allowed': True}]

    def test_the_matrix_needs_manage_settings(self):
        for user in (self.emp_k1, self.mgr_k, self.head):
            with self.subTest(role=user.role):
                self.assertIn('403', self.call_raises('get_role_permissions', user))
                self.assertIn('403', self.call_raises('update_role_permissions', user, changes=self.GRANT))
                self.assertIn('403', self.call_raises('reset_role_permissions', user, confirm=True))

    def test_a_company_admin_reads_and_changes_their_own_grid(self):
        grid = self.call('get_role_permissions', self.admin)
        self.assertEqual(grid['company_name'], 'Acme Consultancy')
        cell = grid['matrix']['EMPLOYEE']['viewAnalytics']
        self.assertFalse(cell['allowed'])
        self.assertEqual(cell['source'], 'default')

        updated = self.call('update_role_permissions', self.admin, changes=self.GRANT)
        granted = updated['matrix']['EMPLOYEE']['viewAnalytics']
        self.assertTrue(granted['allowed'])
        self.assertEqual(granted['source'], 'override')

    def test_a_granted_capability_takes_effect_on_the_api(self):
        self.assertIn('403', self.call_raises('analytics_funnel', self.emp_k1))
        self.call('update_role_permissions', self.admin, changes=self.GRANT)
        self.assertEqual(self.call('analytics_funnel', self.emp_k1)['stages'][0]['stage'], 'Enquiries')

    def test_null_restores_the_built_in_default(self):
        self.call('update_role_permissions', self.admin, changes=self.GRANT)
        restored = self.call('update_role_permissions', self.admin, changes=[
            {'role': 'EMPLOYEE', 'capability': 'viewAnalytics', 'allowed': None},
        ])
        cell = restored['matrix']['EMPLOYEE']['viewAnalytics']
        self.assertFalse(cell['allowed'])
        self.assertEqual(cell['source'], 'default')

    def test_one_refused_cell_refuses_the_whole_batch(self):
        text = self.call_raises('update_role_permissions', self.admin, changes=[
            {'role': 'EMPLOYEE', 'capability': 'viewAnalytics', 'allowed': True},
            {'role': 'EMPLOYEE', 'capability': 'manageSettings', 'allowed': True},
        ])
        self.assertIn('400', text)
        self.assertIn('cannot be granted below', text)
        self.assertFalse(
            self.call('get_role_permissions', self.admin)['matrix']['EMPLOYEE']['viewAnalytics']['allowed'],
            'the acceptable half of a refused batch must not be applied',
        )

    def test_the_platform_row_and_the_admin_essentials_are_locked(self):
        self.assertIn('not configurable', self.call_raises('update_role_permissions', self.admin, changes=[
            {'role': 'DEV_ADMIN', 'capability': 'viewAnalytics', 'allowed': False},
        ]))
        self.assertIn('cannot be taken away', self.call_raises('update_role_permissions', self.admin, changes=[
            {'role': 'COMPANY_ADMIN', 'capability': 'manageSettings', 'allowed': False},
        ]))

    def test_an_empty_batch_is_refused_before_the_api(self):
        self.assertIn('non-empty list', self.call_raises('update_role_permissions', self.admin, changes=[]))

    def test_a_malformed_cell_is_named_with_the_values_that_would_work(self):
        """
        A bad role or capability comes back from DRF as a per-index ChoiceField
        error that never lists the choices. Checking against the catalog first
        costs nothing and tells the caller what to send instead.
        """
        cases = (
            ([{'role': 'WIZARD', 'capability': 'viewAnalytics', 'allowed': True}], 'unknown role', 'BRANCH_MANAGER'),
            ([{'role': 'EMPLOYEE', 'capability': 'castSpells', 'allowed': True}], 'unknown capability', 'viewAnalytics'),
            ([{'role': 'EMPLOYEE', 'capability': 'viewAnalytics'}], 'missing allowed', 'changes[0]'),
            ([{'role': 'EMPLOYEE', 'capability': 'viewAnalytics', 'allowed': True, 'note': 'x'}],
             'unknown key', 'note'),
            ([{'role': 'EMPLOYEE', 'capability': 'viewAnalytics', 'allowed': 'yes'}],
             'must be true, false, or null', 'changes[0]'),
        )
        for changes, expected, also in cases:
            with self.subTest(changes=changes):
                text = self.call_raises('update_role_permissions', self.admin, changes=changes)
                self.assertIn(expected, text)
                self.assertIn(also, text)

    def test_the_index_of_the_bad_cell_is_reported(self):
        text = self.call_raises('update_role_permissions', self.admin, changes=[
            {'role': 'EMPLOYEE', 'capability': 'viewAnalytics', 'allowed': True},
            {'role': 'EMPLOYEE', 'capability': 'castSpells', 'allowed': True},
        ])
        self.assertIn('changes[1]', text)

    def test_reset_requires_confirm_and_then_restores_every_default(self):
        self.call('update_role_permissions', self.admin, changes=self.GRANT)
        self.assertIn('confirm', self.call_raises('reset_role_permissions', self.admin))
        self.assertTrue(
            self.call('get_role_permissions', self.admin)['matrix']['EMPLOYEE']['viewAnalytics']['allowed'],
            'the refusal must not have reset anything',
        )

        reset = self.call('reset_role_permissions', self.admin, confirm=True)
        cell = reset['matrix']['EMPLOYEE']['viewAnalytics']
        self.assertFalse(cell['allowed'])
        self.assertEqual(cell['source'], 'default')

    def test_a_platform_admin_must_name_a_company(self):
        grid = self.call('get_role_permissions', self.dev)
        self.assertIsNone(grid['company'])
        self.assertIn('Choose a company', grid['matrix']['EMPLOYEE']['viewAnalytics']['reason'])

        self.assertIn('company', self.call_raises('update_role_permissions', self.dev, changes=self.GRANT).lower())
        self.assertIn('company', self.call_raises('reset_role_permissions', self.dev, confirm=True).lower())

    def test_a_platform_admin_targets_the_company_they_name(self):
        grid = self.call('get_role_permissions', self.dev, company=self.company.pk)
        self.assertEqual(grid['company'], self.company.pk)

        updated = self.call('update_role_permissions', self.dev, company=self.company.pk, changes=self.GRANT)
        self.assertTrue(updated['matrix']['EMPLOYEE']['viewAnalytics']['allowed'])

        reset = self.call('reset_role_permissions', self.dev, company=self.company.pk, confirm=True)
        self.assertFalse(reset['matrix']['EMPLOYEE']['viewAnalytics']['allowed'])

    def test_a_company_admin_cannot_target_another_tenant(self):
        """`company` is honoured for a platform admin only; anyone else is pinned."""
        grid = self.call('get_role_permissions', self.admin, company=self.rival.pk)
        self.assertEqual(grid['company'], self.company.pk)


class PermissionToolRegistrationTests(McpTestCase):
    def test_annotations_describe_what_each_tool_does(self):
        tools = self.tool_names(self.admin)
        for name in ('whoami', 'my_capabilities', 'explain_permission', 'get_role_permissions'):
            with self.subTest(tool=name):
                self.assertIs(tools[name].annotations.readOnlyHint, True)
        self.assertIs(tools['update_role_permissions'].annotations.readOnlyHint, False)
        self.assertIs(tools['update_role_permissions'].annotations.destructiveHint, False)
        self.assertIs(tools['reset_role_permissions'].annotations.readOnlyHint, False)
        self.assertIs(tools['reset_role_permissions'].annotations.destructiveHint, True)

    def test_read_only_mode_keeps_the_reads_and_drops_the_writes(self):
        tools = self.tool_names(self.admin, read_only=True)
        for name in ('whoami', 'my_capabilities', 'explain_permission', 'get_role_permissions'):
            self.assertIn(name, tools)
        self.assertNotIn('update_role_permissions', tools)
        self.assertNotIn('reset_role_permissions', tools)
