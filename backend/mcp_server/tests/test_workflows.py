"""
Composite workflow tools, driven end to end against the real viewsets.

Every test here goes through the MCP protocol into `tools/workflows.py` and out
to Django, so a "registration was created" assertion is checked against the ORM
rather than against the tool's own return value.

The 403-tolerance tests need a forbidden response that the fixture's roles
cannot actually produce: every section these tools read is scope-narrowed
rather than capability-gated, so an employee gets FEWER rows, never a 403. The
tolerance still has to work — a company can move a capability floor, and
`users/` is explicitly allowed to refuse — so `ForbiddingTransport` answers 403
for the paths a test names and the real backend serves the rest.
"""

import datetime as dt

from core.models import Enquiry, Enrollment, Installment, Payment, Registration
from mcp_server.client import Response
from mcp_server.config import Settings
from mcp_server.server import build_server
from mcp_server.testing import DjangoTestTransport
from mcp_server.tools.workflows import (
    ENQUIRY_TO_REGISTRATION,
    PAYMENT_METADATA_KEYS,
    build_registration_from_enquiry,
)

from .base import CATALOG, McpTestCase

FORBIDDEN_BODY = b'{"error": "You do not have permission to perform this action."}'


class ForbiddingTransport(DjangoTestTransport):
    """The real transport, except that any path under `forbid` answers 403."""

    def __init__(self, forbid=()):
        super().__init__()
        self.forbid = tuple(forbid)

    def request(self, method, path, **kwargs):
        if any(path.lstrip('/').startswith(prefix) for prefix in self.forbid):
            return Response(403, {'content-type': 'application/json'}, FORBIDDEN_BODY)
        return super().request(method, path, **kwargs)


class ForbiddenSectionMixin:
    """`self.forbid = ('users/',)` and every subsequent tool call sees a 403 there."""

    forbid: tuple = ()

    def server_for(self, user, read_only=False, **settings_overrides):
        settings = Settings(api_url='http://testserver/api/', api_key=self.key_for(user),
                            read_only=read_only, **settings_overrides)
        return build_server(settings, transport=ForbiddingTransport(self.forbid), catalog=CATALOG)


class MappingTests(McpTestCase):
    def test_build_registration_maps_profile_fields(self):
        enquiry = {
            'id': 7, 'candidate_name': 'Asha', 'email': 'a@x.com', 'mobile': '9', 'father_name': 'F', 'mother_name': 'M',
            'permanent_address': 'Addr', 'father_occupation': 'Farmer', 'school_name': 'S', 'stream': 'Science',
            'gender': 'Female', 'date_of_birth': '2006-05-01', 'class12_percentage': '88.50', 'physics_marks': '80.00',
            'gap_year': True, 'gap_year_from': 2024, 'college_dropout': False,
            'preferred_locations': ['Kota', 'Delhi'], 'course_interested': 'MBBS', 'status': 'New',
        }
        reg = build_registration_from_enquiry(enquiry, '1500', 'Paid', 'UPI', False, {'mobile': '8'})
        self.assertEqual(reg['student_name'], 'Asha')
        self.assertEqual(reg['mobile'], '8')
        self.assertEqual(reg['enquiry'], 7)
        self.assertEqual(reg['father_occupation'], 'Farmer')
        self.assertEqual(reg['date_of_birth'], '2006-05-01')
        self.assertEqual(reg['registration_fee'], '1500')
        self.assertEqual(reg['payment_status'], 'Paid')
        self.assertEqual(reg['preferences'], [
            {'courseName': 'MBBS', 'location': 'Kota', 'priority': 1},
            {'courseName': 'MBBS', 'location': 'Delhi', 'priority': 2},
        ])
        self.assertNotIn('status', reg)
        self.assertNotIn('id', reg)

    def test_mapping_only_names_fields_both_models_have(self):
        """
        The mapping is checked against the catalog, not against memory.

        A pair naming a field the API does not have would be rejected as an
        unknown field on every single conversion, and the only way to notice
        would be to run one.
        """
        enquiry_fields = {f['name'] for f in CATALOG.resource('enquiries')['fields']}
        registration = CATALOG.resource('registrations')['fields']
        writable = {f['name'] for f in registration if not f['read_only']}
        for source, destination in ENQUIRY_TO_REGISTRATION:
            with self.subTest(pair=f'{source}->{destination}'):
                self.assertIn(source, enquiry_fields)
                self.assertIn(destination, writable)

    def test_mapping_never_copies_a_server_owned_field(self):
        copied = {destination for _, destination in ENQUIRY_TO_REGISTRATION}
        self.assertNotIn('registration_no', copied)
        self.assertNotIn('enquiry', copied)
        self.assertNotIn('registration_fee', copied)

    def test_build_registration_splits_a_comma_joined_location(self):
        """The web form treats "Delhi, Mumbai" in one box as two preferences."""
        reg = build_registration_from_enquiry(
            {'id': 1, 'candidate_name': 'A', 'preferred_locations': ['Delhi, Mumbai'],
             'course_interested': 'MBBS'},
            '100', 'Pending', 'Cash', False, None,
        )
        self.assertEqual([p['location'] for p in reg['preferences']], ['Delhi', 'Mumbai'])
        self.assertEqual([p['priority'] for p in reg['preferences']], [1, 2])

    def test_build_registration_without_locations_has_no_preferences(self):
        reg = build_registration_from_enquiry(
            {'id': 1, 'candidate_name': 'A', 'course_interested': 'MBBS'},
            '100', 'Pending', 'Cash', True, None,
        )
        self.assertNotIn('preferences', reg)
        self.assertIs(reg['needs_loan'], True)


class WorkflowToolTests(McpTestCase):
    def test_convert_enquiry_creates_registration_payment_and_marks_converted(self):
        reg = self.call('convert_enquiry_to_registration', self.emp_k1, enquiry_id=self.enq_k1.pk,
                        registration_fee='2000', payment_status='Paid')
        self.assertTrue(reg['registration_no'].startswith('REG-'))
        self.assertEqual(reg['enquiry'], self.enq_k1.pk)
        self.assertEqual(reg['student_name'], 'kohima-one')
        self.enq_k1.refresh_from_db()
        self.assertEqual(self.enq_k1.status, 'Converted')
        self.assertEqual(Payment.objects.filter(registration_id=reg['id'], status='Success').count(), 1)

    def test_convert_copies_the_enquiry_profile_columns(self):
        Enquiry.objects.filter(pk=self.enq_k1.pk).update(
            gender='Female', caste='OBC', class12_percentage='88.50', physics_marks='80.00',
            pcb_percentage='79.25', gap_year=True, gap_year_from=2024, father_occupation='Farmer',
        )
        reg = self.call('convert_enquiry_to_registration', self.emp_k1, enquiry_id=self.enq_k1.pk,
                        registration_fee='2000')
        row = Registration.objects.get(pk=reg['id'])
        self.assertEqual(row.gender, 'Female')
        self.assertEqual(row.caste, 'OBC')
        self.assertEqual(str(row.class12_percentage), '88.50')
        self.assertEqual(str(row.physics_marks), '80.00')
        # Stored, not recomputed from the marks.
        self.assertEqual(str(row.pcb_percentage), '79.25')
        self.assertTrue(row.gap_year)
        self.assertEqual(row.gap_year_from, 2024)
        self.assertEqual(row.father_occupation, 'Farmer')
        self.assertEqual(row.stream, 'Science')
        self.assertEqual(row.school_name, 'School')

    def test_convert_unpaid_enquiry_books_a_pending_fee_payment(self):
        reg = self.call('convert_enquiry_to_registration', self.emp_k1, enquiry_id=self.enq_k1.pk,
                        registration_fee='2000')
        payment = Payment.objects.get(registration_id=reg['id'])
        self.assertEqual(payment.status, 'Pending')
        self.assertEqual(payment.type, 'Registration')
        self.assertEqual(payment.student_name, 'kohima-one')

    def test_convert_can_leave_the_enquiry_alone(self):
        self.call('convert_enquiry_to_registration', self.emp_k1, enquiry_id=self.enq_k1.pk,
                  registration_fee='2000', mark_converted=False)
        self.enq_k1.refresh_from_db()
        self.assertEqual(self.enq_k1.status, 'New')

    def test_convert_rejects_an_unknown_override(self):
        text = self.call_raises('convert_enquiry_to_registration', self.emp_k1, enquiry_id=self.enq_k1.pk,
                                registration_fee='2000', overrides={'nonsense': 1})
        self.assertIn('nonsense', text)
        self.assertFalse(Registration.objects.filter(enquiry_id=self.enq_k1.pk).exists())

    def test_convert_out_of_scope_enquiry_is_404(self):
        text = self.call_raises('convert_enquiry_to_registration', self.emp_k1, enquiry_id=self.enq_d1.pk, registration_fee='1')
        self.assertIn('404', text)

    def test_enroll_student_builds_installments(self):
        reg = self.call('convert_enquiry_to_registration', self.mgr_k, enquiry_id=self.enq_k2.pk, registration_fee='1000')
        enr = self.call('enroll_student', self.mgr_k, registration_id=reg['id'], program_name='MBBS',
                        start_date='2026-10-01', duration_months=60, total_fees='1000', installments_count=3)
        self.assertTrue(enr['enrollment_no'].startswith('ENR-'))
        amounts = [i['amount'] for i in enr['installments']]
        self.assertEqual(len(amounts), 3)
        self.assertEqual(sum(float(a) for a in amounts), 1000.0)
        self.assertEqual(Installment.objects.filter(enrollment_id=enr['id']).count(), 3)

    def test_enroll_student_installments_step_calendar_months(self):
        reg = self.call('convert_enquiry_to_registration', self.mgr_k, enquiry_id=self.enq_k2.pk, registration_fee='1000')
        enr = self.call('enroll_student', self.mgr_k, registration_id=reg['id'], program_name='MBBS',
                        start_date='2026-12-31', duration_months=12, total_fees='300', installments_count=3)
        due = [i['due_date'] for i in enr['installments']]
        self.assertEqual(due, ['2027-01-31', '2027-02-28', '2027-03-31'])

    def test_enroll_student_without_installments_creates_none(self):
        reg = self.call('convert_enquiry_to_registration', self.mgr_k, enquiry_id=self.enq_k2.pk, registration_fee='1000')
        enr = self.call('enroll_student', self.mgr_k, registration_id=reg['id'], program_name='MBBS',
                        start_date='2026-10-01', duration_months=12, total_fees='500')
        self.assertEqual(enr['installments'], [])
        self.assertEqual(Enrollment.objects.get(pk=enr['id']).student_id, reg['id'])

    def test_enroll_student_rejects_a_registration_outside_the_company(self):
        reg = self.call('convert_enquiry_to_registration', self.rival_admin, enquiry_id=self.enq_rival.pk,
                        registration_fee='1000')
        text = self.call_raises('enroll_student', self.emp_k1, registration_id=reg['id'], program_name='MBBS',
                                start_date='2026-10-01', duration_months=12, total_fees='500')
        self.assertIn('400', text)

    def test_record_payment_validates_method_metadata(self):
        reg = self.call('convert_enquiry_to_registration', self.mgr_k, enquiry_id=self.enq_k2.pk, registration_fee='1000')
        text = self.call_raises('record_payment', self.mgr_k, amount='500', method='UPI', registration=reg['id'], metadata={'cheque_no': '1'})
        self.assertIn('upi_transaction_id', text)
        pay = self.call('record_payment', self.mgr_k, amount='500', method='UPI', registration=reg['id'],
                        metadata={'upi_transaction_id': 'T123'})
        self.assertEqual(pay['status'], 'Success')
        self.assertEqual(pay['student_name'], 'kohima-two')
        self.assertEqual(pay['metadata']['upi_transaction_id'], 'T123')

    def test_record_payment_rejects_a_metadata_key_the_method_does_not_use(self):
        reg = self.call('convert_enquiry_to_registration', self.mgr_k, enquiry_id=self.enq_k2.pk, registration_fee='1000')
        text = self.call_raises('record_payment', self.mgr_k, amount='500', method='Cheque', registration=reg['id'],
                                metadata={'cheque_no': '7', 'bank_name': 'SBI', 'upi_transaction_id': 'T1'})
        self.assertIn('upi_transaction_id', text)
        self.assertEqual(Payment.objects.filter(registration_id=reg['id']).count(), 1)

    def test_record_payment_cash_takes_no_metadata(self):
        reg = self.call('convert_enquiry_to_registration', self.mgr_k, enquiry_id=self.enq_k2.pk, registration_fee='1000')
        text = self.call_raises('record_payment', self.mgr_k, amount='500', method='Cash', registration=reg['id'],
                                metadata={'cheque_no': '7'})
        self.assertIn('cheque_no', text)
        pay = self.call('record_payment', self.mgr_k, amount='500', method='Cash', registration=reg['id'])
        self.assertEqual(pay['metadata'], {})

    def test_record_payment_derives_the_name_from_the_enrollment(self):
        reg = self.call('convert_enquiry_to_registration', self.mgr_k, enquiry_id=self.enq_k2.pk, registration_fee='1000')
        enr = self.call('enroll_student', self.mgr_k, registration_id=reg['id'], program_name='MBBS',
                        start_date='2026-10-01', duration_months=12, total_fees='600', installments_count=2)
        pay = self.call('record_payment', self.mgr_k, amount='300', enrollment=enr['id'],
                        installment=enr['installments'][0]['id'])
        self.assertEqual(pay['student_name'], 'kohima-two')
        self.assertEqual(pay['enrollment'], enr['id'])
        self.assertEqual(pay['installment'], enr['installments'][0]['id'])

    def test_record_payment_needs_something_to_name_the_student(self):
        text = self.call_raises('record_payment', self.mgr_k, amount='300')
        self.assertIn('student_name', text)

    def test_record_payment_rejects_an_unknown_type_and_status(self):
        self.assertIn('Registration', self.call_raises('record_payment', self.mgr_k, amount='1',
                                                       student_name='S', type='Nonsense'))
        self.assertIn('Success', self.call_raises('record_payment', self.mgr_k, amount='1',
                                                  student_name='S', status='Nonsense'))

    def test_student_360_gathers_everything(self):
        reg = self.call('convert_enquiry_to_registration', self.mgr_k, enquiry_id=self.enq_k2.pk, registration_fee='1000', payment_status='Paid')
        enr = self.call('enroll_student', self.mgr_k, registration_id=reg['id'], program_name='MBBS',
                        start_date='2026-10-01', duration_months=60, total_fees='3000', installments_count=2)
        self.call('create_follow_up', self.mgr_k, data={'enquiry': self.enq_k2.pk, 'scheduled_for': '2026-09-20T10:00:00Z', 'notes': 'call'})
        self.call('create_student_remark', self.mgr_k, data={'registration': reg['id'], 'remark': 'good'})
        self.call('create_student_document', self.mgr_k, data={'registration': reg['id'], 'name': 'Passport'})
        self.call('create_visa_tracking', self.mgr_k, data={'student': reg['id'], 'student_name': 'kohima-two', 'country': 'UK', 'passport_no': 'P123'})
        profile = self.call('student_360', self.mgr_k, registration_id=reg['id'])
        self.assertEqual(profile['registration']['id'], reg['id'])
        self.assertEqual(profile['enquiry']['id'], self.enq_k2.pk)
        self.assertEqual(len(profile['enrollments']), 1)
        self.assertEqual(len(profile['enrollments'][0]['installments']), 2)
        self.assertEqual(len(profile['payments']), 1)
        self.assertEqual(profile['totals']['paid'], 1000.0)
        self.assertEqual(profile['totals']['outstanding_installments'], 3000.0)
        self.assertEqual(len(profile['follow_ups']), 1)
        self.assertEqual(len(profile['remarks']), 1)
        self.assertEqual(len(profile['physical_documents']), 1)
        self.assertEqual(len(profile['visa']), 1)
        self.assertEqual(profile['visa'][0]['passport_no'], 'P123')
        by_enrollment = self.call('student_360', self.mgr_k, enrollment_id=enr['id'])
        self.assertEqual(by_enrollment['registration']['id'], reg['id'])
        by_enquiry = self.call('student_360', self.mgr_k, enquiry_id=self.enq_k2.pk)
        self.assertEqual(by_enquiry['registration']['id'], reg['id'])

    def test_student_360_carries_follow_up_comments_transfers_and_approvals(self):
        reg = self.call('convert_enquiry_to_registration', self.mgr_k, enquiry_id=self.enq_k2.pk, registration_fee='1000')
        follow_up = self.call('create_follow_up', self.mgr_k,
                              data={'enquiry': self.enq_k2.pk, 'scheduled_for': '2026-09-20T10:00:00Z'})
        self.call('create_follow_up_comment', self.mgr_k, data={'follow_up': follow_up['id'], 'comment': 'left a voicemail'})
        self.call('create_transfer', self.mgr_k,
                  data={'entity_type': 'registration', 'entity_id': reg['id'], 'to_user': self.emp_k1.pk})
        self.call('create_approval_request', self.mgr_k,
                  data={'action': 'DELETE', 'entity_type': 'registration', 'entity_id': reg['id'],
                        'message': 'duplicate'})
        profile = self.call('student_360', self.mgr_k, registration_id=reg['id'])
        self.assertEqual([c['comment'] for c in profile['follow_ups'][0]['comments']], ['left a voicemail'])
        self.assertEqual(len(profile['transfers']), 1)
        self.assertEqual(profile['transfers'][0]['entity_id'], reg['id'])
        self.assertEqual(len(profile['pending_approvals']), 1)
        self.assertEqual(profile['pending_approvals'][0]['status'], 'PENDING')

    def test_student_360_for_an_enquiry_with_no_registration(self):
        profile = self.call('student_360', self.mgr_k, enquiry_id=self.enq_k1.pk)
        self.assertIsNone(profile['registration'])
        self.assertEqual(profile['enquiry']['id'], self.enq_k1.pk)
        self.assertEqual(profile['student_name'], 'kohima-one')
        for section in ('enrollments', 'payments', 'remarks', 'physical_documents', 'refunds', 'visa'):
            self.assertEqual(profile[section], [], section)
        self.assertEqual(profile['totals']['paid'], 0.0)

    def test_student_360_totals_count_only_settled_money(self):
        reg = self.call('convert_enquiry_to_registration', self.mgr_k, enquiry_id=self.enq_k2.pk,
                        registration_fee='1000', payment_status='Paid')
        self.call('record_payment', self.mgr_k, amount='250', registration=reg['id'], status='Pending')
        self.call('create_refund', self.mgr_k, data={'student': reg['id'], 'amount': '100', 'status': 'Processed'})
        profile = self.call('student_360', self.mgr_k, registration_id=reg['id'])
        self.assertEqual(profile['totals']['paid'], 1000.0)
        self.assertEqual(profile['totals']['pending'], 250.0)
        self.assertEqual(profile['totals']['refunded'], 100.0)
        self.assertEqual(profile['totals']['net'], 900.0)
        self.assertEqual(len(profile['refunds']), 1)

    def test_student_360_needs_exactly_one_id(self):
        self.assertIn('exactly one', self.call_raises('student_360', self.mgr_k))
        self.assertIn('exactly one', self.call_raises('student_360', self.mgr_k, registration_id=1, enquiry_id=2))

    def test_student_360_out_of_scope_registration_is_404(self):
        reg = self.call('convert_enquiry_to_registration', self.emp_d1, enquiry_id=self.enq_d1.pk, registration_fee='1000')
        self.assertIn('404', self.call_raises('student_360', self.emp_k1, registration_id=reg['id']))

    def test_search_everything_groups_results(self):
        result = self.call('search_everything', self.admin, query='kohima')
        self.assertEqual(len(result['enquiries']), 2)
        self.assertIn('users', result)
        self.assertEqual(result['query'], 'kohima')

    def test_search_everything_reports_counts_and_honours_limit(self):
        result = self.call('search_everything', self.admin, query='kohima', limit=1)
        self.assertEqual(len(result['enquiries']), 1)
        self.assertEqual(result['counts']['enquiries'], 2)
        self.assertEqual(result['limit'], 1)
        for group in ('registrations', 'enrollments', 'payments', 'documents', 'visa',
                      'follow_ups', 'tasks', 'appointments', 'users'):
            self.assertIn(group, result)

    def test_search_everything_is_scoped_to_the_caller(self):
        self.assertEqual(self.call('search_everything', self.emp_d1, query='kohima')['enquiries'], [])
        self.assertEqual(len(self.call('search_everything', self.mgr_k, query='kohima')['enquiries']), 2)

    def test_search_everything_rejects_an_empty_query(self):
        self.assertIn('query', self.call_raises('search_everything', self.admin, query='   '))

    def test_daily_briefing(self):
        self.call('create_follow_up', self.mgr_k, data={'enquiry': self.enq_k2.pk, 'scheduled_for': '2026-09-02T09:00:00Z'})
        self.call('create_appointment', self.mgr_k, data={'student_name': 'S', 'counselor': self.mgr_k.pk, 'date': '2026-09-02T11:00:00Z'})
        briefing = self.call('daily_briefing', self.mgr_k, date='2026-09-02')
        self.assertEqual(briefing['date'], '2026-09-02')
        self.assertEqual(len(briefing['follow_ups_due']), 1)
        self.assertEqual(len(briefing['appointments_today']), 1)
        self.assertIn('overview', briefing)
        self.assertIn('transfer_inbox', briefing)
        self.assertIn('pending_approvals', briefing)
        self.assertIn('expiring_documents', briefing)
        self.assertIn('unread_notifications', briefing)

    def test_daily_briefing_flags_overdue_and_upcoming_installments(self):
        """
        Also proves the walk really is ordered by due_date.

        The briefing stops paging at the first row past its window, which is
        only sound on an ordered listing. The second enrollment is created
        LATER but falls due EARLIER, and `installments/` orders by
        (enrollment, number) by default — so if `ordering=due_date` were
        dropped the walk would stop on the first enrollment's October row and
        never reach the July one below it.
        """
        reg = self.call('convert_enquiry_to_registration', self.mgr_k, enquiry_id=self.enq_k2.pk, registration_fee='1000')
        # Due 2026-08-02, 2026-09-02, 2026-10-02.
        late = self.call('enroll_student', self.mgr_k, registration_id=reg['id'], program_name='MBBS',
                         start_date='2026-07-02', duration_months=12, total_fees='300', installments_count=3)
        # Due 2026-07-05 only.
        early = self.call('enroll_student', self.mgr_k, registration_id=reg['id'], program_name='BDS',
                          start_date='2026-06-05', duration_months=12, total_fees='100', installments_count=1)
        briefing = self.call('daily_briefing', self.mgr_k, date='2026-09-01')
        overdue = briefing['overdue_installments']
        self.assertEqual([i['due_date'] for i in overdue], ['2026-07-05', '2026-08-02'])
        self.assertEqual([i['enrollment'] for i in overdue], [early['id'], late['id']])
        self.assertEqual(overdue[0]['student_name'], 'kohima-two')
        self.assertEqual(overdue[1]['enrollment_no'], late['enrollment_no'])
        self.assertEqual([i['due_date'] for i in briefing['installments_due_soon']], ['2026-09-02'])

    def test_daily_briefing_skips_a_completed_follow_up_and_keeps_overdue_ones(self):
        """
        The far-future follow-up is created FIRST on purpose.

        The walk stops at the first row scheduled past the briefing day, so an
        unordered listing would stop on row one and report nothing due at all.
        This does not on its own prove the tool sends `ordering=scheduled_for`,
        because FollowUp.Meta already orders by that column; the equivalent
        check for `installments/`, whose default order is by enrollment, does.
        """
        self.call('create_follow_up', self.mgr_k,
                  data={'enquiry': self.enq_k1.pk, 'scheduled_for': '2026-09-30T09:00:00Z'})
        stale = self.call('create_follow_up', self.mgr_k,
                          data={'enquiry': self.enq_k2.pk, 'scheduled_for': '2026-08-20T09:00:00Z'})
        done = self.call('create_follow_up', self.mgr_k,
                         data={'enquiry': self.enq_k1.pk, 'scheduled_for': '2026-09-02T09:00:00Z'})
        self.call('update_follow_up', self.mgr_k, id=done['id'], data={'status': 'Completed'})
        briefing = self.call('daily_briefing', self.mgr_k, date='2026-09-02')
        self.assertEqual([f['id'] for f in briefing['follow_ups_due']], [stale['id']])
        self.assertEqual([f['id'] for f in briefing['overdue_follow_ups']], [stale['id']])

    def test_daily_briefing_works_for_an_employee(self):
        self.call('create_follow_up', self.emp_k2, data={'enquiry': self.enq_k2.pk, 'scheduled_for': '2026-09-02T09:00:00Z'})
        briefing = self.call('daily_briefing', self.emp_k2, date='2026-09-02')
        self.assertEqual(len(briefing['follow_ups_due']), 1)
        for section in ('appointments_today', 'overdue_installments', 'expiring_documents',
                        'pending_approvals', 'transfer_inbox', 'overview'):
            self.assertIn(section, briefing)
        self.assertIsInstance(briefing['unread_notifications'], int)

    def test_daily_briefing_defaults_to_today(self):
        briefing = self.call('daily_briefing', self.mgr_k)
        self.assertEqual(briefing['date'], dt.date.today().isoformat())

    def test_daily_briefing_rejects_a_bad_date(self):
        self.assertIn('YYYY-MM-DD', self.call_raises('daily_briefing', self.mgr_k, date='02/09/2026'))


class ForbiddenSectionTests(ForbiddenSectionMixin, McpTestCase):
    def test_search_everything_treats_a_forbidden_group_as_empty(self):
        self.forbid = ('users/',)
        result = self.call('search_everything', self.admin, query='kohima')
        self.assertEqual(result['users'], [])
        self.assertEqual(result['counts']['users'], 0)
        self.assertEqual(len(result['enquiries']), 2)

    def test_student_360_marks_the_sections_it_may_not_read(self):
        self.forbid = ()
        reg = self.call('convert_enquiry_to_registration', self.mgr_k, enquiry_id=self.enq_k2.pk,
                        registration_fee='1000', payment_status='Paid')
        self.forbid = ('refunds/', 'student-remarks/')
        profile = self.call('student_360', self.mgr_k, registration_id=reg['id'])
        self.assertEqual(profile['refunds'], {'forbidden': True})
        self.assertEqual(profile['remarks'], {'forbidden': True})
        self.assertEqual(profile['registration']['id'], reg['id'])
        # A forbidden refunds section must not poison the arithmetic.
        self.assertEqual(profile['totals']['paid'], 1000.0)
        self.assertEqual(profile['totals']['refunded'], 0.0)

    def test_daily_briefing_survives_a_forbidden_section(self):
        self.forbid = ('analytics/', 'notifications/')
        briefing = self.call('daily_briefing', self.mgr_k, date='2026-09-02')
        self.assertEqual(briefing['overview'], {'forbidden': True})
        self.assertEqual(briefing['unread_notifications'], {'forbidden': True})
        self.assertEqual(briefing['follow_ups_due'], [])
        self.assertEqual(briefing['date'], '2026-09-02')


class RegistrationTests(McpTestCase):
    def test_read_only_mode_hides_the_three_writes_and_keeps_the_three_reads(self):
        tools = self.tool_names(self.admin, read_only=True)
        for name in ('student_360', 'search_everything', 'daily_briefing'):
            self.assertIn(name, tools)
            self.assertIs(tools[name].annotations.readOnlyHint, True)
        for name in ('convert_enquiry_to_registration', 'enroll_student', 'record_payment'):
            self.assertNotIn(name, tools)

    def test_write_tools_are_annotated_as_non_destructive_writes(self):
        tools = self.tool_names(self.admin)
        for name in ('convert_enquiry_to_registration', 'enroll_student', 'record_payment'):
            with self.subTest(tool=name):
                annotations = tools[name].annotations
                self.assertIs(annotations.readOnlyHint, False)
                self.assertIs(annotations.destructiveHint, False)
                self.assertIs(annotations.idempotentHint, False)

    def test_every_workflow_tool_describes_itself(self):
        tools = self.tool_names(self.admin)
        for name in ('student_360', 'search_everything', 'daily_briefing',
                     'convert_enquiry_to_registration', 'enroll_student', 'record_payment'):
            with self.subTest(tool=name):
                self.assertTrue((tools[name].description or '').strip())
                self.assertIsNotNone(tools[name].outputSchema, f'{name} has no structured output')

    def test_payment_metadata_table_covers_the_methods_the_console_offers(self):
        self.assertEqual(set(PAYMENT_METADATA_KEYS), {'Cash', 'Cheque', 'UPI', 'Card'})
        self.assertEqual(PAYMENT_METADATA_KEYS['Cash'], ())
        self.assertEqual(PAYMENT_METADATA_KEYS['UPI'], ('upi_transaction_id',))
