# ConsultancyDev MCP server

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant work inside the CRM
**as you**: enquiries, follow-ups, registrations, enrollments, payments, documents, visa
tracking, tasks, appointments, approvals, transfers, the permissions matrix and analytics — with
your exact role, company and branch scope, and nothing beyond it.

- [clients.md](clients.md) — copy-paste configuration for every AI client.
- [security.md](security.md) — what a key can do, and what it cannot.
- [tools.md](tools.md) — every tool, generated from the code.

## How it works

The server is a **client of the REST API**, not a second way into the database. It holds no
database connection and no secret key; it makes ordinary HTTP calls to `/api/` carrying your
credential, so every permission, workflow and audit rule stays exactly where the console's own
rules are enforced. If the API would refuse you, it refuses the assistant too, with the same
message.

It knows the API from two sources:

- **A generated catalog** (`backend/mcp_server/catalog.json`, rebuilt by
  `python manage.py export_mcp_catalog`) — every resource, field, filter, choice, custom action
  and capability, read out of the running serializers and viewsets rather than written by hand.
- **Curated knowledge** (`backend/mcp_server/knowledge/`, 15 documents) — the things the code
  cannot say: how the pipeline actually runs, which endpoints do not do what their shape
  suggests, what a 409 usually means.

What it exposes: **171 tools** (81 of them in read-only mode), six `consultancy://` resources
plus two templates — `consultancy://schema/{resource}` and `consultancy://knowledge/{topic}` —
and six guided prompts (`daily_briefing`, `onboard_student`, `follow_up_digest`,
`pipeline_review`, `permissions_audit`, `troubleshoot_error`). `tools.md` is the current tool
list and is regenerated with the catalog.

## Get a key

Sign in to the console, open **Profile**, and use the **AI access keys** card: New key, name it,
copy it once. The key looks like `cdk_` followed by 40 characters and is shown exactly once —
only its hash is stored. It carries your permissions and dies when you do: changing your role,
branch, company or password revokes it, and so does deactivating your account. Revoke it
yourself from the same card at any time.

## Run it locally (stdio)

The client starts the server on your machine; nothing is exposed to the network.

```bash
cd backend
pip install -r requirements.txt

export CONSULTANCY_API_URL=https://console.nexxteducation.in/api/   # or http://127.0.0.1:8000/api/
export CONSULTANCY_API_KEY=cdk_...
python -m mcp_server
```

On Windows use `set` instead of `export`. The process speaks the protocol on stdin/stdout and
logs to stderr, so it looks like it has hung when run by hand — that is correct, and it is a
client that is meant to drive it. `python -m mcp_server --version` prints `1.0.0` and exits.

Flags: `--read-only`, `--api-url URL`, `--transport streamable-http`, `--host`, `--port`.
Environment variables are listed in `deploy/PRODUCTION_SETUP.md`.

## Use the hosted server (Streamable HTTP)

Already running behind nginx at **`https://console.nexxteducation.in/mcp`**
(`deploy/consultancy-mcp.service`). Send `Authorization: Bearer cdk_...` on every request. There
is no server-wide credential: the server acts as whoever's key arrives, and a request without a
bearer is refused with 401 before it reaches the protocol layer.

`https://console.nexxteducation.in/mcp/health` is open and answers
`{"status":"ok","version":"1.0.0","read_only":false}`.

## A first conversation

1. **`whoami`** — confirms who the assistant is acting as, with role, company, branch and live
   capabilities. Always first.
2. Read **`consultancy://knowledge/overview`** — the system in one page.
3. **`daily_briefing`** for what needs attention today, **`student_360`** for one student's whole
   file, **`search_everything`** when you only have a name.
4. Read **`consultancy://schema/<resource>`** before writing anything: it lists required fields,
   valid choices and which fields the server owns.

## Things worth knowing before it writes

- **Deletes, rejections, revocations and deactivations are annotated destructive**, and the
  `delete_*` tools plus `reset_role_permissions` refuse to run without `confirm=true`. A good
  client asks you first.
- **Employees cannot delete directly.** A refused write is usually an approval request waiting to
  be made (`create_approval_request`), not a bug.
- **Transfers move ownership.** The sender loses the record.
- **Reference numbers are the server's.** Omit `registration_no` and `enrollment_no` and let it
  allocate them.
- **`CONSULTANCY_MCP_READ_ONLY=1`** (or `--read-only`) unregisters every write tool, leaving 81
  read-only ones. Nothing that writes is even listed.
- Everything the assistant does is logged by the backend under the user who owns the key.

## Troubleshooting

| What you see | What it means |
|---|---|
| `No credentials configured` | Set `CONSULTANCY_API_KEY` (local), or send the `Authorization` header (hosted). |
| 401 from every tool | The key was revoked or expired, or the user was deactivated. Make a new one. |
| 404 on a record you can see in the console | 404 also means "outside your scope"; the API never says which. Check `whoami`. |
| `Could not reach ...` | The backend is not answering at `CONSULTANCY_API_URL`. Call the `health` tool: it needs no credentials. |
| No `create_*` tools | The server is running read-only. |
| 421 from the hosted URL | `CONSULTANCY_MCP_ALLOWED_HOSTS` does not list the hostname the client used. |

## Development

```bash
cd backend
python manage.py test mcp_server core.test_api_keys core.test_mcp_catalog

# After ANY change to models, serializers, filters, viewsets or actions:
python manage.py export_mcp_catalog --docs ../docs/mcp/tools.md
```

Both the committed catalog and the committed `tools.md` are checked against a fresh render by
`core.test_mcp_catalog`, so neither can drift silently.
