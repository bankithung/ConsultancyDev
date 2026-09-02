# Production Deployment — console.nexxteducation.in

Architecture: nginx (443) → Next.js frontend (:3000) + Django API via `/api` → gunicorn (:8000) → PostgreSQL. Single domain, single TLS cert, no CORS preflights.

## 1. Server prerequisites (Ubuntu/Debian)

```bash
sudo apt update && sudo apt install -y nginx postgresql python3-venv nodejs npm certbot python3-certbot-nginx
```

Deploy code to `/opt/consultancy`:

```bash
sudo mkdir -p /opt/consultancy && sudo chown $USER /opt/consultancy
git clone https://github.com/bankithung/ConsultancyDev.git /opt/consultancy
```

## 2. Database

```bash
sudo -u postgres psql <<'SQL'
CREATE USER consultancy WITH PASSWORD 'STRONG_PASSWORD';
CREATE DATABASE consultancy OWNER consultancy;
SQL
# DATABASE_URL=postgres://consultancy:STRONG_PASSWORD@127.0.0.1:5432/consultancy
```

## 3. Secrets (fill in `backend/.env.production`)

```bash
python3 -c "from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())"

# JWT keypair:
openssl genrsa 4096 | tee private.pem | openssl rsa -pubout > public.pem
base64 -w0 private.pem   # -> JWT_PRIVATE_KEY_B64
base64 -w0 public.pem    # -> JWT_PUBLIC_KEY_B64 (also goes into the FRONTEND env!)

python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"  # FIELD_ENCRYPTION_KEY
```

Then:

```bash
cd /opt/consultancy/backend && cp .env.production .env   # after filling secrets
```

## 4. Backend

```bash
cd /opt/consultancy/backend
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
./venv/bin/python manage.py migrate --noinput
./venv/bin/python manage.py collectstatic --noinput
./venv/bin/python manage.py createsuperuser
```

Run with systemd (`deploy/consultancy-backend.service`):

```ini
[Unit]
Description=Consultancy Django API (gunicorn)
After=network.target postgresql.service

[Service]
User=www-data
WorkingDirectory=/opt/consultancy/backend
EnvironmentFile=/opt/consultancy/backend/.env
ExecStart=/opt/consultancy/backend/venv/bin/gunicorn config.wsgi:application \
    --bind 127.0.0.1:8000 --workers 4 --timeout 30
Restart=always

[Install]
WantedBy=multi-user.target
```

Note: the repo's `gunicorn_config.py` binds to 127.0.0.1:8000 and writes logs to
`/var/log/gunicorn` — the systemd unit above passes the bind explicitly and is
the simpler option on a single box.

## 5. Frontend

Fill in `consultancy-dev/.env.production`, then build (NEXT_PUBLIC_* vars are baked at build time — rebuild after any change):

```bash
cd /opt/consultancy/consultancy-dev
cp .env.production .env.production.local   # after filling JWT_PUBLIC_KEY_B64
npm ci && npm run build
```

Run with systemd (`deploy/consultancy-frontend.service`):

```ini
[Unit]
Description=Consultancy Next.js frontend
After=network.target

[Service]
WorkingDirectory=/opt/consultancy/consultancy-dev
ExecStart=/usr/bin/npm run start
Restart=always

[Install]
WantedBy=multi-user.target
```

## 6. nginx + TLS

```bash
sudo cp deploy/nginx.console.nexxteducation.in.conf /etc/nginx/sites-available/console.nexxteducation.in
sudo ln -s /etc/nginx/sites-available/console.nexxteducation.in /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d console.nexxteducation.in   # TLS cert + auto redirect
```

DNS first: an A record for `console.nexxteducation.in` → server IP.

## 7. Start & verify

```bash
sudo systemctl enable --now consultancy-backend consultancy-frontend
curl -s https://console.nexxteducation.in/api/ -o /dev/null -w "%{http_code}\n"
curl -sI https://console.nexxteducation.in | head -5
```

## 8. MCP server (optional, for AI clients)

Lets Claude, ChatGPT, Cursor and friends work inside the CRM as the signed-in user. It is a
client of the API like any other: no database access, and no credential of its own — each
request carries the user's own key, created on the console's Profile page.

```bash
sudo cp deploy/consultancy-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now consultancy-mcp

# nginx routes /mcp to the unit, and an existing deployment's config predates
# that block: redeploy section 6's config first, or /mcp answers 404.
sudo cp deploy/nginx.console.nexxteducation.in.conf /etc/nginx/sites-available/console.nexxteducation.in
sudo nginx -t && sudo systemctl reload nginx

curl -s https://console.nexxteducation.in/mcp/health     # {"status":"ok","version":"1.0.0","read_only":false}
```

The `/mcp` proxy to `127.0.0.1:8765` lives in the config in section 6, so a first-time install
that followed section 6 already has it and only needs the reload above. The endpoint clients
connect to is `https://console.nexxteducation.in/mcp`.

### Variables

All optional; the unit sets the ones a hosted deployment needs.

| Variable | Default | What it does |
|---|---|---|
| `CONSULTANCY_API_URL` | `http://127.0.0.1:8000/api/` | Which API to call. A trailing slash is added if missing. |
| `CONSULTANCY_MCP_HOST` | `127.0.0.1` | Bind address. Keep it on the loopback and let nginx face the world. |
| `CONSULTANCY_MCP_PORT` | `8765` | Bind port. |
| `CONSULTANCY_MCP_ALLOWED_HOSTS` | *(empty)* | **Required behind a proxy.** Comma-separated `Host` header values to accept, e.g. `console.nexxteducation.in,console.nexxteducation.in:443`. Empty means loopback only, so every proxied request answers **421**. |
| `CONSULTANCY_MCP_ALLOWED_ORIGINS` | *(empty)* | Comma-separated `Origin` values to accept. Only browser-based clients send one; a request without an Origin always passes, and an unlisted one answers 403. |
| `CONSULTANCY_MCP_READ_ONLY` | `0` | `1` unregisters every write tool (171 tools become 81). |
| `CONSULTANCY_MCP_MAX_DOWNLOAD_BYTES` | `5242880` | Cap on a document fetched through a tool. |
| `CONSULTANCY_MCP_TIMEOUT_SECONDS` | `30` | HTTP timeout for calls to the API. |
| `CONSULTANCY_MCP_TRANSPORT` | `stdio` | `streamable-http` for the hosted mode; the unit passes `--transport` instead. |
| `CONSULTANCY_USERNAME` / `CONSULTANCY_PASSWORD` | *(unset)* | **Local mode only.** Log in with a password instead of a key. Needed for the `list_api_keys` and `revoke_api_key` tools, which the API refuses to key-authenticated callers on purpose. |
| `CONSULTANCY_API_KEY` | *(unset)* | **Local (stdio) mode only.** In hosted mode there is no server-wide credential: the bearer on each request is the user's own key, and a request without one is refused with 401 before it reaches the protocol layer. |

### Checks

```bash
systemctl status consultancy-mcp
journalctl -u consultancy-mcp -n 50            # startup line: "N tools, read_only=..., api=..."
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://console.nexxteducation.in/mcp   # 401
```

A **421** from `/mcp` means `CONSULTANCY_MCP_ALLOWED_HOSTS` does not list the name the client
used. A **401** without a bearer is correct. Client setup for every platform is in `docs/mcp/`.
