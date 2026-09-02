"""
Round trips for the two hand-written document tools.

Every upload here goes through the real viewset, the real encryption service
and the real disk, and every download comes back through the streaming action,
so a test proves the bytes survived the trip rather than that a mock was
called. PRIVATE_MEDIA_ROOT is redirected to a temporary directory for the whole
class: the service writes encrypted blobs eagerly and Django's test transaction
cannot roll a file back, so without this the suite would leave scans in the
repository's private_media/.
"""

import base64
import hashlib
import tempfile
from pathlib import Path

from django.test import override_settings
from mcp.shared.memory import create_connected_server_and_client_session

from core.models import Document, Registration
from mcp_server.catalog import Catalog
from mcp_server.config import Settings
from mcp_server.server import build_server
from mcp_server.testing import DjangoTestTransport

from .base import CATALOG, McpTestCase, _run

PDF = b'%PDF-1.4 hello'


def catalog_with_upload_limit(max_bytes: int) -> Catalog:
    """
    The shared catalog with a smaller upload cap.

    The real cap is 10 MB, and proving the client-side guard fires would
    otherwise mean building an 11 MB payload and pushing it through the
    protocol. The copy is shallow apart from the two dicts it rewrites, so the
    shared catalog is left untouched.
    """
    raw = dict(CATALOG.raw)
    conventions = dict(raw['conventions'])
    conventions['uploads'] = {**conventions['uploads'], 'max_bytes': max_bytes}
    raw['conventions'] = conventions
    return Catalog(raw)


class DocumentToolTests(McpTestCase):
    @classmethod
    def setUpClass(cls):
        cls._private_media = tempfile.TemporaryDirectory(prefix='mcp-documents-')
        cls._media_override = override_settings(PRIVATE_MEDIA_ROOT=Path(cls._private_media.name))
        cls._media_override.enable()
        try:
            super().setUpClass()
        except Exception:
            cls._media_override.disable()
            cls._private_media.cleanup()
            raise

    @classmethod
    def tearDownClass(cls):
        try:
            super().tearDownClass()
        finally:
            cls._media_override.disable()
            cls._private_media.cleanup()

    # ------------------------------------------------------------- helpers

    def call_tuned(self, name, user, arguments, catalog=None, **overrides):
        """
        Call one tool on a server built with non-default settings.

        `McpTestCase.call` always builds the default server, and three of the
        rulings here are ABOUT the settings: the download size cap, and the
        refusal of local paths when the transport is not stdio. Returns
        (payload, error_text) with exactly one of the two set.
        """
        settings = Settings(api_url='http://testserver/api/', api_key=self.key_for(user), **overrides)
        server = build_server(settings, transport=DjangoTestTransport(), catalog=catalog or CATALOG)

        async def go():
            async with create_connected_server_and_client_session(server) as session:
                return await session.call_tool(name, arguments)

        result = _run(go())
        if result.isError:
            return None, ''.join(c.text for c in result.content if getattr(c, 'type', '') == 'text')
        return self._unwrap(result), None

    def upload(self, user, content=PDF, **arguments):
        arguments.setdefault('file_name', 'offer.pdf')
        return self.call('upload_document', user, file_base64=base64.b64encode(content).decode(), **arguments)

    # -------------------------------------------------------- round trips

    def test_upload_base64_then_download_base64(self):
        doc = self.call('upload_document', self.emp_k1, file_name='offer.pdf',
                        file_base64=base64.b64encode(PDF).decode(), type='Offer Letter',
                        enquiry=self.enq_k1.pk, expiry_date='2027-01-31')
        self.assertEqual(doc['file_name'], 'offer.pdf')
        self.assertEqual(doc['student_name'], 'kohima-one')
        self.assertEqual(doc['type'], 'Offer Letter')
        self.assertEqual(doc['expiry_date'], '2027-01-31')
        self.assertEqual(doc['status'], 'IN')
        self.assertTrue(doc['is_encrypted'])
        self.assertEqual(doc['file_size'], len(PDF))
        self.assertIn('pdf', doc['content_type'])
        self.assertEqual(doc['download_url'], f"/api/documents/{doc['id']}/download/")

        got = self.call('download_document', self.emp_k1, id=doc['id'])
        self.assertEqual(base64.b64decode(got['base64']), PDF)
        self.assertEqual(got['size'], len(PDF))
        self.assertEqual(got['file_name'], 'offer.pdf')
        self.assertEqual(got['content_type'], doc['content_type'])
        self.assertNotIn('note', got)

        stored = Document.objects.get(pk=doc['id'])
        self.assertEqual(stored.checksum, hashlib.sha256(PDF).hexdigest())
        # What landed on disk is ciphertext: the round trip proves the view
        # decrypts, not that encryption was skipped.
        blob = Path(self._private_media.name) / stored.file.name
        self.assertTrue(blob.is_file())
        self.assertNotEqual(blob.read_bytes(), PDF)

    def test_upload_from_path_and_download_to_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / 'scan.png'
            src.write_bytes(b'\x89PNG fake')
            doc = self.call('upload_document', self.mgr_k, file_name='scan.png', file_path=str(src),
                            type='Passport')
            target = Path(tmp) / 'out.png'
            got = self.call('download_document', self.mgr_k, id=doc['id'], save_to=str(target))
            self.assertEqual(Path(got['saved_to']), target.resolve())
            self.assertEqual(target.read_bytes(), b'\x89PNG fake')
            self.assertIsNone(got.get('base64'))
            self.assertEqual(got['size'], len(b'\x89PNG fake'))

    def test_download_respects_the_size_cap(self):
        content = b'x' * 2048
        doc = self.upload(self.admin, content=content, file_name='big.pdf')
        payload, error = self.call_tuned('download_document', self.admin, {'id': doc['id']},
                                         max_download_bytes=1024)
        self.assertIsNone(error)
        self.assertIsNone(payload['base64'])
        self.assertEqual(payload['size'], 2048)
        self.assertIn('save_to', payload['note'])
        self.assertIn('1024', payload['note'])

    # ------------------------------------------------------ local paths

    def test_file_path_is_refused_when_not_stdio(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / 'scan.pdf'
            src.write_bytes(PDF)
            payload, error = self.call_tuned('upload_document', self.admin,
                                             {'file_name': 'scan.pdf', 'file_path': str(src)},
                                             transport='streamable-http')
        self.assertIsNone(payload)
        self.assertIn('file_base64', error)
        self.assertEqual(Document.objects.count(), 0)

    def test_save_to_is_refused_when_not_stdio(self):
        doc = self.upload(self.admin)
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'out.pdf'
            payload, error = self.call_tuned('download_document', self.admin,
                                             {'id': doc['id'], 'save_to': str(target)},
                                             transport='streamable-http')
            self.assertIsNone(payload)
            self.assertIn('base64', error)
            self.assertFalse(target.exists())

    def test_save_to_a_directory_is_rejected(self):
        doc = self.upload(self.emp_k1)
        with tempfile.TemporaryDirectory() as tmp:
            text = self.call_raises('download_document', self.emp_k1, id=doc['id'], save_to=tmp)
            self.assertIn('directory', text)
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_save_to_does_not_create_directories(self):
        doc = self.upload(self.emp_k1)
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'nested' / 'out.pdf'
            text = self.call_raises('download_document', self.emp_k1, id=doc['id'], save_to=str(target))
            self.assertIn('does not exist', text)
            self.assertFalse(target.parent.exists())

    def test_file_path_that_is_a_directory_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            text = self.call_raises('upload_document', self.emp_k1, file_name='x.pdf', file_path=tmp)
        self.assertIn('directory', text)
        self.assertEqual(Document.objects.count(), 0)

    def test_missing_file_path_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / 'nope.pdf'
            text = self.call_raises('upload_document', self.emp_k1, file_name='nope.pdf', file_path=str(missing))
        self.assertIn('does not exist', text)

    # --------------------------------------------------- argument guards

    def test_missing_content_is_rejected(self):
        text = self.call_raises('upload_document', self.emp_k1, file_name='x.pdf')
        self.assertIn('file_base64', text)
        self.assertEqual(Document.objects.count(), 0)

    def test_two_sources_of_content_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / 'scan.pdf'
            src.write_bytes(PDF)
            text = self.call_raises('upload_document', self.emp_k1, file_name='scan.pdf',
                                    file_base64=base64.b64encode(PDF).decode(), file_path=str(src))
        self.assertIn('not both', text)
        self.assertEqual(Document.objects.count(), 0)

    def test_invalid_base64_is_rejected(self):
        text = self.call_raises('upload_document', self.emp_k1, file_name='x.pdf', file_base64='not base64!!')
        self.assertIn('base64', text)
        self.assertEqual(Document.objects.count(), 0)

    def test_disallowed_extension_is_refused_before_upload(self):
        text = self.call_raises('upload_document', self.emp_k1, file_name='x.exe',
                                file_base64=base64.b64encode(b'x').decode())
        self.assertIn('exe', text)
        self.assertIn('pdf', text)
        self.assertEqual(Document.objects.count(), 0)

    def test_oversize_upload_is_refused_before_upload(self):
        payload, error = self.call_tuned(
            'upload_document', self.emp_k1,
            {'file_name': 'big.pdf', 'file_base64': base64.b64encode(b'x' * 64).decode()},
            catalog=catalog_with_upload_limit(16),
        )
        self.assertIsNone(payload)
        self.assertIn('64', error)
        self.assertIn('16', error)
        self.assertEqual(Document.objects.count(), 0)

    def test_both_registration_and_enquiry_is_rejected(self):
        reg = Registration.objects.create(
            company=self.company, branch=self.kohima, created_by=self.emp_k1, owner=self.emp_k1,
            student_name='R', registration_no='REG-2026-001', registration_fee=100,
        )
        text = self.call_raises('upload_document', self.emp_k1, file_name='x.pdf',
                                file_base64=base64.b64encode(b'x').decode(), registration=reg.pk,
                                enquiry=self.enq_k1.pk)
        self.assertIn('one of registration or enquiry', text)
        self.assertEqual(Document.objects.count(), 0)

    def test_the_api_rejection_of_both_links_is_preserved(self):
        """The guard above never reaches the API, so the API's own 400 is proved separately."""
        reg = Registration.objects.create(
            company=self.company, branch=self.kohima, created_by=self.emp_k1, owner=self.emp_k1,
            student_name='R', registration_no='REG-2026-002', registration_fee=100,
        )
        text = self.call_raises('create_document', self.emp_k1, data={
            'file_name': 'x.pdf', 'type': 'Other', 'registration': reg.pk, 'enquiry': self.enq_k1.pk,
        })
        self.assertIn('400', text)
        self.assertIn('fields=', text)
        self.assertIn('one of registration or enquiry', text)

    # ------------------------------------------------------------- scope

    def test_download_out_of_scope_is_404(self):
        doc = self.upload(self.emp_d1, file_name='d.pdf')
        text = self.call_raises('download_document', self.emp_k1, id=doc['id'])
        self.assertIn('404', text)

    def test_download_without_a_stored_file_is_404(self):
        doc = self.call('create_document', self.emp_k1, data={'file_name': 'ghost.pdf', 'type': 'Other'})
        text = self.call_raises('download_document', self.emp_k1, id=doc['id'])
        self.assertIn('File is not available.', text)

    # ------------------------------------------------------ registration

    def test_upload_hidden_in_read_only_mode(self):
        names = self.tool_names(self.admin, read_only=True)
        self.assertNotIn('upload_document', names)
        self.assertIn('download_document', names)

    def test_annotations(self):
        tools = self.tool_names(self.admin)
        upload = tools['upload_document'].annotations
        self.assertFalse(upload.readOnlyHint)
        self.assertFalse(upload.destructiveHint)
        self.assertFalse(upload.idempotentHint)
        self.assertTrue(tools['download_document'].annotations.readOnlyHint)

    def test_descriptions_carry_the_server_limits(self):
        tools = self.tool_names(self.admin)
        self.assertIn('10485760', tools['upload_document'].description)
        self.assertIn('pdf', tools['upload_document'].description)
        self.assertIn(str(Settings().max_download_bytes), tools['download_document'].description)
