# 🚀 Render Full Stack Deployment Guide

Deploy your **entire** Consultancy Management Application (Django + Next.js) on Render for **FREE**.

## ⚠️ Important Limitations

> **Cold Starts**: Render free tier spins down after 15 minutes of inactivity. Both frontend and backend will sleep. First request can take 50+ seconds.

> **Database**: Free PostgreSQL expires after 90 days. You'll need to migrate or upgrade.

> **Performance**: Both services will experience cold starts. For better frontend performance, consider Vercel (see `RENDER_DEPLOYMENT.md`).

---

## 📋 Prerequisites

- ✅ GitHub account (to deploy from repository)
- ✅ Render account ([render.com](https://render.com))
- ✅ Your code pushed to GitHub

---

## Step 1: Push Code to GitHub

### Initialize Git (if not already)

```bash
cd c:\Users\Asus\Music\kikonsDev
git init
git add .
git commit -m "Initial commit - ready for Render deployment"
```

### Push to GitHub

```bash
# Create a new repository on GitHub first, then:
git branch -M main
git remote add origin https://github.com/your-username/your-repo.git
git push -u origin main
```

---

## Step 2: Create Render Account

1. Go to [render.com](https://render.com)
2. Sign up with GitHub (recommended) or email
3. Authorize Render to access your repositories

---

## Step 3: Deploy Using render.yaml (Recommended)

Render can automatically deploy everything using the `render.yaml` file!

### Option A: Blueprint (Easiest - Deploy Everything at Once)

1. Go to Render Dashboard
2. Click **"New +"** → **"Blueprint"**
3. Connect your GitHub repository
4. Render will detect `backend/render.yaml`
5. Review the services:
   - `consultancy-backend` (Django)
   - `consultancy-frontend` (Next.js)
   - `consultancy-db` (PostgreSQL)
6. Click **"Apply"**
7. Wait 10-15 minutes for deployment

### Option B: Manual Setup (Step by Step)

Follow this if Blueprint doesn't work:

---

## Step 4: Create PostgreSQL Database

1. Click **"New +"** → **"PostgreSQL"**
2. Configure:
   - **Name**: `consultancy-db`
   - **Database**: `consultancy_db`
   - **User**: `consultancy_user`
   - **Region**: Choose closest to you
   - **Plan**: **Free**
3. Click **"Create Database"**
4. **Copy the Internal Database URL** (starts with `postgresql://`)

---

## Step 5: Deploy Backend

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

### Environment Variables for Backend

| Key | Value |
|-----|-------|
| `PYTHON_VERSION` | `3.11.0` |
| `DATABASE_URL` | *Paste the Internal Database URL* |
| `SECRET_KEY` | *Generate below* |
| `DEBUG` | `False` |
| `ALLOWED_HOSTS` | `consultancy-backend.onrender.com,consultancy-frontend.onrender.com` |
| `CORS_ALLOWED_ORIGINS` | `https://consultancy-frontend.onrender.com` |

**Generate SECRET_KEY**:
```bash
python -c "from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())"
```

### Fix build.sh Line Endings
```bash
cd backend
# In VS Code: Click "CRLF" → Select "LF" → Save
git add build.sh
git commit -m "Fix build.sh line endings"
git push
```

4. Click **"Create Web Service"**
5. Wait 5-10 minutes

---

## Step 6: Deploy Frontend

1. Click **"New +"** → **"Web Service"**
2. Connect your GitHub repository
3. Configure:
   - **Name**: `consultancy-frontend`
   - **Region**: Same as backend
   - **Branch**: `main`
   - **Root Directory**: `consultancy-dev`
   - **Runtime**: **Node**
   - **Build Command**: `npm ci && npm run build`
   - **Start Command**: `npm start`
   - **Plan**: **Free**

### Environment Variables for Frontend

| Key | Value |
|-----|-------|
| `NODE_VERSION` | `20.11.0` |
| `NEXT_PUBLIC_API_URL` | `https://consultancy-backend.onrender.com/api` |
| `NEXT_PUBLIC_WS_URL` | `wss://consultancy-backend.onrender.com/ws` |
| `NEXT_PUBLIC_APP_URL` | `https://consultancy-frontend.onrender.com` |

4. Click **"Create Web Service"**
5. Wait 5-10 minutes

---

## Step 7: Update Backend CORS

After frontend is deployed:

1. Go to Backend service settings
2. Update `CORS_ALLOWED_ORIGINS`:
   ```
   https://consultancy-frontend.onrender.com
   ```
3. Service will automatically redeploy

---

## Step 8: Create Django Superuser

1. Go to Render Dashboard → Backend service
2. Click **"Shell"** tab
3. Run:
   ```bash
   python manage.py createsuperuser
   ```
4. Follow prompts

---

## Step 9: Setup Redis (Optional - for WebSockets)

**Option A: Upstash (Free)**

1. Go to [upstash.com](https://upstash.com)
2. Create account and new Redis database
3. Copy Redis URL
4. Add to Backend environment variables:
   - `REDIS_URL`: *Your Upstash Redis URL*
5. Redeploy backend

**Option B: Skip for now**
- App will work without WebSockets
- Can add later when needed

---

## 🎉 Your App is Live!

- **Frontend**: `https://consultancy-frontend.onrender.com`
- **Backend API**: `https://consultancy-backend.onrender.com/api/`
- **Admin**: `https://consultancy-backend.onrender.com/admin/`

---

## 🔧 Troubleshooting

### Build Fails - Permission Denied

**Fix**: Change `build.sh` line endings from CRLF to LF (see Step 5)

### CORS Errors

**Fix**: Ensure `CORS_ALLOWED_ORIGINS` matches your frontend URL exactly

### Frontend Won't Build

**Fix**: Check Node version is 20.x and build command is `npm ci && npm run build`

### Database Connection Error

**Fix**: Verify `DATABASE_URL` is copied correctly (use Internal URL, not External)

### Both Services Slow After Inactivity

**This is normal** - Free tier spins down after 15 minutes. Consider:
- Upgrading to paid tier ($7/month per service)
- Using Oracle Cloud (free forever, no cold starts)
- Using UptimeRobot to ping services (may violate TOS)

---

## 🔄 Updating Your Application

```bash
# Make changes locally
git add .
git commit -m "Update application"
git push

# Both services will auto-deploy from GitHub
```

---

## 💡 Keep Services Awake (Optional)

**UptimeRobot** (free monitoring):
1. Sign up at [uptimerobot.com](https://uptimerobot.com)
2. Add monitors:
   - `https://consultancy-backend.onrender.com/api/`
   - `https://consultancy-frontend.onrender.com`
3. Set interval to 5 minutes

⚠️ **Warning**: Excessive pinging may violate Render's Terms of Service.

---

## 📊 Render Free Tier Limits

- ✅ 750 hours/month per service (enough for 1 service 24/7)
- ✅ Unlimited services (all share the 750 hours)
- ⚠️ Services spin down after 15 min inactivity
- ⚠️ PostgreSQL free for 90 days
- ⚠️ 100 GB bandwidth/month per service

---

## 🆚 Comparison

### All on Render vs Split Deployment

| Feature | All Render | Render + Vercel |
|---------|------------|-----------------|
| **Frontend Cold Starts** | ✅ Yes | ❌ No |
| **Setup Complexity** | ⭐ Simple | ⭐⭐ Medium |
| **Free Tier** | ✅ Both free | ✅ Both free |
| **One Dashboard** | ✅ Yes | ❌ No |
| **Performance** | 🐌 Slower | ⚡ Faster |

### Render vs Oracle Cloud

| Feature | Render | Oracle Cloud |
|---------|--------|--------------|
| **Setup Time** | 20 min | 1-2 hours |
| **Cold Starts** | Yes | No |
| **Production Ready** | No | Yes |
| **Database Limit** | 90 days | Unlimited |
| **RAM** | 512 MB | 24 GB |

---

## 📚 Next Steps

**For Production**: Consider migrating to Oracle Cloud (see `DEPLOYMENT_GUIDE.md`)

**For Better Performance**: Deploy frontend to Vercel (see `RENDER_DEPLOYMENT.md`)

---

## 📞 Support

- [Render Documentation](https://render.com/docs)
- [Render Community](https://community.render.com)
- [Django Deployment Checklist](https://docs.djangoproject.com/en/stable/howto/deployment/checklist/)
