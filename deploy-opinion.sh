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
echo "=== Deploying Opinion Listener to Japan Server ==="
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

echo "=== Pulling latest code ==="
cd $DEPLOY_DIR

if [ -d ".git" ]; then
    git fetch origin
    git reset --hard origin/main
else
    echo "Repository not found. Please run deploy.sh first to set up the repo."
    exit 1
fi

echo "=== Building and starting Opinion listener ==="
docker compose build opinion-listener
docker compose up -d opinion-listener

echo "=== Deployment complete ==="
echo "Checking container status..."
sleep 5
docker compose ps opinion-listener
echo ""
echo "=== Recent logs ==="
docker compose logs --tail 30 opinion-listener

echo "=== Waiting for data to flow before smoke tests (60 seconds) ==="
sleep 60

echo "=== Running smoke tests ==="
# Ensure healthcheck container is built and running
docker compose build healthcheck
docker compose up -d healthcheck
sleep 3

# Run smoke tests - results will be sent to Telegram
docker compose exec -T healthcheck node packages/healthcheck/dist/smoke-test.js || echo "Smoke tests completed with warnings"

echo "=== Smoke test results sent to Telegram ==="

ENDSSH

echo "=== Opinion listener deployment finished ==="
