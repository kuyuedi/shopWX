#!/bin/bash
set -e

# Server configuration
SERVER_IP="8.216.43.26"
SERVER_USER="root"
SERVER_PORT="22"
DEPLOY_DIR="/opt/prediction-market-ingestion"

echo "=== Running Smoke Tests on Japan Server ==="
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
cd $DEPLOY_DIR

echo "=== Running smoke tests via healthcheck container ==="

# Ensure healthcheck container is running and rebuilt with latest code
docker compose build healthcheck
docker compose up -d healthcheck

# Wait for container to be ready
sleep 3

# Run smoke tests using docker exec
docker compose exec -T healthcheck node packages/healthcheck/dist/smoke-test.js

echo "=== Smoke tests complete ==="

ENDSSH

echo "=== Smoke test execution finished ==="
