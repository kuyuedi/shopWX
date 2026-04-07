# Sub-Feature 4: Docker + Deploy + Healthcheck

**Depends on**: Sub-features 1-3 complete

---

## Scope

Containerize the opinion-listener, add to docker-compose, create deploy script, and update healthcheck to monitor it.

---

## Step 1: Dockerfile

### File: `packages/opinion-listener/Dockerfile`

Follow the same multi-stage pattern as other listeners:

```dockerfile
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/opinion-listener/package.json packages/opinion-listener/
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY packages/opinion-listener packages/opinion-listener
RUN pnpm --filter @prediction-market/shared build
RUN pnpm --filter @prediction-market/opinion-listener build

FROM base AS production
WORKDIR /app
COPY --from=build /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/package.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/opinion-listener/package.json packages/opinion-listener/
COPY --from=build /app/packages/opinion-listener/dist packages/opinion-listener/dist
RUN pnpm install --frozen-lockfile --prod
CMD ["node", "packages/opinion-listener/dist/index.js"]
```

---

## Step 2: docker-compose.yml addition

Add the new service alongside existing listeners:

```yaml
opinion-listener:
  build:
    context: .
    dockerfile: packages/opinion-listener/Dockerfile
  environment:
    - DATABASE_URL=${DATABASE_URL}
    - DB_SCHEMA=${DB_SCHEMA:-direct_exchanges_data}
    - OPINION_API_KEY=${OPINION_API_KEY:-}
    - OPINION_WS_URL=${OPINION_WS_URL:-wss://ws.opinion.trade}
    - OPINION_REST_URL=${OPINION_REST_URL:-https://openapi.opinion.trade/openapi}
    - OPINION_MARKETS_PER_SOCKET=${OPINION_MARKETS_PER_SOCKET:-200}
    - BATCH_SIZE=${BATCH_SIZE:-100}
    - BATCH_INTERVAL_MS=${BATCH_INTERVAL_MS:-1000}
    - MARKET_REFRESH_INTERVAL_MS=${MARKET_REFRESH_INTERVAL_MS:-300000}
    - ENABLE_QUOTE_WRITES=${ENABLE_QUOTE_WRITES:-false}
  restart: unless-stopped
  logging:
    driver: json-file
    options:
      max-size: "10m"
      max-file: "3"
```

---

## Step 3: Deploy script

### File: `deploy-opinion.sh`

```bash
#!/bin/bash
set -e

SERVER_IP="8.216.43.26"
SERVER_USER="root"
SERVER_PORT="22"
DEPLOY_DIR="/opt/prediction-market-ingestion"

echo "=== Running unit tests ==="
./scripts/run-tests.sh --notify
echo "=== Unit tests passed ==="

echo ""
echo "=== Deploying Opinion listener to Japan Server ==="
echo "Server: $SERVER_USER@$SERVER_IP"

if ! command -v sshpass &> /dev/null; then
    echo "Installing sshpass..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        brew install hudochenkov/sshpass/sshpass
    else
        apt-get install -y sshpass
    fi
fi

sshpass -p 'n9Y#5df_tu39ko' ssh -o StrictHostKeyChecking=no -p $SERVER_PORT $SERVER_USER@$SERVER_IP << 'ENDSSH'
set -e

DEPLOY_DIR="/opt/prediction-market-ingestion"

echo "=== Updating code ==="
cd $DEPLOY_DIR
git fetch origin
git reset --hard origin/main

echo "=== Building and starting opinion-listener container ==="
docker compose build opinion-listener
docker compose up -d opinion-listener

echo "=== Deployment complete ==="
echo "Checking container status..."
sleep 5
docker compose ps
docker compose logs --tail 20 opinion-listener

ENDSSH

echo "=== Opinion listener deployment finished ==="
```

Make executable: `chmod +x deploy-opinion.sh`

---

## Step 4: Environment variables on server

Add to the server's `.env` file at `/opt/prediction-market-ingestion/.env`:

```bash
OPINION_API_KEY=<key from application>
OPINION_WS_URL=wss://ws.opinion.trade
OPINION_REST_URL=https://openapi.opinion.trade/openapi
OPINION_MARKETS_PER_SOCKET=200
```

---

## Step 5: Healthcheck updates

### File: `packages/healthcheck/src/checks/containers.ts`

Add `opinion-listener` to the monitored containers list:

```typescript
// Find the container name list and add:
const MONITORED_CONTAINERS = [
  'kalshi-listener',
  'polymarket-listener',
  'opinion-listener',    // ADD THIS
  'homepage-api',
  'event-matcher',
];
```

### File: `packages/healthcheck/src/checks/smokeTest.ts`

Add data flow check for Opinion:

```sql
-- Add to the existing smoke test query
SELECT exchange_id, COUNT(*) as recent_records
FROM direct_exchanges_data.market_latest_data
WHERE updated_at > NOW() - INTERVAL '5 minutes'
GROUP BY exchange_id;

-- Alert if OPINIONTRADE has 0 records for >5 minutes
```

---

## Step 6: CLAUDE.md updates

Add Opinion to the system documentation:

1. **Architecture diagram**: Add Opinion listener box
2. **Package Structure table**: Add `opinion-listener` row
3. **Key Files table**: Add opinion-listener entries
4. **Deployment section**: Add `./deploy-opinion.sh`
5. **Environment variables**: Add Opinion-specific vars
6. **WebSocket pools note**: Add Opinion limit info

---

## Deployment Sequence

1. Apply for API key (blocker — Google Form)
2. Get API key, add to server `.env`
3. Commit all code
4. Push to GitHub
5. Run `./deploy-opinion.sh`
6. Deploy healthcheck update: `./deploy-healthcheck.sh`
7. Verify (see below)

---

## Verification

### Container health
```bash
ssh root@8.216.43.26 "docker compose ps | grep opinion"
# Expect: opinion-listener running

ssh root@8.216.43.26 "docker compose logs --tail 30 opinion-listener"
# Expect: market sync logs, WS connection logs, no errors
```

### Data flow
```sql
-- Markets synced
SELECT COUNT(*), COUNT(DISTINCT market_id) as markets
FROM direct_exchanges_data.prediction_markets
WHERE exchange_id = 'OPINIONTRADE';

-- Events synced
SELECT COUNT(*) FROM direct_exchanges_data.events
WHERE exchange_id = 'OPINIONTRADE' AND status = 'Open';

-- Real-time data flowing
SELECT exchange_id, COUNT(*) as records_5min
FROM direct_exchanges_data.market_latest_data
WHERE updated_at > NOW() - INTERVAL '5 minutes'
GROUP BY exchange_id
ORDER BY exchange_id;
-- Expect: OPINIONTRADE row with non-zero count

-- Event matching started
SELECT COUNT(*) FROM direct_exchanges_data.event_mappings
WHERE exchange_id = 'OPINIONTRADE';
-- May take 5-10 minutes for first matches to appear

-- Arbs detected
SELECT leg1_exchange_id, leg2_exchange_id, COUNT(*)
FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE'
GROUP BY leg1_exchange_id, leg2_exchange_id;
-- Expect: new pairs involving OPINIONTRADE
```

### Full pipeline verification (end-to-end)
```sql
-- Opinion market → matched to Kalshi/Poly → arb detected
SELECT ao.arb_type, ao.leg1_exchange_id, ao.leg2_exchange_id,
       ao.market_title, ao.gross_spread_pct, ao.executable_qty
FROM direct_exchanges_data.arb_opportunities ao
WHERE ao.status = 'ACTIVE'
  AND (ao.leg1_exchange_id = 'OPINIONTRADE' OR ao.leg2_exchange_id = 'OPINIONTRADE')
ORDER BY ao.gross_spread_pct DESC
LIMIT 10;
```
