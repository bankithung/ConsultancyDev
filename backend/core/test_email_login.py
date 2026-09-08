from django.test import TestCase
from django.core.cache import cache
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import AccessToken
from rest_framework_simplejwt.token_blacklist.models import OutstandingToken
from core.models import User, Role

class EmailLoginTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username='manager2', email='manager2@example.com', password='DemoPassword!33', role=Role.BRANCH_MANAGER)
        self.client = APIClient()

    def login(self, identifier, password='DemoPassword!33'):
        return self.client.post('/api/auth/login/', {'username':identifier,'password':password}, format='json')

    def test_username_email_and_case_insensitive_email(self):
        for identifier in ('manager2', 'manager2@example.com', '  MANAGER2@EXAMPLE.COM  '):
            response = self.login(identifier)
            self.assertEqual(response.status_code, 200, response.data)
            self.assertEqual(response.data['user']['id'], self.user.pk)
            self.assertEqual(AccessToken(response.data['access'])['user_id'], str(self.user.pk))

    def test_wrong_password_and_unknown_email(self):
        for identifier in ('manager2@example.com','unknown@example.com'):
            self.assertEqual(self.login(identifier,'wrong').status_code, 401)

    def test_inactive_employee_has_no_tokens(self):
        self.user.is_active_employee = False
        self.user.save()
        self.assertEqual(self.login(self.user.email).status_code, 403)
        self.assertFalse(OutstandingToken.objects.filter(user=self.user).exists())

    def test_disabled_account(self):
        self.user.is_active = False
        self.user.save()
        self.assertEqual(self.login(self.user.email).status_code, 401)

    def test_duplicate_email_requires_username(self):
        User.objects.create_user(username='other', email=self.user.email.upper(), password='OtherPassword!33')
        self.assertEqual(self.login(self.user.email).status_code, 401)
        self.assertEqual(self.login(self.user.username).status_code, 200)

    def test_exact_username_takes_precedence_over_email_collision(self):
        other = User.objects.create_user(username=self.user.email, email='other@example.com', password='OtherPassword!33')
        self.assertEqual(self.login(self.user.email).status_code, 401)
        response = self.login(self.user.email,'OtherPassword!33')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['user']['id'], other.pk)

class HeadManagerBaseBranchTests(TestCase):
    def test_changing_base_branch_preserves_all_company_branch_access(self):
        from core import services
        from core.models import Branch
        from core.permissions import branch_ids_for
        company, first = services.provision_company('Head manager test')
        other, foreign = services.provision_company('Other company')
        second = Branch.objects.create(company=company, name='Second', code='SECOND')
        admin = User.objects.create(username='admin', company=company, role=Role.COMPANY_ADMIN)
        head = User.objects.create(username='head', company=company, branch=first, role=Role.HEAD_MANAGER)
        client = APIClient()
        client.force_authenticate(admin)
        response = client.patch(f'/api/users/{head.pk}/', {'branch':second.pk}, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        head.refresh_from_db()
        self.assertEqual(head.branch_id, second.pk)
        self.assertEqual(head.role, Role.HEAD_MANAGER)
        self.assertEqual(set(branch_ids_for(head)), {first.pk, second.pk})
        response = client.patch(f'/api/users/{head.pk}/', {'branch':foreign.pk}, format='json')
        self.assertEqual(response.status_code, 400)
