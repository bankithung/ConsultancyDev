from django.test import TestCase
from rest_framework.test import APIClient
from core import services
from core.models import Branch, User, Role

class DefaultBranchTests(TestCase):
    def setUp(self):
        self.company, self.original = services.provision_company('Default test')
        self.other, self.foreign = services.provision_company('Other tenant')
        self.target = Branch.objects.create(company=self.company, name='Second', code='SECOND')
        self.admin = User.objects.create(username='defaultadmin', company=self.company, role=Role.COMPANY_ADMIN)
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def change(self, branch):
        return self.client.post(f'/api/branches/{branch.pk}/set-default/')

    def test_switch_and_repeat(self):
        for _ in range(2):
            self.assertEqual(self.change(self.target).status_code, 200)
            self.assertEqual(list(Branch.objects.filter(company=self.company, is_default=True).values_list('pk', flat=True)), [self.target.pk])
        self.foreign.refresh_from_db()
        self.assertTrue(self.foreign.is_default)

    def test_foreign_and_inactive(self):
        self.assertEqual(self.change(self.foreign).status_code, 404)
        self.target.is_active = False
        self.target.save()
        self.assertEqual(self.change(self.target).status_code, 400)
        self.original.refresh_from_db()
        self.assertTrue(self.original.is_default)

    def test_non_admins(self):
        for role in (Role.HEAD_MANAGER, Role.BRANCH_MANAGER, Role.EMPLOYEE):
            user = User.objects.create(username=role, company=self.company, branch=self.target, role=role)
            self.client.force_authenticate(user)
            self.assertEqual(self.change(self.target).status_code, 403)
