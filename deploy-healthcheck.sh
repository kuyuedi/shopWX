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
echo "=== Deploying Healthcheck to Japan Server ==="
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

echo "=== Building and starting healthcheck container ==="
docker compose build healthcheck
docker compose up -d healthcheck

echo "=== Deployment complete ==="
echo "Checking container status..."
sleep 5
docker compose ps
docker compose logs --tail 20 healthcheck

ENDSSH

echo "=== Healthcheck deployment finished ==="
