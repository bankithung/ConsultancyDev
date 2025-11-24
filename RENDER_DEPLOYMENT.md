# 🚀 Render + Vercel Deployment Guide

Deploy your Consultancy Management Application (Django + Next.js) to Render and Vercel for **FREE**.

## ⚠️ Important Limitations

> **Cold Starts**: Render free tier spins down after 15 minutes of inactivity. First request can take 50+ seconds.

> **Database**: Free PostgreSQL expires after 90 days. You'll need to migrate or upgrade.

> **Redis**: Render's free tier doesn't include Redis. You can use [Upstash](https://upstash.com) (free tier: 10k commands/day).

---

## 📋 Prerequisites

- ✅ GitHub account (to deploy from repository)
- ✅ Render account ([render.com](https://render.com))
- ✅ Vercel account ([vercel.com](https://vercel.com))
- ✅ Your code pushed to GitHub

---

## Part 1: Push Code to GitHub

### Step 1: Initialize Git (if not already)

```bash
cd c:\Users\Asus\Music\kikonsDev
git init
git add .
git commit -m "Initial commit - ready for Render deployment"
```

### Step 2: Push to GitHub

```bash
# Create a new repository on GitHub first, then:
git branch -M main
git remote add origin https://github.com/your-username/your-repo.git
git push -u origin main
```

---

## Part 2: Deploy Backend to Render

### Step 1: Create Render Account

1. Go to [render.com](https://render.com)
2. Sign up with GitHub (recommended) or email
3. Authorize Render to access your repositories

### Step 2: Create PostgreSQL Database

1. Click **"New +"** → **"PostgreSQL"**
2. Configure:
   - **Name**: `consultancy-db`
   - **Database**: `consultancy_db`
   - **User**: `consultancy_user`
   - **Region**: Choose closest to you
   - **Plan**: **Free**
3. Click **"Create Database"**
4. **Copy the Internal Database URL** (starts with `postgresql://`)

### Step 3: Create Web Service

1. Click **"New +"** → **"Web Service"**
2. Connect your GitHub repository
3. Configure:
   - **Name**: `consultancy-backend`
   - **Region**: Same as database
   - **Branch**: `main`
   - **Root Directory**: `backend`
   - **Runtime**: **Python 3**
   - **Build Command**: `./build.sh`
   - **Start Command**: `gunicorn config.wsgi:application`
   - **Plan**: **Free**

### Step 4: Add Environment Variables

Click **"Environment"** → **"Add Environment Variable"**

Add these variables:

| Key | Value |
|-----|-------|
| `PYTHON_VERSION` | `3.11.0` |
| `DATABASE_URL` | *Paste the Internal Database URL from Step 2* |
| `SECRET_KEY` | *Generate one below* |
| `DEBUG` | `False` |
| `ALLOWED_HOSTS` | `consultancy-backend.onrender.com` |
| `CORS_ALLOWED_ORIGINS` | `https://your-frontend-url.vercel.app` |

**Generate SECRET_KEY**:
```bash
# Run in your local backend
cd c:\Users\Asus\Music\kikonsDev\backend
python -c "from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())"
```

### Step 5: Set Up Redis (Optional - for WebSockets)

**Option A: Use Upstash (Recommended)**

1. Go to [upstash.com](https://upstash.com)
2. Create account and new Redis database
3. Copy the Redis URL
4. Add to Render environment variables:
   - `REDIS_URL`: *Your Upstash Redis URL*

**Option B: Disable WebSockets temporarily**

Update `config/settings.py` to make Redis optional for testing.

### Step 6: Make build.sh Executable

Before deploying, ensure the build script has Unix line endings:

1. Open `backend/build.sh` in VS Code
2. Click "CRLF" in bottom right
3. Select "LF"
4. Save and push to GitHub

```bash
cd backend
git add build.sh
git commit -m "Fix build.sh line endings"
git push
```

### Step 7: Deploy

1. Click **"Create Web Service"**
2. Wait 5-10 minutes for deployment
3. Check logs for any errors

### Step 8: Verify Backend

Once deployed, visit:
```
https://consultancy-backend.onrender.com/api/
```

You should see your API response!

---

## Part 3: Deploy Frontend to Vercel

### Step 1: Create Vercel Account

1. Go to [vercel.com](https://vercel.com)
2. Sign up with GitHub
3. Authorize Vercel to access repositories

### Step 2: Import Project

1. Click **"Add New..."** → **"Project"**
2. Select your GitHub repository
3. Configure:
   - **Framework Preset**: **Next.js** (auto-detected)
   - **Root Directory**: `consultancy-dev`
   - **Build Command**: `npm run build` (default)
   - **Output Directory**: `.next` (default)

### Step 3: Configure Environment Variables

Click **"Environment Variables"** and add:

| Name | Value |
|------|-------|
| `NEXT_PUBLIC_API_URL` | `https://consultancy-backend.onrender.com/api` |
| `NEXT_PUBLIC_WS_URL` | `wss://consultancy-backend.onrender.com/ws` |
| `NEXT_PUBLIC_APP_URL` | *Will be provided after deployment* |

### Step 4: Deploy

1. Click **"Deploy"**
2. Wait 2-5 minutes
3. Once deployed, copy your Vercel URL (e.g., `your-app.vercel.app`)

### Step 5: Update Backend CORS

1. Go back to Render dashboard
2. Update `CORS_ALLOWED_ORIGINS` environment variable:
   ```
   https://your-app.vercel.app
   ```
3. Wait for backend to redeploy (automatic)

### Step 6: Update Frontend URL

In Vercel:
1. Go to Project Settings → Environment Variables
2. Update `NEXT_PUBLIC_APP_URL` to your Vercel URL
3. Redeploy: Deployments → ... → Redeploy

---

## Part 4: Create Django Superuser

### Step 1: Access Render Shell

1. Go to Render Dashboard → Your backend service
2. Click **"Shell"** tab
3. Run:
   ```bash
   python manage.py createsuperuser
   ```
4. Follow prompts to create admin account

---

## Part 5: Testing Your Deployment

### Backend Tests

```bash
# API Health Check
curl https://consultancy-backend.onrender.com/api/

# Admin Panel
# Visit: https://consultancy-backend.onrender.com/admin/
```

### Frontend Tests

1. Open your Vercel URL
2. Test login/signup
3. Test API calls
4. Check browser console for errors

### Cold Start Test

1. Wait 15+ minutes without accessing the app
2. Try to access it again
3. First request will be slow (50+ seconds)
4. Subsequent requests will be fast

---

## 🔧 Troubleshooting

### Build Fails on Render

**Error: Permission denied: ./build.sh**

Solution: Fix line endings (see Part 2, Step 6)

**Error: Module not found**

Solution: Check `requirements.txt` has all dependencies

### Database Connection Error

1. Verify `DATABASE_URL` is set correctly
2. Check database is in same region as web service
3. Ensure `psycopg2-binary` is in requirements.txt

### CORS Errors on Frontend

1. Check `CORS_ALLOWED_ORIGINS` in Render includes your Vercel URL
2. Ensure no trailing slash in URLs
3. Redeploy backend after changes

### Frontend Can't Connect to Backend

1. Verify `NEXT_PUBLIC_API_URL` in Vercel settings
2. Check backend is deployed and running
3. Test backend URL directly in browser

---

## 🔄 Updating Your Application

### Backend Updates

```bash
# Make changes locally
git add .
git commit -m "Update backend"
git push

# Render will auto-deploy from GitHub
```

### Frontend Updates

```bash
# Make changes locally
git add .
git commit -m "Update frontend"
git push

# Vercel will auto-deploy from GitHub
```

---

## 📊 Monitoring

### Render Logs

1. Go to Render Dashboard
2. Click your service
3. View **Logs** tab

### Vercel Logs

1. Go to Vercel Dashboard
2. Click your project
3. Click **Deployments**
4. Click a deployment → **View Function Logs**

---

## 💡 Tips for Free Tier

### Keep Backend Awake

Use a monitoring service (free):
- [UptimeRobot](https://uptimerobot.com) - Ping your API every 5 minutes
- [Cron-job.org](https://cron-job.org) - Schedule health checks

**Warning**: This keeps your service active but may violate Render's TOS if excessive.

### Optimize Cold Starts

1. Keep your dependencies minimal
2. Use gunicorn with preload: `--preload`
3. Reduce worker count for free tier

### Database Backup

Before 90 days expire:
1. Export data: `pg_dump` from Render shell
2. Upgrade to paid plan, or
3. Create new free database and restore

---

## 🎉 Success!

Your application is now live:
- **Frontend**: `https://your-app.vercel.app`
- **Backend API**: `https://consultancy-backend.onrender.com/api/`
- **Admin**: `https://consultancy-backend.onrender.com/admin/`

---

## 📚 Additional Resources

- [Render Documentation](https://render.com/docs)
- [Vercel Documentation](https://vercel.com/docs)
- [Django Deployment Checklist](https://docs.djangoproject.com/en/stable/howto/deployment/checklist/)
- [Upstash Redis](https://upstash.com)

---

## 🆚 Render vs Oracle Cloud

| Feature | Render (Free) | Oracle Cloud (Free) |
|---------|---------------|---------------------|
| **Cold Starts** | Yes (15 min) | No |
| **RAM** | 512 MB | 24 GB |
| **CPU** | Shared | 4 OCPUs |
| **Database** | 90 days | Unlimited |
| **Setup Time** | 15 min | 1-2 hours |
| **Production Ready** | No | Yes |

**Recommendation**: Use Render for quick testing, Oracle Cloud for production.
