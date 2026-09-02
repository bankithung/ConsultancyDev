# Connecting AI clients

There are two ways to connect, and every client below supports at least one of them.

- **Local (stdio)** — the client starts `python -m mcp_server` on your machine and talks to it
  over stdin/stdout. Needs Python 3.11+ with `backend/requirements.txt` installed, and your key
  in the environment. Works against any API URL, local or production. This is the mode to prefer:
  it is the one every client supports, and document upload from a local path only works here.
- **Remote (Streamable HTTP)** — the client talks to `https://console.nexxteducation.in/mcp` and
  sends `Authorization: Bearer <KEY>` on every request. Nothing to install, but the client must
  let you set a custom header.

Throughout, replace:

| Placeholder | With |
|---|---|
| `<KEY>` | A key from the console: Profile → **AI access keys** → New key (`cdk_...`). |
| `<BACKEND>` | The absolute path to `ConsultancyDev/backend`, e.g. `/opt/consultancy/backend`. |
| `python` | The interpreter that has the requirements installed. In a virtualenv, `<BACKEND>/venv/bin/python`. |

On Windows, give the full interpreter path (`C:/Python311/python.exe`) and use forward slashes
throughout. They work everywhere and save you doubling every backslash, which JSON requires.

`python -m mcp_server` only resolves if the process can find the package, and clients disagree
about how you say where it is. Where a client documents `cwd` (VS Code, Gemini CLI) the blocks
below use that alone; everywhere else they set **both** `cwd` and `PYTHONPATH` to `<BACKEND>`, so
whichever mechanism the client honours, the import works and the other is harmless. If you ever
see `ModuleNotFoundError: mcp_server`, it is because neither reached the process.

`CONSULTANCY_API_URL` decides which backend you are working in. Point it at
`https://console.nexxteducation.in/api/` for production or `http://127.0.0.1:8000/api/` for a
local one, and make sure the key came from that same backend.

## Claude Desktop (stdio)

Settings → Developer → Edit Config, which opens `claude_desktop_config.json`
(`%APPDATA%\Claude\` on Windows, `~/Library/Application Support/Claude/` on macOS):

```json
{
  "mcpServers": {
    "consultancy-dev": {
      "command": "python",
      "args": ["-m", "mcp_server"],
      "cwd": "<BACKEND>",
      "env": {
        "PYTHONPATH": "<BACKEND>",
        "CONSULTANCY_API_URL": "https://console.nexxteducation.in/api/",
        "CONSULTANCY_API_KEY": "<KEY>"
      }
    }
  }
}
```

Restart Claude Desktop afterwards. The server appears under the tools icon; ask it `whoami` to
check the connection. `cwd` and `PYTHONPATH` say the same thing twice on purpose, as above:
either one alone makes the package importable.

## Claude Code

The repository has a checked-in `.mcp.json` at its root, so from a clone you only need the two
variables in your shell. It sets both `cwd` and `PYTHONPATH` to `backend` on purpose: whichever
of the two the client honours, `python -m mcp_server` resolves. `CONSULTANCY_API_URL` has a
default in the file; `CONSULTANCY_API_KEY` has none, so export it before starting Claude Code —
without it every tool answers `No credentials configured`.

```bash
export CONSULTANCY_API_KEY=cdk_...
export CONSULTANCY_API_URL=http://127.0.0.1:8000/api/   # optional; this is the default
claude                                                   # then approve the project server
```

Or register it yourself, anywhere:

```bash
# local (stdio)
claude mcp add consultancy-dev \
  -e CONSULTANCY_API_KEY=<KEY> \
  -e CONSULTANCY_API_URL=https://console.nexxteducation.in/api/ \
  -- python -m mcp_server

# hosted (Streamable HTTP)
claude mcp add --transport http consultancy-dev https://console.nexxteducation.in/mcp \
  --header "Authorization: Bearer <KEY>"
```

Run the stdio form from `backend/`, or add `-e PYTHONPATH=<BACKEND>` so the package is importable
from anywhere. `claude mcp list` shows what is connected.

## Cursor

`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "consultancy-dev": {
      "command": "python",
      "args": ["-m", "mcp_server"],
      "cwd": "<BACKEND>",
      "env": {
        "PYTHONPATH": "<BACKEND>",
        "CONSULTANCY_API_URL": "https://console.nexxteducation.in/api/",
        "CONSULTANCY_API_KEY": "<KEY>"
      }
    },
    "consultancy-dev-remote": {
      "url": "https://console.nexxteducation.in/mcp",
      "headers": { "Authorization": "Bearer <KEY>" }
    }
  }
}
```

Keep one of the two, not both, or every tool will be listed twice.

## Windsurf

`~/.codeium/windsurf/mcp_config.json` — the same shape as Cursor, with `serverUrl` for the
hosted form:

```json
{
  "mcpServers": {
    "consultancy-dev": {
      "command": "python",
      "args": ["-m", "mcp_server"],
      "cwd": "<BACKEND>",
      "env": {
        "PYTHONPATH": "<BACKEND>",
        "CONSULTANCY_API_URL": "https://console.nexxteducation.in/api/",
        "CONSULTANCY_API_KEY": "<KEY>"
      }
    },
    "consultancy-dev-remote": {
      "serverUrl": "https://console.nexxteducation.in/mcp",
      "headers": { "Authorization": "Bearer <KEY>" }
    }
  }
}
```

## VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json` in the workspace. Note the key is `servers`, not `mcpServers`, and each entry
declares its `type`:

```json
{
  "servers": {
    "consultancy-dev": {
      "type": "stdio",
      "command": "python",
      "args": ["-m", "mcp_server"],
      "cwd": "<BACKEND>",
      "env": {
        "CONSULTANCY_API_URL": "https://console.nexxteducation.in/api/",
        "CONSULTANCY_API_KEY": "${input:consultancyKey}"
      }
    },
    "consultancy-dev-remote": {
      "type": "http",
      "url": "https://console.nexxteducation.in/mcp",
      "headers": { "Authorization": "Bearer ${input:consultancyKey}" }
    }
  },
  "inputs": [
    {
      "id": "consultancyKey",
      "type": "promptString",
      "description": "ConsultancyDev API key (cdk_...)",
      "password": true
    }
  ]
}
```

The `inputs` block keeps the key out of the file: VS Code prompts once and stores it in its
secret storage. Replace `${input:consultancyKey}` with the literal key if you would rather not.

## Gemini CLI

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "consultancy-dev": {
      "command": "python",
      "args": ["-m", "mcp_server"],
      "cwd": "<BACKEND>",
      "env": {
        "CONSULTANCY_API_URL": "https://console.nexxteducation.in/api/",
        "CONSULTANCY_API_KEY": "<KEY>"
      }
    },
    "consultancy-dev-remote": {
      "httpUrl": "https://console.nexxteducation.in/mcp",
      "headers": { "Authorization": "Bearer <KEY>" }
    }
  }
}
```

`httpUrl` is the Streamable HTTP form; `/mcp` (unlike an SSE endpoint) belongs there.

## OpenAI Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.consultancy]
command = "python"
args = ["-m", "mcp_server"]
env = { CONSULTANCY_API_URL = "https://console.nexxteducation.in/api/", CONSULTANCY_API_KEY = "<KEY>", PYTHONPATH = "<BACKEND>" }
```

`PYTHONPATH` rather than a working directory: it makes `mcp_server` importable whatever
directory Codex starts the process in.

## Claude.ai (remote connector)

Settings → Connectors → **Add custom connector**, URL `https://console.nexxteducation.in/mcp`.
If the dialog offers a custom authentication header, set `Authorization: Bearer <KEY>`.

If it only offers OAuth, this server cannot serve it: OAuth 2.1 authorization and dynamic client
registration are deliberately not implemented in this iteration. Use a local (stdio) client
instead — Claude Desktop or Claude Code, above.

## ChatGPT (connectors / developer mode)

Settings → Connectors → **Create**, URL `https://console.nexxteducation.in/mcp`, with
`Authorization: Bearer <KEY>` wherever the dialog allows a custom header or API key. The same
caveat applies: there is no OAuth flow here, so a connector that insists on one will not
complete.

Deep-research connectors that require the two special `search` and `fetch` tools are not
supported either. The general MCP tools (`search_everything`, `student_360`, the `list_*` and
`get_*` family) do the same work in a normal conversation.

## Any other client, or your own agent

**Streamable HTTP** — POST JSON-RPC to `https://console.nexxteducation.in/mcp`. The server is
stateless, so there is no session id to carry between calls:

```bash
curl -sS https://console.nexxteducation.in/mcp \
  -H "Authorization: Bearer <KEY>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

Both header lines matter. `Accept` must include `application/json` — the default `*/*` that curl
sends on its own is answered with **406**, and so is `text/event-stream` alone. `Content-Type`
must be `application/json` or the answer is **400**. Sending both media types in `Accept`, as
above, is what every SDK does and always works.

**stdio** — raw JSON-RPC, one message per line, no key needed beyond the environment:

```bash
cd backend
export CONSULTANCY_API_KEY=<KEY>
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"shell","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | python -m mcp_server
```

**Python, with the official SDK** (`pip install mcp`):

```python
import asyncio

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client


async def main():
    url = 'https://console.nexxteducation.in/mcp'
    async with streamablehttp_client(url, headers={'Authorization': 'Bearer <KEY>'}) as (r, w, _):
        async with ClientSession(r, w) as session:
            await session.initialize()
            print(await session.call_tool('whoami', {}))


asyncio.run(main())
```

For the local equivalent, use `mcp.client.stdio.stdio_client` with
`StdioServerParameters(command='python', args=['-m', 'mcp_server'], cwd='<BACKEND>', env={...})`.
`backend/mcp_server/tests/test_stdio_smoke.py` is a working example.

## Read-only connections

Add `CONSULTANCY_MCP_READ_ONLY=1` to any `env` block above (or `--read-only` to the arguments) to
hand an assistant the 81 read tools and none of the 90 that write. Nothing that writes is even
listed, so it cannot be called by mistake.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Client shows the server as failed, no tools | Wrong `command` or `cwd`. Check by hand: `cd <BACKEND> && python -m mcp_server --version` must print `1.0.0`. |
| `ModuleNotFoundError: mcp_server` | `cwd` is not `<BACKEND>`, and `PYTHONPATH` is not set to it either. |
| `ModuleNotFoundError: mcp` | The interpreter in `command` is not the one with `backend/requirements.txt` installed. |
| `No credentials configured` from every tool | `CONSULTANCY_API_KEY` did not reach the process; some clients ignore your shell environment entirely, so put it in the config's `env` block. |
| 401 from the hosted URL | Missing or malformed `Authorization` header, or the key has been revoked. |
| 421 from the hosted URL | The deployment's `CONSULTANCY_MCP_ALLOWED_HOSTS` does not list the hostname you used. |
| 403 from the hosted URL, with an `Origin` header | Browser-based client: its origin must be in `CONSULTANCY_MCP_ALLOWED_ORIGINS`. |
| Tools work but every call 404s | The key belongs to a different backend than `CONSULTANCY_API_URL` points at, or the records are outside your scope. |
| No `create_*` tools | The server is running read-only. |
