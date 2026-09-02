"""
The knowledge layer: consultancy:// resources, the prompt templates, and the
fifteen curated markdown topics.

The drift guard at the bottom is the point of this module. Prose about an API
rots silently — a tool gets renamed and the documentation keeps recommending
the old name to an AI client that will dutifully call it and get "Unknown
tool". So every backticked snake_case token in the knowledge files is checked
against the LIVE tool listing and the committed catalog: it must be a real
tool, a real field, a real filter, or an explicitly declared non-tool term.
"""

import json
import re

from mcp_server.catalog import load_catalog
from mcp_server.resources import KNOWLEDGE_DIR, list_topics, read_topic
from mcp_server.tools.workflows import PAYMENT_METADATA_KEYS

from .base import McpTestCase

EXPECTED_TOPICS = {
    'overview', 'roles-and-visibility', 'pipeline', 'payments-and-installments', 'documents', 'transfers',
    'approvals', 'follow-ups-and-appointments', 'visa-tracking', 'commissions', 'universities-and-templates',
    'notifications', 'analytics', 'api-conventions', 'gotchas',
}


class KnowledgeFilesTests(McpTestCase):
    def test_every_topic_exists_and_is_substantial(self):
        self.assertEqual(set(list_topics()), EXPECTED_TOPICS)
        for topic in EXPECTED_TOPICS:
            text = read_topic(topic)
            self.assertGreaterEqual(len(text.splitlines()), 25, topic)
            self.assertTrue(text.startswith('# '), topic)

    def test_unknown_topic_raises(self):
        with self.assertRaises(KeyError):
            read_topic('nope')

    def test_every_topic_is_between_40_and_120_lines(self):
        """Below 40 a topic is a stub; above 120 it stops being reference and starts being a book."""
        for topic in sorted(EXPECTED_TOPICS):
            lines = len(read_topic(topic).splitlines())
            self.assertGreaterEqual(lines, 40, f'{topic} is only {lines} lines')
            self.assertLessEqual(lines, 120, f'{topic} is {lines} lines')

    def test_read_topic_refuses_to_escape_the_knowledge_directory(self):
        for bad in ('../catalog', '..\\catalog', 'sub/dir', 'knowledge/../../catalog'):
            with self.assertRaises(KeyError, msg=bad):
                read_topic(bad)

    def test_knowledge_dir_holds_only_the_expected_markdown(self):
        self.assertTrue(KNOWLEDGE_DIR.is_dir())
        self.assertEqual({p.name for p in KNOWLEDGE_DIR.iterdir()},
                         {f'{topic}.md' for topic in EXPECTED_TOPICS})


class ResourceTests(McpTestCase):
    def test_fixed_resources(self):
        fixed, templates = self.list_resources(self.admin)
        for uri in ('consultancy://catalog', 'consultancy://enums', 'consultancy://roles',
                    'consultancy://api-reference', 'consultancy://knowledge', 'consultancy://me'):
            self.assertIn(uri, fixed)
        self.assertIn('consultancy://schema/{resource}', templates)
        self.assertIn('consultancy://knowledge/{topic}', templates)

    def test_catalog_resource_matches_file(self):
        served = json.loads(self.read_resource('consultancy://catalog', self.admin))
        self.assertEqual(served['schema_version'], load_catalog().raw['schema_version'])
        self.assertEqual({r['prefix'] for r in served['resources']}, set(load_catalog().by_prefix))

    def test_schema_and_knowledge_templates(self):
        md = self.read_resource('consultancy://schema/enquiries', self.admin)
        self.assertIn('candidate_name', md)
        gotchas = self.read_resource('consultancy://knowledge/gotchas', self.admin)
        self.assertIn('installments', gotchas)
        index = self.read_resource('consultancy://knowledge', self.admin)
        for topic in EXPECTED_TOPICS:
            self.assertIn(topic, index)

    def test_me_resource_is_live(self):
        me = json.loads(self.read_resource('consultancy://me', self.emp_k1))
        self.assertEqual(me['user']['username'], 'emp_k1')

    def test_enums_and_roles(self):
        enums = json.loads(self.read_resource('consultancy://enums', self.admin))
        self.assertIn('VisaTracking.current_stage', enums)
        roles = json.loads(self.read_resource('consultancy://roles', self.admin))
        self.assertIn('protected', roles)

    def test_me_differs_between_callers(self):
        """`me` is not a static document: two callers must get their own identity, role and capabilities."""
        employee = json.loads(self.read_resource('consultancy://me', self.emp_k1))
        admin = json.loads(self.read_resource('consultancy://me', self.admin))
        self.assertEqual(employee['role'], 'EMPLOYEE')
        self.assertEqual(admin['role'], 'COMPANY_ADMIN')
        self.assertNotEqual(employee['user']['username'], admin['user']['username'])
        self.assertNotEqual(employee['capabilities'], admin['capabilities'])
        self.assertIn('deleteRecords', admin['capabilities'])
        self.assertNotIn('deleteRecords', employee['capabilities'])
        self.assertTrue(employee['visibility'])
        self.assertNotEqual(employee['visibility'], admin['visibility'])

    def test_unknown_schema_resource_answers_helpfully(self):
        md = self.read_resource('consultancy://schema/enquiry', self.admin)
        self.assertIn('Unknown resource', md)
        self.assertIn('enquiries', md)

    def test_unknown_knowledge_topic_answers_helpfully(self):
        md = self.read_resource('consultancy://knowledge/nope', self.admin)
        self.assertIn('Unknown topic', md)
        self.assertIn('gotchas', md)

    def test_api_reference_and_roles_and_enums_render(self):
        reference = self.read_resource('consultancy://api-reference', self.admin)
        self.assertIn('# ConsultancyDev API reference', reference)
        self.assertIn('/api/enquiries/', reference)
        enums = json.loads(self.read_resource('consultancy://enums', self.admin))
        self.assertEqual([c['value'] for c in enums['Enquiry.status']],
                         ['New', 'Contacted', 'Converted', 'Closed'])
        roles = json.loads(self.read_resource('consultancy://roles', self.admin))
        self.assertEqual(set(roles['rank']), {'DEV_ADMIN', 'COMPANY_ADMIN', 'HEAD_MANAGER',
                                              'BRANCH_MANAGER', 'EMPLOYEE'})

    def test_resources_declare_their_mime_types(self):
        listing = self.resource_listing(self.admin)
        self.assertEqual(listing['consultancy://catalog'], 'application/json')
        self.assertEqual(listing['consultancy://enums'], 'application/json')
        self.assertEqual(listing['consultancy://roles'], 'application/json')
        self.assertEqual(listing['consultancy://me'], 'application/json')
        self.assertEqual(listing['consultancy://api-reference'], 'text/markdown')
        self.assertEqual(listing['consultancy://knowledge'], 'text/markdown')

    def test_knowledge_index_links_every_topic_with_its_headline(self):
        index = self.read_resource('consultancy://knowledge', self.admin)
        for topic in sorted(EXPECTED_TOPICS):
            headline = read_topic(topic).splitlines()[0].lstrip('# ').strip()
            self.assertIn(f'consultancy://knowledge/{topic}', index)
            self.assertIn(headline, index)


class PromptTests(McpTestCase):
    def test_prompts_render(self):
        names = self.list_prompts(self.admin)
        self.assertEqual(names, {'daily_briefing', 'onboard_student', 'follow_up_digest', 'pipeline_review',
                                 'permissions_audit', 'troubleshoot_error'})
        text = '\n'.join(self.get_prompt('onboard_student', self.admin, enquiry_id='12'))
        self.assertIn('convert_enquiry_to_registration', text)
        self.assertIn('12', text)
        text = '\n'.join(self.get_prompt('troubleshoot_error', self.admin,
                                         error='403 Your role cannot delete records directly.'))
        self.assertIn('create_approval_request', text)
        text = '\n'.join(self.get_prompt('daily_briefing', self.admin))
        self.assertIn('daily_briefing', text)

    def test_optional_arguments_are_optional_and_are_used(self):
        default = '\n'.join(self.get_prompt('daily_briefing', self.admin))
        self.assertIn('today', default)
        dated = '\n'.join(self.get_prompt('daily_briefing', self.admin, date='2026-09-01'))
        self.assertIn('2026-09-01', dated)
        self.assertIn('next 7 days', '\n'.join(self.get_prompt('follow_up_digest', self.admin)))
        self.assertIn('next 30 days', '\n'.join(self.get_prompt('follow_up_digest', self.admin, days='30')))
        self.assertIn('months=3', '\n'.join(self.get_prompt('pipeline_review', self.admin)))
        self.assertIn('months=6', '\n'.join(self.get_prompt('pipeline_review', self.admin, months='6')))
        self.assertIn('get_role_permissions', '\n'.join(self.get_prompt('permissions_audit', self.admin)))

    def test_every_prompt_is_described_and_declares_its_arguments(self):
        prompts = self.prompt_listing(self.admin)
        expected = {
            'daily_briefing': {'date': False},
            'onboard_student': {'enquiry_id': True},
            'follow_up_digest': {'days': False},
            'pipeline_review': {'months': False},
            'permissions_audit': {},
            'troubleshoot_error': {'error': True},
        }
        for name, arguments in expected.items():
            prompt = prompts[name]
            self.assertTrue((prompt.description or '').strip(), name)
            declared = {a.name: bool(a.required) for a in (prompt.arguments or [])}
            self.assertEqual(declared, arguments, name)

    def test_every_prompt_returns_one_non_trivial_user_message(self):
        for name, arguments in (('daily_briefing', {}), ('onboard_student', {'enquiry_id': '7'}),
                                ('follow_up_digest', {}), ('pipeline_review', {}),
                                ('permissions_audit', {}), ('troubleshoot_error', {'error': '404'})):
            messages = self.get_prompt(name, self.admin, **arguments)
            self.assertEqual(len(messages), 1, name)
            self.assertGreater(len(messages[0]), 200, name)

    def test_a_required_argument_is_enforced(self):
        # assertLogs captures the SDK's own ERROR record for the refusal, which
        # would otherwise print mid-run and make a passing suite look broken.
        with self.assertLogs('mcp.server.fastmcp.server', level='ERROR'):
            with self.assertRaises(Exception):
                self.get_prompt('onboard_student', self.admin)


class KnowledgeDriftTests(McpTestCase):
    """
    Every backticked snake_case token in the knowledge files must be something
    that really exists: a tool the server registers, a field/filter/parameter
    the catalog knows, or a term declared below.

    The failure message names the offender, so the fix is always either
    correcting the prose or adding one line here — never silently shipping
    documentation that sends a client to a tool that is not there.
    """

    # Backticked, lowercase, at least one underscore. Uppercase constants
    # (SCOPED_CACHE_SECONDS) and paths (`payments/stats/`) are deliberately not
    # matched: they are not tool-shaped and cannot be mistaken for a tool.
    TOKEN_RE = re.compile(r'`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`')

    # Real things that are neither a registered tool nor a catalog field. Kept
    # to exactly what the knowledge files use, so a stale entry can never
    # quietly cover a future typo.
    NON_TOOL_TERMS = frozenset({
        # list-tool parameters, not fields of any resource
        'all_pages', 'page_size',
        # keys of the explain_permission answer, quoted in the role docs
        'read_roles', 'write_roles', 'allowed_by_default',
    # Keys inside Payment.metadata, which is a JSON column: real, required by
    # record_payment, and invisible to a catalog that only knows the column.
    # Taken from the constant itself so a rename there fails this test rather
    # than leaving the documentation pointing at a key nothing writes.
    } | {key for keys in PAYMENT_METADATA_KEYS.values() for key in keys})

    def _tool_names(self):
        return set(self.tool_names(self.admin))

    def _known_catalog_terms(self):
        catalog = load_catalog()
        terms = set()
        for resource in catalog.raw['resources']:
            terms |= {f['name'] for f in resource['fields']}
            terms |= {f['param'] for f in resource['filters']}
            terms |= set(resource['search_fields']) | set(resource['ordering_fields'])
            for action in resource['actions']:
                terms |= set(action.get('body') or {})
                terms |= set(action.get('query') or {})
        for endpoint in catalog.standalone_endpoints:
            terms |= set(endpoint.get('body') or {})
            terms |= set(endpoint.get('query') or {})
        terms |= set(catalog.roles['defaults'])
        terms |= {t for values in catalog.approvals['mutable_fields'].values() for t in values}
        terms |= set(catalog.approvals['entity_types']) | set(catalog.transfers['transferable'])
        return terms

    def test_every_tool_shaped_token_in_the_knowledge_files_is_a_real_tool(self):
        """A token starting with a CRUD verb is unambiguously a tool reference; it must exist."""
        tools = self._tool_names()
        verbs = ('list', 'get', 'create', 'update', 'delete')
        missing = {}
        for topic in sorted(EXPECTED_TOPICS):
            for token in self.TOKEN_RE.findall(read_topic(topic)):
                if token.split('_')[0] in verbs and token not in tools:
                    missing.setdefault(token, []).append(topic)
        self.assertEqual(missing, {}, f'knowledge files name tools that do not exist: {missing}')

    def test_no_knowledge_file_names_an_unknown_identifier(self):
        tools = self._tool_names()
        known = tools | self._known_catalog_terms() | self.NON_TOOL_TERMS
        unknown = {}
        for topic in sorted(EXPECTED_TOPICS):
            for token in self.TOKEN_RE.findall(read_topic(topic)):
                if token not in known:
                    unknown.setdefault(token, []).append(topic)
        self.assertEqual(unknown, {}, 'knowledge files name identifiers that are neither a registered tool '
                                      f'nor a catalog field: {unknown}. Fix the prose, or declare the term '
                                      'in NON_TOOL_TERMS after checking it against the code.')

    def test_the_docs_do_not_promise_the_tools_this_server_deliberately_lacks(self):
        """Installments and API keys have no create tool; prose that offers one would be a dead end."""
        tools = self._tool_names()
        for absent in ('create_installment', 'create_api_key', 'create_notification'):
            self.assertNotIn(absent, tools)
            for topic in sorted(EXPECTED_TOPICS):
                self.assertNotIn(absent, read_topic(topic), f'{topic} names the non-existent {absent}')

    def test_the_workflow_tools_the_docs_lean_on_are_all_registered(self):
        tools = self._tool_names()
        for name in ('whoami', 'my_capabilities', 'explain_permission', 'student_360', 'search_everything',
                     'daily_briefing', 'convert_enquiry_to_registration', 'enroll_student', 'record_payment',
                     'upload_document', 'download_document', 'health'):
            self.assertIn(name, tools)

    def test_prompt_text_only_names_real_tools(self):
        tools = self._tool_names()
        arguments = {'onboard_student': {'enquiry_id': '1'}, 'troubleshoot_error': {'error': 'x'}}
        for name in ('daily_briefing', 'onboard_student', 'follow_up_digest', 'pipeline_review',
                     'permissions_audit', 'troubleshoot_error'):
            text = '\n'.join(self.get_prompt(name, self.admin, **arguments.get(name, {})))
            for token in self.TOKEN_RE.findall(text):
                if token.split('_')[0] in ('list', 'get', 'create', 'update', 'delete'):
                    self.assertIn(token, tools, f'prompt {name} names a missing tool {token}')
