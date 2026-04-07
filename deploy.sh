#!/bin/bash
set -e

# Server configuration
SERVER_IP="8.216.43.26"
SERVER_USER="root"
SERVER_PORT="22"
DEPLOY_DIR="/opt/prediction-market-ingestion"
REPO_URL="https://github.com/kuyuedi/prediction.git"

echo "=== Running unit tests ==="
./scripts/run-tests.sh --notify
echo "=== Unit tests passed ==="

echo ""
echo "=== Deploying to Japan Server ==="
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
REPO_URL="https://github.com/kuyuedi/prediction.git"

echo "=== Setting up deployment directory ==="
mkdir -p $DEPLOY_DIR
cd $DEPLOY_DIR

# Check if git repo exists, clone or pull
if [ -d ".git" ]; then
    echo "=== Pulling latest code ==="
    git fetch origin
    git reset --hard origin/main
else
    echo "=== Cloning repository ==="
    cd /opt
    rm -rf prediction-market-ingestion
    git clone $REPO_URL prediction-market-ingestion
    cd prediction-market-ingestion
fi

# Create .env file if it doesn't exist
if [ ! -f ".env" ]; then
    echo "=== Creating .env file ==="
    cat > .env << 'ENVEOF'
# Database Configuration
DATABASE_URL=postgresql://direct_exchanges:HAH2#mwzay_8a@pgm-0iwbjigj740ve1e5.pgsql.japan.rds.aliyuncs.com:5432/direct_exchanges
DB_SCHEMA=direct_exchanges_data

# Polymarket Configuration
POLYMARKET_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
POLYMARKET_GAMMA_URL=https://gamma-api.polymarket.com
MARKETS_PER_SOCKET=500

# Kalshi Configuration (add your API key)
KALSHI_API_KEY=
KALSHI_WS_URL=wss://api.elections.kalshi.com/trade-api/ws/v2
KALSHI_REST_URL=https://api.elections.kalshi.com/trade-api/v2

# General Configuration
LOG_LEVEL=info
BATCH_SIZE=100
BATCH_INTERVAL_MS=1000
MARKET_REFRESH_INTERVAL_MS=300000
ENVEOF
    echo "NOTE: Please add KALSHI_API_KEY to .env if needed"
fi

# Install Docker if not present
if ! command -v docker &> /dev/null; then
    echo "=== Installing Docker ==="
    curl -fsSL https://get.docker.com | sh
    systemctl start docker
    systemctl enable docker
fi

# Install Docker Compose plugin if not present
if ! docker compose version &> /dev/null; then
    echo "=== Installing Docker Compose ==="
    apt-get update && apt-get install -y docker-compose-plugin
fi

echo "=== Building and starting Polymarket listener ==="
docker compose build polymarket-listener
docker compose up -d polymarket-listener

echo "=== Deployment complete ==="
echo "Checking container status..."
sleep 5
docker compose ps
docker compose logs --tail 20 polymarket-listener

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

echo "=== Deployment finished ==="
