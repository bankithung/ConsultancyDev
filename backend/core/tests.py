"""
End-to-end verification of authentication, tenant isolation, the role
hierarchy, the CRM workflow, transfers and subscription limits.

Every test here corresponds to a defect found in the pre-build audit; the
originals are named in the docstrings so a regression is recognisable.
"""

import os
import tempfile
from decimal import Decimal

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.exceptions import ImproperlyConfigured
from django.db import connection
from django.db.backends.sqlite3.base import DatabaseWrapper as SQLiteDatabaseWrapper
from django.http import QueryDict
from django.test import SimpleTestCase, TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from unittest.mock import patch

from rest_framework import status
from rest_framework.test import APIClient
from rest_framework.throttling import SimpleRateThrottle, UserRateThrottle

from config.settings import _guard_sqlite_engine, _throttle_rates
from core import services
from core.caching import scope_signature, scoped_cache_key
from core.middleware import ApiGZipMiddleware
from core.throttling import BurstUserRateThrottle
from core.models import (
    Appointment, ApprovalRequest, Branch, Company, Document, Enquiry,
    Enrollment, FollowUp, Payment, Plan, RecordTransfer, Refund, Registration,
    Role, StudentDocument, Subscription,
)

User = get_user_model()
PASSWORD = 'Testing!2026xyz'


# NOTE: this override does NOT disable throttling, despite declaring no
# throttle keys. `APIView.throttle_classes` and `SimpleRateThrottle`'s rate
# table are both class attributes bound at IMPORT time, so replacing the
# REST_FRAMEWORK setting later leaves the already-imported classes reading the
# originals. What actually keeps the 8/min login scope from failing tests --
# each of which logs in several times against a shared cache -- is the
# `cache.clear()` in setUp below, which resets the counters per test.
# Throttling itself is covered by ThrottleTests at the end of this file; see
# `throttle_rates` there for the lever that does work.
@override_settings(REST_FRAMEWORK={
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
})
class BaseAPITestCase(TestCase):
    """Builds two companies, three branches and the full role ladder."""

    def setUp(self):
        super().setUp()
        cache.clear()

    @classmethod
    def setUpTestData(cls):
        services.ensure_default_plans()

        cls.company, cls.head_office = services.provision_company('Acme Consultancy')
        cls.kohima = Branch.objects.create(company=cls.company, name='Kohima', code='KOH')
        cls.dimapur = Branch.objects.create(company=cls.company, name='Dimapur', code='DMP')

        cls.rival, cls.rival_branch = services.provision_company('Rival Consultancy')

        def mk(username, role, company, branch):
            user = User.objects.create(
                username=username, role=role, company=company, branch=branch,
                email=f'{username}@example.com',
            )
            user.set_password(PASSWORD)
            user.save()
            return user

        cls.dev = mk('dev', Role.DEV_ADMIN, None, None)
        cls.admin = mk('admin', Role.COMPANY_ADMIN, cls.company, cls.head_office)
        cls.head = mk('head', Role.HEAD_MANAGER, cls.company, cls.head_office)
        cls.mgr_k = mk('mgr_k', Role.BRANCH_MANAGER, cls.company, cls.kohima)
        cls.mgr_d = mk('mgr_d', Role.BRANCH_MANAGER, cls.company, cls.dimapur)
        cls.emp_k1 = mk('emp_k1', Role.EMPLOYEE, cls.company, cls.kohima)
        cls.emp_k2 = mk('emp_k2', Role.EMPLOYEE, cls.company, cls.kohima)
        cls.emp_d1 = mk('emp_d1', Role.EMPLOYEE, cls.company, cls.dimapur)
        cls.rival_admin = mk('rival_admin', Role.COMPANY_ADMIN, cls.rival, cls.rival_branch)

        cls.head.managed_managers.set([cls.mgr_k])  # oversees Kohima only

        def enquiry(owner, branch, name):
            return Enquiry.objects.create(
                company=owner.company, branch=branch, created_by=owner, owner=owner,
                school_name='School', stream='Science', candidate_name=name,
                course_interested='BTech', mobile='9000000000',
                email=f'{name}@example.com', father_name='F', mother_name='M',
                permanent_address='Addr',
            )

        cls.enq_k1 = enquiry(cls.emp_k1, cls.kohima, 'kohima-one')
        cls.enq_k2 = enquiry(cls.emp_k2, cls.kohima, 'kohima-two')
        cls.enq_d1 = enquiry(cls.emp_d1, cls.dimapur, 'dimapur-one')
        cls.enq_rival = enquiry(cls.rival_admin, cls.rival_branch, 'rival-one')

    def auth(self, user):
        client = APIClient()
        response = client.post(
            '/api/auth/login/',
            {'username': user.username, 'password': PASSWORD},
            format='json',
        )
        self.assertEqual(response.status_code, 200, response.data)
        client.credentials(HTTP_AUTHORIZATION=f'Bearer {response.data["access"]}')
        return client

    def names(self, response):
        results = response.data['results'] if 'results' in response.data else response.data
        return {row['candidate_name'] for row in results}


class AnonymousAccessTests(BaseAPITestCase):
    """
    Audit C-1: 21 of 24 viewsets declared no permission class, so DRF's
    AllowAny default made them fully public â€” including DELETE.
    """

    ENDPOINTS = [
        'enquiries', 'registrations', 'enrollments', 'installments', 'payments',
        'documents', 'tasks', 'appointments', 'universities', 'templates',
        'commissions', 'refunds', 'visa-tracking', 'follow-ups',
        'agents', 'transfers', 'approval-requests', 'users', 'branches',
        'companies', 'subscriptions', 'notifications',
    ]

    def test_every_list_endpoint_requires_authentication(self):
        client = APIClient()
        for endpoint in self.ENDPOINTS:
            with self.subTest(endpoint=endpoint):
                response = client.get(f'/api/{endpoint}/')
                self.assertIn(
                    response.status_code,
                    (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN),
                    f'/api/{endpoint}/ returned {response.status_code} anonymously',
                )

    def test_anonymous_delete_is_blocked(self):
        client = APIClient()
        response = client.delete(f'/api/enquiries/{self.enq_k1.pk}/')
        self.assertIn(response.status_code, (401, 403))
        self.assertTrue(Enquiry.objects.filter(pk=self.enq_k1.pk).exists())

    def test_anonymous_write_is_blocked(self):
        client = APIClient()
        response = client.patch(
            f'/api/enquiries/{self.enq_k1.pk}/', {'status': 'Closed'}, format='json',
        )
        self.assertIn(response.status_code, (401, 403))

    def test_public_endpoints_stay_public(self):
        client = APIClient()
        self.assertEqual(client.get('/api/health/').status_code, 200)
        self.assertEqual(client.get('/api/plans/').status_code, 200)


class PrivilegeEscalationTests(BaseAPITestCase):
    """Audit C-2: `role` was writable, so any user could PATCH themselves to DEV_ADMIN."""

    def test_employee_cannot_promote_self_to_any_role(self):
        """
        Every elevated role, not just DEV_ADMIN.

        The original version tried DEV_ADMIN only â€” the one role rejected by
        name in the serializer's validate() â€” so it passed while COMPANY_ADMIN,
        HEAD_MANAGER and BRANCH_MANAGER were all reachable.

        The assertion is on persisted STATE, not the status code: DRF silently
        drops read-only fields, so a well-behaved refusal is a 200 whose write
        did nothing. Asserting 400 here would over-specify that behaviour. The
        status is carried into the failure message so a regression is
        diagnosable without a re-run.
        """
        for role in (Role.DEV_ADMIN, Role.COMPANY_ADMIN, Role.HEAD_MANAGER,
                     Role.BRANCH_MANAGER):
            with self.subTest(role=role):
                client = self.auth(self.emp_k1)
                response = client.patch(
                    f'/api/users/{self.emp_k1.pk}/', {'role': role}, format='json',
                )
                self.emp_k1.refresh_from_db()
                self.assertEqual(
                    self.emp_k1.role, Role.EMPLOYEE,
                    f'employee escalated to {role} (HTTP {response.status_code})',
                )

    def test_employee_cannot_move_themselves_to_another_branch(self):
        """Self-assignment to a branch grants visibility of that branch's data."""
        client = self.auth(self.emp_k1)
        response = client.patch(
            f'/api/users/{self.emp_k1.pk}/',
            {'role': Role.BRANCH_MANAGER, 'branch': self.dimapur.pk},
            format='json',
        )
        self.emp_k1.refresh_from_db()
        self.assertEqual(
            self.emp_k1.branch_id, self.kohima.pk,
            f'branch was reassigned (HTTP {response.status_code})',
        )
        self.assertEqual(
            self.emp_k1.role, Role.EMPLOYEE,
            f'role was escalated (HTTP {response.status_code})',
        )
        self.assertNotIn('dimapur-one', self.names(client.get('/api/enquiries/')))

    def test_password_cannot_be_changed_without_the_current_one(self):
        """
        A stolen 15-minute access token must not become permanent control.

        Self-service password changes go through the change-password action,
        which requires the current password. A bare PATCH must not be a
        second, unguarded route to the same thing.
        """
        client = self.auth(self.emp_k1)
        response = client.patch(
            f'/api/users/{self.emp_k1.pk}/', {'password': 'Hijacked!2026pw'}, format='json',
        )
        self.emp_k1.refresh_from_db()
        self.assertFalse(
            self.emp_k1.check_password('Hijacked!2026pw'),
            f'password changed without the current one (HTTP {response.status_code})',
        )
        self.assertTrue(self.emp_k1.check_password(PASSWORD), 'original password was disturbed')

    def test_change_password_action_requires_the_current_password(self):
        client = self.auth(self.emp_k1)
        rejected = client.post('/api/users/change-password/', {
            'current_password': 'wrong-password', 'new_password': 'Fresh!2026pass',
        }, format='json')
        self.assertEqual(rejected.status_code, 400)

        accepted = client.post('/api/users/change-password/', {
            'current_password': PASSWORD, 'new_password': 'Fresh!2026pass',
        }, format='json')
        self.assertEqual(accepted.status_code, 200)
        self.emp_k1.refresh_from_db()
        self.assertTrue(self.emp_k1.check_password('Fresh!2026pass'))

    def test_employee_cannot_create_a_user(self):
        client = self.auth(self.emp_k1)
        response = client.post('/api/users/', {
            'username': 'sneaky', 'password': PASSWORD, 'role': Role.DEV_ADMIN,
        }, format='json')
        self.assertEqual(response.status_code, 403)
        self.assertFalse(User.objects.filter(username='sneaky').exists())

    def test_company_admin_cannot_mint_a_dev_admin(self):
        client = self.auth(self.admin)
        response = client.post('/api/users/', {
            'username': 'newdev', 'password': PASSWORD,
            'role': Role.DEV_ADMIN, 'branch': self.kohima.pk,
        }, format='json')
        self.assertEqual(response.status_code, 400)

    def test_password_is_hashed_on_update(self):
        """Audit H-1: UserSerializer had no update(), storing passwords in plaintext."""
        client = self.auth(self.admin)
        response = client.patch(
            f'/api/users/{self.emp_k1.pk}/', {'password': 'BrandNew!2026pass'}, format='json',
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.emp_k1.refresh_from_db()
        self.assertNotEqual(self.emp_k1.password, 'BrandNew!2026pass')
        self.assertTrue(self.emp_k1.check_password('BrandNew!2026pass'))


class TenantIsolationTests(BaseAPITestCase):
    """Audit C-3: company_id was client-writable and querysets were unscoped."""

    def test_rival_company_sees_only_its_own_records(self):
        client = self.auth(self.rival_admin)
        self.assertEqual(self.names(client.get('/api/enquiries/')), {'rival-one'})

    def test_rival_cannot_retrieve_our_record(self):
        client = self.auth(self.rival_admin)
        self.assertEqual(client.get(f'/api/enquiries/{self.enq_k1.pk}/').status_code, 404)

    def test_rival_cannot_delete_our_record(self):
        client = self.auth(self.rival_admin)
        client.delete(f'/api/enquiries/{self.enq_k1.pk}/')
        self.assertTrue(Enquiry.objects.filter(pk=self.enq_k1.pk).exists())

    def test_company_cannot_be_reassigned_by_payload(self):
        client = self.auth(self.admin)
        client.patch(
            f'/api/enquiries/{self.enq_k1.pk}/',
            {'company': self.rival.pk, 'branch': self.rival_branch.pk},
            format='json',
        )
        self.enq_k1.refresh_from_db()
        self.assertEqual(self.enq_k1.company_id, self.company.pk)

    def test_created_by_cannot_be_forged(self):
        client = self.auth(self.emp_k1)
        response = client.post('/api/enquiries/', {
            'school_name': 'S', 'stream': 'Science', 'candidate_name': 'forged',
            'course_interested': 'BTech', 'mobile': '9', 'email': 'a@b.com',
            'father_name': 'F', 'mother_name': 'M', 'permanent_address': 'A',
            'created_by': self.admin.pk, 'owner': self.admin.pk,
        }, format='json')
        self.assertEqual(response.status_code, 201, response.data)
        created = Enquiry.objects.get(candidate_name='forged')
        self.assertEqual(created.created_by_id, self.emp_k1.pk)
        self.assertEqual(created.company_id, self.company.pk)


class RoleScopingTests(BaseAPITestCase):
    """The hierarchy: admin > head manager > branch manager > employee."""

    def test_company_admin_sees_all_branches(self):
        client = self.auth(self.admin)
        self.assertEqual(
            self.names(client.get('/api/enquiries/')),
            {'kohima-one', 'kohima-two', 'dimapur-one'},
        )

    def test_branch_manager_sees_only_their_branch(self):
        client = self.auth(self.mgr_k)
        self.assertEqual(
            self.names(client.get('/api/enquiries/')), {'kohima-one', 'kohima-two'},
        )

    def test_head_manager_sees_the_branches_of_managers_they_oversee(self):
        """Oversees Kohima's manager only, so Dimapur stays hidden."""
        client = self.auth(self.head)
        names = self.names(client.get('/api/enquiries/'))
        self.assertIn('kohima-one', names)
        self.assertNotIn('dimapur-one', names)

    def test_head_manager_scope_expands_with_assignment(self):
        self.head.managed_managers.add(self.mgr_d)
        client = self.auth(self.head)
        self.assertIn('dimapur-one', self.names(client.get('/api/enquiries/')))

    def test_employee_sees_only_their_own_records(self):
        client = self.auth(self.emp_k1)
        self.assertEqual(self.names(client.get('/api/enquiries/')), {'kohima-one'})

    def test_employee_cannot_see_a_colleague_in_the_same_branch(self):
        client = self.auth(self.emp_k1)
        self.assertEqual(client.get(f'/api/enquiries/{self.enq_k2.pk}/').status_code, 404)

    def test_dev_admin_sees_every_company(self):
        client = self.auth(self.dev)
        self.assertEqual(len(self.names(client.get('/api/enquiries/'))), 4)

    def test_employee_cannot_delete_directly(self):
        """Audit M-1: destroy() was not overridden, so DELETE bypassed approvals."""
        client = self.auth(self.emp_k1)
        self.assertEqual(client.delete(f'/api/enquiries/{self.enq_k1.pk}/').status_code, 403)
        self.assertTrue(Enquiry.objects.filter(pk=self.enq_k1.pk).exists())

    def test_manager_can_delete_within_their_branch(self):
        client = self.auth(self.mgr_k)
        self.assertEqual(client.delete(f'/api/enquiries/{self.enq_k1.pk}/').status_code, 204)


class TransferTests(BaseAPITestCase):
    """Audit: DocumentTransfer changed no ownership field, so it granted nothing."""

    def test_transfer_moves_ownership_and_grants_visibility(self):
        client = self.auth(self.emp_k1)
        response = client.post('/api/transfers/', {
            'entity_type': 'enquiry', 'entity_id': self.enq_k1.pk,
            'to_user': self.emp_k2.pk, 'note': 'Please take over.',
        }, format='json')
        self.assertEqual(response.status_code, 201, response.data)

        # Peer-to-peer needs acceptance, so nothing moves yet.
        recipient = self.auth(self.emp_k2)
        self.assertNotIn('kohima-one', self.names(recipient.get('/api/enquiries/')))

        transfer = RecordTransfer.objects.get(entity_id=self.enq_k1.pk)
        self.assertEqual(recipient.post(f'/api/transfers/{transfer.pk}/accept/').status_code, 200)

        self.enq_k1.refresh_from_db()
        self.assertEqual(self.enq_k1.owner_id, self.emp_k2.pk)
        self.assertIn('kohima-one', self.names(recipient.get('/api/enquiries/')))

    def test_original_owner_loses_access_after_transfer(self):
        transfer = services.create_transfer(
            actor=self.mgr_k, entity_type='enquiry',
            entity_id=self.enq_k1.pk, to_user=self.emp_d1,
        )
        self.assertEqual(transfer.status, RecordTransfer.Status.ACCEPTED)
        client = self.auth(self.emp_k1)
        self.assertNotIn('kohima-one', self.names(client.get('/api/enquiries/')))

    def test_cannot_transfer_to_another_company(self):
        client = self.auth(self.admin)
        response = client.post('/api/transfers/', {
            'entity_type': 'enquiry', 'entity_id': self.enq_k1.pk,
            'to_user': self.rival_admin.pk,
        }, format='json')
        self.assertEqual(response.status_code, 400)

    def test_cannot_transfer_another_companys_record(self):
        client = self.auth(self.admin)
        response = client.post('/api/transfers/', {
            'entity_type': 'enquiry', 'entity_id': self.enq_rival.pk,
            'to_user': self.emp_k1.pk,
        }, format='json')
        self.assertEqual(response.status_code, 400)

    def test_employee_cannot_transfer_a_record_they_cannot_see(self):
        """
        Transfers were a second route to cross-branch theft.

        `create_transfer` resolved the target directly and checked company
        only, so a Kohima employee could name a Dimapur record invisible to
        them and move it.
        """
        client = self.auth(self.emp_k1)
        response = client.post('/api/transfers/', {
            'entity_type': 'enquiry', 'entity_id': self.enq_d1.pk,
            'to_user': self.emp_k2.pk,
        }, format='json')
        self.assertEqual(response.status_code, 400)
        self.enq_d1.refresh_from_db()
        self.assertEqual(self.enq_d1.owner_id, self.emp_d1.pk)

    def test_manager_cannot_drain_another_branch_via_transfer(self):
        """
        The serious variant: a manager's transfer applies immediately AND
        apply_transfer rewrites branch_id to follow the recipient. Without an
        authority check on the subject, a branch manager could pull any record
        in the company into their own branch, one request at a time.
        """
        client = self.auth(self.mgr_k)
        before = self.names(client.get('/api/enquiries/'))
        self.assertNotIn('dimapur-one', before)

        response = client.post('/api/transfers/', {
            'entity_type': 'enquiry', 'entity_id': self.enq_d1.pk,
            'to_user': self.emp_k1.pk,
        }, format='json')
        self.assertEqual(response.status_code, 400)

        self.enq_d1.refresh_from_db()
        self.assertEqual(self.enq_d1.branch_id, self.dimapur.pk, 'record was moved between branches')
        self.assertNotIn('dimapur-one', self.names(client.get('/api/enquiries/')))

    def test_only_recipient_can_accept(self):
        transfer = services.create_transfer(
            actor=self.emp_k1, entity_type='enquiry',
            entity_id=self.enq_k1.pk, to_user=self.emp_k2,
        )
        client = self.auth(self.emp_d1)
        self.assertIn(client.post(f'/api/transfers/{transfer.pk}/accept/').status_code, (403, 404))


class ApprovalWorkflowTests(BaseAPITestCase):
    """Audit C-4/C-5: cross-tenant confused deputy and unrestricted setattr."""

    def test_cannot_target_another_companys_record(self):
        client = self.auth(self.emp_k1)
        response = client.post('/api/approval-requests/', {
            'action': 'DELETE', 'entity_type': 'enquiry',
            'entity_id': self.enq_rival.pk, 'message': 'cleanup',
        }, format='json')
        self.assertEqual(response.status_code, 400)
        self.assertTrue(Enquiry.objects.filter(pk=self.enq_rival.pk).exists())

    def test_pending_changes_cannot_touch_unlisted_fields(self):
        client = self.auth(self.emp_k1)
        response = client.post('/api/approval-requests/', {
            'action': 'UPDATE', 'entity_type': 'enquiry',
            'entity_id': self.enq_k1.pk,
            'pending_changes': {'company': self.rival.pk, 'status': 'Closed'},
        }, format='json')
        self.assertEqual(response.status_code, 201, response.data)

        admin = self.auth(self.admin)
        approval_id = response.data['id']
        self.assertEqual(
            admin.post(f'/api/approval-requests/{approval_id}/approve/').status_code, 200,
        )

        self.enq_k1.refresh_from_db()
        self.assertEqual(self.enq_k1.status, 'Closed')             # allowed field applied
        self.assertEqual(self.enq_k1.company_id, self.company.pk)  # tenant untouched

    def test_cannot_target_a_record_in_another_branch(self):
        """
        The confused deputy, one level down from cross-tenant.

        A Kohima employee names a Dimapur record they cannot see; the request
        is stamped with the requester's branch, so it lands in the Kohima
        manager's queue and that manager â€” who does not control Dimapur â€”
        approves its destruction.
        """
        client = self.auth(self.emp_k1)
        response = client.post('/api/approval-requests/', {
            'action': 'DELETE', 'entity_type': 'enquiry',
            'entity_id': self.enq_d1.pk, 'message': 'routine cleanup',
        }, format='json')
        self.assertEqual(
            response.status_code, 400,
            'employee filed a request against a record in another branch',
        )
        self.assertTrue(Enquiry.objects.filter(pk=self.enq_d1.pk).exists())

    def test_manager_cannot_approve_outside_their_branch(self):
        """Even a validly-filed request must be re-checked at approval time."""
        approval = ApprovalRequest.objects.create(
            action='DELETE', entity_type='enquiry', entity_id=self.enq_d1.pk,
            company=self.company, branch=self.kohima, requested_by=self.emp_k1,
        )
        client = self.auth(self.mgr_k)  # Kohima manager, Dimapur target
        response = client.post(f'/api/approval-requests/{approval.pk}/approve/')
        self.assertIn(response.status_code, (403, 404))
        self.assertTrue(Enquiry.objects.filter(pk=self.enq_d1.pk).exists())

    def test_request_is_routed_to_the_branch_that_owns_the_record(self):
        """A manager sees requests about their own branch's records."""
        client = self.auth(self.emp_k1)
        response = client.post('/api/approval-requests/', {
            'action': 'DELETE', 'entity_type': 'enquiry',
            'entity_id': self.enq_k1.pk, 'message': 'duplicate',
        }, format='json')
        self.assertEqual(response.status_code, 201, response.data)
        approval = ApprovalRequest.objects.get(pk=response.data['id'])
        self.assertEqual(approval.branch_id, self.kohima.pk)

        manager = self.auth(self.mgr_k)
        self.assertEqual(
            manager.post(f'/api/approval-requests/{approval.pk}/approve/').status_code, 200,
        )
        self.assertFalse(Enquiry.objects.filter(pk=self.enq_k1.pk).exists())

    def test_failed_approval_does_not_record_success(self):
        """Audit M-2: status was written APPROVED before the action was attempted."""
        approval = ApprovalRequest.objects.create(
            action='DELETE', entity_type='enquiry', entity_id=999999,
            company=self.company, branch=self.kohima, requested_by=self.emp_k1,
        )
        client = self.auth(self.admin)
        self.assertEqual(
            client.post(f'/api/approval-requests/{approval.pk}/approve/').status_code, 400,
        )
        approval.refresh_from_db()
        self.assertEqual(approval.status, ApprovalRequest.Status.PENDING)


class CrmWorkflowTests(BaseAPITestCase):
    """The full journey: enquiry -> registration -> enrollment -> payment."""

    def test_end_to_end_pipeline(self):
        client = self.auth(self.emp_k1)

        enquiry = client.post('/api/enquiries/', {
            'school_name': 'Little Flower', 'stream': 'Science',
            'candidate_name': 'Journey Student', 'course_interested': 'BTech CS',
            'mobile': '9876543210', 'email': 'journey@example.com',
            'father_name': 'F', 'mother_name': 'M', 'permanent_address': 'Kohima',
        }, format='json')
        self.assertEqual(enquiry.status_code, 201, enquiry.data)

        registration = client.post('/api/registrations/', {
            'registration_no': 'REG-T-001', 'student_name': 'Journey Student',
            'mobile': '9876543210', 'email': 'journey@example.com',
            'registration_fee': '15000.00', 'payment_status': 'Paid',
            'payment_method': 'Cash', 'enquiry': enquiry.data['id'],
            'date_of_birth': '2005-04-11',
        }, format='json')
        self.assertEqual(registration.status_code, 201, registration.data)

        # A payment is booked automatically, with the status actually chosen.
        payment = Payment.objects.get(registration_id=registration.data['id'])
        self.assertEqual(payment.status, Payment.Status.SUCCESS)
        self.assertEqual(payment.amount, Decimal('15000.00'))
        self.assertEqual(payment.company_id, self.company.pk)
        self.assertEqual(payment.branch_id, self.kohima.pk)

        enrollment = client.post('/api/enrollments/', {
            'enrollment_no': 'ENR-T-001', 'student': registration.data['id'],
            'program_name': 'MSc CS', 'country': 'UK',
            'start_date': timezone.now().date().isoformat(),
            'duration_months': 24, 'total_fees': '1000.00',
            'installments_count': 3,
        }, format='json')
        self.assertEqual(enrollment.status_code, 201, enrollment.data)

        # Audit M-7: instalments must sum exactly to the total.
        obj = Enrollment.objects.get(pk=enrollment.data['id'])
        self.assertEqual(obj.installments.count(), 3)
        self.assertEqual(sum(i.amount for i in obj.installments.all()), Decimal('1000.00'))

    def test_pending_registration_does_not_book_revenue(self):
        """Audit M-6: every registration booked a successful cash payment."""
        client = self.auth(self.emp_k1)
        response = client.post('/api/registrations/', {
            'registration_no': 'REG-T-002', 'student_name': 'Unpaid Student',
            'mobile': '9', 'email': 'u@example.com', 'registration_fee': '5000.00',
            'payment_status': 'Pending', 'payment_method': 'Bank Transfer',
        }, format='json')
        self.assertEqual(response.status_code, 201, response.data)
        payment = Payment.objects.get(registration_id=response.data['id'])
        self.assertEqual(payment.status, Payment.Status.PENDING)
        self.assertEqual(payment.method, 'Bank Transfer')

    def test_date_of_birth_is_encrypted_at_rest(self):
        client = self.auth(self.emp_k1)
        response = client.post('/api/registrations/', {
            'registration_no': 'REG-ENC-1', 'student_name': 'Enc Student',
            'mobile': '9', 'email': 'e@example.com', 'registration_fee': '100.00',
            'date_of_birth': '2004-02-29',
        }, format='json')
        self.assertEqual(response.status_code, 201, response.data)

        from django.db import connection
        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT date_of_birth FROM core_registration WHERE registration_no = %s',
                ['REG-ENC-1'],
            )
            stored = cursor.fetchone()[0]
        self.assertNotIn('2004', stored or '')
        self.assertTrue((stored or '').startswith('gAAAAA'))

        registration = Registration.objects.get(registration_no='REG-ENC-1')
        self.assertEqual(registration.date_of_birth.isoformat(), '2004-02-29')

    def test_registration_number_is_unique_per_company_not_globally(self):
        """Audit B-1: global uniqueness let one tenant block another's numbering."""
        ours = self.auth(self.emp_k1)
        theirs = self.auth(self.rival_admin)
        payload = {
            'registration_no': 'REG-SHARED-1', 'student_name': 'A',
            'mobile': '9', 'email': 'a@example.com', 'registration_fee': '1.00',
        }
        self.assertEqual(ours.post('/api/registrations/', payload, format='json').status_code, 201)
        self.assertEqual(theirs.post('/api/registrations/', payload, format='json').status_code, 201)


class QueryCountTests(BaseAPITestCase):
    """
    A correctly-prefetched list endpoint costs the SAME number of queries
    regardless of row count. Any growth is a per-row query.
    """

    def _hire(self, n, prefix):
        for i in range(n):
            User.objects.create(
                username=f'{prefix}{i}', role=Role.EMPLOYEE,
                company=self.company, branch=self.kohima,
            )

    def test_users_list_does_not_scale_queries_with_rows(self):
        """
        Admins get UserAdminSerializer, which serialises the managed_managers
        M2M â€” one query per row without a prefetch. At the 200-row page cap
        that is 201 queries for a single load of /app/users. Invisible in a
        nine-user fixture, which is how it survived.
        """
        client = self.auth(self.admin)
        client.get('/api/users/')                      # warm any lazy setup

        self._hire(4, 'small')
        with CaptureQueriesContext(connection) as small:
            self.assertEqual(client.get('/api/users/').status_code, 200)

        self._hire(10, 'large')
        with CaptureQueriesContext(connection) as large:
            self.assertEqual(client.get('/api/users/').status_code, 200)

        self.assertEqual(
            len(large), len(small),
            f'query count grew with row count: {len(small)} -> {len(large)} '
            f'(N+1 on /api/users/)',
        )

    def test_enquiry_list_does_not_scale_queries_with_rows(self):
        client = self.auth(self.admin)
        client.get('/api/enquiries/')

        with CaptureQueriesContext(connection) as small:
            client.get('/api/enquiries/')

        for i in range(12):
            Enquiry.objects.create(
                company=self.company, branch=self.kohima,
                created_by=self.emp_k1, owner=self.emp_k1,
                school_name='S', stream='Science', candidate_name=f'bulk-{i}',
                course_interested='BTech', mobile='9', email=f'b{i}@example.com',
                father_name='F', mother_name='M', permanent_address='A',
            )

        with CaptureQueriesContext(connection) as large:
            client.get('/api/enquiries/')

        self.assertEqual(len(large), len(small), 'N+1 on /api/enquiries/')


class StudentFileTests(BaseAPITestCase):
    """
    The student-file features ported from the kikonsDev build: running remarks
    and custody of original physical documents.
    """

    def setUp(self):
        super().setUp()
        self.registration = Registration.objects.create(
            company=self.company, branch=self.kohima,
            created_by=self.emp_k1, owner=self.emp_k1,
            registration_no='REG-SF-1', student_name='File Student',
            mobile='9', email='sf@example.com', registration_fee=Decimal('100.00'),
        )
        self.rival_registration = Registration.objects.create(
            company=self.rival, branch=self.rival_branch,
            created_by=self.rival_admin, owner=self.rival_admin,
            registration_no='REG-SF-R', student_name='Rival Student',
            mobile='9', email='r@example.com', registration_fee=Decimal('100.00'),
        )

    def test_remark_is_attributed_to_the_caller_not_the_payload(self):
        client = self.auth(self.emp_k1)
        response = client.post('/api/student-remarks/', {
            'registration': self.registration.pk,
            'remark': 'Called the parents, they will visit Friday.',
            'user': self.admin.pk,          # attempt to attribute to someone else
        }, format='json')
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data['user'], self.emp_k1.pk)
        self.assertEqual(response.data['user_name'], self.emp_k1.username)

    def test_remarks_are_append_only(self):
        client = self.auth(self.emp_k1)
        created = client.post('/api/student-remarks/', {
            'registration': self.registration.pk, 'remark': 'Original note',
        }, format='json')
        edited = client.patch(
            f'/api/student-remarks/{created.data["id"]}/',
            {'remark': 'Rewritten history'}, format='json',
        )
        self.assertEqual(edited.status_code, 403)

    def test_cannot_attach_a_remark_to_another_companys_student(self):
        client = self.auth(self.emp_k1)
        response = client.post('/api/student-remarks/', {
            'registration': self.rival_registration.pk, 'remark': 'probe',
        }, format='json')
        self.assertEqual(response.status_code, 400)

    def test_original_document_custody_and_return(self):
        client = self.auth(self.emp_k1)
        created = client.post('/api/student-documents/', {
            'registration': self.registration.pk,
            'name': 'Passport (original)', 'document_number': 'M7654321',
        }, format='json')
        self.assertEqual(created.status_code, 201, created.data)
        # Whoever takes it in is holding it until stated otherwise.
        self.assertEqual(created.data['current_holder'], self.emp_k1.pk)
        self.assertEqual(created.data['status'], 'Received')

        returned = client.post('/api/student-documents/return-docs/', {
            'document_ids': [created.data['id']],
        }, format='json')
        self.assertEqual(returned.status_code, 200, returned.data)
        self.assertEqual(returned.data['returned'], 1)

        doc = StudentDocument.objects.get(pk=created.data['id'])
        self.assertEqual(doc.status, StudentDocument.Status.RETURNED)
        self.assertIsNotNone(doc.returned_at)
        self.assertIsNone(doc.current_holder)

    def test_return_docs_ignores_ids_outside_the_callers_scope(self):
        """An out-of-scope id must be inert, not actionable."""
        rival = self.auth(self.rival_admin)
        theirs = rival.post('/api/student-documents/', {
            'registration': self.rival_registration.pk, 'name': 'Rival passport',
        }, format='json')

        ours = self.auth(self.emp_k1)
        response = ours.post('/api/student-documents/return-docs/', {
            'document_ids': [theirs.data['id']],
        }, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['returned'], 0, 'acted on another tenant\'s document')

        untouched = StudentDocument.objects.get(pk=theirs.data['id'])
        self.assertEqual(untouched.status, StudentDocument.Status.RECEIVED)

    def test_student_documents_are_branch_scoped(self):
        client = self.auth(self.emp_k1)
        client.post('/api/student-documents/', {
            'registration': self.registration.pk, 'name': 'Kohima passport',
        }, format='json')
        other_branch = self.auth(self.emp_d1)
        listed = other_branch.get('/api/student-documents/')
        self.assertEqual(listed.data['count'], 0)


class PaginationTests(BaseAPITestCase):
    """Audit H-5: every list endpoint returned an unbounded bare array."""

    def test_list_is_paginated(self):
        client = self.auth(self.admin)
        response = client.get('/api/enquiries/')
        for key in ('count', 'pages', 'page', 'page_size', 'results'):
            self.assertIn(key, response.data)

    def test_page_size_is_capped(self):
        client = self.auth(self.admin)
        response = client.get('/api/enquiries/?page_size=100000')
        self.assertLessEqual(response.data['page_size'], 200)


class EnquiryFilterTests(BaseAPITestCase):
    """
    Multi-select filters on the enquiry directory.

    Every assertion here is about the SERVER doing the narrowing. A filter
    applied in the browser can only narrow the 25 rows already fetched, so it
    hides matches on later pages while the row count keeps reporting the
    unfiltered total.
    """

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        # A board name with a comma in it -- the case that makes comma-separated
        # filter values unusable for this vocabulary.
        cls.enq_k1.status = 'New'
        cls.enq_k1.school_board = 'SEBA (Board of Secondary Education, Assam)'
        cls.enq_k1.preferred_locations = ['Kota', 'Pune']
        cls.enq_k1.save()

        cls.enq_k2.status = 'Contacted'
        cls.enq_k2.preferred_locations = ['Bangalore']
        cls.enq_k2.save()

        cls.enq_d1.status = 'Closed'
        cls.enq_d1.preferred_locations = []
        cls.enq_d1.save()

    def test_repeated_parameter_matches_any_value(self):
        client = self.auth(self.admin)
        response = client.get('/api/enquiries/?status=New&status=Contacted')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.names(response), {'kohima-one', 'kohima-two'})
        # The envelope must agree with the rows: this is the whole point of
        # filtering server-side.
        self.assertEqual(response.data['count'], 2)

    def test_single_value_still_works(self):
        """Older call sites send one value; a list of one must behave the same."""
        client = self.auth(self.admin)
        response = client.get('/api/enquiries/?status=Closed')
        self.assertEqual(self.names(response), {'dimapur-one'})

    def test_value_containing_a_comma_is_not_split(self):
        client = self.auth(self.admin)
        response = client.get(
            '/api/enquiries/',
            {'school_board': 'SEBA (Board of Secondary Education, Assam)'},
        )
        self.assertEqual(self.names(response), {'kohima-one'})

    def test_json_list_column_matches_any_selected_value(self):
        client = self.auth(self.admin)
        response = client.get('/api/enquiries/?preferred_locations=Kota&preferred_locations=Bangalore')
        self.assertEqual(self.names(response), {'kohima-one', 'kohima-two'})

    def test_json_list_filter_does_not_match_a_substring(self):
        """`"Kot"` must not match `"Kota"` -- values are matched with quotes."""
        client = self.auth(self.admin)
        response = client.get('/api/enquiries/?preferred_locations=Kot')
        self.assertEqual(response.data['count'], 0)

    def test_owner_filter_accepts_several_ids(self):
        client = self.auth(self.admin)
        response = client.get(
            f'/api/enquiries/?owner={self.emp_k1.pk}&owner={self.emp_d1.pk}'
        )
        self.assertEqual(self.names(response), {'kohima-one', 'dimapur-one'})

    def test_non_numeric_id_is_a_client_error_not_a_crash(self):
        client = self.auth(self.admin)
        response = client.get('/api/enquiries/?owner=not-a-number')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_empty_parameter_does_not_filter_everything_out(self):
        """A cleared control can leave `?status=` behind; that is not a value."""
        client = self.auth(self.admin)
        response = client.get('/api/enquiries/?status=')
        self.assertEqual(response.data['count'], 3)

    def test_filters_cannot_widen_scope(self):
        """
        Filtering narrows what the role may already see -- it never reaches
        across the tenant boundary.
        """
        client = self.auth(self.mgr_k)
        response = client.get(
            f'/api/enquiries/?owner={self.emp_k1.pk}&owner={self.rival_admin.pk}'
        )
        self.assertEqual(self.names(response), {'kohima-one'})


class FollowUpSearchTests(BaseAPITestCase):
    """
    The follow-up board had a filter row but no search box, because the viewset
    declared no `search_fields`. DRF discards a parameter it does not recognise
    and answers 200 with the whole page, so a search box added without these
    would have looked like it worked and quietly matched everything.
    """

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.fu_k1 = FollowUp.objects.create(
            company=cls.company, branch=cls.kohima, created_by=cls.emp_k1,
            owner=cls.emp_k1, enquiry=cls.enq_k1, assigned_to=cls.emp_k1,
            scheduled_for=timezone.now(), status='Pending', priority='High',
            type='Call', notes='Asked about hostel fees',
        )
        cls.fu_k2 = FollowUp.objects.create(
            company=cls.company, branch=cls.kohima, created_by=cls.emp_k2,
            owner=cls.emp_k2, enquiry=cls.enq_k2, assigned_to=cls.emp_k2,
            scheduled_for=timezone.now(), status='Completed', priority='Low',
            type='Email', notes='Sent the prospectus',
        )

    def test_search_matches_the_students_name(self):
        client = self.auth(self.admin)
        response = client.get('/api/follow-ups/?search=kohima-one')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['count'], 1)
        self.assertEqual(response.data['results'][0]['id'], self.fu_k1.pk)

    def test_search_matches_the_notes(self):
        client = self.auth(self.admin)
        response = client.get('/api/follow-ups/?search=prospectus')
        self.assertEqual(response.data['count'], 1)
        self.assertEqual(response.data['results'][0]['id'], self.fu_k2.pk)

    def test_search_that_matches_nothing_returns_nothing(self):
        """The failure this guards: an ignored `?search=` returns everything."""
        client = self.auth(self.admin)
        response = client.get('/api/follow-ups/?search=zzzz-no-such-student')
        self.assertEqual(response.data['count'], 0)

    def test_status_accepts_several_values(self):
        client = self.auth(self.admin)
        one = client.get('/api/follow-ups/?status=Pending')
        both = client.get('/api/follow-ups/?status=Pending&status=Completed')
        self.assertEqual(one.data['count'], 1)
        self.assertEqual(both.data['count'], 2)

    def test_search_cannot_reach_across_the_tenant_boundary(self):
        FollowUp.objects.create(
            company=self.rival, branch=self.rival_branch, created_by=self.rival_admin,
            owner=self.rival_admin, enquiry=self.enq_rival,
            scheduled_for=timezone.now(), notes='Asked about hostel fees',
        )
        client = self.auth(self.admin)
        response = client.get('/api/follow-ups/?search=hostel')
        self.assertEqual(response.data['count'], 1)
        self.assertEqual(response.data['results'][0]['id'], self.fu_k1.pk)


class AppointmentFilterTests(BaseAPITestCase):
    """
    Filters behind the Appointments tab of the engagements screen.

    `AppointmentViewSet` declared no `filterset_class` at all, so every
    `?status=` it was ever sent was discarded and answered 200 with the WHOLE
    list. The old page worked around that by narrowing in the browser, and
    could only do so honestly over the calendar's complete month set -- its
    paginated list was deliberately offered no status control.

    The calendar action needs its own coverage because a custom action does not
    run the filter backends unless it calls `filter_queryset`; being scoped is
    not the same as being filtered.
    """

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()

        # Fixed months so the calendar assertions do not depend on the day the
        # suite happens to run.
        cls.june = timezone.now().replace(
            month=6, day=15, hour=10, minute=0, second=0, microsecond=0,
        )
        cls.july = cls.june.replace(month=7, day=2)

        def appointment(owner, branch, name, when, status_value, type_value):
            return Appointment.objects.create(
                company=owner.company, branch=branch, created_by=owner, owner=owner,
                counselor=owner, student_name=name,
                student_email=f'{name.split()[0].lower()}@example.com',
                date=when, status=status_value, type=type_value,
            )

        cls.apt_k1 = appointment(
            cls.emp_k1, cls.kohima, 'Ana Kohima', cls.june, 'Scheduled', 'Video Call',
        )
        cls.apt_k2 = appointment(
            cls.emp_k2, cls.kohima, 'Ben Kohima', cls.june, 'Completed', 'Phone Call',
        )
        cls.apt_d1 = appointment(
            cls.emp_d1, cls.dimapur, 'Cara Dimapur', cls.july, 'Cancelled', 'In-Person',
        )
        cls.apt_rival = appointment(
            cls.rival_admin, cls.rival_branch, 'Ana Rival', cls.june, 'Scheduled', 'Video Call',
        )

    def student_names(self, response):
        rows = response.data['results'] if 'results' in response.data else response.data
        return {row['student_name'] for row in rows}

    def test_status_accepts_several_values(self):
        client = self.auth(self.admin)
        one = client.get('/api/appointments/?status=Scheduled')
        both = client.get('/api/appointments/?status=Scheduled&status=Cancelled')
        self.assertEqual(self.student_names(one), {'Ana Kohima'})
        self.assertEqual(self.student_names(both), {'Ana Kohima', 'Cara Dimapur'})
        # The envelope must agree with the rows, or the pager lies about a
        # filtered list.
        self.assertEqual(both.data['count'], 2)

    def test_an_unrecognised_status_matches_nothing(self):
        """
        The failure this guards: a discarded parameter answers 200 with the
        full list, which reads as "every appointment is Postponed".
        """
        client = self.auth(self.admin)
        response = client.get('/api/appointments/?status=Postponed')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['count'], 0)

    def test_type_filter_narrows_the_list(self):
        client = self.auth(self.admin)
        response = client.get('/api/appointments/?type=Video Call&type=In-Person')
        self.assertEqual(self.student_names(response), {'Ana Kohima', 'Cara Dimapur'})

    def test_counselor_filter_accepts_several_ids(self):
        client = self.auth(self.admin)
        response = client.get(
            f'/api/appointments/?counselor={self.emp_k1.pk}&counselor={self.emp_d1.pk}'
        )
        self.assertEqual(self.student_names(response), {'Ana Kohima', 'Cara Dimapur'})

    def test_non_numeric_counselor_is_a_client_error_not_a_crash(self):
        client = self.auth(self.admin)
        response = client.get('/api/appointments/?counselor=not-a-number')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_empty_parameter_does_not_filter_everything_out(self):
        """A cleared control can leave `?status=` behind; that is not a value."""
        client = self.auth(self.admin)
        response = client.get('/api/appointments/?status=')
        self.assertEqual(response.data['count'], 3)

    def test_search_matches_the_student_name(self):
        client = self.auth(self.admin)
        response = client.get('/api/appointments/?search=Ben')
        self.assertEqual(self.student_names(response), {'Ben Kohima'})

    def test_search_that_matches_nothing_returns_nothing(self):
        client = self.auth(self.admin)
        response = client.get('/api/appointments/?search=zzzz-no-such-client')
        self.assertEqual(response.data['count'], 0)

    def test_filters_cannot_widen_scope(self):
        """
        Filtering narrows what the role may already see. Naming another
        company's counsellor must not reach their appointments, and must not
        reach outside the manager's own branch either.
        """
        client = self.auth(self.mgr_k)
        response = client.get(
            f'/api/appointments/?counselor={self.emp_k1.pk}'
            f'&counselor={self.emp_d1.pk}&counselor={self.rival_admin.pk}'
        )
        self.assertEqual(self.student_names(response), {'Ana Kohima'})

    def test_calendar_honours_the_status_filter(self):
        """
        The calendar is a custom action, so it only filters if it asks. Being
        tenant-scoped is not the same as being filtered.
        """
        client = self.auth(self.admin)
        unfiltered = client.get(f'/api/appointments/calendar/?month=6&year={self.june.year}')
        filtered = client.get(
            f'/api/appointments/calendar/?month=6&year={self.june.year}&status=Completed'
        )
        self.assertEqual(self.student_names(unfiltered), {'Ana Kohima', 'Ben Kohima'})
        self.assertEqual(self.student_names(filtered), {'Ben Kohima'})

    def test_calendar_honours_the_search_term(self):
        client = self.auth(self.admin)
        response = client.get(
            f'/api/appointments/calendar/?month=6&year={self.june.year}&search=Ben'
        )
        self.assertEqual(self.student_names(response), {'Ben Kohima'})

    def test_calendar_filters_cannot_widen_scope(self):
        """`Ana` matches a rival's client too; the tenant boundary still holds."""
        client = self.auth(self.mgr_k)
        response = client.get(
            f'/api/appointments/calendar/?month=6&year={self.june.year}&search=Ana'
            f'&counselor={self.rival_admin.pk}&counselor={self.emp_k1.pk}'
        )
        self.assertEqual(self.student_names(response), {'Ana Kohima'})


class MoneyFilterTests(BaseAPITestCase):
    """
    Filters and search behind the payments screen's two tabs.

    Both endpoints were unsafe to put a control over. `RefundViewSet` declared
    no filters and no `search_fields` at all, and `PaymentViewSet` declared
    `filterset_fields`, whose generated filters are single-value: they read
    `data.get(name)` and so keep only the LAST repetition of a parameter.

    Both failures are silent. An unrecognised parameter is discarded and the
    endpoint answers 200 with the unfiltered list; a multi-select collapsed to
    its last value narrows the table, which looks even more like the control
    worked. Every test here asserts the SERVER narrowed, and the last two
    assert narrowing can never widen scope.
    """

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()

        def registration(owner, branch, name, number):
            return Registration.objects.create(
                company=owner.company, branch=branch, created_by=owner, owner=owner,
                registration_no=number, student_name=name, mobile='9000000000',
                email=f'{number.lower()}@example.com',
                registration_fee=Decimal('1000.00'),
            )

        def payment(registration_row, amount, status, method, kind):
            return Payment.objects.create(
                company=registration_row.company, branch=registration_row.branch,
                created_by=registration_row.owner, owner=registration_row.owner,
                registration=registration_row, student_name=registration_row.student_name,
                amount=Decimal(amount), date=timezone.now(), type=kind,
                status=status, method=method,
            )

        def refund(registration_row, payment_row, amount, status, reason):
            return Refund.objects.create(
                company=registration_row.company, branch=registration_row.branch,
                created_by=registration_row.owner, owner=registration_row.owner,
                student=registration_row, payment=payment_row, amount=Decimal(amount),
                reason=reason, status=status,
            )

        # The rival's student shares a name with ours on purpose: a search that
        # leaks across tenants would return two rows and look like a match.
        cls.reg_k1 = registration(cls.emp_k1, cls.kohima, 'Akum Longkumer', 'REG-K1')
        cls.reg_k2 = registration(cls.emp_k2, cls.kohima, 'Bendang Jamir', 'REG-K2')
        cls.reg_d1 = registration(cls.emp_d1, cls.dimapur, 'Chubala Ao', 'REG-D1')
        cls.reg_rival = registration(
            cls.rival_admin, cls.rival_branch, 'Akum Longkumer', 'REG-R1',
        )

        cls.pay_k1 = payment(
            cls.reg_k1, '5000.00', Payment.Status.SUCCESS, 'Cash', 'Registration',
        )
        cls.pay_k2 = payment(
            cls.reg_k2, '7000.00', Payment.Status.PENDING, 'UPI', 'Enrollment',
        )
        cls.pay_d1 = payment(
            cls.reg_d1, '9000.00', Payment.Status.FAILED, 'Cheque', 'Registration',
        )
        cls.pay_rival = payment(
            cls.reg_rival, '999.00', Payment.Status.SUCCESS, 'Cash', 'Registration',
        )

        cls.ref_k1 = refund(
            cls.reg_k1, cls.pay_k1, '1000.00', Refund.Status.PENDING,
            'Course cancelled before the intake',
        )
        cls.ref_k2 = refund(
            cls.reg_k2, cls.pay_k2, '2000.00', Refund.Status.APPROVED,
            'Duplicate transfer from the parent',
        )
        cls.ref_d1 = refund(
            cls.reg_d1, None, '3000.00', Refund.Status.REJECTED,
            'Withdrawal past the cutoff date',
        )
        cls.ref_rival = refund(
            cls.reg_rival, cls.pay_rival, '999.00', Refund.Status.PENDING,
            'Course cancelled before the intake',
        )

    def ids(self, response):
        return {row['id'] for row in response.data['results']}

    # ------------------------------------------------------------- refunds

    def test_refund_status_narrows_to_one_value(self):
        """The base case the ignored parameter used to fail: 3 of 3 came back."""
        client = self.auth(self.admin)
        response = client.get('/api/refunds/?status=Rejected')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.ids(response), {self.ref_d1.pk})
        self.assertEqual(response.data['count'], 1)

    def test_refund_status_accepts_several_values(self):
        client = self.auth(self.admin)
        response = client.get('/api/refunds/?status=Pending&status=Approved')
        self.assertEqual(self.ids(response), {self.ref_k1.pk, self.ref_k2.pk})
        # The envelope must agree with the rows, or paging reports a total the
        # table cannot account for.
        self.assertEqual(response.data['count'], 2)

    def test_refund_status_that_matches_nothing_returns_nothing(self):
        """A value outside the vocabulary must empty the list, not ignore it."""
        client = self.auth(self.admin)
        response = client.get('/api/refunds/?status=Reversed')
        self.assertEqual(response.data['count'], 0)

    def test_refund_empty_parameter_does_not_filter_everything_out(self):
        """A cleared control can leave `?status=` behind; that is not a value."""
        client = self.auth(self.admin)
        response = client.get('/api/refunds/?status=')
        self.assertEqual(response.data['count'], 3)

    def test_refund_payment_filter_narrows_to_one_payment(self):
        client = self.auth(self.admin)
        response = client.get(f'/api/refunds/?payment={self.pay_k1.pk}')
        self.assertEqual(self.ids(response), {self.ref_k1.pk})

    def test_refund_non_numeric_id_is_a_client_error_not_a_crash(self):
        client = self.auth(self.admin)
        response = client.get('/api/refunds/?payment=not-a-number')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_refund_search_matches_the_students_name(self):
        """`student_name` lives on the FK, so this proves the join is searched."""
        client = self.auth(self.admin)
        response = client.get('/api/refunds/?search=Bendang')
        self.assertEqual(self.ids(response), {self.ref_k2.pk})

    def test_refund_search_matches_the_reason(self):
        client = self.auth(self.admin)
        response = client.get('/api/refunds/?search=Duplicate transfer')
        self.assertEqual(self.ids(response), {self.ref_k2.pk})

    def test_refund_search_that_matches_nothing_returns_nothing(self):
        """The failure this guards: an ignored `?search=` returns everything."""
        client = self.auth(self.admin)
        response = client.get('/api/refunds/?search=zzzz-no-such-student')
        self.assertEqual(response.data['count'], 0)

    def test_refund_filters_cannot_widen_scope(self):
        """
        A filter narrows what the role may already see. Naming another
        company's user as the owner must not reach their rows.
        """
        client = self.auth(self.mgr_k)
        response = client.get(
            f'/api/refunds/?owner={self.emp_k1.pk}&owner={self.rival_admin.pk}'
        )
        self.assertEqual(self.ids(response), {self.ref_k1.pk})

    def test_refund_search_cannot_reach_across_the_tenant_boundary(self):
        client = self.auth(self.admin)
        response = client.get('/api/refunds/?search=Akum Longkumer')
        self.assertEqual(self.ids(response), {self.ref_k1.pk})

    def test_refund_status_filter_cannot_widen_scope(self):
        """A branch manager filtering on Pending sees their branch's Pending only."""
        client = self.auth(self.mgr_k)
        response = client.get('/api/refunds/?status=Pending')
        self.assertEqual(self.ids(response), {self.ref_k1.pk})

    # ------------------------------------------------------------ payments

    def test_payment_status_keeps_every_repetition(self):
        """
        The regression `filterset_fields` caused: the generated filter reads
        `data.get()`, so this used to answer with the Pending row alone.
        """
        client = self.auth(self.admin)
        response = client.get('/api/payments/?status=Success&status=Pending')
        self.assertEqual(self.ids(response), {self.pay_k1.pk, self.pay_k2.pk})
        self.assertEqual(response.data['count'], 2)

    def test_payment_single_value_still_works(self):
        """Older call sites send one value; a list of one must behave the same."""
        client = self.auth(self.admin)
        response = client.get('/api/payments/?status=Failed')
        self.assertEqual(self.ids(response), {self.pay_d1.pk})

    def test_payment_method_and_type_narrow_together(self):
        """Separate groups intersect; values within a group are alternatives."""
        client = self.auth(self.admin)
        response = client.get('/api/payments/?method=Cash&method=UPI&type=Registration')
        self.assertEqual(self.ids(response), {self.pay_k1.pk})

    def test_payment_empty_parameter_does_not_filter_everything_out(self):
        client = self.auth(self.admin)
        response = client.get('/api/payments/?status=')
        self.assertEqual(response.data['count'], 3)

    def test_payment_filters_cannot_widen_scope(self):
        client = self.auth(self.mgr_k)
        response = client.get(
            f'/api/payments/?branch={self.kohima.pk}&branch={self.rival_branch.pk}'
        )
        self.assertEqual(self.ids(response), {self.pay_k1.pk, self.pay_k2.pk})


class FinancialScopeTests(BaseAPITestCase):
    """Audit H-4: payment stats aggregated platform-wide with no auth."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        Payment.objects.create(
            company=cls.company, branch=cls.kohima, created_by=cls.emp_k1,
            owner=cls.emp_k1, student_name='ours', amount=Decimal('100.00'),
            type='Registration', status=Payment.Status.SUCCESS,
        )
        Payment.objects.create(
            company=cls.rival, branch=cls.rival_branch, created_by=cls.rival_admin,
            owner=cls.rival_admin, student_name='theirs', amount=Decimal('999.00'),
            type='Registration', status=Payment.Status.SUCCESS,
        )

    def test_stats_exclude_other_companies(self):
        client = self.auth(self.admin)
        response = client.get('/api/payments/stats/')
        self.assertEqual(Decimal(str(response.data['totalRevenue'])), Decimal('100.00'))

    def test_employee_cannot_read_commissions(self):
        client = self.auth(self.emp_k1)
        self.assertEqual(client.get('/api/commissions/').status_code, 403)

    def test_analytics_are_scoped(self):
        client = self.auth(self.admin)
        response = client.get('/api/analytics/overview/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(Decimal(str(response.data['totalRevenue'])), Decimal('100.00'))

    def test_analytics_funnel_reports_real_numbers(self):
        client = self.auth(self.admin)
        response = client.get('/api/analytics/funnel/')
        self.assertEqual(response.status_code, 200)
        stages = {s['stage']: s['count'] for s in response.data['stages']}
        self.assertEqual(stages['Enquiries'], 3)


class SubscriptionsRemovedTests(BaseAPITestCase):
    """
    Subscriptions no longer gate anything: every tenant gets free, unlimited
    access for unlimited time. These tests pin that guarantee down so a
    billing check cannot creep back in unnoticed.
    """

    ENQUIRY = {
        'school_name': 'S', 'stream': 'Sci', 'course_interested': 'X',
        'mobile': '9', 'email': 'x@example.com', 'father_name': 'F',
        'mother_name': 'M', 'permanent_address': 'A',
    }

    def _on_starter(self):
        """Put the company on the old most-restrictive plan."""
        subscription = self.company.subscription
        subscription.plan = Plan.objects.get(slug='starter')
        subscription.save()
        return subscription

    def test_branch_creation_is_not_capped_by_the_plan(self):
        self._on_starter()
        client = self.auth(self.admin)
        response = client.post('/api/branches/', {'name': 'Mokokchung'}, format='json')
        self.assertEqual(response.status_code, 201)

    def test_hiring_is_not_capped_by_the_plan(self):
        self._on_starter()
        client = self.auth(self.admin)

        def hire(name):
            return client.post('/api/users/', {
                'username': name, 'password': PASSWORD,
                'role': Role.EMPLOYEE, 'branch': self.kohima.pk,
            }, format='json')

        # The fixture already seats more staff than the old 5-seat Starter plan
        # allowed, so under the old rules the very first hire here was refused.
        for n in range(3):
            self.assertEqual(hire('extra%d' % n).status_code, 201)

    def test_company_without_a_subscription_can_still_write(self):
        """A company created outside provision_company has no plan at all."""
        orphan = Company.objects.create(name='Orphan Consultancy')
        branch = Branch.objects.create(company=orphan, name='Only', is_default=True)
        user = User.objects.create(
            username='orphan_admin', role=Role.COMPANY_ADMIN,
            company=orphan, branch=branch,
        )
        user.set_password(PASSWORD)
        user.save()

        client = self.auth(user)
        response = client.post('/api/enquiries/', self.ENQUIRY, format='json')
        self.assertEqual(response.status_code, 201)

    def test_expired_subscription_still_permits_writes(self):
        subscription = self.company.subscription
        subscription.status = Subscription.Status.EXPIRED
        subscription.save()

        client = self.auth(self.admin)
        self.assertEqual(
            client.post('/api/enquiries/', self.ENQUIRY, format='json').status_code,
            201,
        )
        self.assertEqual(client.get('/api/enquiries/').status_code, 200)


class ServerAssignedReferenceTests(BaseAPITestCase):
    """
    A record must be creatable without its reference number -- the number is
    generated server-side in perform_create.

    DRF builds a UniqueTogetherValidator from the ('company', <ref>) model
    constraint, and that validator forces an implied 'required' on every field
    it covers. It runs during validation, before perform_create, so every
    create that relied on generation died with "<ref>: This field is required."
    """

    REGISTRATION = {
        'student_name': 'Sara Sharma',
        'mobile': '9130801582',
        'email': 'sara.sharma@example.com',
        'registration_fee': '5000',
        'payment_status': 'Paid',
        'payment_method': 'Cash',
    }

    def test_registration_create_generates_the_reference(self):
        client = self.auth(self.admin)
        response = client.post('/api/registrations/', self.REGISTRATION, format='json')
        self.assertEqual(response.status_code, 201, getattr(response, 'data', None))
        self.assertTrue(
            response.data['registration_no'].startswith('REG-'),
            response.data['registration_no'],
        )

    def test_consecutive_registrations_get_distinct_references(self):
        client = self.auth(self.admin)
        first = client.post('/api/registrations/', self.REGISTRATION, format='json')
        second = client.post(
            '/api/registrations/', dict(self.REGISTRATION, mobile='9000000001'),
            format='json',
        )
        self.assertEqual(first.status_code, 201, getattr(first, 'data', None))
        self.assertEqual(second.status_code, 201, getattr(second, 'data', None))
        self.assertNotEqual(
            first.data['registration_no'], second.data['registration_no'],
        )

    def test_an_explicitly_supplied_reference_is_kept(self):
        client = self.auth(self.admin)
        response = client.post(
            '/api/registrations/',
            dict(self.REGISTRATION, registration_no='REG-CUSTOM-1'),
            format='json',
        )
        self.assertEqual(response.status_code, 201, getattr(response, 'data', None))
        self.assertEqual(response.data['registration_no'], 'REG-CUSTOM-1')

    def test_enrollment_carries_the_same_relaxed_validator(self):
        """Enrollment has the identical constraint and the identical bug."""
        from core.serializers import (
            EnrollmentSerializer, _OptionalRefUniqueTogetherValidator,
        )
        covering = [
            v for v in EnrollmentSerializer().validators
            if 'enrollment_no' in getattr(v, 'fields', ())
        ]
        self.assertTrue(covering, 'no unique-together validator covers enrollment_no')
        for validator in covering:
            self.assertIsInstance(validator, _OptionalRefUniqueTogetherValidator)


class AuthLifecycleTests(BaseAPITestCase):
    """Audit H-3: logout made no network call, so tokens were never revoked."""

    def test_logout_blacklists_the_refresh_token(self):
        client = APIClient()
        login = client.post('/api/auth/login/', {
            'username': self.admin.username, 'password': PASSWORD,
        }, format='json')
        refresh = login.data['refresh']
        client.credentials(HTTP_AUTHORIZATION=f'Bearer {login.data["access"]}')

        self.assertEqual(
            client.post('/api/auth/logout/', {'refresh': refresh}, format='json').status_code,
            205,
        )

        anon = APIClient()
        self.assertEqual(
            anon.post('/api/auth/refresh/', {'refresh': refresh}, format='json').status_code,
            401,
        )

    def test_access_token_carries_role_company_and_branch_claims(self):
        """
        The edge middleware gates routes on the `role` claim. Without it the
        middleware fails closed and every gated route redirects everyone,
        admins included.
        """
        import json
        from base64 import urlsafe_b64decode

        def claims(jwt):
            payload = jwt.split('.')[1]
            payload += '=' * (-len(payload) % 4)
            return json.loads(urlsafe_b64decode(payload))

        client = APIClient()
        login = client.post('/api/auth/login/', {
            'username': self.mgr_k.username, 'password': PASSWORD,
        }, format='json')

        access = claims(login.data['access'])
        self.assertEqual(access['role'], Role.BRANCH_MANAGER)
        self.assertEqual(access['company'], self.company.pk)
        self.assertEqual(access['branch'], self.kohima.pk)

        # Claims must survive rotation, or gating breaks 15 minutes after login.
        refreshed = client.post(
            '/api/auth/refresh/', {'refresh': login.data['refresh']}, format='json',
        )
        self.assertEqual(claims(refreshed.data['access'])['role'], Role.BRANCH_MANAGER)

    def test_role_change_revokes_outstanding_sessions(self):
        """
        Identity claims ride on the refresh token and rotation copies them
        forward without re-reading the user, so without revocation a demoted
        admin keeps admin-level UI routing for the full refresh lifetime â€” up
        to a week after the demotion.
        """
        client = APIClient()
        login = client.post('/api/auth/login/', {
            'username': self.admin.username, 'password': PASSWORD,
        }, format='json')
        refresh = login.data['refresh']

        demoter = self.auth(self.dev)
        self.assertEqual(
            demoter.patch(f'/api/users/{self.admin.pk}/',
                          {'role': Role.EMPLOYEE}, format='json').status_code,
            200,
        )

        anon = APIClient()
        self.assertEqual(
            anon.post('/api/auth/refresh/', {'refresh': refresh}, format='json').status_code,
            401,
            'a demoted user could still rotate their old token',
        )

    def test_deactivation_revokes_outstanding_sessions(self):
        client = APIClient()
        login = client.post('/api/auth/login/', {
            'username': self.emp_k1.username, 'password': PASSWORD,
        }, format='json')
        refresh = login.data['refresh']

        admin = self.auth(self.admin)
        self.assertEqual(
            admin.post(f'/api/users/{self.emp_k1.pk}/set-active/',
                       {'is_active': False}, format='json').status_code,
            200,
        )

        anon = APIClient()
        self.assertEqual(
            anon.post('/api/auth/refresh/', {'refresh': refresh}, format='json').status_code,
            401,
        )

    def test_login_returns_the_user_with_role_and_branch(self):
        client = APIClient()
        response = client.post('/api/auth/login/', {
            'username': self.mgr_k.username, 'password': PASSWORD,
        }, format='json')
        self.assertEqual(response.data['user']['role'], Role.BRANCH_MANAGER)
        self.assertEqual(response.data['user']['branch_name'], 'Kohima')

    def test_deactivated_employee_cannot_log_in(self):
        self.emp_k1.is_active_employee = False
        self.emp_k1.save()
        client = APIClient()
        response = client.post('/api/auth/login/', {
            'username': self.emp_k1.username, 'password': PASSWORD,
        }, format='json')
        self.assertEqual(response.status_code, 403)

    def test_deactivation_revokes_an_already_issued_token(self):
        """
        The property that actually matters: an attacker holding a stolen token
        does not log in again.

        Blocking login only is not enough â€” a live 15-minute access token would
        keep working after the account was disabled. This passes only because
        IsAuthenticatedAndActive re-reads is_active_employee on every request;
        moving that check into the login view would keep the login test green
        while leaving every live session alive.
        """
        client = self.auth(self.emp_k1)                    # token issued while active
        self.assertEqual(client.get('/api/enquiries/').status_code, 200)

        self.emp_k1.is_active_employee = False
        self.emp_k1.save()

        self.assertEqual(
            client.get('/api/enquiries/').status_code, 403,
            'a token issued before deactivation still works',
        )


class DocumentTests(BaseAPITestCase):
    """Audit F-1: uploads were a client-side mock that stored only a filename."""

    PDF = b'%PDF-1.4 real passport bytes'

    def _upload(self, client, name='passport.pdf', content=None):
        from django.core.files.uploadedfile import SimpleUploadedFile
        return client.post('/api/documents/', {
            'file_name': name,
            'file': SimpleUploadedFile(
                name, content or self.PDF, content_type='application/pdf',
            ),
            'type': 'Passport', 'student_name': 'Journey Student',
        }, format='multipart')

    def test_upload_stores_and_encrypts_the_file(self):
        from django.conf import settings

        client = self.auth(self.emp_k1)
        response = self._upload(client)
        self.assertEqual(response.status_code, 201, response.data)

        document = Document.objects.get(pk=response.data['id'])
        self.assertTrue(document.file.name)
        self.assertEqual(document.file_size, len(self.PDF))

        stored = (settings.PRIVATE_MEDIA_ROOT / document.file.name).read_bytes()
        self.assertNotIn(b'real passport bytes', stored)

        download = client.get(f'/api/documents/{document.pk}/download/')
        self.assertEqual(download.status_code, 200)
        self.assertEqual(b''.join(download.streaming_content), self.PDF)

    # ---------------------------------------------------------------- linking
    #
    # A document that names a student in free text is not linked to that
    # student. The upload form posted `student_name` plus a `registration_no`
    # that was never a serializer field, so DRF dropped it silently and every
    # document uploaded through the UI landed with both FKs null.

    def _upload_linked(self, client, **extra):
        from django.core.files.uploadedfile import SimpleUploadedFile
        body = {
            'file_name': 'passport.pdf',
            'file': SimpleUploadedFile(
                'passport.pdf', self.PDF, content_type='application/pdf',
            ),
            'type': 'Passport',
        }
        body.update(extra)
        return client.post('/api/documents/', body, format='multipart')

    def test_uploading_against_a_registration_stores_the_fk(self):
        client = self.auth(self.emp_k1)
        registration = Registration.objects.create(
            company=self.emp_k1.company, branch=self.kohima,
            created_by=self.emp_k1, owner=self.emp_k1,
            registration_no='REG-LINK-1', student_name='Linked Student',
            email='linked@example.com', registration_fee=Decimal('1000.00'),
        )

        response = self._upload_linked(client, registration=registration.pk)
        self.assertEqual(response.status_code, 201, response.data)

        document = Document.objects.get(pk=response.data['id'])
        self.assertEqual(document.registration_id, registration.pk)
        self.assertIsNone(document.enquiry_id)

    def test_uploading_against_an_enquiry_stores_the_fk(self):
        """The reason the enquiry FK exists: an enquirer has no Registration."""
        client = self.auth(self.emp_k1)

        response = self._upload_linked(client, enquiry=self.enq_k1.pk)
        self.assertEqual(response.status_code, 201, response.data)

        document = Document.objects.get(pk=response.data['id'])
        self.assertEqual(document.enquiry_id, self.enq_k1.pk)
        self.assertIsNone(document.registration_id)

    def test_the_student_name_is_derived_from_the_link_not_the_client(self):
        """
        `student_name` is a denormalised cache for list and search, not the
        truth. Trusting the posted value is what let it drift from the record
        it names.
        """
        client = self.auth(self.emp_k1)

        response = self._upload_linked(
            client, enquiry=self.enq_k1.pk, student_name='Someone Else Entirely',
        )
        self.assertEqual(response.status_code, 201, response.data)

        document = Document.objects.get(pk=response.data['id'])
        self.assertEqual(
            document.student_name, self.enq_k1.candidate_name,
            'the posted student_name must not override the linked record',
        )

    def test_a_document_cannot_name_two_different_students(self):
        client = self.auth(self.emp_k1)
        registration = Registration.objects.create(
            company=self.emp_k1.company, branch=self.kohima,
            created_by=self.emp_k1, owner=self.emp_k1,
            registration_no='REG-LINK-2', student_name='Linked Student',
            email='linked2@example.com', registration_fee=Decimal('1000.00'),
        )

        response = self._upload_linked(
            client, registration=registration.pk, enquiry=self.enq_k1.pk,
        )
        self.assertEqual(response.status_code, 400, response.data)

    def test_a_document_cannot_link_across_the_tenant_boundary(self):
        """
        The FK is a new way to name a row by id, so it needs the same scope
        check every other reference field gets.
        """
        client = self.auth(self.emp_k1)

        response = self._upload_linked(client, enquiry=self.enq_rival.pk)
        self.assertEqual(
            response.status_code, 400,
            "an employee must not attach a document to another tenant's enquiry",
        )

    def test_an_unlinked_upload_is_still_allowed(self):
        """Not every document belongs to a student; the link is optional."""
        client = self.auth(self.emp_k1)
        response = self._upload_linked(client, student_name='Walk-in Copy')
        self.assertEqual(response.status_code, 201, response.data)

        document = Document.objects.get(pk=response.data['id'])
        self.assertIsNone(document.registration_id)
        self.assertIsNone(document.enquiry_id)
        self.assertEqual(document.student_name, 'Walk-in Copy')

    def test_rival_cannot_download_our_document(self):
        owner = self.auth(self.emp_k1)
        created = self._upload(owner, 'secret.pdf', b'secret bytes')
        rival = self.auth(self.rival_admin)
        self.assertEqual(
            rival.get(f'/api/documents/{created.data["id"]}/download/').status_code, 404,
        )

    def test_replacing_a_file_by_patch_stays_encrypted_and_validated(self):
        """
        PATCH previously fell through to ModelSerializer.update(), writing the
        raw bytes into the web-served MEDIA_ROOT with no extension or size
        check, while `is_encrypted` kept asserting True over plaintext.
        """
        from django.conf import settings
        from django.core.files.uploadedfile import SimpleUploadedFile

        client = self.auth(self.emp_k1)
        created = self._upload(client)
        document_id = created.data['id']
        original_name = Document.objects.get(pk=document_id).file.name

        replacement = b'%PDF-1.4 replacement bytes'
        response = client.patch(f'/api/documents/{document_id}/', {
            'file': SimpleUploadedFile(
                'replacement.pdf', replacement, content_type='application/pdf',
            ),
        }, format='multipart')
        self.assertEqual(response.status_code, 200, response.data)

        document = Document.objects.get(pk=document_id)
        stored = (settings.PRIVATE_MEDIA_ROOT / document.file.name).read_bytes()
        self.assertNotIn(b'replacement bytes', stored, 'file was stored unencrypted')
        self.assertEqual(document.file_size, len(replacement), 'metadata is stale')

        download = client.get(f'/api/documents/{document_id}/download/')
        self.assertEqual(download.status_code, 200)
        self.assertEqual(b''.join(download.streaming_content), replacement)

        # The superseded blob must not linger.
        if original_name != document.file.name:
            self.assertFalse((settings.PRIVATE_MEDIA_ROOT / original_name).exists())

    def test_patch_cannot_smuggle_a_disallowed_extension(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        client = self.auth(self.emp_k1)
        created = self._upload(client)
        response = client.patch(f'/api/documents/{created.data["id"]}/', {
            'file': SimpleUploadedFile('payload.exe', b'MZ', content_type='application/exe'),
        }, format='multipart')
        self.assertEqual(response.status_code, 400)

    def test_disallowed_extension_is_rejected(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        client = self.auth(self.emp_k1)
        response = client.post('/api/documents/', {
            'file_name': 'payload.exe',
            'file': SimpleUploadedFile('payload.exe', b'MZ', content_type='application/exe'),
            'type': 'Other',
        }, format='multipart')
        self.assertEqual(response.status_code, 400)


# ===========================================================================
#  Throttling
# ===========================================================================

# Seconds in each period DRF understands. It keys off the FIRST letter of the
# period, so 'min', 'm' and 'minute' are all the same thing to it -- mirrored
# here so the test parses a rate string the same way the framework does.
_PERIOD_SECONDS = {'s': 1, 'm': 60, 'h': 3600, 'd': 86400}


def _per_second(rate):
    """'120/min' -> 2.0. Lets two rates be compared without instantiating DRF."""
    count, _, period = rate.partition('/')
    return int(count) / _PERIOD_SECONDS[period[0]]


def throttle_rates(**overrides):
    """
    Apply the PRODUCTION rate table for one test, with named scopes adjusted.

    `override_settings(REST_FRAMEWORK=...)` DOES NOT WORK HERE, and fails
    silently, which is why this helper exists instead. `SimpleRateThrottle`
    binds

        THROTTLE_RATES = api_settings.DEFAULT_THROTTLE_RATES

    as a CLASS attribute at import time, so it holds a reference to the dict
    object that existed then. Replacing the setting swaps `api_settings` for a
    new dict and leaves every throttle class still reading the old one --
    verified directly: inside an override the class still reports the shipped
    rates. A test written the obvious way passes or fails on the real settings
    while appearing to test its own.

    `APIView.throttle_classes` is frozen the same way. That has a consequence
    worth knowing: throttling is LIVE in every test in this file, despite
    `BaseAPITestCase` overriding REST_FRAMEWORK with no throttle keys. What
    actually stops the 8/min login scope tripping the suite is the
    `cache.clear()` in its `setUp`, not that override.

    Basing the table on `_throttle_rates(debug=False)` means these tests
    exercise the rates that ship to production, not invented ones.
    """
    rates = {**_throttle_rates(debug=False), **overrides}
    return patch.object(SimpleRateThrottle, 'THROTTLE_RATES', rates)


class ThrottleTests(BaseAPITestCase):
    """
    The rate limits, exercised rather than assumed.

    A user hit `1000/hour` during ordinary browsing and got a full-page error
    reading "Expected available in 1006 seconds" -- the limit sat below this
    app's real request rate (~20 requests per page load), so it punished work
    instead of abuse. The rates are environment-aware now, and these tests pin
    the parts that must not drift: the credential defences stay strict
    everywhere, and a breach answers 429 WITH a Retry-After header.

    `BaseAPITestCase.setUp` clears the cache, which is where DRF keeps its
    counters -- so each test starts with an empty budget.
    """

    @throttle_rates()
    def test_login_scope_blocks_credential_stuffing(self):
        """8/min on the login scope, counted per attempt regardless of outcome."""
        client = APIClient()
        for attempt in range(8):
            response = client.post(
                '/api/auth/login/',
                {'username': self.admin.username, 'password': 'wrong-password'},
                format='json',
            )
            self.assertEqual(
                response.status_code, status.HTTP_401_UNAUTHORIZED,
                f'attempt {attempt + 1} should have been rejected on credentials, not throttled',
            )

        blocked = client.post(
            '/api/auth/login/',
            {'username': self.admin.username, 'password': 'wrong-password'},
            format='json',
        )
        self.assertEqual(blocked.status_code, status.HTTP_429_TOO_MANY_REQUESTS)

    @throttle_rates(user='4/hour', user_burst='1000/min')
    def test_sustained_user_rate_returns_429_with_retry_after(self):
        """
        The hourly bucket refuses, and says when to come back.

        Retry-After is what lets a client wait instead of hammering. DRF sets
        it from `exc.wait`, but this project replaces the exception handler
        (`core.exception_handler`), and that handler rewrites `response.data`
        -- so the header surviving is a property of OUR code, not a framework
        guarantee, and is worth a test.
        """
        client = self.auth(self.admin)

        for request_number in range(4):
            response = client.get('/api/enquiries/')
            self.assertEqual(
                response.status_code, status.HTTP_200_OK,
                f'request {request_number + 1} of 4 should be within budget',
            )

        blocked = client.get('/api/enquiries/')
        self.assertEqual(blocked.status_code, status.HTTP_429_TOO_MANY_REQUESTS)
        self.assertIn('Retry-After', blocked.headers)
        self.assertGreater(int(blocked.headers['Retry-After']), 0)
        # The custom handler normalises every error body to {'error': ...}.
        self.assertIn('error', blocked.data)

    @throttle_rates(user_burst='5/min', user='10000/hour')
    def test_burst_rate_returns_429_within_a_short_window(self):
        """
        The short window refuses on its own, with the hourly budget untouched.

        `user` is left at 10000/hour here, so a 429 can only have come from the
        burst class -- which is the point of it existing.
        """
        client = self.auth(self.admin)

        for request_number in range(5):
            response = client.get('/api/enquiries/')
            self.assertEqual(
                response.status_code, status.HTTP_200_OK,
                f'request {request_number + 1} of 5 should be within budget',
            )

        blocked = client.get('/api/enquiries/')
        self.assertEqual(blocked.status_code, status.HTTP_429_TOO_MANY_REQUESTS)
        self.assertIn('Retry-After', blocked.headers)

    def test_burst_and_sustained_use_separate_counters(self):
        """
        Sharing a scope would make both classes read the same cache key, and
        the tighter rate would silently apply to both windows.
        """
        self.assertEqual(BurstUserRateThrottle.scope, 'user_burst')
        self.assertNotEqual(BurstUserRateThrottle.scope, UserRateThrottle.scope)

    def test_credential_throttles_are_identical_in_both_environments(self):
        """Loosening these locally means they are first exercised in production."""
        development = _throttle_rates(debug=True)
        production = _throttle_rates(debug=False)

        for scope, expected in (('login', '8/min'), ('signup', '5/hour')):
            self.assertEqual(development[scope], expected)
            self.assertEqual(production[scope], expected)

    def test_development_rates_are_generous_but_never_unlimited(self):
        """
        A scope with no rate is not "relaxed", it is unexercised -- the code
        path would then run for the first time in production.
        """
        development = _throttle_rates(debug=True)
        production = _throttle_rates(debug=False)

        for scope in ('anon', 'user_burst', 'user'):
            self.assertIsNotNone(development[scope], f'{scope} must keep a rate in development')
            self.assertGreater(
                _per_second(development[scope]), _per_second(production[scope]),
                f'{scope} should be more generous in development than in production',
            )

    def test_burst_window_is_wider_than_the_sustained_average(self):
        """
        The burst bucket only earns its place if it lets a spike through that
        the hourly average would not. If it were the tighter of the two, the
        hourly bucket could never be the binding constraint and one throttle
        would do.
        """
        production = _throttle_rates(debug=False)
        self.assertGreater(
            _per_second(production['user_burst']), _per_second(production['user']),
            'the short window must allow a higher instantaneous rate than the hourly average',
        )


# ===========================================================================
#  Durability and efficiency
# ===========================================================================

class _StubRequest:
    """
    The two attributes `scoped_cache_key` reads, and nothing else.

    A real DRF Request would need a factory, a renderer and an authenticator
    to produce the same two values, and would let a change in any of those
    quietly become a failure in a cache-key test.
    """

    def __init__(self, user, query=''):
        self.user = user
        self.query_params = QueryDict(query)


class SqliteConcurrencyMitigationTests(TestCase):
    """
    The SQLite tuning in settings.py raises the concurrency CEILING. It does
    not add row locking, and these tests exist to keep that distinction from
    quietly eroding.
    """

    def setUp(self):
        super().setUp()
        if connection.vendor != 'sqlite':
            self.skipTest('SQLite-specific; the engine is %s.' % connection.vendor)

    def test_sqlite_options_ask_for_wal_busy_timeout_and_immediate_transactions(self):
        """The configuration itself, before asking whether it took effect."""
        options = settings.DATABASES['default']['OPTIONS']

        init_command = options['init_command'].lower()
        self.assertIn('journal_mode = wal', init_command)
        self.assertIn('synchronous = normal', init_command)

        # A blocked writer has to WAIT rather than raise "database is locked"
        # immediately, and the wait has to finish inside gunicorn's 30s worker
        # timeout or the worker is killed instead of the request failing.
        self.assertGreaterEqual(options['timeout'], 5)
        self.assertLess(options['timeout'], 30)

        # Without IMMEDIATE the busy timeout is nearly useless: a DEFERRED
        # transaction that reads and then writes must upgrade its lock, and a
        # failed upgrade returns SQLITE_BUSY without consulting the busy
        # handler at all.
        self.assertEqual(options['transaction_mode'], 'IMMEDIATE')

    def test_wal_is_actually_active_on_a_file_backed_database(self):
        """
        EMPIRICAL, not a re-reading of the setting.

        The suite's own database is in-memory, where `PRAGMA journal_mode`
        answers 'memory' no matter what was requested -- so asserting against
        the live test connection would prove nothing. This opens a real file
        with the exact OPTIONS from settings and asks the database what it did.
        """
        options = dict(settings.DATABASES['default']['OPTIONS'])

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            wrapper = SQLiteDatabaseWrapper(
                {**connection.settings_dict,
                 'NAME': os.path.join(tmp, 'pragma-check.sqlite3'),
                 'OPTIONS': options},
                alias='pragma-check',
            )
            try:
                with wrapper.cursor() as cursor:
                    cursor.execute('PRAGMA journal_mode;')
                    journal_mode = cursor.fetchone()[0]
                    cursor.execute('PRAGMA busy_timeout;')
                    busy_timeout = cursor.fetchone()[0]
                    cursor.execute('PRAGMA synchronous;')
                    synchronous = cursor.fetchone()[0]
            finally:
                wrapper.close()

        self.assertEqual(str(journal_mode).lower(), 'wal')
        # sqlite3.connect(timeout=<seconds>) becomes sqlite3_busy_timeout(ms).
        self.assertEqual(busy_timeout, options['timeout'] * 1000)
        self.assertEqual(synchronous, 1, 'PRAGMA synchronous should be NORMAL (1)')

    def test_row_locking_is_still_absent_despite_the_tuning(self):
        """
        THE POINT OF THIS TEST IS TO REFUSE A FALSE CONCLUSION.

        WAL, a busy timeout and IMMEDIATE transactions make collisions rarer.
        They do not make `select_for_update()` work. Django reports
        has_select_for_update = False for SQLite and then SILENTLY DROPS the
        FOR UPDATE clause -- no warning, no exception -- so the company-row
        lock in `services.next_reference_number` locks nothing and two
        concurrent registrations can still allocate the same reference number.
        If this assertion ever fails because the flag flipped, the comment in
        settings.py and the one in services.py both need revisiting.
        """
        self.assertFalse(
            connection.features.has_select_for_update,
            'SQLite gained row locking; revisit the FOR UPDATE caveats in '
            'config/settings.py and core/services.py.',
        )


class SqliteProductionGuardTests(SimpleTestCase):
    """
    `_guard_sqlite_engine` refuses to boot a non-DEBUG deployment on SQLite.

    Tested as a function rather than by importing settings under a patched
    environment, because the module-level raise happens once at import and
    cannot be re-triggered.
    """

    SQLITE = 'django.db.backends.sqlite3'
    POSTGRES = 'django.db.backends.postgresql'

    def test_sqlite_with_debug_off_refuses_to_boot(self):
        with self.assertRaises(ImproperlyConfigured) as caught:
            _guard_sqlite_engine(self.SQLITE, debug=False, allow_sqlite=False)
        message = str(caught.exception)
        # The message has to name the way out, or the guard just looks broken.
        self.assertIn('ALLOW_SQLITE_IN_PRODUCTION', message)
        self.assertIn('DATABASE_URL', message)

    def test_the_escape_hatch_is_honoured(self):
        """A conscious single-user deployment stays possible."""
        _guard_sqlite_engine(self.SQLITE, debug=False, allow_sqlite=True)

    def test_development_is_unaffected(self):
        _guard_sqlite_engine(self.SQLITE, debug=True, allow_sqlite=False)

    def test_postgres_passes_in_every_combination(self):
        for debug in (True, False):
            for allow in (True, False):
                with self.subTest(debug=debug, allow_sqlite=allow):
                    _guard_sqlite_engine(self.POSTGRES, debug=debug, allow_sqlite=allow)

    def test_the_guard_matches_on_the_engine_suffix(self):
        """
        A sqlite:// DATABASE_URL and a bare DB_ENGINE both end up as an ENGINE
        string ending in 'sqlite3'; a third-party wrapper backend would too.
        Matching the suffix catches all of them.
        """
        for engine in (self.SQLITE, 'some.vendor.backends.sqlite3'):
            with self.subTest(engine=engine):
                with self.assertRaises(ImproperlyConfigured):
                    _guard_sqlite_engine(engine, debug=False, allow_sqlite=False)


class ResponseCompressionTests(BaseAPITestCase):
    """gzip is on, and deliberately off for two kinds of response."""

    def test_the_middleware_sits_above_everything_that_writes_the_body(self):
        """
        Response middleware runs bottom-up, so gzip must be near the TOP of
        MIDDLEWARE to be the last thing to touch the body. Below WhiteNoise it
        would also never see a static response at all, since WhiteNoise
        short-circuits and never calls what follows it.
        """
        order = list(settings.MIDDLEWARE)
        gzip_at = order.index('core.middleware.ApiGZipMiddleware')

        self.assertEqual(
            order.index('django.middleware.security.SecurityMiddleware'), gzip_at - 1,
            'gzip should sit directly after SecurityMiddleware',
        )
        for below in (
            'whitenoise.middleware.WhiteNoiseMiddleware',
            'django.contrib.sessions.middleware.SessionMiddleware',
            'django.middleware.common.CommonMiddleware',
        ):
            self.assertGreater(order.index(below), gzip_at, below + ' should be below gzip')

    def test_a_large_json_response_is_compressed(self):
        client = self.auth(self.admin)

        plain = client.get('/api/enquiries/')
        gzipped = client.get('/api/enquiries/', HTTP_ACCEPT_ENCODING='gzip')

        self.assertEqual(gzipped.status_code, 200)
        self.assertGreater(
            len(plain.content), 200,
            'GZipMiddleware ignores bodies under 200 bytes; this fixture must be bigger',
        )
        self.assertEqual(gzipped['Content-Encoding'], 'gzip')
        self.assertIn('Accept-Encoding', gzipped['Vary'])
        self.assertLess(len(gzipped.content), len(plain.content))

    def test_a_client_that_does_not_ask_is_not_given_gzip(self):
        client = self.auth(self.admin)
        response = client.get('/api/enquiries/')
        self.assertNotIn('Content-Encoding', response.headers)
        self.assertEqual(response.status_code, 200)

    def test_token_bearing_auth_responses_are_never_compressed(self):
        """
        The login body carries an access token, a refresh token AND an echo of
        the caller-supplied username: a secret and reflected input in one
        compressed body, which is the shape BREACH needs. The attack is not
        reachable here (see core/middleware.py), so this is belt-and-braces --
        but it costs nothing on a few hundred bytes.
        """
        response = APIClient().post(
            '/api/auth/login/',
            {'username': self.admin.username, 'password': PASSWORD},
            format='json',
            HTTP_ACCEPT_ENCODING='gzip',
        )

        self.assertEqual(response.status_code, 200)
        self.assertNotIn('Content-Encoding', response.headers)
        # Asserting the body is over the 200-byte floor proves the exemption
        # did this, not GZipMiddleware's don't-bother-with-tiny-responses rule.
        self.assertGreater(len(response.content), 200)

    def test_the_exemption_list_covers_tokens_and_file_downloads(self):
        middleware = ApiGZipMiddleware(lambda request: None)

        for path in ('/api/auth/login/', '/api/auth/refresh/', '/api/auth/logout/',
                     '/api/documents/7/download/'):
            with self.subTest(path=path):
                self.assertTrue(middleware.is_exempt(path))

        for path in ('/api/enquiries/', '/api/analytics/overview/', '/api/payments/stats/'):
            with self.subTest(path=path):
                self.assertFalse(middleware.is_exempt(path))


class ScopedCacheTests(BaseAPITestCase):
    """
    The aggregate endpoints are cached per CALLER.

    A cache key that omitted the caller would serve one company's revenue to
    another company's dashboard. That is a tenant-isolation failure, not a
    performance regression, so it is tested like an authorization rule.
    """

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        # Distinct amounts, so a leaked entry is unmistakable in the assertion.
        Payment.objects.create(
            company=cls.company, branch=cls.kohima, created_by=cls.emp_k1,
            owner=cls.emp_k1, student_name='ours', amount=Decimal('100.00'),
            type='Registration', status=Payment.Status.SUCCESS,
        )
        Payment.objects.create(
            company=cls.rival, branch=cls.rival_branch, created_by=cls.rival_admin,
            owner=cls.rival_admin, student_name='theirs', amount=Decimal('999.00'),
            type='Registration', status=Payment.Status.SUCCESS,
        )

    def test_two_companies_never_share_an_analytics_entry(self):
        ours = self.auth(self.admin).get('/api/analytics/overview/')
        theirs = self.auth(self.rival_admin).get('/api/analytics/overview/')

        self.assertEqual(ours.status_code, 200)
        self.assertEqual(theirs.status_code, 200)
        # Both are computed; neither is answered by the other's entry.
        self.assertEqual(ours['X-Cache'], 'MISS')
        self.assertEqual(theirs['X-Cache'], 'MISS')

        self.assertEqual(ours.data['enquiries'], 3)
        self.assertEqual(theirs.data['enquiries'], 1)
        self.assertEqual(Decimal(str(ours.data['totalRevenue'])), Decimal('100.00'))
        self.assertEqual(Decimal(str(theirs.data['totalRevenue'])), Decimal('999.00'))

    def test_two_companies_never_share_a_payment_stats_entry(self):
        ours = self.auth(self.admin).get('/api/payments/stats/')
        theirs = self.auth(self.rival_admin).get('/api/payments/stats/')

        self.assertEqual(Decimal(str(ours.data['totalRevenue'])), Decimal('100.00'))
        self.assertEqual(Decimal(str(theirs.data['totalRevenue'])), Decimal('999.00'))
        self.assertEqual(theirs['X-Cache'], 'MISS')

    def test_two_callers_in_the_same_company_never_share_an_entry(self):
        """
        Cross-tenant is the loud failure; this is the quiet one. Inside one
        company an employee sees only their own records, so a key that stopped
        at company_id would show them the admin's company-wide totals.
        """
        as_admin = self.auth(self.admin).get('/api/analytics/overview/')
        as_employee = self.auth(self.emp_k1).get('/api/analytics/overview/')

        self.assertEqual(as_admin.data['enquiries'], 3)
        self.assertEqual(as_employee.data['enquiries'], 1)
        self.assertEqual(as_employee['X-Cache'], 'MISS')

    def test_a_repeated_request_is_served_from_cache_and_costs_fewer_queries(self):
        client = self.auth(self.admin)

        with CaptureQueriesContext(connection) as first_pass:
            first = client.get('/api/analytics/overview/')
        with CaptureQueriesContext(connection) as second_pass:
            second = client.get('/api/analytics/overview/')

        self.assertEqual(first['X-Cache'], 'MISS')
        self.assertEqual(second['X-Cache'], 'HIT')
        self.assertEqual(first.data, second.data)
        self.assertLess(
            len(second_pass.captured_queries), len(first_pass.captured_queries),
            'a cache hit should not re-run the aggregates',
        )

    def test_different_query_parameters_are_different_questions(self):
        """
        `?months=1` must not be answered from the `?months=12` entry. The key
        folds in the query string for exactly this.
        """
        client = self.auth(self.admin)

        twelve = client.get('/api/analytics/revenue/?months=12')
        one = client.get('/api/analytics/revenue/?months=1')

        self.assertEqual(twelve['X-Cache'], 'MISS')
        self.assertEqual(one['X-Cache'], 'MISS')
        self.assertEqual(client.get('/api/analytics/revenue/?months=12')['X-Cache'], 'HIT')

    @override_settings(SCOPED_CACHE_SECONDS=0)
    def test_setting_the_ttl_to_zero_switches_caching_off(self):
        """An operator can disable it without a deploy that removes decorators."""
        client = self.auth(self.admin)
        self.assertEqual(client.get('/api/analytics/overview/')['X-Cache'], 'DISABLED')
        self.assertEqual(client.get('/api/analytics/overview/')['X-Cache'], 'DISABLED')

    def test_the_key_itself_separates_callers_endpoints_and_questions(self):
        """
        Below the HTTP level: the same assertions against `scoped_cache_key`,
        so a regression is diagnosed at the key and not at a leaked figure.
        """
        ours = _StubRequest(self.admin)
        theirs = _StubRequest(self.rival_admin)
        colleague = _StubRequest(self.emp_k1)

        key = scoped_cache_key('analytics:overview', ours)
        self.assertNotEqual(key, scoped_cache_key('analytics:overview', theirs))
        self.assertNotEqual(key, scoped_cache_key('analytics:overview', colleague))
        self.assertNotEqual(key, scoped_cache_key('analytics:funnel', ours))
        self.assertNotEqual(
            key, scoped_cache_key('analytics:overview', _StubRequest(self.admin, 'months=1')),
        )
        # Same caller, same endpoint, same question -> same entry, or the cache
        # would never hit at all.
        self.assertEqual(key, scoped_cache_key('analytics:overview', _StubRequest(self.admin)))

    def test_repeated_query_parameters_are_not_flattened_into_one_key(self):
        """
        These are QueryDicts. `?branch=1&branch=2` and `?branch=2` mean
        different things, and `.items()` would collapse them to the same key --
        which is why `scoped_cache_key` uses `.lists()`.
        """
        self.assertNotEqual(
            scoped_cache_key('payments:stats', _StubRequest(self.admin, 'branch=1&branch=2')),
            scoped_cache_key('payments:stats', _StubRequest(self.admin, 'branch=2')),
        )

    def test_scope_changes_on_the_user_row_take_effect_immediately(self):
        """
        The signature carries company, branch, role and active status, so
        re-parenting or demoting an account invalidates its entries at once
        rather than after the TTL. (Changes NOT on the row -- a head manager's
        assigned managers, an accepted transfer -- lag by up to the TTL; that
        is documented in core/caching.py and is bounded to the user's own view.)
        """
        before = scope_signature(self.mgr_k)

        self.mgr_k.role = Role.EMPLOYEE
        self.assertNotEqual(before, scope_signature(self.mgr_k))
        self.mgr_k.role = Role.BRANCH_MANAGER

        self.mgr_k.branch = self.dimapur
        self.assertNotEqual(before, scope_signature(self.mgr_k))
        self.mgr_k.branch = self.kohima

        self.mgr_k.is_active_employee = False
        self.assertNotEqual(before, scope_signature(self.mgr_k))
        self.mgr_k.is_active_employee = True

        self.assertEqual(before, scope_signature(self.mgr_k))
