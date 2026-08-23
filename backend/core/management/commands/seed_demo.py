"""
Seed a realistic multi-branch organisation for development and manual testing.

Creates the full hierarchy the product is built around:

    Company: Doxa Education Consultancy
      ├─ Branch: Kohima
      │    ├─ Branch Manager
      │    └─ 2 Employees
      └─ Branch: Dimapur
           ├─ Branch Manager
           └─ 2 Employees
      Head Manager  (oversees both branch managers)
      Company Admin (sees everything)

Plus a second company so that tenant isolation can be verified by hand.
"""

from datetime import timedelta
from decimal import Decimal

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from core import services
from core.models import (
    Agent, Appointment, Branch, Company, Document, Enquiry, Enrollment,
    FollowUp, Payment, Registration, Role, Task, University, User,
    VisaTracking,
)

PASSWORD = 'Passw0rd!2026'


class Command(BaseCommand):
    help = 'Seed demo companies, branches, staff and CRM records.'

    def add_arguments(self, parser):
        parser.add_argument('--wipe', action='store_true', help='Delete existing demo data first.')

    @transaction.atomic
    def handle(self, *args, **options):
        if options['wipe']:
            Company.objects.filter(
                slug__in=['doxa-education-consultancy', 'northeast-overseas'],
            ).delete()
            User.objects.filter(role=Role.DEV_ADMIN, username='devadmin').delete()
            self.stdout.write(self.style.WARNING('Wiped existing demo data.'))

        services.ensure_default_plans()

        dev = self._user(
            'devadmin', Role.DEV_ADMIN, None, None,
            first='Platform', last='Operator', staff=True, superuser=True,
        )

        company, branches, staff = self._build_primary_company()
        self._build_crm(company, branches, staff)
        other = self._build_second_company()

        self._report(dev, company, branches, staff, other)

    # -- helpers ----------------------------------------------------------

    def _user(self, username, role, company, branch, first='', last='',
              staff=False, superuser=False):
        user, _ = User.objects.get_or_create(
            username=username,
            defaults={
                'email': f'{username}@example.com',
                'first_name': first,
                'last_name': last,
            },
        )
        user.role = role
        user.company = company
        user.branch = branch
        user.first_name = first or user.first_name
        user.last_name = last or user.last_name
        user.email = user.email or f'{username}@example.com'
        user.is_staff = staff
        user.is_superuser = superuser
        user.is_active_employee = True
        user.set_password(PASSWORD)
        user.save()
        return user

    def _build_primary_company(self):
        company = Company.objects.filter(slug='doxa-education-consultancy').first()
        if company is None:
            company, _ = services.provision_company(
                'Doxa Education Consultancy',
                email='hello@doxa.example',
                phone='+91 370 000 0000',
                address='Circular Road, Kohima, Nagaland',
            )

        head_office = Branch.objects.get(company=company, is_default=True)
        kohima, _ = Branch.objects.get_or_create(
            company=company, name='Kohima',
            defaults={'code': 'KOH', 'city': 'Kohima', 'phone': '+91 370 111 1111'},
        )
        dimapur, _ = Branch.objects.get_or_create(
            company=company, name='Dimapur',
            defaults={'code': 'DMP', 'city': 'Dimapur', 'phone': '+91 386 222 2222'},
        )
        branches = {'head': head_office, 'kohima': kohima, 'dimapur': dimapur}

        admin = self._user('admin', Role.COMPANY_ADMIN, company, head_office, 'Anita', 'Rao')
        head = self._user('headmanager', Role.HEAD_MANAGER, company, head_office, 'Hemant', 'Sharma')
        mgr_k = self._user('manager.kohima', Role.BRANCH_MANAGER, company, kohima, 'Meren', 'Jamir')
        mgr_d = self._user('manager.dimapur', Role.BRANCH_MANAGER, company, dimapur, 'Dolly', 'Sema')

        emp_k1 = self._user('emp.kohima1', Role.EMPLOYEE, company, kohima, 'Kevi', 'Angami')
        emp_k2 = self._user('emp.kohima2', Role.EMPLOYEE, company, kohima, 'Neikhrienuo', 'Kire')
        emp_d1 = self._user('emp.dimapur1', Role.EMPLOYEE, company, dimapur, 'Imli', 'Ao')
        emp_d2 = self._user('emp.dimapur2', Role.EMPLOYEE, company, dimapur, 'Rokovilie', 'Nakhro')

        # The admin configures which managers the head manager oversees.
        head.managed_managers.set([mgr_k, mgr_d])

        staff = {
            'admin': admin, 'head': head, 'mgr_k': mgr_k, 'mgr_d': mgr_d,
            'emp_k1': emp_k1, 'emp_k2': emp_k2, 'emp_d1': emp_d1, 'emp_d2': emp_d2,
        }
        return company, branches, staff

    def _build_crm(self, company, branches, staff):
        if Enquiry.objects.filter(company=company).exists():
            self.stdout.write('CRM records already present; skipping.')
            return

        uni, _ = University.objects.get_or_create(
            company=company, name='University of Manchester',
            defaults={
                'country': 'United Kingdom', 'city': 'Manchester', 'ranking': 32,
                'programs': ['MSc Computer Science', 'MBA'],
                'tuition_fee_min': 800000, 'tuition_fee_max': 1500000,
                'admission_deadline': '2026-06-30',
                'requirements': ['IELTS 6.5', "Bachelor's degree"], 'rating': Decimal('4.50'),
            },
        )
        agent, _ = Agent.objects.get_or_create(
            company=company, name='Northeast Study Partners',
            defaults={
                'email': 'partners@example.com', 'commission_type': 'Percentage',
                'commission_value': Decimal('10.00'), 'branch': branches['kohima'],
                'created_by': staff['admin'], 'owner': staff['admin'],
            },
        )

        people = [
            ('Rahul Sharma', 'Science', 'kohima', 'emp_k1'),
            ('Priya Singh', 'Commerce', 'kohima', 'emp_k1'),
            ('Amit Patel', 'Arts', 'kohima', 'emp_k2'),
            ('Sneha Roy', 'Science', 'dimapur', 'emp_d1'),
            ('Vikram Nair', 'Commerce', 'dimapur', 'emp_d1'),
            ('Tali Jamir', 'Science', 'dimapur', 'emp_d2'),
        ]

        now = timezone.now()
        for i, (name, stream, branch_key, owner_key) in enumerate(people):
            branch = branches[branch_key]
            owner = staff[owner_key]
            enquiry = Enquiry.objects.create(
                company=company, branch=branch, created_by=owner, owner=owner,
                school_name=f'St. Joseph School {i + 1}', stream=stream,
                candidate_name=name, course_interested='BTech Computer Science',
                mobile=f'98765{43200 + i}', email=f'{name.split()[0].lower()}@example.com',
                father_name=f'Mr. {name.split()[1]}', mother_name=f'Mrs. {name.split()[1]}',
                father_occupation='Business', mother_occupation='Teacher',
                permanent_address=f'{i + 1} Circular Road, {branch.city}, Nagaland',
                preferred_locations=['United Kingdom', 'Canada'],
                status=Enquiry.Status.CONVERTED if i < 4 else Enquiry.Status.NEW,
            )
            FollowUp.objects.create(
                company=company, branch=branch, created_by=owner, owner=owner,
                enquiry=enquiry, assigned_to=owner,
                scheduled_for=now + timedelta(days=i + 1),
                type='Call', status='Pending', priority='High' if i < 2 else 'Medium',
                notes='Discuss course options and fee structure.',
            )

            if i >= 4:
                continue

            registration = Registration.objects.create(
                company=company, branch=branch, created_by=owner, owner=owner,
                registration_no=f'REG-2026-{i + 1:03d}', student_name=name,
                mobile=f'98765{43200 + i}', email=f'{name.split()[0].lower()}@example.com',
                date_of_birth=(now - timedelta(days=365 * 20)).date(),
                father_name=f'Mr. {name.split()[1]}', mother_name=f'Mrs. {name.split()[1]}',
                permanent_address=f'{i + 1} Circular Road, {branch.city}',
                registration_fee=Decimal('15000.00'), payment_status='Paid',
                payment_method='Cash' if i % 2 else 'Bank Transfer',
                preferences=['University of Manchester'], enquiry=enquiry,
            )
            Payment.objects.create(
                company=company, branch=branch, created_by=owner, owner=owner,
                registration=registration, student_name=name,
                amount=Decimal('15000.00'), type='Registration',
                status=Payment.Status.SUCCESS, method=registration.payment_method,
            )
            Document.objects.create(
                company=company, branch=branch, created_by=owner, owner=owner,
                registration=registration, file_name=f'{name.replace(" ", "_")}_passport.pdf',
                type='Passport', student_name=name,
                expiry_date=(now + timedelta(days=200 + i * 40)).date(),
                is_encrypted=False,
            )

            if i >= 2:
                continue

            enrollment = Enrollment.objects.create(
                company=company, branch=branch, created_by=owner, owner=owner,
                enrollment_no=f'ENR-2026-{i + 1:03d}', student=registration,
                program_name='MSc Computer Science', university=uni,
                university_name=uni.name, country='United Kingdom',
                start_date=(now + timedelta(days=120)).date(), duration_months=24,
                total_fees=Decimal('1200000.00'), commission_amount=Decimal('120000.00'),
            )
            services.build_installments(enrollment, 4)
            Payment.objects.create(
                company=company, branch=branch, created_by=owner, owner=owner,
                registration=registration, enrollment=enrollment, student_name=name,
                amount=Decimal('300000.00'), type='Enrollment',
                status=Payment.Status.SUCCESS, method='Bank Transfer',
            )
            VisaTracking.objects.create(
                company=company, branch=branch, created_by=owner, owner=owner,
                student=registration, student_name=name,
                passport_no=f'M{7654321 + i}', country='United Kingdom',
                visa_type='Student (Tier 4)', applied_date=now.date(),
                current_stage='Applied' if i else 'Interview',
                expected_decision=(now + timedelta(days=45)).date(),
            )
            Appointment.objects.create(
                company=company, branch=branch, created_by=owner, owner=owner,
                student_name=name, student_email=f'{name.split()[0].lower()}@example.com',
                counselor=owner, date=now + timedelta(days=3 + i), duration=45,
                type='In-Person', status='Scheduled', notes='Visa document review.',
            )
            Task.objects.create(
                company=company, branch=branch, created_by=staff['mgr_k'], owner=owner,
                assigned_to=owner, title=f'Collect financial documents for {name}',
                description='Bank statements and sponsor letter.',
                due_date=now + timedelta(days=5), priority='High', status='Todo',
            )

    def _build_second_company(self):
        """A second tenant, so cross-company isolation can be checked by hand."""
        other = Company.objects.filter(slug='northeast-overseas').first()
        if other is None:
            other, branch = services.provision_company(
                'Northeast Overseas', email='info@neo.example',
            )
        else:
            branch = Branch.objects.filter(company=other, is_default=True).first()

        rival_admin = self._user('rival.admin', Role.COMPANY_ADMIN, other, branch, 'Rival', 'Admin')
        if not Enquiry.objects.filter(company=other).exists():
            Enquiry.objects.create(
                company=other, branch=branch, created_by=rival_admin, owner=rival_admin,
                school_name='Rival School', stream='Science',
                candidate_name='CONFIDENTIAL Rival Student',
                course_interested='MBA', mobile='9000000000',
                email='rival@example.com', father_name='Mr Rival', mother_name='Mrs Rival',
                permanent_address='Rival Address', status=Enquiry.Status.NEW,
            )
        return other

    def _report(self, dev, company, branches, staff, other):
        w = self.stdout.write
        w('')
        w(self.style.SUCCESS('=' * 66))
        w(self.style.SUCCESS(' SEED COMPLETE'))
        w(self.style.SUCCESS('=' * 66))
        w(f'  Password for every account below: {PASSWORD}')
        w('')
        w(f'  {"USERNAME":<20} {"ROLE":<16} {"BRANCH"}')
        w(f'  {"-" * 20} {"-" * 16} {"-" * 20}')
        rows = [
            (dev.username, 'DEV_ADMIN', '(platform)'),
            (staff['admin'].username, 'COMPANY_ADMIN', 'Head Office'),
            (staff['head'].username, 'HEAD_MANAGER', 'Head Office'),
            (staff['mgr_k'].username, 'BRANCH_MANAGER', 'Kohima'),
            (staff['mgr_d'].username, 'BRANCH_MANAGER', 'Dimapur'),
            (staff['emp_k1'].username, 'EMPLOYEE', 'Kohima'),
            (staff['emp_k2'].username, 'EMPLOYEE', 'Kohima'),
            (staff['emp_d1'].username, 'EMPLOYEE', 'Dimapur'),
            (staff['emp_d2'].username, 'EMPLOYEE', 'Dimapur'),
            ('rival.admin', 'COMPANY_ADMIN', f'{other.name} (other tenant)'),
        ]
        for username, role, branch in rows:
            w(f'  {username:<20} {role:<16} {branch}')
        w('')
        w(f'  Head manager oversees: {", ".join(m.username for m in staff["head"].managed_managers.all())}')
        w(f'  Company: {company.name} ({company.branches.count()} branches)')
        w(f'  Enquiries {Enquiry.objects.filter(company=company).count()}, '
          f'Registrations {Registration.objects.filter(company=company).count()}, '
          f'Enrollments {Enrollment.objects.filter(company=company).count()}, '
          f'Payments {Payment.objects.filter(company=company).count()}')
        w('')
