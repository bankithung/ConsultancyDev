# 🚀 Render Full Stack - Quick Start

Deploy EVERYTHING on Render in ~20 minutes!

## ✅ What's Ready

All files are configured for **full stack Render deployment**:

### Backend
- `backend/render.yaml` - Complete infrastructure config
- `backend/build.sh` - Build script
- Django settings updated for Render

### Frontend  
- Added to `render.yaml` as second service
- Configured for Next.js on Render

### Database
- PostgreSQL configured in `render.yaml`

## 🚀 Deploy Now

### Option 1: Blueprint (Easiest - One Click!)

1. Push to GitHub:
   ```bash
   git add .
   git commit -m "Ready for Render"
   git push
   ```

2. Go to [render.com](https://render.com)

3. Click **"New +"** → **"Blueprint"**

4. Connect your GitHub repo

5. Render auto-deploys **everything**!
   - Backend
   - Frontend
   - Database

6. Set environment variables (Render will prompt)

**That's it!** ⏱️ 15-20 minutes total

### Option 2: Manual

Follow step-by-step guide in `RENDER_FULL_STACK.md`

## 📱 Your URLs

After deployment:
- **Frontend**: `https://consultancy-frontend.onrender.com`
- **Backend**: `https://consultancy-backend.onrender.com/api/`
- **Admin**: `https://consultancy-backend.onrender.com/admin/`

## ⚠️ Remember

- Both services sleep after 15 min (cold starts)
- Database free for 90 days
- Great for testing, not production

## 📖 Full Guide

See `RENDER_FULL_STACK.md` for complete instructions!
