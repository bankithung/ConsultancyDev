from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient
from core import services
from core.models import User, Role, Branch, Task, ApprovalRequest, Notification

class TaskApprovalTests(TestCase):
    def setUp(self):
        self.company, self.branch = services.provision_company('Task approval test')
        self.other = Branch.objects.create(company=self.company, name='Other', code='OTHER')
        self.emp = User.objects.create(username='employee', company=self.company, branch=self.branch, role=Role.EMPLOYEE)
        self.manager = User.objects.create(username='manager', company=self.company, branch=self.branch, role=Role.BRANCH_MANAGER)
        self.head = User.objects.create(username='head', company=self.company, role=Role.HEAD_MANAGER)
        self.admin = User.objects.create(username='admin', company=self.company, role=Role.COMPANY_ADMIN)
        self.outsider = User.objects.create(username='outsider', company=self.company, branch=self.other, role=Role.BRANCH_MANAGER)
        self.task = Task.objects.create(company=self.company, branch=self.branch, owner=self.emp, created_by=self.emp, assigned_to=self.emp, title='Test task', due_date=timezone.now())
        self.client = APIClient()
        self.client.force_authenticate(self.emp)

    def submit(self, **values):
        return self.client.post(f'/api/tasks/{self.task.pk}/request-status/', {'status':'In Progress', 'message':'Started research', 'assigned_reviewer':self.manager.pk, **values}, format='json')

    def test_status_requires_approval_on_all_employee_write_paths(self):
        self.assertEqual(self.client.patch(f'/api/tasks/{self.task.pk}/', {'status':'Done'}, format='json').status_code, 400)
        self.assertEqual(self.client.post('/api/tasks/reorder/', {'ids':[self.task.pk], 'status':'Done'}, format='json').status_code, 403)
        self.task.refresh_from_db()
        self.assertEqual(self.task.status, 'Todo')

    def test_request_edit_and_manager_approval(self):
        response = self.submit()
        self.assertEqual(response.status_code, 200, response.data)
        self.task.refresh_from_db()
        self.assertEqual(self.task.status, 'Todo')
        self.assertTrue(Notification.objects.filter(user=self.manager).exists())
        updated = self.submit(message='Finished research', status='Done')
        self.assertEqual(updated.data['id'], response.data['id'])
        self.client.force_authenticate(self.manager)
        response = self.client.post(f"/api/approval-requests/{response.data['id']}/approve/")
        self.assertEqual(response.status_code, 200, response.data)
        self.task.refresh_from_db()
        self.assertEqual(self.task.status, 'Done')
        self.assertIsNotNone(self.task.completed_at)
        self.assertEqual(self.client.post(f"/api/approval-requests/{response.data['id']}/approve/").status_code, 400)

    def test_reviewer_scope_description_and_self_approval(self):
        self.assertEqual(self.submit(message=' ').status_code, 400)
        self.assertEqual(self.submit(assigned_reviewer=self.outsider.pk).status_code, 400)
        response = self.submit()
        self.assertEqual(self.client.post(f"/api/approval-requests/{response.data['id']}/approve/").status_code, 403)
        self.client.force_authenticate(self.outsider)
        self.assertEqual(self.client.post(f"/api/approval-requests/{response.data['id']}/approve/").status_code, 404)

    def test_head_fallback_and_admin_direct_change(self):
        response = self.submit()
        self.manager.is_active_employee = False
        self.manager.save()
        self.client.force_authenticate(self.head)
        self.assertEqual(self.client.post(f"/api/approval-requests/{response.data['id']}/approve/").status_code, 200)
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.client.patch(f'/api/tasks/{self.task.pk}/', {'status':'Done'}, format='json').status_code, 200)

    def test_rejection_does_not_move_task(self):
        response = self.submit()
        self.client.force_authenticate(self.manager)
        self.assertEqual(self.client.post(f"/api/approval-requests/{response.data['id']}/reject/", {'note':'More detail needed'}).status_code, 200)
        self.task.refresh_from_db()
        self.assertEqual(self.task.status, 'Todo')
        self.client.force_authenticate(self.emp)
        self.assertEqual(self.submit().status_code, 200)
