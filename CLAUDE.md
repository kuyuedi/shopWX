# Claude Code Instructions

## Project Overview

This is a **real-time prediction market data ingestion system** that connects to Kalshi, Polymarket, Predict.fun, and Opinion.trade exchanges via WebSocket APIs to ingest market data, trades, and order book updates into a PostgreSQL database.

## Architecture

```
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌─────────────┐
│  Kalshi API  │ │Polymarket API│ │ Predict API  │ │Opinion.trade │ │  PostgreSQL  │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────▲──────┘
       │                │               │                │                │
       ▼                ▼               ▼                ▼                │
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐      │
│kalshi-listen │ │polymarket-l  │ │predict-listen│ │opinion-listen│      │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘      │
       │                │               │                │                │
       └────────────────┼───────────────┼────────────────┘               │
                        │               │                                 │
                 ┌──────▼──────┐  ┌─────▼────────┐                       │
                 │   shared    ├──┤ event-matcher ├───────────────────────┘
                 └─────────────┘  └──────────────┘
```

## Package Structure

```
packages/
├── shared/                 # Database client, queries, types, utilities
├── kalshi-listener/        # Kalshi WebSocket listener + event ingestion
├── polymarket-listener/    # Polymarket WebSocket listener + event ingestion
├── opinion-listener/       # Opinion.trade WebSocket listener + event ingestion
├── predict-listener/       # Predict.fun REST/WS listener + cross-exchange mapping
├── event-matcher/          # Event-level cross-exchange matching (OpenAI)
├── homepage-api/           # REST API for frontend
└── healthcheck/            # System monitoring and Telegram alerts
```

## Key Files

| Purpose | Location |
|---------|----------|
| Database queries | `packages/shared/src/db/queries.ts` |
| Database types | `packages/shared/src/db/types.ts` |
| Batch writer | `packages/shared/src/utils/batchWriter.ts` |
| Band metrics calc | `packages/shared/src/utils/bandMetrics.ts` |
| Polymarket handlers | `packages/polymarket-listener/src/websocket/handlers.ts` |
| Polymarket market sync | `packages/polymarket-listener/src/services/gammaApi.ts` |
| Kalshi handlers | `packages/kalshi-listener/src/websocket/handlers.ts` |
| Kalshi market sync | `packages/kalshi-listener/src/services/marketSync.ts` |
| Kalshi WS pool | `packages/kalshi-listener/src/websocket/pool.ts` |
| Polymarket WS pool | `packages/polymarket-listener/src/websocket/pool.ts` |
| Healthcheck main | `packages/healthcheck/src/index.ts` |
| Healthcheck checks | `packages/healthcheck/src/checks/` |
| Telegram alerting | `packages/healthcheck/src/alerting/telegram.ts` |
| Kalshi OrderBook Manager | `packages/kalshi-listener/src/state/orderBookManager.ts` |
| Polymarket OrderBook Manager | `packages/polymarket-listener/src/state/orderBookManager.ts` |
| Opinion handlers | `packages/opinion-listener/src/websocket/handlers.ts` |
| Opinion market sync | `packages/opinion-listener/src/services/marketSync.ts` |
| Opinion WS pool | `packages/opinion-listener/src/websocket/pool.ts` |
| Opinion OrderBook Manager | `packages/opinion-listener/src/state/orderBookManager.ts` |
| Predict market sync | `packages/predict-listener/src/services/marketSync.ts` |
| Predict cross-mapping | `packages/predict-listener/src/services/crossMapping.ts` |
| Predict config | `packages/predict-listener/src/config.ts` |

## Database

- **Schema**: `direct_exchanges_data`
- **Key Tables**: `prediction_markets`, `events`, `event_mappings`, `order_books`, `trades`, `market_latest_data`, `market_mappings`, `market_titles`
- **Connection**: Alibaba Cloud RDS PostgreSQL
- **Note**: `quotes` table exists but writes are disabled via `ENABLE_QUOTE_WRITES` flag (was 37GB)

## Development Commands

```bash
pnpm install          # Install dependencies
pnpm build            # Build all packages
pnpm dev:polymarket   # Run Polymarket listener in dev mode
pnpm dev:kalshi       # Run Kalshi listener in dev mode
pnpm dev:opinion      # Run Opinion listener in dev mode
pnpm dev:event-matcher # Run event matcher in dev mode
./deploy.sh           # Deploy to production server
```

## Deployment

- **Server**: 8.216.43.26 (Japan)
- **Path**: /opt/prediction-market-ingestion
- **Method**: `./deploy.sh` for Polymarket, `./deploy-kalshi.sh` for Kalshi, `./deploy-opinion.sh` for Opinion, `./deploy-predict.sh` for Predict, `./deploy-event-matcher.sh` for Event Matcher, `./deploy-homepage-api.sh` for Homepage API, `./deploy-healthcheck.sh` for Healthcheck

### When to Deploy

Deploy after completing any code changes that should go to production:
- New features
- Bug fixes
- Configuration changes

### How to Deploy

1. **Commit and push changes to GitHub** (deploy.sh pulls from origin/main)
2. **Run database migrations if needed** (from server, see below)
3. **Run deploy script**:
   ```bash
   ./deploy.sh            # Deploy Polymarket listener
   ./deploy-kalshi.sh     # Deploy Kalshi listener
   ./deploy-opinion.sh    # Deploy Opinion listener
   ./deploy-predict.sh    # Deploy Predict listener
   ./deploy-event-matcher.sh # Deploy event matcher service
   ./deploy-homepage-api.sh  # Deploy homepage API + arb scanner
   ./deploy-healthcheck.sh # Deploy healthcheck service
   ```

The deploy scripts will:
- SSH to the Japan server
- Pull latest code from GitHub
- Build Docker containers
- Restart the respective listener service

### Running Database Migrations

Database migrations must be run from the server (local machine cannot reach the DB):

```bash
# SSH to server first
ssh root@8.216.43.26

# Run migration
PGPASSWORD='HAH2#mwzay_8a' psql -h pgm-0iwbjigj740ve1e5.pgsql.japan.rds.aliyuncs.com -U direct_exchanges -d direct_exchanges -c "
<your SQL migration here>
"
```

### Verify Deployment

After deploying, verify the service is running:
```bash
ssh root@8.216.43.26 "docker compose -f /opt/prediction-market-ingestion/docker-compose.yml logs --tail 50 polymarket-listener"
```

## Feature Requests

**New features are defined in the `features/` folder.**

When implementing a new feature:
1. Read the feature file in `features/` folder
2. Validate the algorithm/logic if it's a calculation feature
3. Create an implementation plan
4. Implement incrementally, testing each step
5. Deploy and verify with the provided SQL queries

## Coding Standards

1. **TypeScript**: Use strict types, avoid `any`
2. **Batch Operations**: Use BatchWriter for database writes
3. **Error Handling**: Use retry with exponential backoff for transient errors
4. **Logging**: Use pino logger with structured logs
5. **Testing**: Verify with SQL queries after deployment

## Common Tasks

### Add a new database column
1. Run SQL migration on server (via psql)
2. Update types in `packages/shared/src/db/types.ts`
3. Update queries in `packages/shared/src/db/queries.ts`
4. Update handlers to populate the new field
5. Deploy and verify

### Add a new calculated metric
1. Read the PRD/feature spec
2. Create utility function for calculation
3. Add to appropriate handler or create new service
4. Store results in appropriate table
5. Deploy and verify

### Debug production issues
```bash
# SSH to server
ssh root@8.216.43.26

# View logs
docker compose logs -f polymarket-listener

# Query database
PGPASSWORD='HAH2#mwzay_8a' psql -h pgm-0iwbjigj740ve1e5.pgsql.japan.rds.aliyuncs.com -U direct_exchanges -d direct_exchanges
```

### Arb Monitor (Telegram)

A server-side cron job (`/opt/arb-monitor.sh`) queries the active arb count every 5 minutes and sends it to the "One pager monitoring" Telegram group with trend info. History is kept in `/opt/arb-monitor-history.txt` (last 12 entries).

```bash
# Stop the monitor
ssh root@8.216.43.26 "crontab -l | grep -v arb-monitor | crontab -"

# Restart it
ssh root@8.216.43.26 '(crontab -l 2>/dev/null | grep -v arb-monitor; echo "*/5 * * * * /opt/arb-monitor.sh") | crontab -'

# Check history
ssh root@8.216.43.26 "cat /opt/arb-monitor-history.txt"
```

## Feature Flags

| Flag | Default | Description |
|------|---------|-------------|
| `ENABLE_QUOTE_WRITES` | `false` | Enable writing to quotes table (disabled to save storage) |
| `ENABLE_PHASE2` | `true` (prod: `false`) | Enable Phase 2 cross-event market matching in event-matcher |

## Current Features

### Event Ingestion

All listeners ingest event-level data alongside market data during each sync cycle. Events are stored in the `events` table.

**Data flow:**
- **Kalshi**: Events extracted from `GET /events?with_nested_markets=true&status=open` response (same API call that fetches markets)
- **Polymarket**: Events fetched from `GET /events?active=true&closed=false` with nested markets. This unified fetch replaces the previous separate `/markets` + `/events` calls.
- **Predict**: Events and markets fetched from `GET /v1/categories?status=OPEN` (paginated). Each category = event, with nested markets. Open markets extracted from the category response.

**Database:**
- Table: `direct_exchanges_data.events`
- Primary key: `(source_id, exchange_id, event_id)`
- Stale events (not refreshed during sync) are automatically marked as `Closed`

**Key queries:**
```sql
-- Event counts by exchange
SELECT exchange_id, status, COUNT(*), AVG(market_count)::int as avg_markets
FROM direct_exchanges_data.events
GROUP BY exchange_id, status
ORDER BY exchange_id, status;

-- Recent events
SELECT exchange_id, event_id, title, category, market_count, updated_at
FROM direct_exchanges_data.events
WHERE status = 'Open'
ORDER BY updated_at DESC
LIMIT 20;
```

See `features/2026-03-03-event-level-matching/` for full documentation.

**Legacy matching data:** The `market_mappings` and `market_titles` tables remain with existing data (used by homepage-api). The `market-matcher` service has been removed — event-level matching has replaced it (see below).

### Event Matching

The `event-matcher` service runs a three-phase matching pipeline every 5 minutes:

```
Phase 1: Event-level matching (Kalshi↔Polymarket)
    └─► Inline market matching for newly matched event pairs
Phase 1.5: (NOT YET IMPLEMENTED) Re-match markets in existing event pairs
Phase 2: Cross-event market matching for remaining unmatched markets (DISABLED via ENABLE_PHASE2=false)
```

#### Phase 1: Event Matching

Runs every 5 min (configurable via `MATCHER_INTERVAL_MS`):

1. Fetch open events from both exchanges (sorted by volume DESC)
2. Skip already-matched events (checked against `event_mappings`)
3. Skip events checked within the last 24h with no match (`match_checked_at`, configurable via `MATCHER_RECHECK_INTERVAL_MS`)
4. Apply minimum volume filter if configured
5. Launch concurrent workers (default 20, configurable via `MATCHER_CONCURRENCY`)
6. Each worker picks next unmatched Kalshi event, runs keyword pre-filtering to find top candidates from Polymarket, then sends to OpenAI for semantic comparison
7. On match: write to `event_mappings` (2 rows per match, linked by `canonical_event_id`), then immediately match markets within the event pair (see Market-Within-Event Matching below)
8. On no match: update `match_checked_at` so the event is skipped for 24h before retrying
9. Rate limiting uses OpenAI response headers (`x-ratelimit-remaining-*`, `x-ratelimit-limit-*`); workers gate when 90% of RPM or TPM capacity is used

**Pre-filtering (`preFilter.ts`):**
- Keyword extraction with synonym normalization (e.g., "win" → "victory", "cut" → "decrease")
- Entity extraction from Kalshi titles (text after " — " em-dash)
- Accent stripping (e.g., "Petró" → "Petro")
- Scores candidates by keyword overlap + entity bonus (+3 for entity match)

**Routine operation:** There is no separate "initial" vs "routine" mode. The service runs the same cycle continuously. On first run, most events are unmatched so the cycle processes many events. In steady state, only newly-appeared events (from either exchange) are eligible — they get picked up in the next 5-minute cycle, matched against the other exchange, and if an event match is found, markets are matched inline immediately. Previously-checked events with no match are rechecked after 24h in case new counterparts appeared.

**Database:**
- Table: `direct_exchanges_data.event_mappings`
- Primary key: `(source_id, exchange_id, event_id)`
- Key columns: `canonical_event_id` (links matched pairs), `confidence_score`, `model_id`

**Key queries:**
```sql
-- Matched event pairs
SELECT a.event_id as kalshi_event, ka.title as kalshi_title,
       b.event_id as poly_event, pa.title as poly_title,
       a.confidence_score
FROM direct_exchanges_data.event_mappings a
JOIN direct_exchanges_data.event_mappings b
  ON a.canonical_event_id = b.canonical_event_id
JOIN direct_exchanges_data.events ka
  ON a.source_id = ka.source_id AND a.exchange_id = ka.exchange_id AND a.event_id = ka.event_id
JOIN direct_exchanges_data.events pa
  ON b.source_id = pa.source_id AND b.exchange_id = pa.exchange_id AND b.event_id = pa.event_id
WHERE a.exchange_id = 'KALSHI' AND b.exchange_id = 'POLYMARKET'
ORDER BY a.confidence_score DESC;
```

#### Market-Within-Event Matching

Market matching runs inline immediately after each event match via `matchMarketsForSinglePair()`. **Important: this only runs once when the event pair is first created. There is no periodic re-matching for existing event pairs.** If markets are added after the event match, or the initial matching fails, those markets will only be picked up by Phase 2 cross-event matching.

**Four-tier matching:**
1. **Binary (1:1)**: If exactly 1 market on each side, auto-match at confidence 1.0, `model_id = 'algorithmic-v1'`
2. **Substring matching (primary)**: Extract outcome name after " — " from Kalshi titles (e.g., "Will Seattle win? — Seattle" → "Seattle"), substring match against Polymarket titles. Handles tie/draw synonyms. `model_id = 'substring-v1'`
3. **Jaccard >= 0.85 (fallback)**: Auto-accept via greedy matching on remaining unmatched markets, `model_id = 'algorithmic-v1'`
4. **Jaccard 0.3–0.85 (fallback)**: AI verification via `verifyMarketMatch()`, accepted if AI confidence >= 0.8, `model_id = 'ai-verified-v1'`

Writes to `market_mappings` (4 rows: YES+NO per exchange) and `market_titles`.

See `features/2026-03-05-substring-market-matching/` and `features/2026-03-04-market-within-event-matching/` for full documentation.

#### Phase 2: Cross-Event Market Matching (Currently Disabled)

**Status:** Disabled in production via `ENABLE_PHASE2=false` (docker-compose.yml defaults to `true`, but production overrides to `false`). Can be re-enabled by setting `ENABLE_PHASE2=true`.

After Phase 1, Phase 2 picks up Kalshi markets that remain unmatched — either because their event wasn't matched, or because inline market matching within a matched event pair missed them.

**Strategy (`crossEventMatcher.ts`):**
1. Fetch all unmatched Kalshi YES markets (filtered by `phase2_checked_at` — skip if checked within 24h)
2. Extract entity name from each market title (text after " — ")
3. Filter out invalid entities (numeric values, thresholds like "above 80%", ranges, etc.) via `isValidEntity()`
4. Group markets by normalized entity to avoid redundant searches
5. For each unique entity, search Polymarket DB for markets containing that entity name (`searchPolymarketMarketsByEntity`)
6. Build a work queue of (Kalshi market, Polymarket candidates) pairs
7. Run concurrent AI verification workers (default 100, configurable via `MATCHER_PHASE2_CONCURRENCY`)
8. Each worker verifies up to 5 candidates per item (`Promise.all`), picks best match with confidence >= 0.8
9. Write `market_mappings` for confirmed matches, `model_id = 'cross-event-ai-v1'`
10. Mark each market as checked immediately (`phase2_checked_at` column) so restarts don't reprocess

**Rate limiting:** Same header-based limiter as Phase 1. Gate is capped at 60s max to prevent stalls from anomalous reset headers.

**Key files:**
- `packages/event-matcher/src/services/crossEventMatcher.ts` — Phase 2 logic
- `packages/event-matcher/src/services/aiComparer.ts` — OpenAI calls with rate limiting
- `packages/event-matcher/src/services/preFilter.ts` — Entity extraction, synonym normalization, accent stripping
- `packages/event-matcher/src/services/marketMatcher.ts` — Phase 1 inline market matching
- `packages/event-matcher/src/services/matchingCycle.ts` — Orchestrates all phases

**Known limitation:** Markets within already-matched event pairs are only matched once (at event match time). If markets are added later or the initial matching was incomplete, they rely on Phase 2 cross-event matching which is less efficient (entity search + AI verification instead of direct substring/Jaccard matching within a known event pair).

**Environment variables:**
| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | (required) | OpenAI API key |
| `OPENAI_MODEL` | `gpt-5-nano` | Model for event/market comparison |
| `MATCHER_CONCURRENCY` | `20` | Phase 1 concurrent event-matching workers |
| `ENABLE_PHASE2` | `true` | Enable Phase 2 cross-event matching (currently `false` in production) |
| `MATCHER_PHASE2_CONCURRENCY` | `100` | Phase 2 concurrent market-matching workers |
| `MATCHER_INTERVAL_MS` | `300000` | Cycle interval (5 min) |
| `MATCHER_CONFIDENCE_THRESHOLD` | `0.85` | Min confidence for event match |
| `MATCHER_CANDIDATES_PER_BATCH` | `10` | Max Polymarket candidates per AI event comparison |
| `MATCHER_MIN_EVENT_VOLUME` | `0` | Min total volume to consider for event matching |
| `MATCHER_RECHECK_INTERVAL_MS` | `86400000` | Recheck interval for unmatched events (24h) |
| `MARKET_MATCH_THRESHOLD` | `0.85` | Jaccard auto-accept threshold for market matching |
| `MARKET_MATCH_AI_THRESHOLD` | `0.3` | Min Jaccard to trigger AI verification for borderline matches |

### Predict Integration

Predict.fun provides API-provided links to Kalshi and Polymarket markets. The `predict-listener` fetches data and creates cross-exchange mappings automatically.

**Data fetching:** `GET /v1/categories?status=OPEN` (paginated). Each category = event, with nested markets containing `kalshiMarketTicker` and `polymarketConditionIds` fields.

**Cross-exchange mapping** (`packages/predict-listener/src/services/crossMapping.ts`):
During each sync cycle, the predict-listener:
1. Reads `kalshiMarketTicker` and `polymarketConditionIds` from each Predict market
2. Looks up the corresponding Kalshi/Polymarket market in the DB
3. Checks if either market already belongs to a canonical group (`findExistingCanonicalMarketId()`) for transitive grouping
4. Creates `market_mappings` entries with `model_id = 'predict-api-link-v1'`, `confidence_score = 1.0`
5. Uses hash-based canonical IDs (`CM-<hash>`) consistent with event-matcher format

**Environment variables:**
| Variable | Default | Description |
|----------|---------|-------------|
| `PREDICT_REST_URL` | `https://api.predict.fun` | REST API URL |
| `PREDICT_WS_URL` | `wss://ws.predict.fun/ws` | WebSocket URL |
| `PREDICT_API_KEY` | (optional) | API key |
| `PREDICT_MARKETS_PER_SOCKET` | `500` | Max markets per WebSocket |
| `ENABLE_CROSS_MAPPING` | `true` | Enable cross-exchange market mapping |

### Outcome Side Tracking
All market data records include an `outcome_side` field ('YES' or 'NO') to distinguish between the two sides of binary prediction markets:

**Kalshi:**
- Each market ticker represents a single question with YES/NO outcomes
- The listener emits **two records per update** (one YES, one NO)
- YES uses raw prices, NO uses inverted prices (100 - price for cents, 1 - price for decimal)
- Order books: YES orders become YES bids, NO orders become NO bids; cross-side orders become asks

**Polymarket:**
- Each token/asset represents one outcome (either YES or NO)
- The `outcome_side` is cached from the Gamma API market sync
- If cache miss occurs, records are skipped (not written as UNKNOWN)

### Price Normalization
All prices are normalized to decimal (0-1) across all exchanges.

**Kalshi:**
- Kalshi API returns prices in **cents (0-100)** — all values must be divided by 100
- **NEW (2026-03):** Kalshi WS trade messages now use **string dollar fields** (`yes_price_dollars`, `no_price_dollars`) instead of numeric cent fields (`yes_price`, `price`). The handler parses both formats with fallback.
- `prediction_markets.price`: Uses `last_price / 100` (last executed trade price), falls back to `yes_bid / 100`
- `trades.price`: Uses `yes_price_dollars` (string, already decimal) or falls back to `yes_price / 100` (legacy cents)
- `trades.quantity`: Uses `count_fp` (string like `"808.00"`) or falls back to `count` (legacy number), defaults to 1
- `market_latest_data.price_close`: Uses `last_price` from WebSocket ticker (raw cents, NOT divided — stored as cents)
- Order book prices: Stored in cents (0-100) in the `order_books` table, normalized to decimal for band metrics calculation

**Polymarket:**
- Polymarket API returns prices in **decimal (0-1)** — no conversion needed
- `prediction_markets.price`: Uses `outcomePrices[i]` from Gamma API
- `trades.price`: Uses `price` from WebSocket `last_trade_price` event

**Opinion.trade:**
- Opinion API returns prices as **decimal strings (0-1)** — `parseFloat()`, no division needed
- All WS message prices are decimal strings
- Order book prices stored in decimal (0-1), same as band metrics

### OrderBook Delta Accumulation
All three exchanges use **delta accumulation** — maintaining in-memory orderbook state and applying incremental updates.

**Kalshi** (`packages/kalshi-listener/src/state/orderBookManager.ts`):
- Maintains in-memory state per market (YES bids, NO bids as Maps)
- Subscribes to `orderbook_delta` channel, which sends an `orderbook_snapshot` on subscription then `orderbook_delta` messages continuously
- Prices in cents (0-100) internally; new API also sends string dollar fields (`yes_dollars_fp`, `price_dollars`, `delta_fp`) which are parsed with `parseFloat()`
- `applySnapshot()`: Replaces entire book (initial `orderbook_snapshot` message)
- `applyDelta()`: Updates single price level (subsequent `orderbook_delta` messages)
- `getOrderBook()`: Returns full accumulated state for DB write
- Note: many low-volume Kalshi markets may not receive any orderbook delta for 15+ minutes, causing them to appear "stale" to the arb scanner

**Polymarket** (`packages/polymarket-listener/src/state/orderBookManager.ts`):
- Maintains in-memory state per asset (bids, asks as Maps, keyed by assetId)
- `book` messages: full orderbook snapshots — stored via `applySnapshot()`, only sent at subscription time and occasionally on trades
- `price_change` messages: orderbook deltas with `changes` array containing `{price, side, size}` — applied via `applyDelta()`, then full book is reconstructed and band metrics recalculated
- Prices are decimal (0-1), no conversion needed
- In steady state, **100% of messages are `price_change`** — without delta accumulation, band metrics would go stale after the initial snapshot ages out

**Opinion.trade** (`packages/opinion-listener/src/state/orderBookManager.ts`):
- Same delta accumulation pattern, keyed by `${marketId}:${outcomeSide}` since Opinion messages include outcome side
- Opinion sends `market.depth.diff` with individual level changes
- Prices are already decimal (0-1), no conversion needed for band metrics

**Database constraints:**
- `market_latest_data` unique key: `(source_id, exchange_id, market_id, outcome_side)`
- `order_books` unique key: `(source_id, exchange_id, market_id, outcome_side, time_exchange)`

### Band Metrics (market_latest_data)
Calculates liquidity metrics within a price band around the reference price:
- `reference_price` - Midpoint of best bid/ask (clamped to VWAP band)
- `band_liquidity_qty_bid` - Total quantity on bid side within band
- `band_liquidity_qty_ask` - Total quantity on ask side within band
- `band_vwap_bid` - Volume-weighted average price for bids in band
- `band_vwap_ask` - Volume-weighted average price for asks in band
- `band_delta_used` - The delta/band width used (default 1%)

See `features/2026-02-04-band-metrics/` for full documentation.

### Healthcheck Service
Monitors system health and sends Telegram alerts:
- **Disk usage** - Warns at 70%, critical at 85%
- **Docker containers** - Alerts when kalshi-listener or polymarket-listener are down
- **Database connectivity** - Alerts on connection failures
- **Data flow** - Alerts when no trades/orderbook updates in last 5 minutes

Environment variables:
| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | (required) | Telegram bot token for alerts |
| `TELEGRAM_CHAT_ID` | (required) | Telegram chat ID for alerts |
| `HEALTHCHECK_INTERVAL_MS` | `60000` | Check interval (1 minute) |
| `DISK_WARNING_THRESHOLD` | `70` | Disk % for warning alert |
| `DISK_CRITICAL_THRESHOLD` | `85` | Disk % for critical alert |
| `DATA_FLOW_MIN_RECORDS` | `100` | Minimum records expected per check period |
| `DATA_FLOW_CHECK_MINUTES` | `5` | Time window for data flow check |
| `ALERT_COOLDOWN_MS` | `300000` | Cooldown between repeated alerts (5 min) |

### Arb Scanner

The `homepage-api` service runs an arb scanner on a 10-second loop. Configuration is stored in the `arb_config` DB table and reloaded every 30 cycles (~5 min).

**Current production config (2026-03-13):**
| Parameter | Value | Description |
|-----------|-------|-------------|
| `max_staleness_sec` | `900` | Max age of orderbook data before excluding a leg (15 min) |
| `min_arb_pct` | `0.01` | Minimum gross spread % to flag (1%) |
| `min_executable_qty` | `5` | Minimum contracts on both legs |
| `min_liquidity_usd` | `2` | Minimum gross profit USD |
| `min_confidence` | `0.95` | Minimum market_mappings confidence |
| `scan_interval_sec` | `10` | Scanner loop interval |
| `expire_grace_sec` | `902` | Grace period for arbs whose market was evaluated |
| `expire_long_grace_sec` | `600` | Grace period for arbs whose market could not be evaluated (stale legs) |
| `kalshi_fee_rate` | `0.07` | Kalshi fee rate (on profit) |
| `polymarket_fee_rate` | `0.02` | Polymarket taker fee rate |
| `default_fee_rate` | `0.01` | Default fee for unknown exchanges |

**Key files:**
- Scanner: `packages/homepage-api/src/services/arbScanner.ts`
- Queries: `packages/shared/src/db/queries.ts` (`fetchMatchedMarketLegs`, `upsertArbOpportunities`, `expireEvaluatedArbs`)
- Config: `arb_config` table in DB

**Tuning notes (2026-03-13 investigation):**
- `max_staleness_sec` was increased from 120→900 because Kalshi low-volume markets may not receive orderbook deltas for 15+ minutes. At 120s, only ~12 markets had both legs fresh simultaneously.
- `min_arb_pct` was lowered from 0.02→0.01 because real spreads are typically 1-1.5%.
- `updated_at` in `market_latest_data` only refreshes when `band_delta_used IS NOT NULL` (orderbook updates), not on price-only updates. This is correct — arbs require fresh band metrics.

**Steady-state arb count (2026-03-14):**
- After Kalshi restart: ~346 arbs (all markets have fresh snapshots)
- Steady state: ~200-260 arbs (low-volume Kalshi markets age past 15 min without orderbook updates)
- The arb count is bottlenecked by Kalshi freshness — only ~35% of matched Kalshi legs stay fresh within `max_staleness_sec` (900s). Polymarket stays at ~99% freshness thanks to delta accumulation from `price_change` messages.
- The post-restart spike then decay to steady state is expected behavior, not a bug.

## Important Notes

- **Partition management**: Script creates/drops partitions every 5 minutes (`/opt/manage-partitions.sh`): order_books (hourly, 4h retention), trades (daily, 48h retention)
- Polymarket has a **500 assets per WebSocket** limit - uses pool (configurable via `MARKETS_PER_SOCKET`)
- Kalshi has a **~2000 subscriptions per WebSocket** limit - uses pool (configurable via `KALSHI_MARKETS_PER_SOCKET`)
- All three exchanges use **WebSocket pools** to handle all active markets (~27k Kalshi, ~19k Polymarket, Opinion TBD)
- Opinion.trade has a **~200 markets per WebSocket** starting limit (configurable via `OPINION_MARKETS_PER_SOCKET`)
- Always use **batch writes** for performance
- **Sort by market_id** before batch insert to prevent deadlocks
- **Include outcome_side** in deduplication keys for batch operations (market_id alone is not unique)
- Kalshi requires **API key + private key** authentication (RSA-PSS headers per connection)
- Market sync happens every **5 minutes** by default

## Server Credentials

- **IP**: 8.216.43.26
- **Username**: root
- **Password**: n9Y#5df_tu39ko
- **Port**: 22
