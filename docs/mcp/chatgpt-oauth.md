# ChatGPT OAuth connection

The hosted MCP supports OAuth authorization code with S256 PKCE as well as
existing personal API keys. OAuth uses the signed-in consultancy user and all
existing tenant/role checks. Tokens cannot manage API keys.

In ChatGPT's custom connector form:

| Field | Value |
| --- | --- |
| Server URL | `https://console.nexxteducation.in/mcp` |
| Authentication | OAuth |
| Registration method | User-Defined OAuth Client |
| Client ID | `consultancy-chatgpt` |
| Client secret | Leave blank |
| Token endpoint auth method | `none` |
| Default scopes | `crm` |
| Base scopes | Leave blank |
| OIDC | Off |

Discovery fills authorization and token URLs. If manual values are needed:

- Authorization: `https://console.nexxteducation.in/oauth/authorize/`
- Token: `https://console.nexxteducation.in/oauth/token/`
- Issuer: `https://console.nexxteducation.in`
- Resource: `https://console.nexxteducation.in/mcp`
- Registration URL: leave blank (the client is pre-registered).

The callback must exactly match a redirect URI registered on the OAuth
application. A new ChatGPT connector may have a new callback: the server
administrator must register that exact HTTPS URL before connecting. Never use
wildcard redirect URLs.

The current client was registered for:
`https://chatgpt.com/connector/oauth/eohYyzsZlamh`.

Sign in and approve access. Connections can be revoked at `/oauth/connections/`.
Access tokens expire after an hour; refresh tokens rotate. Password and role
changes revoke OAuth tokens alongside API keys and JWT refresh tokens.

Deployment requires installing backend requirements, running OAuth Toolkit's
migrations, and routing `/oauth/` and `/.well-known/oauth-*` to Django. The
existing MCP process must be restarted to pick up token verification and its
protected-resource challenge. Tests: `core.test_oauth`, `core.test_api_keys`,
and `mcp_server.tests.test_server`.
