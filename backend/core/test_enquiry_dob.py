"""Saving DOB must round-trip without narrowing a free-text academic stream."""
from django.test import TestCase
from rest_framework.test import APIClient
from core.models import User, Role
from core.services import provision_company


class EnquiryDateOfBirthTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        company, branch = provision_company('Enquiry DOB test')
        cls.admin = User.objects.create_user(username='dob-admin', company=company, branch=branch, role=Role.COMPANY_ADMIN)

    def test_save_retrieve_and_clear_dob_preserves_pcb_stream(self):
        client = APIClient()
        client.force_authenticate(self.admin)
        body = {
            'candidate_name': 'DOB test student', 'school_name': 'Test school',
            'stream': 'PCB', 'course_interested': 'MBBS', 'mobile': '9000000000',
            'email': 'dob-test@example.com', 'father_name': 'Father',
            'mother_name': 'Mother', 'permanent_address': 'Test address',
        }
        created = client.post('/api/enquiries/', body, format='json', secure=True)
        self.assertEqual(created.status_code, 201, created.data)
        url = f"/api/enquiries/{created.data['id']}/"
        saved = client.put(url, {**body, 'date_of_birth': '2005-09-09'}, format='json', secure=True)
        self.assertEqual(saved.status_code, 200, saved.data)
        retrieved = client.get(url, secure=True)
        self.assertEqual(retrieved.data['date_of_birth'], '2005-09-09')
        self.assertEqual(retrieved.data['stream'], 'PCB')
        cleared = client.put(url, {**body, 'date_of_birth': None}, format='json', secure=True)
        self.assertEqual(cleared.status_code, 200, cleared.data)
        self.assertIsNone(client.get(url, secure=True).data['date_of_birth'])
