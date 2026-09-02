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
