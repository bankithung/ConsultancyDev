#!/usr/bin/env bash
# Auto-deploy for ConsultancyDev
# Pulls latest main, merges local changes (stash/pop), runs migrations,
# rebuilds the frontend, restarts services, and pushes local commits back.
set -euo pipefail

APP_DIR="/opt/consultancy"
LOG="/var/log/consultancy-autodeploy.log"
LOCK="/tmp/consultancy-autodeploy.lock"
STATE="/var/lib/consultancy-autodeploy.last"

exec >>"$LOG" 2>&1
echo "=== $(date '+%F %T') auto-deploy started ==="

# Prevent overlapping runs
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "Another deploy is running, exiting."
  exit 0
fi

cd "$APP_DIR"
LAST_DEPLOYED=$(cat "$STATE" 2>/dev/null || echo "none")

# 0) If there are local commits not yet pushed, push them first
git fetch origin main
LOCAL=$(git rev-parse main)
REMOTE=$(git rev-parse origin/main)
if git merge-base --is-ancestor "$REMOTE" "$LOCAL" && [ "$LOCAL" != "$REMOTE" ]; then
  echo "Pushing local commits to origin..."
  git push origin main || echo "WARN: push failed, continuing"
fi

# 1) Pull latest, preserving local uncommitted changes
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Stashing local changes..."
  git stash push -m "autodeploy-stash-$(date +%s)"
  STASHED=1
fi

PULL_OK=1
if ! git pull --rebase origin main; then
  echo "ERROR: pull/rebase failed. Aborting without touching services."
  [ "${STASHED:-0}" = "1" ] && git stash pop
  exit 1
fi
[ "${STASHED:-0}" = "1" ] && git stash pop && git add -A && \
  git -c user.name="deploy" -c user.email="deploy@server" commit -m "Auto-merge local changes after deploy $(date '+%F %T')" || true

NEW_HEAD=$(git rev-parse HEAD)

# Deploy if HEAD differs from what was last successfully deployed,
# or if any service is down (self-heal).
NEED_DEPLOY=0
[ "$NEW_HEAD" != "$LAST_DEPLOYED" ] && NEED_DEPLOY=1
systemctl is-active --quiet consultancy-backend || NEED_DEPLOY=1
systemctl is-active --quiet consultancy-frontend || NEED_DEPLOY=1

if [ "$NEED_DEPLOY" = "0" ]; then
  echo "Already up to date ($NEW_HEAD). Nothing to deploy."
  echo "=== done ==="
  exit 0
fi

echo "Deploying $(git log --oneline -1)..."

# 2) Backend deps (in case requirements changed) + migrations
cd "$APP_DIR/backend"
venv/bin/pip install -q -r requirements.txt
venv/bin/python manage.py migrate --noinput
venv/bin/python manage.py collectstatic --noinput 2>/dev/null || true

# 3) Frontend deps + rebuild
cd "$APP_DIR/consultancy-dev"
npm ci --silent
npm run build

# 4) Restart services
systemctl restart consultancy-backend consultancy-frontend
if systemctl is-active --quiet consultancy-mcp; then
  systemctl restart consultancy-mcp
fi
sleep 3

# 5) Health check
FAIL=0
systemctl is-active --quiet consultancy-backend || FAIL=1
systemctl is-active --quiet consultancy-frontend || FAIL=1
if [ "$FAIL" = "1" ]; then
  echo "ERROR: service failed after restart. Check: journalctl -u consultancy-backend -u consultancy-frontend"
  exit 1
fi

echo "$NEW_HEAD" > "$STATE"
echo "Services healthy. Deploy of $NEW_HEAD complete."
echo "=== $(date '+%F %T') auto-deploy finished ==="
