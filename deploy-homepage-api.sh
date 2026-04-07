#!/bin/bash
set -e

# Server configuration
SERVER_IP="8.216.43.26"
SERVER_USER="root"
SERVER_PORT="22"
DEPLOY_DIR="/opt/prediction-market-ingestion"

echo "=== Running unit tests ==="
./scripts/run-tests.sh --notify
echo "=== Unit tests passed ==="

echo ""
echo "=== Deploying Homepage API to Japan Server ==="
echo "Server: $SERVER_USER@$SERVER_IP"

# Check if sshpass is installed
if ! command -v sshpass &> /dev/null; then
    echo "Installing sshpass..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        brew install hudochenkov/sshpass/sshpass
    else
        apt-get install -y sshpass
    fi
fi

# SSH commands to run on the server
sshpass -p 'n9Y#5df_tu39ko' ssh -o StrictHostKeyChecking=no -p $SERVER_PORT $SERVER_USER@$SERVER_IP << 'ENDSSH'
set -e

DEPLOY_DIR="/opt/prediction-market-ingestion"

echo "=== Updating code ==="
cd $DEPLOY_DIR
git fetch origin
git reset --hard origin/main

echo "=== Building and starting homepage-api container ==="
docker compose build homepage-api
docker compose up -d homepage-api

echo "=== Deployment complete ==="
echo "Checking container status..."
sleep 5
docker compose ps
docker compose logs --tail 20 homepage-api

ENDSSH

echo "=== Homepage API deployment finished ==="
