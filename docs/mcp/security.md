# Security notes for the MCP server

## The trust boundary

The MCP server is **a client of the REST API**, not a second door into the data. It holds no
database connection, no Django secret key, and no field-encryption key. Every call it makes
carries the end user's own credential, so the backend authorises it exactly as it authorises the
web console: role, company, branch, ownership, the capability matrix, the approval workflow, and
the same audit log.

The practical consequence: **a key can do what its owner can do, and nothing more.** There is no
elevated mode, no service account, and no way for an assistant to reach a record its user could
not open in the console.

## API keys

- Format `cdk_` + 40 characters from a 62-symbol alphabet (`secrets.choice`, about 238 bits).
  Only the sha256 is stored; the first 12 characters are kept as a visible prefix so a key can be
  recognised in a list.
- A key **inherits the owner's scope**, live. It is not a snapshot: change the user's role or
  branch and the key's reach changes with it.
- **An administrator** changing a user's role, branch, company or password — or deactivating them
  — **revokes every token and key they hold**, immediately. A deactivated user's keys stop working
  the moment they are deactivated.
- Changing your **own** password does **not** — not on the Profile page, and not through the
  `change_password` tool. That endpoint verifies the current password, sets the new one and
  returns; it revokes nothing. A password and a key are separate secrets, so if you think a key
  has leaked, **revoke the key**.
- **A key cannot manage keys.** Every `api-keys/` endpoint refuses a caller who authenticated
  with an API key, so a stolen key cannot enumerate its siblings, revoke them, or mint a
  replacement. Keys are created only from a password-authenticated session — the Profile page.
  There is no `create_api_key` tool, and there never will be one.
- Optional expiry. `last_used_at` is stamped at most once a minute, so a key that starts being
  used somewhere unexpected is visible on the Profile page.
- Company admins can list and revoke their own staff's keys; a dev admin can revoke anyone's.

**Revoke a key**: console → Profile → AI access keys → Revoke. It stops working at once.

## Hosted mode (`https://console.nexxteducation.in/mcp`)

- nginx terminates TLS and proxies to `127.0.0.1:8765`. The server never listens publicly.
- **No server-wide credential.** Each request's `Authorization: Bearer cdk_...` is forwarded to
  the API, and that is the only identity in play, so one process serves many users without ever
  holding an ambient one. The systemd unit deliberately does not load the backend's `.env`.
- `BearerRequiredMiddleware` answers **401** to any `/mcp` request without a bearer or
  `X-API-Key` header, before the protocol layer sees it.
- The session is stateless (`stateless_http=True`): no affinity, nothing cached between users.
- **DNS-rebinding protection is always on.** Only `Host` headers listed in
  `CONSULTANCY_MCP_ALLOWED_HOSTS` (plus loopback) are served; anything else gets **421**. This is
  what stops a malicious page from resolving its own domain to a local address and driving the
  server through the victim's browser. Browser clients also send `Origin`, which must be in
  `CONSULTANCY_MCP_ALLOWED_ORIGINS` or the answer is **403**; a request with no `Origin` at all
  passes, which is every non-browser client.
- The backend's throttles apply per user: 120/min burst, 5000/hour.

## Local mode (stdio)

- The key lives in a client config file or your shell environment. Treat it like a password:
  prefer one key per device, name it after the device, and give it an expiry.
- Reading a local file for upload and writing a downloaded document to disk are enabled **only**
  over stdio, where the filesystem is the user's own. The hosted server never touches a path.
- The client you point at it can see everything it can see. Choose one whose data handling you
  are comfortable with, especially for the encrypted fields below.

## Destructive operations

- Every `delete_*` tool and `reset_role_permissions` refuse to act without `confirm=true`, and
  say so in the error. The model has to come back and ask.
- Deletes, `reject_transfer`, `reject_approval_request`, `reject_signup_request`,
  `revoke_api_key` and `set_user_active` are annotated with **`destructiveHint`**, which is how a
  client knows to put a confirmation in front of the user rather than running them silently.
- `CONSULTANCY_MCP_READ_ONLY=1` (or `--read-only`) unregisters every write tool: 171 tools become
  81, and each one that remains is annotated `readOnlyHint`. This is the setting for an analyst
  or a kiosk. It is enforced by not registering the tools at all, so there is nothing to call.
- Employees cannot delete directly in the first place. The API answers 403 and the right move is
  an approval request for a manager, which is what the error message says.

## Personal data

- `date_of_birth` (enquiries, registrations) and `passport_no` (visa tracking) are encrypted at
  rest and cannot be filtered, searched or sorted. They come back in clear on an authenticated
  read, which means they reach whichever AI client asked for them.
- Documents are stored encrypted and only leave through the download action, capped by
  `CONSULTANCY_MCP_MAX_DOWNLOAD_BYTES` (5 MB by default).
- The knowledge base tells assistants never to copy a passport number into a free-text field.

## Logging

- The server logs to stderr, which systemd captures into the journal: tool names, HTTP methods,
  paths and status codes. **Never request bodies, response bodies, keys or bearer tokens.**
- The backend keeps its own `core.security` log of logins, key creation and revocation, document
  downloads and permission changes, attributed to the acting user — including everything done
  through this server.
- A 404 is deliberately ambiguous between "does not exist" and "outside your scope", and the
  wording varies. That is the API's behaviour, not a bug to work around: it stops a caller
  mapping records they cannot read.

## Deliberately not implemented

- **OAuth 2.1 / dynamic client registration.** Some hosted connectors (Claude.ai, ChatGPT) will
  therefore only work if they allow a static `Authorization` header. Use a local stdio client
  otherwise.
- **Rate limiting inside the MCP process.** The backend's throttles are the limit; a 429 is
  retried once, honouring `Retry-After`, and then surfaces to the caller.
- **Any tool that mints credentials.** See above: keys come from a password session only.
