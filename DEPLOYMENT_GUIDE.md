# Oracle Cloud Free Tier Deployment Guide

Complete step-by-step guide to deploy your Consultancy Management Application (Django + Next.js) on Oracle Cloud's Always Free tier.

## 📋 Table of Contents

1. [Prerequisites](#prerequisites)
2. [Oracle Cloud Setup](#oracle-cloud-setup)
3. [Server Initial Setup](#server-initial-setup)
4. [Backend Deployment](#backend-deployment)
5. [Frontend Deployment](#frontend-deployment)
6. [Nginx Configuration](#nginx-configuration)
7. [SSL Setup (Optional)](#ssl-setup)
8. [Maintenance](#maintenance)
9. [Troubleshooting](#troubleshooting)

---

## Prerequisites

- ✅ Oracle Cloud account (sign up at [cloud.oracle.com](https://cloud.oracle.com))
- ✅ Domain name (optional, but recommended)
- ✅ SSH client (PuTTY for Windows, built-in for Mac/Linux)
- ✅ Git installed on your local machine

---

## Oracle Cloud Setup

### Step 1: Create Oracle Cloud Account

1. Go to [cloud.oracle.com](https://cloud.oracle.com)
2. Click "Sign up for free" (requires credit card for verification, but won't charge)
3. Complete verification process

### Step 2: Create Compute Instance

1. **Login to Oracle Cloud Console**
   - Navigate to: Compute → Instances → Create Instance

2. **Configure Instance**
   - **Name**: `consultancy-app-server`
   - **Compartment**: Select your compartment
   - **Placement**: Leave default
   
3. **Choose Image and Shape**
   - **Image**: Canonical Ubuntu 22.04
   - **Shape**: Click "Change Shape"
     - Select **Ampere** (ARM processor)
     - Choose **VM.Standard.A1.Flex**
     - Set **OCPU count**: 4
     - Set **Memory (GB)**: 24
     - Click "Select Shape"

4. **Configure Networking**
   - **Virtual cloud network**: Create new VCN or select existing
   - **Subnet**: Create new public subnet or select existing
   - **Public IP**: Assign public IPv4 address

5. **Add SSH Keys**
   - **Generate SSH key pair**: Download both private and public keys
   - OR **Upload your own public key**
   - Save the private key securely!

6. **Boot Volume**
   - Set size to **200 GB** (use full free tier allocation)

7. Click **Create** and wait 2-3 minutes

### Step 3: Configure Network Security

1. **Update VCN Security List**
   - Go to: Networking → Virtual Cloud Networks → Your VCN
   - Click "Security Lists" → "Default Security List"
   - Click "Add Ingress Rules"

   Add these rules:

   | Source CIDR | Protocol | Port Range | Description |
   |-------------|----------|------------|-------------|
   | 0.0.0.0/0   | TCP      | 22         | SSH         |
   | 0.0.0.0/0   | TCP      | 80         | HTTP        |
   | 0.0.0.0/0   | TCP      | 443        | HTTPS       |

2. **Configure Ubuntu Firewall (will do this after SSH)**

### Step 4: Get Instance IP Address

1. Go to Compute → Instances → Your instance
2. Copy the **Public IP Address** (e.g., `xxx.xxx.xxx.xxx`)

---

## Server Initial Setup

### Step 1: Connect via SSH

**For Windows (using PuTTY)**:
1. Download and install PuTTY
2. Convert private key to .ppk format using PuTTYgen
3. Open PuTTY, enter IP address
4. Under Connection → SSH → Auth, browse to your .ppk file
5. Click Open

**For Mac/Linux**:
```bash
chmod 600 /path/to/your-private-key
ssh -i /path/to/your-private-key ubuntu@your-oracle-ip
```

### Step 2: Configure Ubuntu Firewall

```bash
# Allow SSH, HTTP, and HTTPS
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

### Step 3: Update System

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl wget
```

---

## Backend Deployment

### Step 1: Upload Backend Code

**Option 1: Using Git (Recommended)**
```bash
# Clone your repository
git clone https://your-repo-url.git
cd your-repo/backend
```

**Option 2: Using SCP/SFTP**
```bash
# From your local machine
scp -r -i /path/to/private-key c:\Users\Asus\Music\kikonsDev\backend ubuntu@your-oracle-ip:/home/ubuntu/consultancy-backend
```

### Step 2: Make Deployment Script Executable

```bash
cd /home/ubuntu/consultancy-backend
chmod +x deploy_backend.sh
```

### Step 3: Run Deployment Script

```bash
./deploy_backend.sh
```

This script will:
- ✅ Install Python 3, pip, and system dependencies
- ✅ Set up virtual environment
- ✅ Install Python packages from requirements.txt
- ✅ Create .env file from template
- ✅ Run Django migrations
- ✅ Collect static files
- ✅ Set up Gunicorn and Daphne systemd services
- ✅ Install and configure Redis

### Step 4: Configure Environment Variables

```bash
nano .env
```

Update these values:
```env
SECRET_KEY=<generate-a-new-secret-key>
DEBUG=False
ALLOWED_HOSTS=your-domain.com,your-oracle-ip,localhost
CORS_ALLOWED_ORIGINS=https://your-domain.com,http://your-oracle-ip:3000
```

To generate a new SECRET_KEY:
```bash
source venv/bin/activate
python -c 'from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())'
```

### Step 5: Create Django Superuser

```bash
source venv/bin/activate
python manage.py createsuperuser
```

### Step 6: Restart Services

```bash
sudo systemctl restart gunicorn
sudo systemctl restart daphne
```

### Step 7: Verify Backend

```bash
# Check service status
sudo systemctl status gunicorn
sudo systemctl status daphne
sudo systemctl status redis-server

# Test backend
curl http://127.0.0.1:8000/api/
```

---

## Frontend Deployment

### Step 1: Upload Frontend Code

**Option 1: Using Git**
```bash
git clone https://your-repo-url.git
cd your-repo/consultancy-dev
```

**Option 2: Using SCP**
```bash
# From your local machine
scp -r -i /path/to/private-key c:\Users\Asus\Music\kikonsDev\consultancy-dev ubuntu@your-oracle-ip:/home/ubuntu/consultancy-frontend
```

### Step 2: Make Deployment Script Executable

```bash
cd /home/ubuntu/consultancy-frontend
chmod +x deploy_frontend.sh
```

### Step 3: Run Deployment Script

```bash
./deploy_frontend.sh
```

This script will:
- ✅ Install Node.js 20.x LTS
- ✅ Install PM2 process manager
- ✅ Install npm dependencies
- ✅ Create .env.production.local from template
- ✅ Build Next.js application
- ✅ Start application with PM2

### Step 4: Configure Environment Variables

```bash
nano .env.production.local
```

Update with your actual values:
```env
NEXT_PUBLIC_API_URL=http://your-oracle-ip:8000/api
NEXT_PUBLIC_WS_URL=ws://your-oracle-ip:8001/ws
NEXT_PUBLIC_APP_URL=http://your-oracle-ip:3000
```

Or with domain:
```env
NEXT_PUBLIC_API_URL=https://api.yourdomain.com/api
NEXT_PUBLIC_WS_URL=wss://api.yourdomain.com/ws
NEXT_PUBLIC_APP_URL=https://yourdomain.com
```

### Step 5: Rebuild and Restart

```bash
npm run build
pm2 restart consultancy-frontend
```

### Step 6: Verify Frontend

```bash
pm2 status
pm2 logs consultancy-frontend --lines 50
```

---

## Nginx Configuration

### Step 1: Install Nginx

```bash
sudo apt install -y nginx
```

### Step 2: Configure Backend Nginx

```bash
sudo cp /home/ubuntu/consultancy-backend/nginx_backend.conf /etc/nginx/sites-available/backend
```

Edit the configuration:
```bash
sudo nano /etc/nginx/sites-available/backend
```

Update `server_name` with your IP or domain.

Enable the site:
```bash
sudo ln -s /etc/nginx/sites-available/backend /etc/nginx/sites-enabled/
```

### Step 3: Configure Frontend Nginx

```bash
sudo cp /home/ubuntu/consultancy-frontend/nginx_frontend.conf /etc/nginx/sites-available/frontend
```

Edit the configuration:
```bash
sudo nano /etc/nginx/sites-available/frontend
```

Update `server_name` with your IP or domain.

Enable the site:
```bash
sudo ln -s /etc/nginx/sites-available/frontend /etc/nginx/sites-enabled/
```

### Step 4: Remove Default Site

```bash
sudo rm /etc/nginx/sites-enabled/default
```

### Step 5: Test and Restart Nginx

```bash
sudo nginx -t
sudo systemctl restart nginx
sudo systemctl enable nginx
```

### Step 6: Test Your Application

Open your browser and navigate to:
- **Frontend**: `http://your-oracle-ip`
- **Backend API**: `http://your-oracle-ip/api/`
- **Admin Panel**: `http://your-oracle-ip/admin/`

---

## SSL Setup (Optional but Recommended)

### Prerequisites
- Domain name pointing to your Oracle IP

### Step 1: Install Certbot

```bash
sudo apt install certbot python3-certbot-nginx -y
```

### Step 2: Obtain SSL Certificates

For frontend:
```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

For backend:
```bash
sudo certbot --nginx -d api.yourdomain.com
```

### Step 3: Test Auto-Renewal

```bash
sudo certbot renew --dry-run
```

### Step 4: Update Environment Variables

Update `.env` in backend:
```env
ALLOWED_HOSTS=yourdomain.com,api.yourdomain.com,localhost
CORS_ALLOWED_ORIGINS=https://yourdomain.com
```

Update `.env.production.local` in frontend:
```env
NEXT_PUBLIC_API_URL=https://api.yourdomain.com/api
NEXT_PUBLIC_WS_URL=wss://api.yourdomain.com/ws
NEXT_PUBLIC_APP_URL=https://yourdomain.com
```

### Step 5: Restart Services

```bash
sudo systemctl restart gunicorn daphne
pm2 restart consultancy-frontend
sudo systemctl restart nginx
```

---

## Maintenance

### View Logs

**Backend (Gunicorn)**:
```bash
sudo journalctl -u gunicorn -f
sudo tail -f /var/log/gunicorn/error.log
```

**Backend (Daphne)**:
```bash
sudo journalctl -u daphne -f
```

**Frontend (PM2)**:
```bash
pm2 logs consultancy-frontend
pm2 logs consultancy-frontend --lines 100
```

**Nginx**:
```bash
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

### Update Application

**Backend**:
```bash
cd /home/ubuntu/consultancy-backend
git pull
source venv/bin/activate
pip install -r requirements.txt
python manage.py migrate
python manage.py collectstatic --noinput
sudo systemctl restart gunicorn daphne
```

**Frontend**:
```bash
cd /home/ubuntu/consultancy-frontend
git pull
npm ci
npm run build
pm2 restart consultancy-frontend
```

### Monitor Resources

```bash
# CPU and memory usage
htop

# Disk usage
df -h

# PM2 monitoring
pm2 monit
```

---

## Troubleshooting

### Backend Not Accessible

1. **Check service status**:
   ```bash
   sudo systemctl status gunicorn
   sudo systemctl status daphne
   ```

2. **Check logs**:
   ```bash
   sudo journalctl -u gunicorn -n 50
   ```

3. **Restart services**:
   ```bash
   sudo systemctl restart gunicorn daphne
   ```

### Frontend Not Loading

1. **Check PM2 status**:
   ```bash
   pm2 status
   pm2 logs consultancy-frontend --lines 50
   ```

2. **Rebuild and restart**:
   ```bash
   cd /home/ubuntu/consultancy-frontend
   npm run build
   pm2 restart consultancy-frontend
   ```

### Nginx 502 Bad Gateway

1. **Check backend services**:
   ```bash
   curl http://127.0.0.1:8000/api/
   curl http://127.0.0.1:3000
   ```

2. **Check Nginx configuration**:
   ```bash
   sudo nginx -t
   ```

3. **Check Nginx logs**:
   ```bash
   sudo tail -f /var/log/nginx/error.log
   ```

### Database Connection Errors

1. **If using PostgreSQL, check if it's running**:
   ```bash
   sudo systemctl status postgresql
   ```

2. **Check Redis**:
   ```bash
   sudo systemctl status redis-server
   redis-cli ping
   ```

### Port Already in Use

```bash
# Find process using port 8000
sudo lsof -i :8000

# Kill process
sudo kill -9 <PID>
```

---

## 🎉 Success!

Your application should now be live at:
- **Frontend**: `http://your-oracle-ip` or `https://yourdomain.com`
- **Backend API**: `http://your-oracle-ip/api/` or `https://api.yourdomain.com/api/`

## 📚 Additional Resources

- [Oracle Cloud Documentation](https://docs.oracle.com/en-us/iaas/Content/home.htm)
- [Django Deployment Checklist](https://docs.djangoproject.com/en/stable/howto/deployment/checklist/)
- [Next.js Deployment](https://nextjs.org/docs/deployment)
- [PM2 Documentation](https://pm2.keymetrics.io/docs/usage/quick-start/)
- [Nginx Documentation](https://nginx.org/en/docs/)
