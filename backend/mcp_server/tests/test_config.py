from django.test import SimpleTestCase

from mcp_server.config import Settings, load_settings


class LoadSettingsTests(SimpleTestCase):
    def test_defaults_when_env_is_empty(self):
        s = load_settings(env={})
        self.assertEqual(s.api_url, 'http://127.0.0.1:8000/api/')
        self.assertIsNone(s.api_key)
        self.assertFalse(s.read_only)
        self.assertEqual(s.max_download_bytes, 5 * 1024 * 1024)
        self.assertEqual(s.transport, 'stdio')
        self.assertTrue(s.stdio)
        self.assertFalse(s.has_credentials)

    def test_trailing_slash_is_forced_on_api_url(self):
        s = load_settings(env={'CONSULTANCY_API_URL': 'https://console.example.com/api'})
        self.assertEqual(s.api_url, 'https://console.example.com/api/')

    def test_api_key_and_flags_are_read(self):
        s = load_settings(env={
            'CONSULTANCY_API_KEY': 'cdk_abc',
            'CONSULTANCY_MCP_READ_ONLY': 'yes',
            'CONSULTANCY_MCP_MAX_DOWNLOAD_BYTES': '1024',
        })
        self.assertEqual(s.api_key, 'cdk_abc')
        self.assertTrue(s.read_only)
        self.assertEqual(s.max_download_bytes, 1024)
        self.assertTrue(s.has_credentials)

    def test_username_password_count_as_credentials(self):
        s = load_settings(env={'CONSULTANCY_USERNAME': 'admin', 'CONSULTANCY_PASSWORD': 'x'})
        self.assertTrue(s.has_credentials)

    def test_overrides_win_over_env(self):
        s = load_settings(env={'CONSULTANCY_API_URL': 'http://a/api/'}, overrides={'api_url': 'http://b/api/', 'transport': 'streamable-http', 'port': 9000})
        self.assertEqual(s.api_url, 'http://b/api/')
        self.assertEqual(s.transport, 'streamable-http')
        self.assertEqual(s.port, 9000)
        self.assertFalse(s.stdio)

    def test_bad_int_falls_back_to_default(self):
        s = load_settings(env={'CONSULTANCY_MCP_MAX_DOWNLOAD_BYTES': 'lots'})
        self.assertEqual(s.max_download_bytes, 5 * 1024 * 1024)

    def test_allowed_hosts_and_origins_default_to_nothing_extra(self):
        s = load_settings(env={})
        self.assertEqual(s.allowed_hosts, ())
        self.assertEqual(s.allowed_origins, ())

    def test_allowed_hosts_and_origins_are_comma_separated(self):
        s = load_settings(env={
            'CONSULTANCY_MCP_ALLOWED_HOSTS': 'console.nexxteducation.in, console.nexxteducation.in:443',
            'CONSULTANCY_MCP_ALLOWED_ORIGINS': 'https://console.nexxteducation.in',
        })
        self.assertEqual(s.allowed_hosts, ('console.nexxteducation.in', 'console.nexxteducation.in:443'))
        self.assertEqual(s.allowed_origins, ('https://console.nexxteducation.in',))

    def test_blank_entries_in_the_host_list_are_dropped(self):
        s = load_settings(env={'CONSULTANCY_MCP_ALLOWED_HOSTS': ' , a.example.com ,, '})
        self.assertEqual(s.allowed_hosts, ('a.example.com',))

    def test_settings_stay_hashable_so_they_can_be_shared(self):
        """Frozen dataclass: the host lists are tuples, not lists."""
        hash(load_settings(env={'CONSULTANCY_MCP_ALLOWED_HOSTS': 'a.example.com'}))
