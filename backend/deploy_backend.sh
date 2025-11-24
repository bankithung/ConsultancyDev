#!/bin/bash

# Backend Deployment Script for Oracle Cloud
# This script sets up and deploys the Django backend

set -e  # Exit on error

echo "========================================="
echo "  Django Backend Deployment Script"
echo "========================================="

# Configuration
APP_DIR="/home/ubuntu/consultancy-backend"
VENV_DIR="$APP_DIR/venv"
LOG_DIR="/var/log/gunicorn"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}[1/8] Updating system packages...${NC}"
sudo apt-get update
sudo apt-get upgrade -y

echo -e "${GREEN}[2/8] Installing system dependencies...${NC}"
sudo apt-get install -y python3-pip python3-venv python3-dev \
    build-essential libpq-dev nginx redis-server \
    supervisor git curl

echo -e "${GREEN}[3/8] Creating application directory...${NC}"
sudo mkdir -p $APP_DIR
sudo chown $USER:$USER $APP_DIR

echo -e "${GREEN}[4/8] Setting up Python virtual environment...${NC}"
cd $APP_DIR
python3 -m venv $VENV_DIR
source $VENV_DIR/bin/activate

echo -e "${GREEN}[5/8] Installing Python dependencies...${NC}"
pip install --upgrade pip
pip install -r requirements.txt

echo -e "${GREEN}[6/8] Running Django setup...${NC}"
# Generate a new secret key if needed
if [ ! -f .env ]; then
    echo -e "${YELLOW}Creating .env file from template...${NC}"
    cp .env.production .env
    # Generate a new Django secret key
    NEW_SECRET=$(python3 -c 'from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())')
    sed -i "s/your-production-secret-key-here-change-this/$NEW_SECRET/" .env
fi

# Collect static files
python manage.py collectstatic --noinput

# Run migrations
python manage.py migrate

echo -e "${GREEN}[7/8] Setting up Gunicorn...${NC}"
sudo mkdir -p $LOG_DIR
sudo mkdir -p /var/run/gunicorn
sudo chown $USER:$USER $LOG_DIR
sudo chown $USER:$USER /var/run/gunicorn

# Create systemd service for Gunicorn
sudo tee /etc/systemd/system/gunicorn.service > /dev/null <<EOF
[Unit]
Description=gunicorn daemon for Django backend
After=network.target

[Service]
User=$USER
Group=www-data
WorkingDirectory=$APP_DIR
Environment="PATH=$VENV_DIR/bin"
ExecStart=$VENV_DIR/bin/gunicorn config.wsgi:application -c gunicorn_config.py

[Install]
WantedBy=multi-user.target
EOF

# Create systemd service for Daphne (ASGI/WebSockets)
sudo tee /etc/systemd/system/daphne.service > /dev/null <<EOF
[Unit]
Description=daphne daemon for Django Channels
After=network.target

[Service]
User=$USER
Group=www-data
WorkingDirectory=$APP_DIR
Environment="PATH=$VENV_DIR/bin"
ExecStart=$VENV_DIR/bin/daphne -b 127.0.0.1 -p 8001 config.asgi:application

[Install]
WantedBy=multi-user.target
EOF

echo -e "${GREEN}[8/8] Starting services...${NC}"
# Start and enable Redis
sudo systemctl start redis-server
sudo systemctl enable redis-server

# Start and enable Gunicorn
sudo systemctl daemon-reload
sudo systemctl start gunicorn
sudo systemctl enable gunicorn

# Start and enable Daphne
sudo systemctl start daphne
sudo systemctl enable daphne

# Check status
echo -e "\n${GREEN}Service Status:${NC}"
sudo systemctl status gunicorn --no-pager
sudo systemctl status daphne --no-pager
sudo systemctl status redis-server --no-pager

echo -e "\n${GREEN}=========================================${NC}"
echo -e "${GREEN}  Backend deployment completed!${NC}"
echo -e "${GREEN}=========================================${NC}"
echo -e "Backend is running on http://127.0.0.1:8000"
echo -e "WebSocket is running on http://127.0.0.1:8001"
echo -e "\nNext steps:"
echo -e "1. Configure Nginx (copy nginx_backend.conf to /etc/nginx/sites-available/)"
echo -e "2. Update .env file with your actual values"
echo -e "3. Restart services: sudo systemctl restart gunicorn daphne"
