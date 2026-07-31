"""
The configurable role x capability matrix, and the manager hiring right.

Four properties are worth more than the rest of this file put together, and
each of them is here because getting it wrong is an outage or a takeover:

  1. AN EMPTY TABLE CHANGES NOTHING. The migration that ships this feature adds
     rows to nobody. If "no override" resolved to "denied" every tenant would be
     locked out on deploy; if it resolved to "allowed" every employee would get
     the admin surface. `DefaultsAreTheOldBehaviourTests` asserts the same
     statuses the existing authorization suite asserts, with the table empty.

  2. THE TABLE IS ACTUALLY CONSULTED. A permissions screen the server does not
     read is worse than no screen, because it makes a promise the product does
     not keep. Every capability is granted and revoked here and the resulting
     API behaviour is asserted — not the row, the STATUS CODE.

  3. PROTECTED CAPABILITIES CANNOT CROSS THEIR FLOOR. Parameterised over every
     role, not just the lowest: a rule written as one `if role == EMPLOYEE`
     comparison passes a lowest-role-only test while leaving the two manager
     tiers able to escalate.

  4. ONE TENANT'S MATRIX NEVER REACHES ANOTHER. Including through the cache,
     which is where this class of bug actually lives — a cache key without the
     company id serves whichever tenant warmed it first.

Throughout: assert the HTTP STATUS alongside the persisted state. "The user was
not created" is equally true of a refused write and an accepted-but-ignored one.
"""

from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase, override_settings

from rest_framework import status
from rest_framework.test import APIClient

from core import capabilities, services
from core.models import (
    Branch, Capability, Company, Enquiry, Plan, Refund, Registration, Role,
    RolePermission,
)

User = get_user_model()
PASSWORD = 'Testing!2026xyz'

MATRIX_URL = '/api/role-permissions/'
MINE_URL = '/api/role-permissions/mine/'


# The same REST_FRAMEWORK override the other suites use: the settings module
# reads env vars that are not set under test, and pinning it here keeps a
# developer's local .env from changing what these assertions mean.
REST_OVERRIDE = {
    'DEFAULT_AUTHENTICATION_CLASSES': (
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

CONFIGURABLE = capabilities.CONFIGURABLE_ROLES


class MatrixFixture(TestCase):
    """
    Two companies, one user per role in the first, and the fixtures the CRM
    endpoints need in order to return a real 201 rather than a 400.

    A second company exists in every test in this file, not only the isolation
    ones. A tenant boundary that is only exercised by the test named after it
    tends to be a boundary that exists only in that test.
    """

    @classmethod
    def setUpTestData(cls):
        services.ensure_default_plans()
        cls.company, cls.head_office = services.provision_company('Acme Consultancy')
        cls.kohima = Branch.objects.create(company=cls.company, name='Kohima', code='KOH')
        cls.dimapur = Branch.objects.create(company=cls.company, name='Dimapur', code='DIM')

        # Unlimited seats and branches. On the default Starter plan a create
        # returns 400 for quota reasons, which would be indistinguishable from a
        # permission rule that had silently stopped working.
        for company in (cls.company,):
            subscription = company.subscription
            subscription.plan = Plan.objects.get(slug='scale')
            subscription.save()

        cls.users = {
            Role.DEV_ADMIN: cls._mk('devadmin', Role.DEV_ADMIN, None, None),
            Role.COMPANY_ADMIN: cls._mk(
                'coadmin', Role.COMPANY_ADMIN, cls.company, cls.head_office,
            ),
            Role.HEAD_MANAGER: cls._mk(
                'headmgr', Role.HEAD_MANAGER, cls.company, cls.head_office,
            ),
            Role.BRANCH_MANAGER: cls._mk(
                'branchmgr', Role.BRANCH_MANAGER, cls.company, cls.kohima,
            ),
            Role.EMPLOYEE: cls._mk('employee', Role.EMPLOYEE, cls.company, cls.kohima),
        }
        # The head manager's span of control is Kohima, so the Kohima fixtures
        # are inside their write scope and a 403 there is the permission rule
        # talking rather than the queryset hiding the row.
        cls.users[Role.HEAD_MANAGER].managed_managers.set(
            [cls.users[Role.BRANCH_MANAGER]]
        )

        employee = cls.users[Role.EMPLOYEE]
        scope = dict(
            company=cls.company, branch=cls.kohima,
            created_by=employee, owner=employee,
        )
        cls.registration = Registration.objects.create(
            student_name='Existing', mobile='9000000000',
            email='existing@example.com', registration_fee=Decimal('1000.00'),
            **scope,
        )
        cls.refund = Refund.objects.create(
            student=cls.registration, amount=Decimal('250.00'), reason='Fixture',
            status=Refund.Status.PENDING, **scope,
        )

        # The neighbouring tenant.
        cls.other_company, cls.other_office = services.provision_company('Rival Consultancy')
        other_sub = cls.other_company.subscription
        other_sub.plan = Plan.objects.get(slug='scale')
        other_sub.save()
        cls.other_admin = cls._mk(
            'rivaladmin', Role.COMPANY_ADMIN, cls.other_company, cls.other_office,
        )
        cls.other_employee = cls._mk(
            'rivalstaff', Role.EMPLOYEE, cls.other_company, cls.other_office,
        )

    @classmethod
    def _mk(cls, username, role, company, branch):
        user = User.objects.create(
            username=username, role=role, company=company, branch=branch,
            email=f'{username}@example.com',
        )
        user.set_password(PASSWORD)
        user.save()
        return user

    def setUp(self):
        super().setUp()
        # BOTH halves matter. `TestCase` rolls the database back between tests
        # but never the cache, so a matrix cached after one test's grant would
        # still be served to the next — the row is gone and the permission
        # survives. The login throttle counter lives in the same cache.
        cache.clear()
        self._clients = {}

    # ----------------------------------------------------------------- helpers

    def client_for(self, user):
        """One authenticated client per user, reused within a test method.

        The login scope is throttled at 8/min; a fresh login per request would
        fail these tests for a reason that has nothing to do with permissions.
        """
        if user.pk not in self._clients:
            client = APIClient()
            response = client.post('/api/auth/login/', {
                'username': user.username, 'password': PASSWORD,
            }, format='json')
            self.assertEqual(
                response.status_code, 200, f'{user.username} could not log in',
            )
            client.credentials(HTTP_AUTHORIZATION=f'Bearer {response.data["access"]}')
            self._clients[user.pk] = client
        return self._clients[user.pk]

    def role_client(self, role):
        return self.client_for(self.users[role])

    def put_changes(self, actor, changes, company=None):
        """Submit a batch of cell changes as `actor`."""
        body = {'changes': changes}
        if company is not None:
            body['company'] = company.pk
        return self.client_for(actor).put(MATRIX_URL, body, format='json')

    def grant(self, role, capability, allowed=True, actor=None, company=None):
        """Apply one change and assert it was accepted."""
        actor = actor or self.users[Role.COMPANY_ADMIN]
        response = self.put_changes(
            actor,
            [{'role': role, 'capability': str(capability), 'allowed': allowed}],
            company=company,
        )
        self.assertEqual(response.status_code, 200, response.data)
        return response

    def assertStatus(self, response, expected, note):
        self.assertEqual(
            response.status_code, expected,
            f'{note}: got {response.status_code}, expected {expected}. '
            f'Body: {getattr(response, "data", None)!r}',
        )


# ===========================================================================
#  1. An empty table reproduces the previous behaviour, exactly
# ===========================================================================

@override_settings(REST_FRAMEWORK=REST_OVERRIDE)
class DefaultsAreTheOldBehaviourTests(MatrixFixture):
    """
    With no override rows, every endpoint answers what it answered before the
    matrix existed.

    The statuses below are the ones `core/test_authorization.py` already
    asserts. Duplicating them is the point: if resolving through the database
    changes any of them, this fails rather than that file, and the message says
    which capability drifted.
    """

    # (capability, path, roles that may GET, roles that may POST, body)
    ENDPOINTS = (
        (
            Capability.MANAGE_LEAD_SOURCES, 'lead-sources/',
            {Role.DEV_ADMIN, Role.COMPANY_ADMIN},
            {Role.DEV_ADMIN, Role.COMPANY_ADMIN},
            lambda t, role: {'name': f'Source {role}', 'type': 'Referral'},
        ),
        (
            Capability.MANAGE_COMMISSIONS, 'agents/',
            {Role.DEV_ADMIN, Role.COMPANY_ADMIN},
            {Role.DEV_ADMIN, Role.COMPANY_ADMIN},
            lambda t, role: {'name': f'Agent {role}', 'email': f'{role}@agents.test'},
        ),
        (
            Capability.MANAGE_REFUNDS, 'refunds/',
            set(capabilities.ALL_ROLES),
            {Role.DEV_ADMIN, Role.COMPANY_ADMIN, Role.HEAD_MANAGER, Role.BRANCH_MANAGER},
            lambda t, role: {
                'student': t.registration.pk, 'amount': '100.00',
                'reason': f'Filed by {role}',
            },
        ),
    )

    def test_the_table_starts_empty(self):
        """The premise of every assertion below."""
        self.assertEqual(RolePermission.objects.count(), 0)

    def test_reads_are_unchanged(self):
        for capability, path, readers, _writers, _body in self.ENDPOINTS:
            for role in sorted(capabilities.ALL_ROLES):
                with self.subTest(path=path, role=role):
                    response = self.role_client(role).get(f'/api/{path}')
                    expected = (
                        status.HTTP_200_OK if role in readers
                        else status.HTTP_403_FORBIDDEN
                    )
                    self.assertStatus(response, expected, f'GET {path} as {role} ({capability})')

    def test_creates_are_unchanged(self):
        for capability, path, _readers, writers, body in self.ENDPOINTS:
            for role in sorted(capabilities.ALL_ROLES):
                with self.subTest(path=path, role=role):
                    response = self.role_client(role).post(
                        f'/api/{path}', body(self, role), format='json',
                    )
                    expected = (
                        status.HTTP_201_CREATED if role in writers
                        else status.HTTP_403_FORBIDDEN
                    )
                    self.assertStatus(
                        response, expected, f'POST {path} as {role} ({capability})',
                    )

    def test_analytics_stays_manager_and_above(self):
        managers_up = {
            Role.DEV_ADMIN, Role.COMPANY_ADMIN, Role.HEAD_MANAGER, Role.BRANCH_MANAGER,
        }
        for role in sorted(capabilities.ALL_ROLES):
            with self.subTest(role=role):
                response = self.role_client(role).get('/api/analytics/funnel/')
                expected = (
                    status.HTTP_200_OK if role in managers_up
                    else status.HTTP_403_FORBIDDEN
                )
                self.assertStatus(response, expected, f'GET analytics/funnel/ as {role}')

    def test_employees_still_cannot_delete_directly(self):
        """`deleteRecords` now comes from the matrix; its default is unchanged."""
        for role in sorted(capabilities.ALL_ROLES):
            with self.subTest(role=role):
                target = Enquiry.objects.create(
                    school_name='School', stream='Science',
                    candidate_name=f'Doomed {role}', course_interested='BTech',
                    mobile='9000000002', email=f'doomed.{role}@example.com',
                    father_name='F', mother_name='M', permanent_address='Addr',
                    company=self.company, branch=self.kohima,
                    created_by=self.users[Role.EMPLOYEE],
                    owner=self.users[Role.EMPLOYEE],
                )
                response = self.role_client(role).delete(f'/api/enquiries/{target.pk}/')
                expected = (
                    status.HTTP_403_FORBIDDEN if role == Role.EMPLOYEE
                    else status.HTTP_204_NO_CONTENT
                )
                self.assertStatus(response, expected, f'DELETE enquiry as {role}')

    def test_employee_keeps_the_crm_baseline(self):
        """
        A gate that denies everybody satisfies every deny assertion above.

        This is the positive control: the endpoints an employee works in all day
        must still answer 200 and 201.
        """
        client = self.role_client(Role.EMPLOYEE)
        for prefix in ('enquiries', 'registrations', 'payments', 'tasks', 'follow-ups'):
            with self.subTest(endpoint=prefix):
                self.assertStatus(
                    client.get(f'/api/{prefix}/'), status.HTTP_200_OK,
                    f'GET {prefix}/ as employee',
                )
        response = client.post('/api/enquiries/', {
            'school_name': 'School', 'stream': 'Science',
            'candidate_name': 'Baseline', 'course_interested': 'BTech',
            'mobile': '9000000001', 'email': 'baseline@candidates.test',
            'father_name': 'F', 'mother_name': 'M', 'permanent_address': 'Addr',
        }, format='json')
        self.assertStatus(response, status.HTTP_201_CREATED, 'POST enquiries/ as employee')


# ===========================================================================
#  2. The defaults themselves are coherent
# ===========================================================================

class DefaultTableIntegrityTests(TestCase):
    """
    Cheap structural checks on the tables in core/capabilities.py.

    A capability added to the enum but not to DEFAULTS would resolve to a
    KeyError on the first request; one added to DEFAULTS but not the enum would
    never be reachable. Neither is caught by any behavioural test, because the
    behavioural tests only exercise the capabilities somebody remembered.
    """

    def test_every_capability_has_a_default(self):
        self.assertEqual(
            sorted(str(c) for c in capabilities.DEFAULTS),
            sorted(Capability.values),
        )

    def test_default_roles_are_real_roles(self):
        for capability, roles in capabilities.DEFAULTS.items():
            with self.subTest(capability=capability):
                unknown = [r for r in roles if r not in Role.values]
                self.assertEqual(unknown, [], f'{capability} names roles that do not exist')

    def test_ranks_cover_every_role(self):
        self.assertEqual(sorted(capabilities.ROLE_RANK), sorted(Role.values))

    def test_no_default_violates_its_own_floor(self):
        """
        A default that grants a capability below its floor would be silently
        clamped away on resolution — the product would ship advertising a
        permission it never honours.
        """
        for capability, roles in capabilities.DEFAULTS.items():
            for role in roles:
                with self.subTest(capability=capability, role=role):
                    self.assertTrue(
                        capabilities.is_delegable_to(capability, role),
                        f'{capability} is granted to {role} by default but its '
                        f'floor is {capabilities.floor_for(capability)}',
                    )

    def test_protected_floors_name_real_roles(self):
        for capability, (floor, reason) in capabilities.PROTECTED.items():
            with self.subTest(capability=capability):
                self.assertIn(floor, Role.values)
                self.assertTrue(reason.strip(), 'a locked cell must explain itself')

    def test_the_backend_vocabulary_matches_the_frontend(self):
        """
        `Capability` is a copy of the `CAN` map in rbac/roles.ts, and the copy
        has to stay honest: a capability the server enforces under a name the
        UI does not know is a control that can never be rendered.
        """
        expected = {
            'manageCompanies', 'manageBranches', 'manageUsers', 'viewAnalytics',
            'viewEarnings', 'manageCommissions', 'manageSettings',
            'reviewApprovals', 'manageCounselors', 'manageLeadSources',
            'manageRefunds', 'deleteRecords',
        }
        self.assertEqual(set(Capability.values), expected)


# ===========================================================================
#  3. Granting and revoking actually change what the API does
# ===========================================================================

@override_settings(REST_FRAMEWORK=REST_OVERRIDE)
class GrantAndRevokeChangeBehaviourTests(MatrixFixture):
    """The table is consulted, and the cache does not outlive the change."""

    def test_granting_lead_sources_lets_an_employee_read_them(self):
        employee = self.role_client(Role.EMPLOYEE)
        self.assertStatus(
            employee.get('/api/lead-sources/'), status.HTTP_403_FORBIDDEN,
            'employee before the grant',
        )

        self.grant(Role.EMPLOYEE, Capability.MANAGE_LEAD_SOURCES)

        self.assertStatus(
            employee.get('/api/lead-sources/'), status.HTTP_200_OK,
            'employee after the grant',
        )
        self.assertStatus(
            employee.post(
                '/api/lead-sources/', {'name': 'Walk-in', 'type': 'Referral'},
                format='json',
            ),
            status.HTTP_201_CREATED, 'employee create after the grant',
        )

    def test_granting_analytics_opens_the_manager_endpoints(self):
        employee = self.role_client(Role.EMPLOYEE)
        self.assertStatus(
            employee.get('/api/analytics/revenue/'), status.HTTP_403_FORBIDDEN,
            'employee before the grant',
        )
        self.grant(Role.EMPLOYEE, Capability.VIEW_ANALYTICS)
        self.assertStatus(
            employee.get('/api/analytics/revenue/'), status.HTTP_200_OK,
            'employee after the grant',
        )

    def test_revoking_refunds_stops_a_branch_manager_filing_one(self):
        manager = self.role_client(Role.BRANCH_MANAGER)
        payload = {
            'student': self.registration.pk, 'amount': '100.00', 'reason': 'Test',
        }
        self.assertStatus(
            manager.post('/api/refunds/', payload, format='json'),
            status.HTTP_201_CREATED, 'branch manager before the revoke',
        )
        before = Refund.objects.count()

        self.grant(Role.BRANCH_MANAGER, Capability.MANAGE_REFUNDS, allowed=False)

        response = manager.post('/api/refunds/', payload, format='json')
        self.assertStatus(response, status.HTTP_403_FORBIDDEN, 'after the revoke')
        # The status alone would also be satisfied by a write that was accepted
        # and then failed for another reason.
        self.assertEqual(Refund.objects.count(), before)

        # Reads stay open: the student profile renders a refund card for every
        # role, and revoking the WRITE must not turn that into an error panel.
        self.assertStatus(
            manager.get('/api/refunds/'), status.HTTP_200_OK,
            'refund reads after the revoke',
        )

    def test_revoking_approval_review_takes_effect(self):
        self.grant(Role.BRANCH_MANAGER, Capability.REVIEW_APPROVALS, allowed=False)
        # `pending-count` stays readable (it is scoped, not gated); the review
        # actions are what `reviewApprovals` governs.
        response = self.role_client(Role.BRANCH_MANAGER).post(
            '/api/approval-requests/1/approve/', {}, format='json',
        )
        self.assertIn(
            response.status_code,
            (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND),
        )
        self.assertStatus(response, status.HTTP_403_FORBIDDEN, 'review after the revoke')

    def test_returning_a_cell_to_null_restores_the_default(self):
        employee = self.role_client(Role.EMPLOYEE)
        self.grant(Role.EMPLOYEE, Capability.MANAGE_LEAD_SOURCES)
        self.assertStatus(
            employee.get('/api/lead-sources/'), status.HTTP_200_OK, 'after the grant',
        )

        self.grant(Role.EMPLOYEE, Capability.MANAGE_LEAD_SOURCES, allowed=None)

        self.assertEqual(
            RolePermission.objects.filter(
                company=self.company, role=Role.EMPLOYEE,
                capability=Capability.MANAGE_LEAD_SOURCES,
            ).count(),
            0,
            'null must DELETE the override, not store a false',
        )
        self.assertStatus(
            employee.get('/api/lead-sources/'), status.HTTP_403_FORBIDDEN,
            'after returning to the default',
        )

    def test_reset_clears_every_override(self):
        self.grant(Role.EMPLOYEE, Capability.MANAGE_LEAD_SOURCES)
        self.grant(Role.EMPLOYEE, Capability.VIEW_ANALYTICS)
        self.assertEqual(RolePermission.objects.count(), 2)

        response = self.client_for(self.users[Role.COMPANY_ADMIN]).delete(MATRIX_URL)
        self.assertStatus(response, status.HTTP_200_OK, 'reset')
        self.assertEqual(RolePermission.objects.count(), 0)
        self.assertStatus(
            self.role_client(Role.EMPLOYEE).get('/api/lead-sources/'),
            status.HTTP_403_FORBIDDEN, 'employee after the reset',
        )

    def test_a_write_invalidates_the_cache_it_warmed(self):
        """
        Explicitly, rather than as a side effect of the tests above.

        `resolve()` caches, so without invalidation a grant would take up to the
        TTL to be honoured — a permission change that appears to have saved and
        provably has not.
        """
        self.assertFalse(
            capabilities.resolve(self.company.pk)[Role.EMPLOYEE]['manageLeadSources'],
        )
        self.assertIsNotNone(
            cache.get(capabilities.cache_key(self.company.pk)),
            'the read above should have populated the cache',
        )

        self.grant(Role.EMPLOYEE, Capability.MANAGE_LEAD_SOURCES)

        self.assertTrue(
            capabilities.resolve(self.company.pk)[Role.EMPLOYEE]['manageLeadSources'],
        )

    def test_a_direct_model_write_also_invalidates(self):
        """The Django admin and shell are writers too."""
        self.assertFalse(
            capabilities.resolve(self.company.pk)[Role.EMPLOYEE]['manageLeadSources'],
        )
        RolePermission.objects.create(
            company=self.company, role=Role.EMPLOYEE,
            capability=Capability.MANAGE_LEAD_SOURCES, allowed=True,
        )
        self.assertTrue(
            capabilities.resolve(self.company.pk)[Role.EMPLOYEE]['manageLeadSources'],
            'post_save on RolePermission must drop the cached matrix',
        )

    def test_mine_reflects_the_company_matrix(self):
        employee = self.role_client(Role.EMPLOYEE)
        before = employee.get(MINE_URL)
        self.assertStatus(before, status.HTTP_200_OK, 'GET mine')
        self.assertNotIn('manageLeadSources', before.data['capabilities'])

        self.grant(Role.EMPLOYEE, Capability.MANAGE_LEAD_SOURCES)

        after = employee.get(MINE_URL)
        self.assertIn('manageLeadSources', after.data['capabilities'])
        self.assertEqual(after.data['role'], Role.EMPLOYEE)


# ===========================================================================
#  4. Escalation guards
# ===========================================================================

@override_settings(REST_FRAMEWORK=REST_OVERRIDE)
class DelegationGuardTests(MatrixFixture):
    """The rules that keep a permissions screen from being a takeover button."""

    def assertRefused(self, response, fragment=''):
        self.assertStatus(response, status.HTTP_400_BAD_REQUEST, 'delegation refused')
        body = str(response.data)
        if fragment:
            self.assertIn(fragment, body)

    def test_protected_capabilities_cannot_be_granted_below_their_floor(self):
        """
        Parameterised over EVERY configurable role and EVERY protected
        capability.

        A rule expressed as a single `if role == EMPLOYEE` check would pass a
        lowest-role-only version of this test while leaving both manager tiers
        able to grant themselves `manageUsers`.
        """
        admin = self.users[Role.COMPANY_ADMIN]
        for capability in capabilities.PROTECTED:
            floor = capabilities.floor_for(capability)
            for role in CONFIGURABLE:
                below = capabilities.ROLE_RANK[role] < capabilities.ROLE_RANK[floor]
                if not below:
                    continue
                with self.subTest(capability=str(capability), role=role):
                    response = self.put_changes(admin, [
                        {'role': role, 'capability': str(capability), 'allowed': True},
                    ])
                    self.assertRefused(response)
                    self.assertFalse(
                        RolePermission.objects.filter(
                            role=role, capability=capability,
                        ).exists(),
                        'a refused change must not be written',
                    )
                    self.assertFalse(
                        capabilities.resolve(self.company.pk)[role][str(capability)],
                        'and must not be resolvable',
                    )

    def test_at_or_above_the_floor_a_protected_capability_is_grantable(self):
        """
        The positive control. A guard that refuses every grant would satisfy the
        test above perfectly and make the screen useless.
        """
        dev_admin = self.users[Role.DEV_ADMIN]
        checked = 0
        for capability in capabilities.PROTECTED:
            floor = capabilities.floor_for(capability)
            for role in CONFIGURABLE:
                if capabilities.ROLE_RANK[role] < capabilities.ROLE_RANK[floor]:
                    continue
                with self.subTest(capability=str(capability), role=role):
                    response = self.put_changes(
                        dev_admin,
                        [{'role': role, 'capability': str(capability), 'allowed': True}],
                        company=self.company,
                    )
                    self.assertStatus(
                        response, status.HTTP_200_OK,
                        f'grant {capability} to {role} (floor {floor})',
                    )
                    self.assertTrue(
                        capabilities.resolve(self.company.pk)[role][str(capability)],
                    )
                    checked += 1
        self.assertGreater(checked, 0, 'this test asserted nothing')

    def test_the_resolver_clamps_a_row_written_around_the_api(self):
        """
        Defence in depth. The serializer refuses the escalating change, but a
        row inserted through the Django admin, a shell or a bad data migration
        bypasses the serializer entirely — so the floor is applied again when
        the matrix is read.
        """
        RolePermission.objects.create(
            company=self.company, role=Role.EMPLOYEE,
            capability=Capability.MANAGE_USERS, allowed=True,
        )
        self.assertFalse(
            capabilities.resolve(self.company.pk)[Role.EMPLOYEE]['manageUsers'],
            'a hand-written row must not be able to escalate anyone',
        )
        # And the API agrees: creating a staff account is still refused.
        response = self.role_client(Role.EMPLOYEE).post('/api/users/', {
            'username': 'smuggled', 'password': PASSWORD, 'role': Role.COMPANY_ADMIN,
        }, format='json')
        self.assertStatus(response, status.HTTP_403_FORBIDDEN, 'employee create user')
        self.assertFalse(User.objects.filter(username='smuggled').exists())

    def test_nobody_can_grant_a_capability_they_do_not_hold(self):
        """
        A company admin who has had a capability taken away from their own role
        must not be able to hand it to a role and take it back.
        """
        admin = self.users[Role.COMPANY_ADMIN]
        # Taken away by the platform operator, so the admin is not simply
        # undoing their own edit.
        self.grant(
            Role.COMPANY_ADMIN, Capability.MANAGE_LEAD_SOURCES, allowed=False,
            actor=self.users[Role.DEV_ADMIN], company=self.company,
        )
        self.assertFalse(capabilities.role_has(admin, Capability.MANAGE_LEAD_SOURCES))

        response = self.put_changes(admin, [{
            'role': Role.HEAD_MANAGER, 'capability': 'manageLeadSources',
            'allowed': True,
        }])
        self.assertRefused(response, 'does not hold it')
        self.assertFalse(
            capabilities.resolve(self.company.pk)[Role.HEAD_MANAGER]['manageLeadSources'],
        )

        # Revoking something you do not hold is not escalation, and stays legal.
        allowed_response = self.put_changes(admin, [{
            'role': Role.HEAD_MANAGER, 'capability': 'manageRefunds',
            'allowed': False,
        }])
        self.assertStatus(allowed_response, status.HTTP_200_OK, 'revoke is not a grant')

    def test_a_company_admin_cannot_strip_their_own_administration(self):
        for capability in capabilities.ADMIN_ESSENTIALS:
            with self.subTest(capability=str(capability)):
                response = self.put_changes(self.users[Role.COMPANY_ADMIN], [{
                    'role': Role.COMPANY_ADMIN, 'capability': str(capability),
                    'allowed': False,
                }])
                self.assertRefused(response)
                self.assertTrue(
                    capabilities.resolve(self.company.pk)[Role.COMPANY_ADMIN][str(capability)],
                )

    def test_dev_admin_rows_are_refused_and_ignored(self):
        response = self.put_changes(self.users[Role.COMPANY_ADMIN], [{
            'role': Role.DEV_ADMIN, 'capability': 'manageCompanies', 'allowed': False,
        }])
        self.assertRefused(response, 'not configurable')

        # And even a row written directly has no effect.
        RolePermission.objects.create(
            company=self.company, role=Role.DEV_ADMIN,
            capability=Capability.MANAGE_COMPANIES, allowed=False,
        )
        matrix = capabilities.resolve(self.company.pk)
        self.assertTrue(matrix[Role.DEV_ADMIN]['manageCompanies'])
        self.assertStatus(
            self.role_client(Role.DEV_ADMIN).get('/api/companies/'),
            status.HTTP_200_OK, 'dev admin after a hostile row',
        )

    def test_a_whole_batch_is_rejected_when_one_cell_is(self):
        """
        The grid the admin submitted is the unit of intent; applying half of it
        leaves a state nobody chose.
        """
        response = self.put_changes(self.users[Role.COMPANY_ADMIN], [
            {'role': Role.HEAD_MANAGER, 'capability': 'manageLeadSources', 'allowed': True},
            {'role': Role.EMPLOYEE, 'capability': 'manageUsers', 'allowed': True},
        ])
        self.assertRefused(response)
        self.assertEqual(RolePermission.objects.count(), 0, 'nothing may be written')


# ===========================================================================
#  5. Who may open the screen at all
# ===========================================================================

@override_settings(REST_FRAMEWORK=REST_OVERRIDE)
class MatrixEndpointAccessTests(MatrixFixture):

    def test_only_manage_settings_holders_can_read_the_grid(self):
        allowed = {Role.DEV_ADMIN, Role.COMPANY_ADMIN}
        for role in sorted(capabilities.ALL_ROLES):
            with self.subTest(role=role):
                response = self.role_client(role).get(MATRIX_URL)
                expected = (
                    status.HTTP_200_OK if role in allowed
                    else status.HTTP_403_FORBIDDEN
                )
                self.assertStatus(response, expected, f'GET the grid as {role}')

    def test_only_manage_settings_holders_can_write_the_grid(self):
        allowed = {Role.DEV_ADMIN, Role.COMPANY_ADMIN}
        change = [{
            'role': Role.HEAD_MANAGER, 'capability': 'manageLeadSources',
            'allowed': True,
        }]
        for role in sorted(capabilities.ALL_ROLES):
            with self.subTest(role=role):
                body = {'changes': change}
                if role == Role.DEV_ADMIN:
                    body['company'] = self.company.pk
                response = self.role_client(role).put(MATRIX_URL, body, format='json')
                expected = (
                    status.HTTP_200_OK if role in allowed
                    else status.HTTP_403_FORBIDDEN
                )
                self.assertStatus(response, expected, f'PUT the grid as {role}')

    def test_the_grid_reports_defaults_versus_overrides(self):
        response = self.client_for(self.users[Role.COMPANY_ADMIN]).get(MATRIX_URL)
        self.assertStatus(response, status.HTTP_200_OK, 'GET the grid')
        cell = response.data['matrix'][Role.HEAD_MANAGER]['manageLeadSources']
        self.assertEqual(cell['source'], 'default')
        self.assertFalse(cell['allowed'])

        self.grant(Role.HEAD_MANAGER, Capability.MANAGE_LEAD_SOURCES)

        after = self.client_for(self.users[Role.COMPANY_ADMIN]).get(MATRIX_URL)
        cell = after.data['matrix'][Role.HEAD_MANAGER]['manageLeadSources']
        self.assertEqual(cell['source'], 'override')
        self.assertTrue(cell['allowed'])

    def test_locked_cells_carry_a_reason(self):
        """
        A greyed toggle with no explanation reads as a bug. Every cell the UI
        will disable must arrive with the sentence that explains it.
        """
        response = self.client_for(self.users[Role.COMPANY_ADMIN]).get(MATRIX_URL)
        for role, row in response.data['matrix'].items():
            for capability, cell in row.items():
                with self.subTest(role=role, capability=capability):
                    if not cell['editable']:
                        self.assertTrue(
                            cell['reason'].strip(),
                            f'{role}/{capability} is locked with no reason given',
                        )

    def test_a_dev_admin_must_name_a_company_to_write(self):
        response = self.client_for(self.users[Role.DEV_ADMIN]).put(MATRIX_URL, {
            'changes': [{
                'role': Role.EMPLOYEE, 'capability': 'manageLeadSources',
                'allowed': True,
            }],
        }, format='json')
        self.assertStatus(response, status.HTTP_400_BAD_REQUEST, 'no company named')
        self.assertEqual(RolePermission.objects.count(), 0)


# ===========================================================================
#  6. Tenant isolation, including through the cache
# ===========================================================================

@override_settings(REST_FRAMEWORK=REST_OVERRIDE)
class TenantIsolationTests(MatrixFixture):
    """
    A cache key without the company id is an authorization bug, not a
    performance one: whichever tenant warms the cache first decides everybody's
    permissions.
    """

    def test_cache_keys_differ_per_company(self):
        self.assertNotEqual(
            capabilities.cache_key(self.company.pk),
            capabilities.cache_key(self.other_company.pk),
        )

    def test_one_companys_grant_does_not_reach_another(self):
        # Warm the neighbour's matrix FIRST. If the key were shared, this is the
        # entry the grant below would go on to overwrite.
        self.assertFalse(
            capabilities.resolve(self.other_company.pk)[Role.EMPLOYEE]['manageLeadSources'],
        )

        self.grant(Role.EMPLOYEE, Capability.MANAGE_LEAD_SOURCES)

        self.assertTrue(
            capabilities.resolve(self.company.pk)[Role.EMPLOYEE]['manageLeadSources'],
        )
        self.assertFalse(
            capabilities.resolve(self.other_company.pk)[Role.EMPLOYEE]['manageLeadSources'],
            'company A\'s override leaked into company B',
        )
        self.assertStatus(
            self.client_for(self.other_employee).get('/api/lead-sources/'),
            status.HTTP_403_FORBIDDEN, 'the neighbour\'s employee',
        )
        self.assertStatus(
            self.role_client(Role.EMPLOYEE).get('/api/lead-sources/'),
            status.HTTP_200_OK, 'our own employee',
        )

    def test_the_reverse_direction_too(self):
        """
        Warm OUR matrix first and change THEIRS. A one-directional test passes
        against an implementation that simply never invalidates.
        """
        self.assertFalse(
            capabilities.resolve(self.company.pk)[Role.EMPLOYEE]['viewAnalytics'],
        )
        self.grant(
            Role.EMPLOYEE, Capability.VIEW_ANALYTICS,
            actor=self.other_admin,
        )
        self.assertTrue(
            capabilities.resolve(self.other_company.pk)[Role.EMPLOYEE]['viewAnalytics'],
        )
        self.assertFalse(
            capabilities.resolve(self.company.pk)[Role.EMPLOYEE]['viewAnalytics'],
        )

    def test_an_admin_cannot_target_another_companys_grid(self):
        """
        `?company=` is honoured for a platform operator only. For anyone else it
        would be a one-parameter cross-tenant write.
        """
        response = self.put_changes(
            self.users[Role.COMPANY_ADMIN],
            [{'role': Role.EMPLOYEE, 'capability': 'manageLeadSources', 'allowed': True}],
            company=self.other_company,
        )
        self.assertStatus(response, status.HTTP_200_OK, 'the write is accepted')
        # ...but applied to their OWN company, never the one they named.
        self.assertTrue(
            RolePermission.objects.filter(company=self.company).exists(),
        )
        self.assertFalse(
            RolePermission.objects.filter(company=self.other_company).exists(),
            'a company admin steered a write into another tenant',
        )

    def test_reading_another_companys_grid_returns_your_own(self):
        response = self.client_for(self.users[Role.COMPANY_ADMIN]).get(
            f'{MATRIX_URL}?company={self.other_company.pk}',
        )
        self.assertStatus(response, status.HTTP_200_OK, 'GET with a foreign company')
        self.assertEqual(response.data['company'], self.company.pk)


# ===========================================================================
#  7. Managers hiring employees
# ===========================================================================

@override_settings(REST_FRAMEWORK=REST_OVERRIDE)
class ManagerHiringTests(MatrixFixture):
    """
    "The admin can add the employees, or managers can also add the employee."

    The narrow right the business asked for, and the three things it must not
    become: a manager minting a manager, a manager minting an admin, or a
    manager staffing a branch they do not run.
    """

    def hire(self, actor, username, role=Role.EMPLOYEE, branch=None):
        return self.client_for(actor).post('/api/users/', {
            'username': username,
            'email': f'{username}@example.com',
            'password': PASSWORD,
            'role': role,
            'branch': branch.pk if branch else None,
        }, format='json')

    # ------------------------------------------------------------- positive

    def test_a_branch_manager_can_hire_into_their_own_branch(self):
        response = self.hire(
            self.users[Role.BRANCH_MANAGER], 'kohima_hire', branch=self.kohima,
        )
        self.assertStatus(response, status.HTTP_201_CREATED, 'branch manager hires')

        hire = User.objects.get(username='kohima_hire')
        self.assertEqual(hire.role, Role.EMPLOYEE)
        self.assertEqual(hire.branch_id, self.kohima.pk)
        # Stamped from the caller, never accepted from the payload.
        self.assertEqual(hire.company_id, self.company.pk)
        self.assertTrue(hire.has_usable_password())

    def test_a_head_manager_can_hire_into_a_branch_they_oversee(self):
        """
        A head manager's scope is the union of their branch managers' branches,
        so Kohima is inside it and Dimapur is not.
        """
        response = self.hire(
            self.users[Role.HEAD_MANAGER], 'span_hire', branch=self.kohima,
        )
        self.assertStatus(response, status.HTTP_201_CREATED, 'head manager hires')
        self.assertEqual(User.objects.get(username='span_hire').branch_id, self.kohima.pk)

    def test_an_admin_can_still_create_any_role(self):
        """The positive control for the rule the managers' one sits beside."""
        for role in (Role.COMPANY_ADMIN, Role.HEAD_MANAGER, Role.BRANCH_MANAGER,
                     Role.EMPLOYEE):
            with self.subTest(role=role):
                response = self.hire(
                    self.users[Role.COMPANY_ADMIN], f'admin_made_{role.lower()}',
                    role=role, branch=self.dimapur,
                )
                self.assertStatus(response, status.HTTP_201_CREATED, f'admin creates {role}')

    # ------------------------------------------------------------- negative

    def test_a_manager_cannot_create_anything_but_an_employee(self):
        """Parameterised over every role a manager might reach for."""
        for actor_role in (Role.BRANCH_MANAGER, Role.HEAD_MANAGER):
            for target in (Role.COMPANY_ADMIN, Role.HEAD_MANAGER, Role.BRANCH_MANAGER):
                username = f'{actor_role.lower()}_makes_{target.lower()}'
                with self.subTest(actor=actor_role, target=target):
                    response = self.hire(
                        self.users[actor_role], username, role=target,
                        branch=self.kohima,
                    )
                    self.assertStatus(
                        response, status.HTTP_403_FORBIDDEN,
                        f'{actor_role} creating a {target}',
                    )
                    self.assertFalse(
                        User.objects.filter(username=username).exists(),
                        'a refused hire must not be written',
                    )

    def test_a_manager_cannot_create_a_platform_admin(self):
        """
        Called out separately because it is the one the whole role field exists
        to stop, and because the parent serializer refuses it for its own
        reason — this pins the status either way.
        """
        response = self.hire(
            self.users[Role.BRANCH_MANAGER], 'sneaky_dev', role=Role.DEV_ADMIN,
            branch=self.kohima,
        )
        self.assertStatus(response, status.HTTP_403_FORBIDDEN, 'manager creates dev admin')
        self.assertFalse(User.objects.filter(username='sneaky_dev').exists())

    def test_a_manager_cannot_hire_into_a_branch_they_do_not_run(self):
        for actor_role in (Role.BRANCH_MANAGER, Role.HEAD_MANAGER):
            username = f'{actor_role.lower()}_reaches_dimapur'
            with self.subTest(actor=actor_role):
                response = self.hire(
                    self.users[actor_role], username, branch=self.dimapur,
                )
                self.assertStatus(
                    response, status.HTTP_403_FORBIDDEN,
                    f'{actor_role} hiring into Dimapur',
                )
                self.assertFalse(User.objects.filter(username=username).exists())

    def test_an_employee_still_cannot_create_anyone(self):
        response = self.hire(
            self.users[Role.EMPLOYEE], 'employee_hire', branch=self.kohima,
        )
        self.assertStatus(response, status.HTTP_403_FORBIDDEN, 'employee hires')
        self.assertFalse(User.objects.filter(username='employee_hire').exists())

    def test_hiring_does_not_hand_a_manager_the_admin_serializer(self):
        """
        The escalation the spec warns about: if the permissive serializer were
        chosen by ACTION, a manager would receive it for their own row and
        could PATCH themselves to COMPANY_ADMIN.
        """
        manager = self.users[Role.BRANCH_MANAGER]
        response = self.client_for(manager).patch(
            f'/api/users/{manager.pk}/',
            {'role': Role.COMPANY_ADMIN, 'branch': self.dimapur.pk},
            format='json',
        )
        # The write is accepted, but `role` and `branch` are read-only on the
        # serializer a manager gets, so neither moves. Asserting the persisted
        # state as well as the status is what tells "ignored" from "refused".
        self.assertStatus(response, status.HTTP_200_OK, 'manager patches own row')
        manager.refresh_from_db()
        self.assertEqual(manager.role, Role.BRANCH_MANAGER)
        self.assertEqual(manager.branch_id, self.kohima.pk)

    def test_a_manager_cannot_delete_or_deactivate(self):
        """
        `create` was widened; `destroy` and `set-active` were not. Hiring and
        firing are different rights, and the second one ends someone's session.
        """
        target = self.users[Role.EMPLOYEE]
        manager = self.users[Role.BRANCH_MANAGER]
        self.assertStatus(
            self.client_for(manager).delete(f'/api/users/{target.pk}/'),
            status.HTTP_403_FORBIDDEN, 'manager deletes a user',
        )
        self.assertStatus(
            self.client_for(manager).post(
                f'/api/users/{target.pk}/set-active/', {'is_active': False},
                format='json',
            ),
            status.HTTP_403_FORBIDDEN, 'manager deactivates a user',
        )
        target.refresh_from_db()
        self.assertTrue(target.is_active_employee)
        self.assertTrue(User.objects.filter(pk=target.pk).exists())

    def test_a_manager_cannot_configure_a_head_managers_span_of_control(self):
        """
        `managed_managers` decides which branches a head manager can see. A
        manager who could set it could widen their own supervisor's scope — or,
        with a self-referential set, their own.
        """
        response = self.client_for(self.users[Role.BRANCH_MANAGER]).post(
            '/api/users/', {
                'username': 'span_attempt',
                'email': 'span_attempt@example.com',
                'password': PASSWORD,
                'role': Role.EMPLOYEE,
                'branch': self.kohima.pk,
                'managed_managers': [self.users[Role.BRANCH_MANAGER].pk],
            }, format='json',
        )
        self.assertStatus(response, status.HTTP_201_CREATED, 'hire with a smuggled field')
        hire = User.objects.get(username='span_attempt')
        self.assertEqual(
            hire.managed_managers.count(), 0,
            'the field is absent from the manager serializer, so it is dropped',
        )

    def test_granting_manage_users_to_a_manager_is_still_refused(self):
        """
        The whole reason the hiring right is its own permission rather than a
        capability: `manageUsers` remains non-delegable, so the business need
        did not become an escalation path.
        """
        response = self.put_changes(self.users[Role.COMPANY_ADMIN], [{
            'role': Role.BRANCH_MANAGER, 'capability': 'manageUsers', 'allowed': True,
        }])
        self.assertStatus(response, status.HTTP_400_BAD_REQUEST, 'grant manageUsers')
        self.assertFalse(
            capabilities.resolve(self.company.pk)[Role.BRANCH_MANAGER]['manageUsers'],
        )
        # And the manager still cannot create a manager.
        self.assertStatus(
            self.hire(
                self.users[Role.BRANCH_MANAGER], 'still_no',
                role=Role.BRANCH_MANAGER, branch=self.kohima,
            ),
            status.HTTP_403_FORBIDDEN, 'manager creates a manager after the attempt',
        )


# ===========================================================================
#  8. The resolver in isolation
# ===========================================================================

class ResolverTests(TestCase):
    """Unit-level checks on the fallback rule itself."""

    @classmethod
    def setUpTestData(cls):
        services.ensure_default_plans()
        cls.company, _ = services.provision_company('Resolver Co')

    def setUp(self):
        super().setUp()
        cache.clear()

    def test_no_rows_means_the_defaults(self):
        matrix = capabilities.resolve(self.company.pk)
        for capability, roles in capabilities.DEFAULTS.items():
            for role in capabilities.ALL_ROLES:
                with self.subTest(capability=str(capability), role=role):
                    expected = role in roles
                    if role == Role.DEV_ADMIN:
                        expected = True
                    self.assertEqual(matrix[role][str(capability)], expected)

    def test_a_company_less_caller_gets_the_defaults(self):
        """
        A DEV_ADMIN has no company. Resolving `None` must not blow up, and must
        not return an empty matrix that denies them everything.
        """
        matrix = capabilities.resolve(None)
        self.assertTrue(matrix[Role.DEV_ADMIN]['manageCompanies'])
        self.assertFalse(matrix[Role.EMPLOYEE]['manageUsers'])

    def test_an_unknown_capability_row_is_ignored(self):
        """
        A capability removed from the enum leaves rows behind. They must be
        inert rather than a KeyError on every request.
        """
        RolePermission.objects.create(
            company=self.company, role=Role.EMPLOYEE,
            capability='someRetiredCapability', allowed=True,
        )
        matrix = capabilities.resolve(self.company.pk)
        self.assertNotIn('someRetiredCapability', matrix[Role.EMPLOYEE])

    def test_capabilities_for_lists_only_what_is_held(self):
        employee = User.objects.create(
            username='resolver_employee', role=Role.EMPLOYEE, company=self.company,
        )
        held = capabilities.capabilities_for(employee)
        self.assertNotIn('manageUsers', held)
        self.assertIn('manageCounselors', held)

        RolePermission.objects.create(
            company=self.company, role=Role.EMPLOYEE,
            capability=Capability.MANAGE_REFUNDS, allowed=True,
        )
        self.assertIn('manageRefunds', capabilities.capabilities_for(employee))

    def test_a_dev_admin_holds_everything(self):
        dev = User.objects.create(username='resolver_dev', role=Role.DEV_ADMIN)
        self.assertEqual(
            capabilities.capabilities_for(dev), sorted(Capability.values),
        )
