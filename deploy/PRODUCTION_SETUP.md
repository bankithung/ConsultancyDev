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
