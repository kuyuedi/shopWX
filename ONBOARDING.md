# Onboarding Guide: Building a New Exchange Integration

This guide is for teams building a new prediction market exchange integration that writes data into our shared PostgreSQL database. Your service will live in a **separate repository** but must follow the conventions below so data is compatible with the existing system.

---

## Table of Contents

1. [Using Claude Code for Development](#using-claude-code-for-development)
2. [System Architecture Overview](#system-architecture-overview)
3. [Database Schema](#database-schema)
4. [What Your Service Must Implement](#what-your-service-must-implement)
5. [Data Conventions](#data-conventions)
6. [Implementation Patterns](#implementation-patterns)
7. [Deployment](#deployment)
8. [Checklist](#checklist)

---

## Using Claude Code for Development

Claude Code is Anthropic's CLI tool for AI-assisted development. It can read your codebase, write code, run commands, and help you implement features.

### Installation

```bash
npm install -g @anthropic-ai/claude-code
```

### Getting Started

```bash
# Navigate to your project root
cd /path/to/your-exchange-listener

# Start Claude Code
claude
```

### Key Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Clear conversation context |
| `/compact` | Compress conversation to save context |

### Tips for Effective Use

1. **Create a `CLAUDE.md` file** at your project root. Claude Code reads this automatically on every session. Include:
   - Project overview and architecture
   - Key file locations
   - Development commands (`pnpm install`, `pnpm build`, `pnpm test`)
   - Database schema and connection info
   - Deployment instructions
   - Coding standards

2. **Use a `features/` folder** for feature specs. Create a subfolder per feature with:
   - `requirements.md` — what to build, acceptance criteria
   - `technical.md` — implementation details, DB migrations, code changes
   - `usage.md` — verification queries, troubleshooting

3. **Let Claude Code explore first**. When starting a new task, tell it to read the relevant files before writing code. Example: "Read the Polymarket handler to understand the pattern, then implement the same for our exchange."

4. **Incremental implementation**. Break work into steps: implement, test, deploy, verify. Don't try to build everything at once.

5. **Provide example API responses**. When integrating a new exchange API, paste sample WebSocket messages or REST responses so Claude Code can understand the data format.

6. **Use plan mode for complex features**. Claude Code can create implementation plans before writing code. This is useful for multi-file changes.

---

## System Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Your Exchange  │     │  Kalshi API     │     │  Polymarket API │
│  API            │     │                 │     │                 │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  your-listener  │     │ kalshi-listener │     │polymarket-lstnr │
│  (your repo)    │     │                 │     │                 │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         └───────────────┬───────┴───────────────────────┘
                         │
                  ┌──────▼──────┐
                  │  PostgreSQL │
                  │  (shared)   │
                  └─────────────┘
```

Each exchange listener is an independent service that:
1. Fetches market metadata via REST API (every 5 minutes)
2. Subscribes to real-time updates via WebSocket (order books, trades, ticker)
3. Writes normalized data to the shared PostgreSQL database

---

## Database Schema

**Schema**: `direct_exchanges_data`

### Tables Your Service Must Write To

#### 1. `prediction_markets` — Market metadata

Synced from REST API every 5 minutes. One row per market per outcome side.

```sql
-- Key columns (not exhaustive)
source_id         VARCHAR(255)   -- Your unique source identifier, e.g. 'BETFAIR_DIRECT'
exchange_id       VARCHAR(255)   -- Exchange name, e.g. 'BETFAIR'
market_id         VARCHAR(255)   -- Exchange-specific market identifier
event_id          VARCHAR(255)   -- Groups related markets under one event
series_id         VARCHAR(255)   -- Groups events in a recurring series
outcome_side      VARCHAR(10)    -- 'YES' or 'NO'
outcome_name      VARCHAR(255)   -- Human-readable: 'Yes', 'No', or named outcome
outcome_type      VARCHAR(50)    -- 'Binary', 'Scalar', or 'MultipleChoice'
title             TEXT           -- Market question/title
sub_title         TEXT           -- Outcome bracket label (e.g., 'Above 300,000')
rules_primary     TEXT           -- Resolution rules
rules_secondary   TEXT           -- Additional resolution rules
category          VARCHAR(255)   -- Market category (e.g., 'Politics', 'Sports')
price             NUMERIC        -- Latest price, normalized to decimal 0-1
expires_at        TIMESTAMPTZ    -- When the market expires/resolves
status            VARCHAR(50)    -- 'Open', 'Closed', 'Resolved', 'Cancelled'
source_specific_data JSONB       -- Exchange-specific fields that don't fit the schema

-- Unique key
UNIQUE (source_id, exchange_id, market_id, outcome_side)
```

#### 2. `order_books` — Order book snapshots

Written from WebSocket in real-time. Partitioned by hour, 4-hour retention.

```sql
source_id         VARCHAR(255)
exchange_id       VARCHAR(255)
market_id         VARCHAR(255)
outcome_side      VARCHAR(10)    -- 'YES' or 'NO'
bids              JSONB          -- Array of {price, quantity} objects
asks              JSONB          -- Array of {price, quantity} objects
time_exchange     TIMESTAMPTZ    -- Timestamp from the exchange
time_recorded     TIMESTAMPTZ    -- When we received it

-- Unique key
UNIQUE (source_id, exchange_id, market_id, outcome_side, time_exchange)
```

#### 3. `trades` — Individual trade executions

Written from WebSocket in real-time. Partitioned by day, 48-hour retention.

```sql
source_id         VARCHAR(255)
exchange_id       VARCHAR(255)
market_id         VARCHAR(255)
trade_id          VARCHAR(255)   -- Exchange-specific trade identifier
price             NUMERIC        -- Normalized to decimal 0-1
quantity          NUMERIC        -- Number of contracts
side              VARCHAR(10)    -- 'Buy' or 'Sell'
outcome           VARCHAR(10)    -- 'YES' or 'NO'
time_exchange     TIMESTAMPTZ    -- Trade timestamp from exchange
time_recorded     TIMESTAMPTZ    -- When we received it
```

#### 4. `market_latest_data` — Latest OHLCV + liquidity metrics

One row per market per outcome side, updated on every tick/orderbook update.

```sql
source_id              VARCHAR(255)
exchange_id            VARCHAR(255)
market_id              VARCHAR(255)
outcome_side           VARCHAR(10)
price_open             NUMERIC
price_high             NUMERIC
price_low              NUMERIC
price_close            NUMERIC
volume_traded          NUMERIC
trades_count           INTEGER
reference_price        NUMERIC      -- Midpoint of best bid/ask
band_liquidity_qty_bid NUMERIC      -- Total bid quantity within band
band_liquidity_qty_ask NUMERIC      -- Total ask quantity within band
band_vwap_bid          NUMERIC      -- Volume-weighted avg bid price in band
band_vwap_ask          NUMERIC      -- Volume-weighted avg ask price in band
band_delta_used        NUMERIC      -- Band width (default 1%)
entry_time             TIMESTAMPTZ
updated_at             TIMESTAMPTZ

-- Unique key
UNIQUE (source_id, exchange_id, market_id, outcome_side)
```

---

## What Your Service Must Implement

### 1. Market Sync (REST API → `prediction_markets`)

Fetch all active markets from the exchange REST API and upsert them into `prediction_markets`.

**Requirements:**
- Run every 5 minutes (configurable via `MARKET_REFRESH_INTERVAL_MS`)
- Handle pagination (exchanges may have thousands of markets)
- Populate the **4-level hierarchy**: `category` → `series_id` → `event_id` → `market_id`
- Populate `sub_title` with outcome bracket labels if available
- Set `outcome_side` to 'YES' or 'NO' for each record
- After upserting, mark stale markets as 'Closed' (markets that disappeared from the API)
- Use batch upserts (not individual inserts) for performance

**Example flow:**
```
1. Record syncStartTime
2. Fetch all active markets from REST API (paginated)
3. Normalize each market to standard schema
4. Batch upsert to prediction_markets
5. Mark stale: UPDATE status='Closed' WHERE status='Open' AND updated_at < syncStartTime
```

### 2. Real-Time Data (WebSocket → `order_books`, `trades`, `market_latest_data`)

Subscribe to WebSocket feeds for all active markets and write updates in real-time.

**Requirements:**
- Use a **WebSocket connection pool** if the exchange limits subscriptions per connection
- Write order books, trades, and ticker/OHLCV data as they arrive
- Use **batch writers** (buffer items, flush every 100 items or 100ms)
- Emit **two records per market** for binary markets (YES and NO sides)
- Calculate **band metrics** for `market_latest_data` (use the shared `calculateBandMetrics()` function)
- Reshard the connection pool every 5 minutes when market list changes

**Data to capture per WebSocket message type:**

| Message Type | Write To | Key Fields |
|-------------|----------|------------|
| Order book snapshot/update | `order_books` + `market_latest_data` | Full bid/ask arrays, band metrics |
| Trade execution | `trades` + `market_latest_data` | price, quantity, side, OHLCV update |
| Ticker/price update | `market_latest_data` | price_close, volume |

### 3. Graceful Lifecycle

**Requirements:**
- Validate database connection on startup (`healthCheck()`)
- Handle SIGTERM/SIGINT for graceful shutdown
- Close WebSocket connections and flush batch writers before exit
- Log structured JSON using pino logger
- Recover from transient errors (DB connection drops, WebSocket disconnects)

---

## Data Conventions

### Price Normalization

**All prices must be stored as decimal values between 0 and 1.**

| Exchange Example | Raw Format | Stored Format |
|-----------------|-----------|--------------|
| Kalshi | 65 (cents) | 0.65 |
| Polymarket | 0.65 (decimal) | 0.65 |
| Your exchange | Convert to 0-1 | 0.65 |

### Outcome Side (YES/NO)

Every binary market must produce **two records** — one for YES, one for NO.

- **YES side**: Use the raw price from the exchange
- **NO side**: Use inverted price (1 - price)
- Order books: YES bids become YES bids; NO bids become NO bids; cross-side orders become asks

This is critical — `market_id` alone is NOT unique. The composite key is always `(source_id, exchange_id, market_id, outcome_side)`.

### Source and Exchange IDs

Define two constants for your exchange:

```typescript
export const YOUR_SOURCE_ID = 'YOUR_EXCHANGE_DIRECT';   // Data source identifier
export const YOUR_EXCHANGE_ID = 'YOUR_EXCHANGE';         // Exchange name
```

These must be consistent across all records from your service.

### Sorting Before Batch Insert

**Always sort records by `market_id` before batch inserting** to prevent database deadlocks when multiple writers operate concurrently.

### Timestamps

- Use the exchange's timestamp when available (`time_exchange`)
- Record your own receipt time as `time_recorded`
- All timestamps in UTC

---

## Implementation Patterns

### Recommended Project Structure

```
your-exchange-listener/
├── package.json
├── tsconfig.json
├── Dockerfile
├── CLAUDE.md                    # Claude Code instructions
├── features/                    # Feature specifications
├── src/
│   ├── index.ts                 # Entry point: init, refresh loop, shutdown
│   ├── config.ts                # Environment variable loading and validation
│   ├── constants.ts             # SOURCE_ID, EXCHANGE_ID constants
│   ├── services/
│   │   └── marketSync.ts        # REST API fetching, market normalization, upsert
│   ├── transformers/
│   │   └── normalize.ts         # Exchange-specific → standard type conversion
│   ├── websocket/
│   │   ├── client.ts            # Single WebSocket connection wrapper
│   │   ├── pool.ts              # Connection pool (sharding across connections)
│   │   └── handlers.ts          # Message parsing → batch writer
│   └── __tests__/               # Unit tests
└── deploy.sh                    # Deployment script
```

### Entry Point Pattern (`index.ts`)

```typescript
import 'dotenv/config';

async function main() {
  // 1. Validate DB connection
  // 2. Initial market sync
  // 3. Create WebSocket pool, subscribe to all markets
  // 4. Set up refresh interval (5 min): re-sync markets, reshard pool
  // 5. Set up cleanup interval: delete old closed markets
  // 6. Install SIGTERM/SIGINT handlers
}

async function shutdown(signal: string) {
  // 1. Clear intervals
  // 2. Close WebSocket pool
  // 3. Flush batch writers
  // 4. Close DB pool
  // 5. process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error('Fatal error', err);
  process.exit(1);
});
```

### Batch Writer Pattern

Buffer writes and flush periodically to avoid overwhelming the database:

```typescript
// Pseudo-code — implement or use a library
const orderBookWriter = new BatchWriter<OrderBook>({
  maxSize: 100,          // Flush at 100 items
  maxWaitMs: 100,        // Or flush every 100ms
  writeFn: insertOrderBooksBatch,
});

// In your WebSocket handler:
function onOrderBookMessage(msg) {
  const orderBook = normalizeOrderBook(msg);
  await orderBookWriter.add(orderBook);
}

// On shutdown:
await orderBookWriter.shutdown();  // Flush remaining items
```

### WebSocket Pool Pattern

Most exchanges limit subscriptions per connection. Shard across multiple connections:

```typescript
class WebSocketPool {
  private clients: WebSocketClient[] = [];

  async subscribeToMarkets(marketIds: string[]) {
    // Close existing connections
    await this.closeAll();

    // Chunk market IDs by exchange limit
    const chunks = chunkArray(marketIds, MARKETS_PER_SOCKET);

    // Create one connection per chunk
    for (const chunk of chunks) {
      const client = new WebSocketClient(wsUrl);
      client.subscribe(chunk);
      this.clients.push(client);
      await sleep(100);  // Stagger connections
    }
  }

  async closeAll() {
    await Promise.all(this.clients.map(c => c.close()));
    this.clients = [];
  }
}
```

### Market Sync Pattern

```typescript
async function syncMarkets() {
  const syncStartTime = new Date();

  // 1. Fetch all active markets (paginated)
  const rawMarkets = await fetchActiveMarkets();

  // 2. Normalize to standard types
  const markets: PredictionMarket[] = rawMarkets.flatMap(m => normalizeMarket(m));

  // 3. Batch upsert
  await upsertPredictionMarketsBatch(markets);

  // 4. Mark stale markets as closed
  await markStaleMarketsAsClosed(SOURCE_ID, EXCHANGE_ID, syncStartTime);

  // 5. Return market IDs for WebSocket subscription
  return markets.map(m => m.market_id);
}
```

### Band Metrics Calculation

When writing to `market_latest_data`, calculate band metrics from the order book:

```
1. Take the full order book (bids and asks)
2. Find the reference price = midpoint of best bid and best ask
3. Define a band = reference_price +/- 1% (configurable)
4. Sum all bid quantity within the band → band_liquidity_qty_bid
5. Sum all ask quantity within the band → band_liquidity_qty_ask
6. Calculate VWAP for bids in band → band_vwap_bid
7. Calculate VWAP for asks in band → band_vwap_ask
```

The existing system has a `calculateBandMetrics()` utility you can reference or port to your codebase.

---

## Deployment

### Docker

Use a multi-stage Dockerfile:

```dockerfile
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml package.json ./
RUN pnpm install --frozen-lockfile
COPY src/ src/
COPY tsconfig.json ./
RUN pnpm build

FROM base AS production
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
RUN pnpm install --frozen-lockfile --prod
ENV NODE_ENV=production
USER node
CMD ["node", "dist/index.js"]
```

### Environment Variables

Your service should accept these standard environment variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host/db` |
| `DB_SCHEMA` | Database schema | `direct_exchanges_data` |
| `DB_MAX_CONNECTIONS` | Connection pool size | `5` |
| `BATCH_SIZE` | Batch writer max items | `100` |
| `BATCH_INTERVAL_MS` | Batch writer flush interval | `100` |
| `MARKET_REFRESH_INTERVAL_MS` | Market sync interval | `300000` (5 min) |
| `MARKETS_PER_SOCKET` | Markets per WebSocket connection | Exchange-specific |
| `LOG_LEVEL` | Logging verbosity | `info` |

Plus exchange-specific variables (API keys, WebSocket URLs, etc.).

### Production Server

- **Server**: 8.216.43.26 (Japan)
- **Path**: `/opt/your-exchange-listener`
- **Method**: Docker Compose, same server as other listeners
- **Logging**: JSON format, 10MB max per file, 3 file rotation

### Deploy Script

Create a `deploy.sh` that:
1. Runs tests locally
2. SSHs to the server
3. Pulls latest code from GitHub
4. Builds Docker image
5. Restarts the container

---

## Checklist

### Before You Start

- [ ] Get database credentials (ask the team)
- [ ] Get exchange API credentials (keys, secrets)
- [ ] Understand the exchange's API: REST endpoints, WebSocket protocol, rate limits
- [ ] Understand the exchange's market model: How are markets identified? How are YES/NO sides represented?

### Implementation

- [ ] Define `SOURCE_ID` and `EXCHANGE_ID` constants
- [ ] Implement market sync (REST API → `prediction_markets`)
- [ ] Implement outcome side mapping (which token/asset = YES vs NO)
- [ ] Implement price normalization (exchange format → decimal 0-1)
- [ ] Implement WebSocket connection with pool if needed
- [ ] Implement order book handler → `order_books` + `market_latest_data`
- [ ] Implement trade handler → `trades` + `market_latest_data`
- [ ] Implement band metrics calculation for `market_latest_data`
- [ ] Implement batch writers for all write paths
- [ ] Sort records by `market_id` before batch insert
- [ ] Include `outcome_side` in all deduplication keys
- [ ] Implement stale market cleanup (mark as Closed after sync)
- [ ] Implement graceful shutdown (SIGTERM/SIGINT)
- [ ] Add structured logging (pino or similar)
- [ ] Write unit tests for normalizers and handlers
- [ ] Create Dockerfile and docker-compose.yml
- [ ] Create deploy script
- [ ] Create CLAUDE.md for your repo

### Verification

- [ ] Markets appear in `prediction_markets` with correct hierarchy (category, series_id, event_id)
- [ ] Both YES and NO sides are written for binary markets
- [ ] Prices are normalized to 0-1 range
- [ ] Order books are flowing into `order_books` table
- [ ] Trades are flowing into `trades` table
- [ ] `market_latest_data` has band metrics populated
- [ ] Stale markets get marked as Closed
- [ ] Service recovers from WebSocket disconnects
- [ ] Service shuts down gracefully on SIGTERM

### Verification SQL

```sql
-- Check markets are being ingested
SELECT COUNT(*), outcome_side
FROM direct_exchanges_data.prediction_markets
WHERE exchange_id = 'YOUR_EXCHANGE' AND updated_at > NOW() - INTERVAL '10 minutes'
GROUP BY outcome_side;

-- Check order books are flowing
SELECT COUNT(*)
FROM direct_exchanges_data.order_books
WHERE exchange_id = 'YOUR_EXCHANGE' AND time_recorded > NOW() - INTERVAL '5 minutes';

-- Check trades are flowing
SELECT COUNT(*)
FROM direct_exchanges_data.trades
WHERE exchange_id = 'YOUR_EXCHANGE' AND time_recorded > NOW() - INTERVAL '5 minutes';

-- Check market_latest_data has band metrics
SELECT market_id, outcome_side, reference_price, band_liquidity_qty_bid, band_liquidity_qty_ask
FROM direct_exchanges_data.market_latest_data
WHERE exchange_id = 'YOUR_EXCHANGE'
LIMIT 10;

-- Check price normalization (all prices should be 0-1)
SELECT MIN(price), MAX(price)
FROM direct_exchanges_data.prediction_markets
WHERE exchange_id = 'YOUR_EXCHANGE' AND price IS NOT NULL;
```
