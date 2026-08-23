"""
Authorization: does the SERVER enforce what the UI advertises?

`consultancy-dev/components/rbac/roles.ts` declares a capability map (`CAN`)
that decides which controls each role is shown. That map is presentation only;
the API is the authority. Three endpoints had drifted apart from it — an
employee could read and write lead sources and refunds through the API while
the UI hid every control, because the viewsets declared no permission class and
inherited `ScopedModelViewSet`'s scope-only defaults.

WHY THIS FILE IS A TABLE AND NOT A LIST OF HAND-WRITTEN CASES

Those three were missed for the same reason each time: a suite with one
hand-written test per endpoint only ever covers the endpoints someone
remembered. Here the expectations live in `ENDPOINTS`, `DETAIL_RULES` and
`ANALYTICS`, and the tests are loops over ROLES x RULE. Adding a role means
adding one entry. `test_every_registered_endpoint_has_a_rule` closes the other
half of the gap: a viewset registered on the router that appears in no table
below fails the suite until someone states, in writing, what its rule is.

Three properties every case asserts, each learned from a test that passed while
the defect was live:

  * the HTTP STATUS, never just "no row appeared". A write that is accepted and
    silently ignored leaves the same empty table as a write that was refused.
  * the POSITIVE path. A gate that denies everybody satisfies a deny-only suite
    perfectly, and would take the product down.
  * EVERY elevated role, not just the top one. A rule written as a single
    `if user.is_company_admin` check passes a dev-admin-only test while leaving
    the two manager tiers wide open.
"""

from dataclasses import dataclass
from decimal import Decimal
from typing import Callable, FrozenSet, Optional

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase, override_settings

from rest_framework import status
from rest_framework.test import APIClient

from core import services
from core.models import (
    Agent, Branch, Commission, Company, Enquiry, Plan, Refund,
    Registration, Role,
)
from core.urls import router

User = get_user_model()
PASSWORD = 'Testing!2026xyz'


# ------------------------------------------------------------------ role sets

ALL_ROLES = frozenset({
    Role.DEV_ADMIN, Role.COMPANY_ADMIN, Role.HEAD_MANAGER,
    Role.BRANCH_MANAGER, Role.EMPLOYEE,
})
ADMINS = frozenset({Role.DEV_ADMIN, Role.COMPANY_ADMIN})
MANAGERS_UP = ADMINS | {Role.HEAD_MANAGER, Role.BRANCH_MANAGER}
# `CanViewFinancials` — reading the money, which a head manager running a
# branch P&L is entitled to do. Writing it is `ADMINS`; see CAN.manageCommissions.
FINANCE_READERS = ADMINS | {Role.HEAD_MANAGER}


@dataclass(frozen=True)
class Rule:
    """One collection endpoint and the roles allowed to read and to create."""

    capability: str
    path: str
    readers: FrozenSet[str]
    writers: FrozenSet[str]
    # (testcase, role) -> a payload the endpoint accepts, so an ALLOWED role
    # gets a real 201 rather than a 400 that only proves the gate let it in.
    body: Optional[Callable] = None
    # Roles whose create probe is skipped, and why. Only for a role that fails
    # for a reason unrelated to authorization — never to paper over a gate.
    create_skip: FrozenSet[str] = frozenset()


@dataclass(frozen=True)
class DetailRule:
    """A single existing record, and the roles allowed to modify it."""

    capability: str
    url: Callable          # (testcase) -> '/api/refunds/3/'
    payload: dict
    writers: FrozenSet[str]


# ------------------------------------------------------------ the expectations
#
# Each `capability` names the entry in rbac/roles.ts the server rule must be at
# least as strict as. Where the server is deliberately MORE permissive than the
# UI, the comment says why — that is a decision, not drift.

ENDPOINTS = (
    Rule(
        capability='manageCompanies (create) / manageSettings (read own)',
        path='companies/',
        # A company admin reads their OWN row here — the Settings page's
        # company tab is built from it. The row-level scoping that keeps them
        # off every other tenant is covered by CompanyScopeTests below.
        readers=ADMINS,
        writers=frozenset({Role.DEV_ADMIN}),
        body=lambda t, role: {'name': f'Provisioned by {role}'},
    ),
    Rule(
        capability='manageBranches',
        path='branches/',
        # Read is open on purpose: the admissions filter drawer and the
        # transfer modal both need the branch list, for every role.
        readers=ALL_ROLES,
        writers=ADMINS,
        body=lambda t, role: {'name': f'Branch {role}', 'code': role[:6]},
        # A dev admin has no company, `Branch.company` is NOT NULL, and
        # `BranchViewSet.perform_create` saves `company=user.company`
        # unconditionally — so POST /api/branches/ as a dev admin raises an
        # IntegrityError and answers 500. That is a real defect, but it is a
        # data-integrity one rather than an authorization one, and asserting
        # either 201 or 403 here would be asserting something untrue. The
        # dev-admin branch WRITE rule is covered by the PATCH case below.
        create_skip=frozenset({Role.DEV_ADMIN}),
    ),
    Rule(
        capability='manageUsers',
        path='users/',
        # Read is scoped, not blocked: an employee sees only their own row and
        # needs the directory to hand a record to a colleague.
        readers=ALL_ROLES,
        writers=ADMINS,
        body=lambda t, role: {
            'username': f'hire_{role.lower()}', 'password': PASSWORD,
            'role': Role.HEAD_MANAGER,
        },
    ),
    Rule(
        capability='manageCommissions',
        path='commissions/',
        readers=FINANCE_READERS,
        writers=ADMINS,
        body=lambda t, role: {
            'agent': t.agent.pk, 'commission_amount': '500.00',
            'enrollment_fee': '5000.00',
        },
    ),
    Rule(
        capability='manageCommissions',
        # The commissions screen is the only consumer of `agents/`, so the
        # agent roster carries the same rule as the ledger it feeds.
        path='agents/',
        readers=ADMINS,
        writers=ADMINS,
        body=lambda t, role: {'name': f'Agent {role}', 'email': f'{role}@agents.test'},
    ),
    Rule(
        capability='manageRefunds',
        path='refunds/',
        # Read stays open to the tenant: the student profile renders a refund
        # history card for every role, and `scope_queryset` already narrows an
        # employee to refunds they own. Filing one moves money — that is write.
        readers=ALL_ROLES,
        writers=MANAGERS_UP,
        body=lambda t, role: {
            'student': t.reg_k1.pk, 'amount': '100.00', 'reason': f'Filed by {role}',
        },
    ),
    Rule(
        # No CAN entry governs the university catalogue; the rule is the
        # pre-existing `ReadOnlyOrManager` and this pins it.
        capability='(none — ReadOnlyOrManager)',
        path='universities/',
        readers=ALL_ROLES,
        writers=MANAGERS_UP,
        body=lambda t, role: {'name': f'University of {role}', 'country': 'UK'},
    ),
    Rule(
        # The baseline every CRM resource shares: any active user may create
        # their own records. Here to prove the tightening above did not leak
        # into the endpoints employees do their job with.
        capability='(none — tenant CRM baseline)',
        path='enquiries/',
        readers=ALL_ROLES,
        writers=ALL_ROLES,
        body=lambda t, role: {
            'school_name': 'School', 'stream': 'Science',
            'candidate_name': f'Candidate {role}', 'course_interested': 'BTech',
            'mobile': '9000000001', 'email': f'{role}@candidates.test',
            'father_name': 'F', 'mother_name': 'M', 'permanent_address': 'Addr',
        },
    ),
)

DETAIL_RULES = (
    DetailRule(
        capability='manageBranches',
        url=lambda t: f'/api/branches/{t.kohima.pk}/',
        payload={'name': 'Kohima (renamed)'},
        # `perform_create` already refused a non-admin POST; PATCH and DELETE
        # were left to ReadOnlyOrManager, so a branch manager could rename the
        # branch they work in.
        writers=ADMINS,
    ),
    DetailRule(
        capability='manageRefunds',
        url=lambda t: f'/api/refunds/{t.refund.pk}/',
        # Approving a refund is the step that releases the money.
        payload={'status': Refund.Status.APPROVED},
        writers=MANAGERS_UP,
    ),
    DetailRule(
        capability='manageCommissions',
        url=lambda t: f'/api/commissions/{t.commission.pk}/',
        payload={'status': 'Paid'},
        # A head manager may READ this row (it is in FINANCE_READERS above) and
        # still not mark it paid.
        writers=ADMINS,
    ),
)

# GET-only. `viewAnalytics` is admins + both manager tiers.
ANALYTICS = (
    # DELIBERATELY wider than viewAnalytics: the employee dashboard renders
    # these counters, and /app/visa-tracking carries no role gate at all. Both
    # are scope-filtered, so an employee's totals cover only their own records.
    ('viewAnalytics (open by design)', 'analytics/overview/', ALL_ROLES),
    ('viewAnalytics (open by design)', 'analytics/visa-pipeline/', ALL_ROLES),
    ('viewAnalytics', 'analytics/funnel/', MANAGERS_UP),
    ('viewEarnings / viewAnalytics', 'analytics/revenue/', MANAGERS_UP),
    ('viewAnalytics', 'analytics/branches/', MANAGERS_UP),
    ('viewAnalytics', 'analytics/sources/', MANAGERS_UP),
)

# Router prefixes that no CAN capability governs, each with the rule that does.
# Listed so `test_every_registered_endpoint_has_a_rule` can tell "considered and
# exempt" from "nobody has looked at this one yet".
UNGOVERNED = {
    'plans': 'Public pricing catalogue (AllowAny). Carries no tenant data.',
    'signup-requests': 'Public create; everything else is IsDevAdmin.',
    'subscriptions': 'Read-only and filtered to the caller\'s own company.',
    'notifications': 'Read-only and filtered to the caller\'s own rows.',
    'transfers': 'Every role must be able to hand a record to a colleague.',
    'approval-requests': (
        'Every role must be able to RAISE one — it is the employee\'s route to '
        'a delete. Review is gated separately by _require_reviewer.'
    ),
}

# The shared CRM rule: any active user may read and create within their own
# scope, and `ScopedModelViewSet.perform_destroy` is what stops an employee
# deleting. Covered as a group by `test_employee_keeps_the_crm_baseline`.
TENANT_CRM = (
    'registrations', 'enrollments', 'installments', 'payments', 'documents',
    'tasks', 'appointments', 'templates', 'visa-tracking', 'follow-ups',
    'follow-up-comments', 'student-remarks', 'student-documents',
)


# NOTE: this override does not by itself disable throttling — `throttle_classes`
# and the rate table are bound at import time. What keeps the 8/min login scope
# from failing these tests is `cache.clear()` in setUp, which resets the
# counters per test. Same approach as core/tests.py; see the longer note there.
REST_FRAMEWORK_FOR_TESTS = {
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


@override_settings(REST_FRAMEWORK=REST_FRAMEWORK_FOR_TESTS)
class AuthorizationMatrixTests(TestCase):
    """One user per role, and a fixture row for every endpoint in the tables."""

    @classmethod
    def setUpTestData(cls):
        services.ensure_default_plans()
        cls.company, cls.head_office = services.provision_company('Acme Consultancy')
        cls.kohima = Branch.objects.create(company=cls.company, name='Kohima', code='KOH')

        # The unlimited plan, so a quota rejection can never be mistaken for an
        # authorization result: `branches/` and `users/` both refuse a create on
        # the default Starter plan with 400, which would hide a broken gate.
        subscription = cls.company.subscription
        subscription.plan = Plan.objects.get(slug='scale')
        subscription.save()

        def mk(username, role, branch):
            user = User.objects.create(
                username=username, role=role,
                company=None if role == Role.DEV_ADMIN else cls.company,
                branch=None if role == Role.DEV_ADMIN else branch,
                email=f'{username}@example.com',
            )
            user.set_password(PASSWORD)
            user.save()
            return user

        cls.users = {
            Role.DEV_ADMIN: mk('devadmin', Role.DEV_ADMIN, None),
            Role.COMPANY_ADMIN: mk('coadmin', Role.COMPANY_ADMIN, cls.head_office),
            Role.HEAD_MANAGER: mk('headmgr', Role.HEAD_MANAGER, cls.head_office),
            Role.BRANCH_MANAGER: mk('branchmgr', Role.BRANCH_MANAGER, cls.kohima),
            Role.EMPLOYEE: mk('employee', Role.EMPLOYEE, cls.kohima),
        }
        # The head manager oversees Kohima, so the Kohima fixtures are inside
        # their write scope and a 403 there is the permission class talking
        # rather than the queryset hiding the row.
        cls.users[Role.HEAD_MANAGER].managed_managers.set(
            [cls.users[Role.BRANCH_MANAGER]]
        )

        employee = cls.users[Role.EMPLOYEE]
        scope = dict(
            company=cls.company, branch=cls.kohima,
            created_by=employee, owner=employee,
        )

        cls.enquiry = Enquiry.objects.create(
            school_name='School', stream='Science', candidate_name='Existing',
            course_interested='BTech', mobile='9000000000',
            email='existing@example.com', father_name='F', mother_name='M',
            permanent_address='Addr', **scope,
        )
        cls.reg_k1 = Registration.objects.create(
            student_name='Existing', mobile='9000000000',
            email='existing@example.com', registration_fee=Decimal('1000.00'),
            **scope,
        )
        cls.refund = Refund.objects.create(
            student=cls.reg_k1, amount=Decimal('250.00'), reason='Fixture',
            status=Refund.Status.PENDING, **scope,
        )
        cls.agent = Agent.objects.create(name='Fixture Agent', email='a@agents.test', **scope)
        cls.commission = Commission.objects.create(
            agent=cls.agent, commission_amount=Decimal('750.00'), **scope,
        )

    def setUp(self):
        super().setUp()
        cache.clear()
        self._clients = {}

    def client_for(self, role):
        """One authenticated client per role, reused within a test method.

        The login scope is throttled at 8/min and there are five roles, so a
        fresh login per request would fail these tests for the wrong reason.
        """
        if role not in self._clients:
            client = APIClient()
            response = client.post('/api/auth/login/', {
                'username': self.users[role].username, 'password': PASSWORD,
            }, format='json')
            self.assertEqual(response.status_code, 200, f'{role} could not log in')
            client.credentials(HTTP_AUTHORIZATION=f'Bearer {response.data["access"]}')
            self._clients[role] = client
        return self._clients[role]

    def assertStatus(self, response, expected, role, method, path, capability):
        url = path if path.startswith('/api/') else f'/api/{path}'
        self.assertEqual(
            response.status_code, expected,
            f'{method} {url} as {role} returned '
            f'{response.status_code}, expected {expected} '
            f'(capability: {capability}). Body: {getattr(response, "data", None)!r}',
        )

    # ------------------------------------------------------------------ reads

    def test_list_reads_match_the_capability_map(self):
        for rule in ENDPOINTS:
            for role in sorted(ALL_ROLES):
                with self.subTest(endpoint=rule.path, role=role, method='GET'):
                    response = self.client_for(role).get(f'/api/{rule.path}')
                    expected = (
                        status.HTTP_200_OK if role in rule.readers
                        else status.HTTP_403_FORBIDDEN
                    )
                    self.assertStatus(
                        response, expected, role, 'GET', rule.path, rule.capability,
                    )

    def test_analytics_reads_match_the_capability_map(self):
        for capability, path, readers in ANALYTICS:
            for role in sorted(ALL_ROLES):
                with self.subTest(endpoint=path, role=role):
                    response = self.client_for(role).get(f'/api/{path}')
                    expected = (
                        status.HTTP_200_OK if role in readers
                        else status.HTTP_403_FORBIDDEN
                    )
                    self.assertStatus(response, expected, role, 'GET', path, capability)

    # ----------------------------------------------------------------- creates

    def test_creates_match_the_capability_map(self):
        """
        An allowed role must get a real 201.

        Probing with an empty body would only ever distinguish 403 from 400,
        and 400 is also what a permitted role gets when the gate is right but
        the endpoint is broken.
        """
        for rule in ENDPOINTS:
            if rule.body is None:
                continue
            for role in sorted(ALL_ROLES - rule.create_skip):
                with self.subTest(endpoint=rule.path, role=role, method='POST'):
                    response = self.client_for(role).post(
                        f'/api/{rule.path}', rule.body(self, role), format='json',
                    )
                    expected = (
                        status.HTTP_201_CREATED if role in rule.writers
                        else status.HTTP_403_FORBIDDEN
                    )
                    self.assertStatus(
                        response, expected, role, 'POST', rule.path, rule.capability,
                    )

    # ----------------------------------------------------------- detail writes

    def test_detail_writes_match_the_capability_map(self):
        for rule in DETAIL_RULES:
            url = rule.url(self)
            for role in sorted(ALL_ROLES):
                with self.subTest(endpoint=url, role=role, method='PATCH'):
                    response = self.client_for(role).patch(
                        url, rule.payload, format='json',
                    )
                    expected = (
                        status.HTTP_200_OK if role in rule.writers
                        else status.HTTP_403_FORBIDDEN
                    )
                    self.assertStatus(
                        response, expected, role, 'PATCH', url, rule.capability,
                    )

    def test_deletes_match_the_delete_records_capability(self):
        """
        `deleteRecords` is everyone above employee; an employee raises an
        approval request instead. Each role gets its own row, because a
        subTest shares the surrounding transaction and the second deletion of
        one record would 404 for a reason that has nothing to do with the rule.
        """
        for role in sorted(ALL_ROLES):
            with self.subTest(role=role, method='DELETE'):
                target = Enquiry.objects.create(
                    school_name='School', stream='Science',
                    candidate_name=f'Doomed {role}', course_interested='BTech',
                    mobile='9000000002', email=f'doomed.{role}@example.com',
                    father_name='F', mother_name='M', permanent_address='Addr',
                    company=self.company, branch=self.kohima,
                    created_by=self.users[Role.EMPLOYEE],
                    owner=self.users[Role.EMPLOYEE],
                )
                response = self.client_for(role).delete(f'/api/enquiries/{target.pk}/')
                expected = (
                    status.HTTP_403_FORBIDDEN if role == Role.EMPLOYEE
                    else status.HTTP_204_NO_CONTENT
                )
                self.assertStatus(
                    response, expected, role, 'DELETE',
                    f'enquiries/{target.pk}/', 'deleteRecords',
                )

    # -------------------------------------------------------------- baselines

    def test_employee_keeps_the_crm_baseline(self):
        """
        The tightening above must not have leaked into the endpoints an
        employee works in all day. A gate that denies everyone would pass every
        deny assertion in this file without this.
        """
        client = self.client_for(Role.EMPLOYEE)
        for prefix in TENANT_CRM:
            with self.subTest(endpoint=prefix):
                response = client.get(f'/api/{prefix}/')
                self.assertStatus(
                    response, status.HTTP_200_OK, Role.EMPLOYEE, 'GET',
                    f'{prefix}/', 'tenant CRM baseline',
                )

    def test_every_registered_endpoint_has_a_rule(self):
        """
        The mechanism that stops this class of defect coming back.

        A viewset added to the router with no permission class inherits the
        scope-only default and is open to every role. Unless its prefix appears
        in a table above or in `UNGOVERNED` with a reason, this fails.
        """
        registered = {prefix for prefix, _viewset, _basename in router.registry}
        covered = (
            {rule.path.rstrip('/') for rule in ENDPOINTS}
            | set(UNGOVERNED)
            | set(TENANT_CRM)
        )
        missing = sorted(registered - covered)
        self.assertEqual(
            missing, [],
            'These endpoints are registered on the router but no authorization '
            f'rule covers them: {missing}. Add a Rule to ENDPOINTS, list the '
            'prefix in TENANT_CRM if it follows the shared scoped-CRM rule, or '
            'add it to UNGOVERNED with the reason no capability applies.',
        )


@override_settings(REST_FRAMEWORK=REST_FRAMEWORK_FOR_TESTS)
class CommissionRequiredFieldTests(TestCase):
    """
    `POST /api/commissions/` with `{}` returned 201.

    Every column on Commission is nullable or defaulted, so the ModelSerializer
    made every field optional and the API would write a financial row with no
    agent, no student and a zero amount — a record that can never be reconciled
    against anything.
    """

    @classmethod
    def setUpTestData(cls):
        services.ensure_default_plans()
        cls.company, cls.head_office = services.provision_company('Acme Consultancy')
        cls.admin = User.objects.create(
            username='coadmin', role=Role.COMPANY_ADMIN, company=cls.company,
            branch=cls.head_office, email='coadmin@example.com',
        )
        cls.admin.set_password(PASSWORD)
        cls.admin.save()
        cls.agent = Agent.objects.create(
            name='Fixture Agent', email='a@agents.test', company=cls.company,
            branch=cls.head_office, created_by=cls.admin, owner=cls.admin,
        )

    def setUp(self):
        super().setUp()
        cache.clear()
        self.client_ = APIClient()
        response = self.client_.post('/api/auth/login/', {
            'username': self.admin.username, 'password': PASSWORD,
        }, format='json')
        self.assertEqual(response.status_code, 200)
        self.client_.credentials(HTTP_AUTHORIZATION=f'Bearer {response.data["access"]}')

    def assertRejected(self, response, *fields):
        """
        400, naming each field, and nothing written.

        The status alone is not enough — a 400 for the wrong reason (a bad FK,
        say) would pass while the required-field rule was missing. The count
        check is what proves nothing slipped through underneath the error.
        `core.exception_handler` nests the per-field errors under `fields`.
        """
        self.assertEqual(response.status_code, 400, response.data)
        reported = response.data.get('fields', {})
        for field in fields:
            self.assertIn(field, reported, f'{field} was not reported: {response.data!r}')
        self.assertEqual(Commission.objects.count(), 0)

    def test_empty_body_is_rejected(self):
        response = self.client_.post('/api/commissions/', {}, format='json')
        self.assertRejected(response, 'agent', 'commission_amount')

    def test_amount_without_an_agent_is_rejected(self):
        response = self.client_.post(
            '/api/commissions/', {'commission_amount': '500.00'}, format='json',
        )
        self.assertRejected(response, 'agent')

    def test_agent_without_an_amount_is_rejected(self):
        response = self.client_.post(
            '/api/commissions/', {'agent': self.agent.pk}, format='json',
        )
        self.assertRejected(response, 'commission_amount')

    def test_zero_amount_is_rejected(self):
        """A commission worth nothing is the empty record in another guise."""
        response = self.client_.post('/api/commissions/', {
            'agent': self.agent.pk, 'commission_amount': '0.00',
        }, format='json')
        self.assertRejected(response, 'commission_amount')

    def test_a_complete_commission_is_accepted(self):
        """The positive path: the tightening must not have shut the door."""
        response = self.client_.post('/api/commissions/', {
            'agent': self.agent.pk, 'commission_amount': '500.00',
            'enrollment_fee': '5000.00',
        }, format='json')
        self.assertEqual(response.status_code, 201, response.data)
        commission = Commission.objects.get()
        self.assertEqual(commission.agent_id, self.agent.pk)
        self.assertEqual(commission.commission_amount, Decimal('500.00'))
        # Stamped by the view, never accepted from the payload.
        self.assertEqual(commission.company_id, self.company.pk)

    def test_marking_paid_still_works(self):
        """
        PATCH must stay usable — it is the only commission write the UI makes
        (apiClient.ts:1398). DRF skips `required` on a partial update, and this
        pins that so a later `PUT`-shaped refactor cannot break it silently.
        """
        commission = Commission.objects.create(
            agent=self.agent, commission_amount=Decimal('750.00'),
            company=self.company, branch=self.head_office,
            created_by=self.admin, owner=self.admin,
        )
        response = self.client_.patch(
            f'/api/commissions/{commission.pk}/', {'status': 'Paid'}, format='json',
        )
        self.assertEqual(response.status_code, 200, response.data)
        commission.refresh_from_db()
        self.assertEqual(commission.status, 'Paid')


@override_settings(REST_FRAMEWORK=REST_FRAMEWORK_FOR_TESTS)
class CompanyScopeTests(TestCase):
    """
    `companies/` serves two audiences, and used to serve only one.

    The whole viewset was `IsDevAdmin`, so `GET /api/companies/` answered 403
    to a COMPANY_ADMIN and the Settings page's company tab could never have
    loaded — a pre-existing defect that the authorization work made visible
    rather than introduced. Opening it up is only safe if the row-level scoping
    holds, so that is what most of this class tests: a company admin must reach
    exactly one company, theirs, and must not be able to tell whether any other
    exists.
    """

    OTHER_ROLES = (Role.HEAD_MANAGER, Role.BRANCH_MANAGER, Role.EMPLOYEE)

    @classmethod
    def setUpTestData(cls):
        services.ensure_default_plans()
        cls.company, cls.head_office = services.provision_company('Acme Consultancy')
        cls.kohima = Branch.objects.create(company=cls.company, name='Kohima', code='KOH')
        cls.rival, cls.rival_branch = services.provision_company('Rival Consultancy')

        def mk(username, role, company, branch):
            user = User.objects.create(
                username=username, role=role, company=company, branch=branch,
                email=f'{username}@example.com',
            )
            user.set_password(PASSWORD)
            user.save()
            return user

        cls.users = {
            Role.DEV_ADMIN: mk('devadmin', Role.DEV_ADMIN, None, None),
            Role.COMPANY_ADMIN: mk('coadmin', Role.COMPANY_ADMIN, cls.company, cls.head_office),
            Role.HEAD_MANAGER: mk('headmgr', Role.HEAD_MANAGER, cls.company, cls.head_office),
            Role.BRANCH_MANAGER: mk('branchmgr', Role.BRANCH_MANAGER, cls.company, cls.kohima),
            Role.EMPLOYEE: mk('employee', Role.EMPLOYEE, cls.company, cls.kohima),
        }
        cls.rival_admin = mk(
            'rivaladmin', Role.COMPANY_ADMIN, cls.rival, cls.rival_branch,
        )

    def setUp(self):
        super().setUp()
        cache.clear()
        self._clients = {}

    def client_for(self, user):
        """One authenticated client per user, reused within a test method."""
        if user.username not in self._clients:
            client = APIClient()
            response = client.post('/api/auth/login/', {
                'username': user.username, 'password': PASSWORD,
            }, format='json')
            self.assertEqual(response.status_code, 200, f'{user.username} could not log in')
            client.credentials(HTTP_AUTHORIZATION=f'Bearer {response.data["access"]}')
            self._clients[user.username] = client
        return self._clients[user.username]

    def ids(self, response):
        return {row['id'] for row in response.data['results']}

    # ------------------------------------------------------------------ reads

    def test_company_admin_reads_exactly_their_own_company(self):
        """
        The Settings page builds its company tab from `companies/?page_size=1`
        and takes the first row (apiClient.ts:1712). That is only correct if
        the caller's own row is the only one in the list, so the count and the
        ids are both asserted — a list that happened to be ordered favourably
        would satisfy a weaker check while still leaking the rival's row.
        """
        client = self.client_for(self.users[Role.COMPANY_ADMIN])

        listing = client.get('/api/companies/')
        self.assertEqual(listing.status_code, 200, listing.data)
        self.assertEqual(self.ids(listing), {self.company.pk})
        self.assertEqual(listing.data['count'], 1)

        detail = client.get(f'/api/companies/{self.company.pk}/')
        self.assertEqual(detail.status_code, 200, detail.data)
        self.assertEqual(detail.data['name'], 'Acme Consultancy')

    def test_another_companys_row_is_a_404_not_a_403(self):
        """
        404 on read and update, deliberately. A 403 for an id outside the
        caller's tenant confirms the row exists, which turns the detail route
        into an enumeration oracle for the platform's customer list.

        DELETE is the exception and answers 403: deleting a company is refused
        for a company admin before any row is looked up, so there is nothing to
        leak — the answer is the same whichever id was named.
        """
        client = self.client_for(self.users[Role.COMPANY_ADMIN])
        for method, expected in (('get', 404), ('patch', 404), ('delete', 403)):
            with self.subTest(method=method):
                response = getattr(client, method)(f'/api/companies/{self.rival.pk}/')
                self.assertEqual(
                    response.status_code, expected,
                    f'{method.upper()} on another tenant returned '
                    f'{response.status_code}: {getattr(response, "data", None)!r}',
                )

    def test_rival_admin_sees_none_of_this_company(self):
        """Scoping is symmetric, not a special case for one fixture."""
        client = self.client_for(self.rival_admin)
        listing = client.get('/api/companies/')
        self.assertEqual(listing.status_code, 200, listing.data)
        self.assertEqual(self.ids(listing), {self.rival.pk})
        self.assertEqual(
            client.get(f'/api/companies/{self.company.pk}/').status_code, 404,
        )

    def test_roles_below_company_admin_are_denied(self):
        """
        `manageSettings` is floored at COMPANY_ADMIN (capabilities.PROTECTED),
        so this is not merely the default — no permission-grid edit can hand
        the company profile to a manager or an employee.
        """
        for role in self.OTHER_ROLES:
            client = self.client_for(self.users[role])
            for label, response in (
                ('list', client.get('/api/companies/')),
                ('retrieve', client.get(f'/api/companies/{self.company.pk}/')),
                ('update', client.patch(
                    f'/api/companies/{self.company.pk}/', {'name': 'Hijacked'},
                    format='json',
                )),
                ('create', client.post(
                    '/api/companies/', {'name': 'Sneaky Ltd'}, format='json',
                )),
                ('destroy', client.delete(f'/api/companies/{self.company.pk}/')),
            ):
                with self.subTest(role=role, action=label):
                    self.assertEqual(
                        response.status_code, 403,
                        f'{label} as {role} returned {response.status_code}',
                    )

    # ----------------------------------------------------------------- writes

    def test_company_admin_updates_their_own_profile(self):
        """The positive path: the four fields the Settings form actually sends."""
        client = self.client_for(self.users[Role.COMPANY_ADMIN])
        response = client.patch(f'/api/companies/{self.company.pk}/', {
            'name': 'Acme Consultancy Ltd',
            'email': 'hello@acme.test',
            'phone': '9000000000',
            'address': 'Head Office, Kohima',
        }, format='json')
        self.assertEqual(response.status_code, 200, response.data)

        self.company.refresh_from_db()
        self.assertEqual(self.company.name, 'Acme Consultancy Ltd')
        self.assertEqual(self.company.email, 'hello@acme.test')
        self.assertEqual(self.company.phone, '9000000000')
        self.assertEqual(self.company.address, 'Head Office, Kohima')

    def test_protected_fields_are_not_writable_by_a_company_admin(self):
        """
        `is_active` and `slug` must survive an attempt to change them.

        The status is asserted alongside the persisted value on purpose. DRF
        drops read-only fields silently, so the request succeeds with 200 and
        the columns are untouched — "accepted and ignored", not "refused". A
        test that only checked the value would pass identically if the field
        were writable but the payload malformed, and one that insisted on a 403
        would be asserting behaviour this framework does not produce.
        """
        original_slug = self.company.slug
        client = self.client_for(self.users[Role.COMPANY_ADMIN])
        response = client.patch(f'/api/companies/{self.company.pk}/', {
            'name': 'Acme Consultancy',
            'is_active': False,
            'slug': 'acme-hijacked',
        }, format='json')
        self.assertEqual(response.status_code, 200, response.data)

        self.company.refresh_from_db()
        self.assertTrue(
            self.company.is_active,
            'a company admin switched their own tenant is_active flag',
        )
        self.assertEqual(self.company.slug, original_slug)
        self.assertTrue(response.data['is_active'])

    def test_subscription_limits_are_unreachable_from_the_profile(self):
        """
        The plan decides seat and branch caps, so a company admin who could
        re-point it could lift their own limits. `subscription` is a read-only
        nested serializer; this pins that a nested write is ignored.
        """
        scale = Plan.objects.get(slug='scale')
        subscription = self.company.subscription
        original_plan_id = subscription.plan_id
        self.assertNotEqual(original_plan_id, scale.pk, 'fixture must not start on Scale')

        client = self.client_for(self.users[Role.COMPANY_ADMIN])
        response = client.patch(f'/api/companies/{self.company.pk}/', {
            'subscription': {'plan': scale.pk},
        }, format='json')
        self.assertEqual(response.status_code, 200, response.data)

        subscription.refresh_from_db()
        self.assertEqual(subscription.plan_id, original_plan_id)

    def test_company_admin_cannot_create_or_delete_a_company(self):
        """
        Provisioning and removing tenants is `manageCompanies`, floored at
        DEV_ADMIN and undelegable — a company admin holding `manageSettings`
        must not inherit it as a side effect of being able to read their row.
        """
        client = self.client_for(self.users[Role.COMPANY_ADMIN])
        before = Company.objects.count()

        created = client.post('/api/companies/', {'name': 'Sneaky Ltd'}, format='json')
        self.assertEqual(created.status_code, 403, created.data)

        destroyed = client.delete(f'/api/companies/{self.company.pk}/')
        self.assertEqual(destroyed.status_code, 403, destroyed.data)

        self.assertEqual(Company.objects.count(), before)
        self.assertTrue(Company.objects.filter(pk=self.company.pk).exists())

    def test_dev_admin_retains_full_access(self):
        """
        The other half of the fix: none of the above was bought by narrowing
        the platform operator, who must still see every tenant and be able to
        provision, suspend and remove one.
        """
        client = self.client_for(self.users[Role.DEV_ADMIN])

        listing = client.get('/api/companies/')
        self.assertEqual(listing.status_code, 200, listing.data)
        self.assertEqual(self.ids(listing), {self.company.pk, self.rival.pk})

        self.assertEqual(
            client.get(f'/api/companies/{self.rival.pk}/').status_code, 200,
        )

        created = client.post('/api/companies/', {'name': 'Newco Ltd'}, format='json')
        self.assertEqual(created.status_code, 201, created.data)

        # `is_active` stays writable for the operator — it is the suspension
        # switch, and CompanyProfileSerializer locks it only for everyone else.
        toggled = client.patch(
            f'/api/companies/{self.rival.pk}/', {'is_active': False}, format='json',
        )
        self.assertEqual(toggled.status_code, 200, toggled.data)
        self.rival.refresh_from_db()
        self.assertFalse(self.rival.is_active)

        self.assertEqual(
            client.delete(f'/api/companies/{created.data["id"]}/').status_code, 204,
        )
