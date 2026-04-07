# Prediction Market Ingestion - Architecture Document

## Overview

Real-time prediction market data ingestion system that connects to **Kalshi**, **Polymarket**, **Predict.fun**, and **Opinion.trade** exchanges via WebSocket APIs to ingest market data, trades, and order book updates into a PostgreSQL database. Includes cross-exchange **event matching**, **market matching**, and **arbitrage detection**.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      PREDICTION MARKET INGESTION                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌────────┐  ┌──────────┐  ┌─────────┐  ┌─────────┐  ┌────────────┐  │
│  │ Kalshi │  │Polymarket│  │ Predict │  │ Opinion │  │ PostgreSQL │  │
│  │Exchange│  │ Exchange │  │  .fun   │  │ .trade  │  │  Database  │  │
│  └───┬────┘  └────┬─────┘  └───┬─────┘  └───┬─────┘  └─────▲──────┘  │
│      │            │            │            │               │          │
│  ┌───▼────┐  ┌────▼─────┐  ┌───▼─────┐  ┌───▼─────┐       │          │
│  │ Kalshi │  │Polymarket│  │ Predict │  │ Opinion │       │          │
│  │Listener│  │ Listener │  │Listener │  │Listener │       │          │
│  └───┬────┘  └────┬─────┘  └───┬─────┘  └───┬─────┘       │          │
│      │            │            │            │               │          │
│      └────────────┼────────────┼────────────┘               │          │
│                   │            │                             │          │
│            ┌──────▼──────┐    │                             │          │
│            │   Shared    ├────┘─────────────────────────────┘          │
│            └──────┬──────┘                                             │
│                   │                                                     │
│      ┌────────────┼────────────┐                                       │
│  ┌───▼────────┐ ┌─▼─────────┐ ┌▼────────────┐                        │
│  │   Event    │ │  Homepage  │ │ Healthcheck │                        │
│  │  Matcher   │ │    API     │ │   Service   │                        │
│  │  (OpenAI)  │ │ (Arb Scan) │ │ (Telegram)  │                        │
│  └────────────┘ └────────────┘ └─────────────┘                        │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Package Structure

```
prediction-market-ingestion/
├── packages/
│   ├── shared/                    # Shared utilities & database
│   │   ├── src/
│   │   │   ├── db/               # Database client & queries
│   │   │   ├── types/            # TypeScript interfaces
│   │   │   └── utils/            # Logger, batch writer, retry, cache, band metrics
│   │   └── package.json
│   │
│   ├── kalshi-listener/           # Kalshi exchange listener
│   │   ├── src/
│   │   │   ├── websocket/        # WS pool, handlers (ticker, orderbook, trade)
│   │   │   ├── services/         # Market sync service
│   │   │   ├── state/            # OrderBookManager (delta accumulation)
│   │   │   ├── transformers/     # Data normalization
│   │   │   └── index.ts          # Entry point
│   │   └── Dockerfile
│   │
│   ├── polymarket-listener/       # Polymarket exchange listener
│   │   ├── src/
│   │   │   ├── websocket/        # WS pool, client, handlers
│   │   │   ├── services/         # Gamma API service
│   │   │   ├── state/            # OrderBookManager (delta accumulation)
│   │   │   └── transformers/     # Data normalization
│   │   └── Dockerfile
│   │
│   ├── opinion-listener/          # Opinion.trade exchange listener
│   │   ├── src/
│   │   │   ├── websocket/        # WS pool, handlers
│   │   │   ├── services/         # Market sync service
│   │   │   ├── state/            # OpinionOrderBookManager
│   │   │   └── index.ts
│   │   └── Dockerfile
│   │
│   ├── predict-listener/           # Predict.fun exchange listener + cross-mapping
│   │   ├── src/
│   │   │   ├── websocket/        # WS pool, client, handlers
│   │   │   ├── services/         # Market sync, cross-exchange mapping
│   │   │   ├── state/            # OrderBookManager (delta accumulation)
│   │   │   ├── transformers/     # Data normalization
│   │   │   ├── types/            # Predict API types
│   │   │   └── index.ts
│   │   └── Dockerfile
│   │
│   ├── event-matcher/             # Cross-exchange event & market matching
│   │   ├── src/
│   │   │   ├── services/         # OpenAI matching, keyword pre-filter
│   │   │   └── index.ts
│   │   └── Dockerfile
│   │
│   ├── homepage-api/              # REST API + arb scanner
│   │   ├── src/
│   │   │   ├── routes/           # API endpoints
│   │   │   ├── services/         # Arb scanner service
│   │   │   └── index.ts
│   │   └── Dockerfile
│   │
│   └── healthcheck/               # System monitoring + Telegram alerts
│       ├── src/
│       │   ├── checks/           # Disk, containers, DB, data flow checks
│       │   └── alerting/         # Telegram integration
│       └── Dockerfile
│
├── docs/                          # Documentation
├── features/                      # Feature specifications
├── scripts/                       # Backfill & seed scripts
├── migrations/                    # Database migrations
├── docker-compose.yml
├── deploy.sh                      # Deploy Polymarket listener
├── deploy-kalshi.sh               # Deploy Kalshi listener
├── deploy-opinion.sh              # Deploy Opinion listener
├── deploy-predict.sh              # Deploy Predict listener
├── deploy-event-matcher.sh        # Deploy event matcher
├── deploy-homepage-api.sh         # Deploy homepage API
└── deploy-healthcheck.sh          # Deploy healthcheck
```

---

## Data Flow

### Kalshi Data Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Kalshi REST    │     │ Kalshi WebSocket│     │   PostgreSQL    │
│  /events API    │     │   Real-time     │     │   Database      │
└────────┬────────┘     └────────┬────────┘     └────────▲────────┘
         │                       │                       │
         │ Market List           │ ticker, orderbook,    │
         │ + OHLC Data           │ trade messages        │
         ▼                       ▼                       │
┌────────────────────────────────────────────────────────┤
│                  KALSHI LISTENER                       │
├────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ Market Sync  │  │  Handlers    │  │ Batch Writer │ │
│  │   Service    │  │              │  │              │─┼─►
│  └──────────────┘  └──────────────┘  └──────────────┘ │
└────────────────────────────────────────────────────────┘
```

### Polymarket Data Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Gamma API     │     │ Polymarket WS   │     │   PostgreSQL    │
│   /events       │     │ Pool (N sockets)│     │   Database      │
└────────┬────────┘     └────────┬────────┘     └────────▲────────┘
         │                       │                       │
         │ Market List           │ book, trade,          │
         │ + Outcome Cache       │ price_change          │
         ▼                       ▼                       │
┌────────────────────────────────────────────────────────┤
│               POLYMARKET LISTENER                      │
├────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ Gamma API    │  │  Handlers    │  │ Batch Writer │ │
│  │   Service    │  │ + WS Pool    │  │              │─┼─►
│  └──────────────┘  └──────────────┘  └──────────────┘ │
└────────────────────────────────────────────────────────┘
```

### Predict Data Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Predict REST   │     │  Predict WS     │     │   PostgreSQL    │
│  /v1/categories │     │  Real-time      │     │   Database      │
└────────┬────────┘     └────────┬────────┘     └────────▲────────┘
         │                       │                       │
         │ Categories            │ orderbook, trade      │
         │ (events + markets)    │ messages              │
         ▼                       ▼                       │
┌────────────────────────────────────────────────────────┤
│                 PREDICT LISTENER                       │
├────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ Market Sync  │  │  Handlers    │  │Cross-Mapping │ │
│  │  + Events    │  │ + WS Pool    │  │(Kalshi/Poly) │─┼─►
│  └──────────────┘  └──────────────┘  └──────────────┘ │
└────────────────────────────────────────────────────────┘
```

**Predict.fun unique feature — API-provided cross-exchange links:**
- Each Predict market contains `kalshiMarketTicker` and `polymarketConditionIds`
- The cross-mapping service (`crossMapping.ts`) reads these fields during each sync
- Looks up the corresponding Kalshi/Polymarket market in the DB
- Creates `market_mappings` entries with `model_id = 'predict-api-link-v1'`, `confidence_score = 1.0`
- Uses `CM-<hash>` canonical IDs consistent with event-matcher format
- Checks existing canonical groups via `findExistingCanonicalMarketId()` for transitive grouping

### Band Metrics Data Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   order_books   │     │ market_mappings │     │ market_prices   │
│    (JSONB)      │     │    (bridge)     │     │    _latest      │
└────────┬────────┘     └────────┬────────┘     └────────▲────────┘
         │                       │                       │
         │ bids/asks             │ market_id →           │ reference_price
         │                       │ canonical_market_id   │ band_liquidity
         ▼                       ▼                       │ band_vwap
┌────────────────────────────────────────────────────────┤
│              BAND METRICS CALCULATOR                   │
├────────────────────────────────────────────────────────┤
│  1. Dust filter       → Remove orders < min_qty       │
│  2. Reference check   → Validate spread < max         │
│  3. Reference price   → (best_bid + best_ask) / 2     │
│  4. Band filter       → Orders within delta of ref    │
│  5. Liquidity sum     → Aggregate qty (capped)        │
│  6. VWAP calculation  → Weighted price average        │
└────────────────────────────────────────────────────────┘
```

---

## Database Schema

All tables live in the **`direct_exchanges_data`** schema on Alibaba Cloud RDS PostgreSQL. No ORM is used — all queries are raw SQL via the `pg` (node-postgres) driver.

### Tables Overview

| Table | Purpose | Write Volume | Retention |
|-------|---------|-------------|-----------|
| `prediction_markets` | Market metadata (one row per market per outcome side) | Batch upsert every 5 min | Closed markets cleaned after 24h |
| `market_latest_data` | Current OHLC prices + execution-band liquidity metrics | Every tick & orderbook event | Cleaned with parent market |
| `order_books` | Time-series order book snapshots | Every orderbook message | 4 hours (hourly partitions) |
| `trades` | Individual trade records | Every trade message | 48 hours (daily partitions) |
| `quotes` | Best bid/ask snapshots (**writes disabled**) | Disabled (`ENABLE_QUOTE_WRITES=false`) | N/A (was 37GB) |
| `exchanges` | Exchange registry | Seed data only | Permanent |
| `data_sources` | Data source registry | Seed data only | Permanent |
| `market_mappings` | Cross-exchange market ID mapping (populated by event-matcher) | Batch upsert per matching cycle | Permanent |

---

### Table: `prediction_markets`

Market metadata — one row per market per outcome side (YES/NO). Populated by REST API sync every 5 minutes from Kalshi `/events` and Polymarket Gamma `/markets` endpoints.

**Unique constraint:** `(source_id, exchange_id, market_id, outcome_side)`
**Conflict behavior:** `DO UPDATE SET` (full upsert — all fields overwritten)

| Column | Type | Description |
|--------|------|-------------|
| `source_id` | VARCHAR | `KALSHI_DIRECT` or `POLYMARKET_DIRECT` |
| `exchange_id` | VARCHAR | `KALSHI` or `POLYMARKET` |
| `market_id` | VARCHAR(255) | Kalshi: ticker string; Polymarket: numeric Gamma market ID |
| `outcome_side` | VARCHAR | `'YES'` or `'NO'` |
| `outcome_name` | VARCHAR | Human-readable label: `"Yes"`, `"No"`, or specific option name |
| `outcome_type` | VARCHAR | `'Binary'`, `'Scalar'`, or `'MultipleChoice'` |
| `title` | VARCHAR(512) | Market name (truncated); Kalshi format: `"title — yes_sub_title"` |
| `sub_title` | TEXT | Optional subtitle / group item title |
| `event_id` | VARCHAR(255) | Parent event grouping (Kalshi: `event_ticker`; Polymarket: Gamma event ID) |
| `series_id` | VARCHAR(255) | Series ticker (Kalshi: `series_ticker`; Polymarket: from events API) |
| `rules_primary` | TEXT | Primary resolution rules |
| `rules_secondary` | TEXT | Secondary resolution rules (Kalshi only) |
| `category` | VARCHAR(255) | Market category |
| `price` | NUMERIC | Last price, normalized to decimal 0–1 |
| `expires_at` | TIMESTAMP | Market expiration/close time |
| `status` | VARCHAR | `'Open'`, `'Closed'`, `'Resolved'`, or `'Cancelled'` |
| `source_specific_data` | JSONB | Exchange-specific payload (e.g., `token_id`, `condition_id`, `open_interest`, `volume_24h`) |
| `created_at` | TIMESTAMP | Set to `NOW()` on insert |
| `updated_at` | TIMESTAMP | Updated to `NOW()` on every upsert |

**Indexes:**
- `idx_prediction_markets_series_id` — on `(series_id)` WHERE `series_id IS NOT NULL`
- `idx_prediction_markets_cleanup` — on `(source_id, exchange_id, status, updated_at)` WHERE status IN (`'Closed'`, `'Resolved'`, `'Cancelled'`)
- `idx_prediction_markets_stale_check` — on `(source_id, exchange_id, updated_at)` WHERE `status = 'Open'`

**Data sources:**
- **Kalshi**: `GET /events?with_nested_markets=true&status=open` (paginated, 100 events/page). Sports combo markets filtered out. `event_ticker` and `series_ticker` threaded from event level.
- **Polymarket**: `GET https://gamma-api.polymarket.com/events?active=true&closed=false` (paginated). Markets extracted from nested event data in a unified fetch.

**Lifecycle:** `markStaleMarketsAsClosed()` runs after every sync — any market with `status='Open'` whose `updated_at < syncStartTime` is set to `'Closed'`. `deleteClosedMarkets()` runs hourly to remove markets closed for >24h.

---

### Table: `market_latest_data`

One row per market per outcome side, storing current OHLC prices, volume, and execution-band liquidity metrics. Updated on every ticker event (prices) and every order book event (band metrics).

**Unique constraint:** `(source_id, exchange_id, market_id, outcome_side)`
**Conflict behavior:** `DO UPDATE SET` with merge logic (not full replace):
- `price_open` / `price_close` / `volume_traded` / `trades_count` — only updated if incoming value is non-zero
- `price_high` — `GREATEST(existing, incoming)`
- `price_low` — `LEAST(existing, incoming)`
- Band metric columns — only updated when `band_delta_used IS NOT NULL` (i.e., triggered by order book event)

| Column | Type | Description |
|--------|------|-------------|
| `source_id` | VARCHAR | Data source ID |
| `exchange_id` | VARCHAR | Exchange ID |
| `market_id` | VARCHAR | Market identifier |
| `outcome_side` | VARCHAR | `'YES'`, `'NO'`, or `'UNKNOWN'` |
| `time_period_start` | TIMESTAMP | Start of OHLC period |
| `time_period_end` | TIMESTAMP | End of OHLC period |
| `time_open` | TIMESTAMP | Time of open price |
| `time_close` | TIMESTAMP | Time of close price |
| `price_open` | NUMERIC | Opening price (decimal 0–1) |
| `price_high` | NUMERIC | Period high |
| `price_low` | NUMERIC | Period low |
| `price_close` | NUMERIC | Closing/latest price (decimal 0–1) |
| `volume_traded` | BIGINT | Total traded volume (NOT NULL, default 0) |
| `trades_count` | INTEGER | Number of trades (NOT NULL, default 0) |
| `reference_price` | NUMERIC(10,4) | Mid-price from dust-filtered best bid/ask |
| `band_liquidity_qty_ask` | NUMERIC(12,2) | Total ask quantity within execution band |
| `band_liquidity_qty_bid` | NUMERIC(12,2) | Total bid quantity within execution band |
| `band_vwap_ask` | NUMERIC(10,4) | Volume-weighted avg ask price in band |
| `band_vwap_bid` | NUMERIC(10,4) | Volume-weighted avg bid price in band |
| `band_delta_used` | NUMERIC(6,4) | Execution band delta used (default 0.01 = 1%) |
| `created_at` | TIMESTAMP | Row creation time |
| `updated_at` | TIMESTAMP | Last update time |

**Data sources:**
- **Market sync (every 5 min)**: Kalshi OHLC from `GET /markets/candlesticks`; Polymarket prices + volume from Gamma API. Both sides (YES/NO) written per market.
- **WebSocket ticker events**: `price_close` updated in real-time from Kalshi `ticker` messages and Polymarket `price_change` messages.
- **WebSocket orderbook events**: Band metrics recalculated via `calculateBandMetrics()` after every order book snapshot/delta.

---

### Table: `order_books`

Time-series order book snapshots. High write volume — partitioned by time (hourly partitions, 4h retention). Server cron deletes rows older than 3–4 hours.

**Unique constraint:** `(source_id, exchange_id, market_id, outcome_side, time_exchange)`
**Conflict behavior:** `DO NOTHING`

| Column | Type | Description |
|--------|------|-------------|
| `source_id` | VARCHAR | Data source ID |
| `exchange_id` | VARCHAR | Exchange ID |
| `market_id` | VARCHAR | Market identifier |
| `outcome_side` | VARCHAR | `'YES'` or `'NO'` |
| `bids` | JSONB | Array of `{price, quantity}` objects |
| `asks` | JSONB | Array of `{price, quantity}` objects |
| `time_exchange` | TIMESTAMP | Timestamp from the exchange WebSocket message |
| `time_coinapi` | TIMESTAMP | Receive timestamp (set to `NOW()` at time of DB write) |
| `created_at` | TIMESTAMP | Row creation time |
| `updated_at` | TIMESTAMP | Last update time |

**Price format in JSONB:**
- **Kalshi**: Prices stored in cents (0–100); normalized to decimal only for band metrics calculation
- **Polymarket**: Prices stored in decimal (0–1)

**Data sources:**
- **Kalshi**: `orderbook_snapshot` and `orderbook_delta` messages accumulated by `OrderBookManager`, then two rows written (YES + NO).
- **Polymarket**: `book` messages provide full snapshots directly, one row per asset/outcome.

---

### Table: `trades`

Individual trade records. Partitioned by time (daily partitions, 48h retention).

**Unique constraint:** `(source_id, exchange_id, trade_id, timestamp)`
**Conflict behavior:** `DO NOTHING`

| Column | Type | Description |
|--------|------|-------------|
| `source_id` | VARCHAR | Data source ID |
| `exchange_id` | VARCHAR | Exchange ID |
| `market_id` | VARCHAR | Market identifier |
| `trade_id` | VARCHAR | Exchange trade ID (empty string if not provided) |
| `price` | NUMERIC | Trade price, decimal 0–1 |
| `quantity` | NUMERIC | Trade size |
| `side` | VARCHAR | `'Buy'` or `'Sell'` |
| `outcome` | VARCHAR | `'YES'` or `'NO'` |
| `timestamp` | TIMESTAMP | Trade execution timestamp |
| `created_at` | TIMESTAMP | DB insert time |
| `updated_at` | TIMESTAMP | Last update time |

**Data sources:**
- **Kalshi**: `trade` WebSocket messages. `taker_side='yes'` → `side='Buy'`, `'no'` → `side='Sell'`. New API uses `yes_price_dollars` (string, decimal) and `count_fp` (string, e.g. `"808.00"`). Handler falls back to legacy `yes_price` (cents) and `count` (number) fields.
- **Polymarket**: `last_trade_price` WebSocket messages. `transaction_hash` used as `trade_id`.

---

### Table: `quotes`

Best bid/ask snapshots. **Writes are disabled by default** via `ENABLE_QUOTE_WRITES=false` because the table grew to 37GB.

**Unique constraint:** `(source_id, exchange_id, market_id, entry_time)`
**Conflict behavior:** `DO NOTHING`

| Column | Type | Description |
|--------|------|-------------|
| `source_id` | VARCHAR | Data source ID |
| `exchange_id` | VARCHAR | Exchange ID |
| `market_id` | VARCHAR | Market identifier |
| `outcome_side` | VARCHAR | `'YES'`, `'NO'`, or `'UNKNOWN'` |
| `bid` | NUMERIC | Best bid price |
| `bid_volume` | NUMERIC | Bid size |
| `ask` | NUMERIC | Best ask price |
| `ask_volume` | NUMERIC | Ask size |
| `entry_time` | TIMESTAMP | Quote timestamp |
| `recv_time` | TIMESTAMP | Receive timestamp |
| `created_at` | TIMESTAMP | Row creation time |
| `updated_at` | TIMESTAMP | Last update time |

**Data source:** Kalshi `ticker` WebSocket messages (when `ENABLE_QUOTE_WRITES=true`).

---

### Table: `exchanges`

Exchange registry metadata. Populated once via seed script.

**Primary key:** `exchange_id`
**Conflict behavior:** `DO UPDATE SET`

| Column | Type | Description |
|--------|------|-------------|
| `exchange_id` | VARCHAR | `'KALSHI'`, `'POLYMARKET'`, or `'OPINION'` |
| `name` | VARCHAR | Human-readable name |
| `settlement_type` | VARCHAR | `'BINARY'` |
| `is_active` | BOOLEAN | Whether exchange is active |

**Data source:** `scripts/seed-exchanges.sql`

---

### Table: `data_sources`

Data source registry metadata. Populated once via seed script.

**Primary key:** `source_id`
**Conflict behavior:** `DO UPDATE SET`

| Column | Type | Description |
|--------|------|-------------|
| `source_id` | VARCHAR | `'KALSHI_DIRECT'`, `'POLYMARKET_DIRECT'`, or `'OPINION_DIRECT'` |
| `source_type` | VARCHAR | `'WEBSOCKET'` |
| `name` | VARCHAR | Human-readable name |
| `refresh_method` | VARCHAR | `'REALTIME'` |
| `refresh_interval_sec` | INTEGER | `0` (real-time) |
| `is_active` | BOOLEAN | Whether source is active |

**Data source:** `scripts/seed-exchanges.sql`

---

### Table: `market_mappings`

Bridge table mapping exchange-specific market IDs to canonical market IDs for cross-exchange arbitrage. Populated by the event-matcher service (4 rows per match: YES+NO × 2 exchanges).

**Primary key:** `(source_id, exchange_id, market_id, outcome_side)`

| Column | Type | Description |
|--------|------|-------------|
| `source_id` | VARCHAR(50) | Data source identifier |
| `exchange_id` | VARCHAR(50) | Exchange identifier |
| `market_id` | VARCHAR(255) | Exchange-specific market ID |
| `outcome_side` | VARCHAR(10) | YES/NO side for the market |
| `canonical_market_id` | VARCHAR(255) | Unified market identifier |
| `confidence_score` | NUMERIC(5,4) | Match confidence (0-1) |
| `model_id` | VARCHAR(50) | Matching method (`algorithmic-v1`, `substring-v1`, `ai-verified-v1`) |
| `created_at` | TIMESTAMP | Row creation time |

---

### Table: `arb_opportunities`

Detected arbitrage opportunities across exchanges. Written by the arb scanner service (runs every 10s in homepage-api).

**Unique key:** `(canonical_market_id, arb_type, leg1_exchange_id, leg2_exchange_id)`
**Conflict behavior:** `DO UPDATE SET` (refresh spread, qty, profit, timestamps)

| Column | Type | Description |
|--------|------|-------------|
| `arb_id` | BIGINT | Auto-increment PK |
| `canonical_market_id` | VARCHAR(50) | Links to market_mappings |
| `canonical_event_id` | VARCHAR(50) | For event grouping in UI |
| `arb_type` | VARCHAR(20) | `'DIRECT'` or `'COMPLEMENT'` |
| `arb_subtype` | VARCHAR(20) | `'LIQUIDITY_GAP'`, `'TIME_DECAY'`, or `'CROSS_PLATFORM'` |
| `leg1_exchange_id` | VARCHAR(50) | Buy side exchange |
| `leg1_market_id` | VARCHAR(255) | Buy side market |
| `leg1_side` | VARCHAR(3) | `'YES'` or `'NO'` |
| `leg1_action` | VARCHAR(4) | `'BUY'` |
| `leg1_vwap` | NUMERIC | VWAP price used |
| `leg1_liquidity_qty` | NUMERIC | Available quantity |
| `leg2_exchange_id` | VARCHAR(50) | Sell/second buy exchange |
| `leg2_market_id` | VARCHAR(255) | Sell/second buy market |
| `leg2_side` | VARCHAR(3) | `'YES'` or `'NO'` |
| `leg2_action` | VARCHAR(4) | `'SELL'` or `'BUY'` |
| `leg2_vwap` | NUMERIC | VWAP price used |
| `leg2_liquidity_qty` | NUMERIC | Available quantity |
| `gross_spread` | NUMERIC | Raw price difference |
| `gross_spread_pct` | NUMERIC | Spread as percentage |
| `prev_gross_spread_pct` | NUMERIC | Previous spread (for trend) |
| `executable_qty` | NUMERIC | MIN of both legs' liquidity |
| `gross_profit` | NUMERIC | spread × executable_qty |
| `status` | VARCHAR(20) | `'ACTIVE'` / `'EXPIRED'` |
| `detected_at` | TIMESTAMPTZ | First detected |
| `updated_at` | TIMESTAMPTZ | Last refreshed |
| `last_checked_at` | TIMESTAMPTZ | Last scanner evaluation |
| `expired_at` | TIMESTAMPTZ | When opportunity expired |

---

### Table: `arb_config`

Runtime-configurable parameters for the arb scanner. Read from DB every ~5 min.

**Primary key:** `config_key`

| Key | Production Value | Description |
|-----|-----------------|-------------|
| `max_staleness_sec` | `900` | Max age of orderbook data before excluding a leg (15 min) |
| `min_arb_pct` | `0.01` | Minimum gross spread % to flag (1%) |
| `min_executable_qty` | `5` | Minimum contracts on both legs |
| `min_liquidity_usd` | `2` | Minimum gross profit USD |
| `min_confidence` | `0.95` | Minimum market_mappings confidence |
| `scan_interval_sec` | `10` | Scanner loop interval |
| `expire_grace_sec` | `902` | Grace period for evaluated arbs |
| `expire_long_grace_sec` | `600` | Grace period for non-evaluated arbs (stale legs) |
| `kalshi_fee_rate` | `0.07` | Kalshi fee rate (on profit) |
| `polymarket_fee_rate` | `0.02` | Polymarket taker fee rate |
| `default_fee_rate` | `0.01` | Default fee for unknown exchanges |

---

### Table Relationships & Conflict Behavior Summary

| Table | Unique Key | On Conflict |
|-------|-----------|-------------|
| `prediction_markets` | `(source_id, exchange_id, market_id, outcome_side)` | Full upsert |
| `market_latest_data` | `(source_id, exchange_id, market_id, outcome_side)` | Merge (conditional update) |
| `order_books` | `(source_id, exchange_id, market_id, outcome_side, time_exchange)` | Skip duplicate |
| `trades` | `(source_id, exchange_id, trade_id, timestamp)` | Skip duplicate |
| `quotes` | `(source_id, exchange_id, market_id, entry_time)` | Skip duplicate |
| `exchanges` | `exchange_id` | Full upsert |
| `data_sources` | `source_id` | Full upsert |
| `market_mappings` | `(source_id, exchange_id, market_id, outcome_side)` | Full upsert |
| `arb_opportunities` | `(canonical_market_id, arb_type, leg1_exchange_id, leg2_exchange_id)` | Update spread/qty/profit |
| `arb_config` | `config_key` | Full upsert |

All tables share the composite key pattern `(source_id, exchange_id, ...)` to support multi-source ingestion. The `market_id` + `outcome_side` combination uniquely identifies a market position across the system.

---

## Key Components

### 1. Batch Writer
Generic batching utility for database writes:
- Accumulates items up to `BATCH_SIZE` (default: 100)
- Auto-flushes after `BATCH_INTERVAL_MS` (default: 100ms)
- Exponential backoff retry (5 attempts)
- Handles transient errors (deadlocks, timeouts)

### 2. WebSocket Clients

| Feature | Kalshi | Polymarket | Predict.fun | Opinion.trade |
|---------|--------|------------|-------------|---------------|
| Auth | API Key + RSA-PSS | None | API Key (optional) | None |
| Channels | ticker, orderbook, trade | book, price_change, trade | orderbook, trade | market.depth, market.trade |
| Reconnect | Exponential backoff | Exponential backoff | Exponential backoff | Exponential backoff |
| Pooling | Pool (~2000/socket) | Pool (500 assets/socket) | Pool (~500/socket) | Pool (~200/socket) |
| OB Handling | Delta accumulation | Delta accumulation (snapshots + price_change deltas) | Delta accumulation | Delta accumulation |
| Trade format | `count_fp` (string), `yes_price_dollars` (string) | `size` (string), `price` (string) | Per WS message | `quantity` (string), `price` (string) |
| Special | — | — | Cross-exchange mapping via API links | — |

### 3. Outcome Side Cache
In-memory cache mapping `asset_id → outcome_side` for Polymarket:
- Populated during market sync from Gamma API
- Used by handlers when inserting data
- **Cache miss behavior**: Records are skipped (not written) if outcome_side cannot be resolved

**Exchange-specific handling:**
- **Kalshi**: Emits two records per orderbook update (one YES, one NO) since each market represents both sides
- **Polymarket**: Each token/asset represents a single outcome; cache miss causes record to be skipped

**Database unique constraints include outcome_side:**
- `market_latest_data`: `(source_id, exchange_id, market_id, outcome_side)`
- `order_books`: `(source_id, exchange_id, market_id, outcome_side, time_exchange)`

### 4. OrderBook Managers
All four exchanges use delta accumulation — maintaining in-memory orderbook state and applying incremental updates.

| Exchange | Location | Key Format | Price Format |
|----------|----------|------------|-------------|
| Kalshi | `packages/kalshi-listener/src/state/orderBookManager.ts` | `marketId` | Cents (0-100) |
| Polymarket | `packages/polymarket-listener/src/state/orderBookManager.ts` | `assetId` | Decimal (0-1) |
| Predict | `packages/predict-listener/src/state/orderBookManager.ts` | `marketId` | Decimal (0-1) |
| Opinion | `packages/opinion-listener/src/state/orderBookManager.ts` | `${marketId}:${outcomeSide}` | Decimal (0-1) |

**Operations:** `applySnapshot()` (replaces entire book), `applyDelta()` (updates single level), `getOrderBook()` (returns accumulated state for DB write)
**Pruning:** Stale markets removed periodically (configurable max age)

### 5. Event Matcher
Cross-exchange event and market matching service (`packages/event-matcher/`). Runs a matching pipeline every 5 minutes:

```
Phase 1: Event-level matching (Kalshi↔Polymarket via OpenAI)
    └─► Inline market matching for newly matched event pairs (4-tier)
Phase 2: Cross-event market matching (DISABLED via ENABLE_PHASE2=false)
```

**Phase 1 — Event matching:**
1. Fetch open events from both exchanges, skip already-matched or recently-checked
2. Concurrent workers (default 20) pick unmatched Kalshi events
3. Pre-filter Polymarket candidates by keyword overlap + entity matching
4. Send to OpenAI for semantic comparison (confidence >= 0.85)
5. On match: write `event_mappings`, immediately run market matching

**Market-within-event matching (4-tier):**
1. Binary (1:1) — auto-match if exactly 1 market per side
2. Substring — extract entity after " — " from Kalshi title, match against Polymarket
3. Jaccard >= 0.85 — auto-accept
4. Jaccard 0.3–0.85 — AI verification

**Phase 2 — Cross-event (disabled):**
Picks up unmatched Kalshi markets, searches Polymarket by entity name, AI-verifies candidates.

**Key files:**
- `services/matchingCycle.ts` — Orchestrates all phases
- `services/aiComparer.ts` — OpenAI calls with rate limiting
- `services/preFilter.ts` — Keyword extraction, synonym normalization, accent stripping
- `services/marketMatcher.ts` — 4-tier market matching
- `services/crossEventMatcher.ts` — Phase 2 cross-event matching

### 6. Arb Scanner
Arbitrage opportunity detection service running inside `homepage-api` on a 10-second loop.

```
┌────────────────────────────────────────────────────────────┐
│                      ARB SCANNER CYCLE                      │
├────────────────────────────────────────────────────────────┤
│  1. Fetch matched market legs (market_mappings + band      │
│     metrics from market_latest_data)                        │
│  2. Filter by staleness (max_staleness_sec = 900)          │
│  3. For each canonical market, compute spread between      │
│     exchanges using VWAP prices within execution band       │
│  4. Apply filters: min_arb_pct, min_executable_qty,        │
│     min_liquidity_usd                                       │
│  5. Upsert to arb_opportunities table                      │
│  6. Expire stale arbs (grace periods)                      │
│  7. Reload config from arb_config table every 30 cycles    │
└────────────────────────────────────────────────────────────┘
```

**How it works:**
- Joins `market_mappings` with `market_latest_data` to get band metrics for both exchanges
- Computes gross spread: `leg1_vwap_ask - leg2_vwap_bid` (and vice versa)
- DIRECT arbs: Buy YES on one exchange, Sell YES on another
- COMPLEMENT arbs: Buy YES on one exchange, Buy NO on another (combined cost < 1.0)
- Only considers legs with fresh orderbook data (`updated_at` within `max_staleness_sec`)

**Expiry logic:** Two grace periods to prevent oscillation:
- `expire_grace_sec` (902s): For arbs whose market was evaluated this cycle
- `expire_long_grace_sec` (600s): For arbs whose market had stale legs

**Key files:**
- `packages/homepage-api/src/services/arbScanner.ts`
- `packages/shared/src/db/queries.ts` (`fetchMatchedMarketLegs`, `upsertArbOpportunities`, `expireEvaluatedArbs`)

### 7. Predict Cross-Exchange Mapping
The predict-listener automatically creates `market_mappings` entries from Predict.fun's API-provided links to Kalshi and Polymarket.

- Each Predict market contains `kalshiMarketTicker` and `polymarketConditionIds`
- Creates pairwise mappings: Predict↔Kalshi and Predict↔Polymarket
- Uses `findExistingCanonicalMarketId()` for transitive grouping (reuses existing canonical IDs)
- `model_id = 'predict-api-link-v1'`, `confidence_score = 1.0`
- Hash-based canonical IDs (`CM-<hash>`) consistent with event-matcher format

**Key file:** `packages/predict-listener/src/services/crossMapping.ts`

---

## Configuration

### Environment Variables

```bash
# Database
DATABASE_URL=postgresql://user:pass@host:5432/db
DB_SCHEMA=direct_exchanges_data
DB_MAX_CONNECTIONS=5

# Kalshi
KALSHI_API_KEY=<key>
KALSHI_WS_URL=wss://api.elections.kalshi.com/trade-api/ws/v2
KALSHI_REST_URL=https://api.elections.kalshi.com/trade-api/v2

# Polymarket
POLYMARKET_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
POLYMARKET_GAMMA_URL=https://gamma-api.polymarket.com
MARKETS_PER_SOCKET=500

# Predict
PREDICT_REST_URL=https://api.predict.fun
PREDICT_WS_URL=wss://ws.predict.fun/ws
PREDICT_API_KEY=<key>  # optional
PREDICT_MARKETS_PER_SOCKET=500
ENABLE_CROSS_MAPPING=true

# Batch Writing
BATCH_SIZE=100
BATCH_INTERVAL_MS=100

# General
LOG_LEVEL=info
MARKET_REFRESH_INTERVAL_MS=300000
```

---

## Deployment

### Docker Compose

```bash
# Start all services
docker compose up -d polymarket-listener

# View logs
docker compose logs -f polymarket-listener

# Deploy to server
./deploy.sh
```

### Server Details
- **Host**: 8.216.43.26 (Japan)
- **Path**: /opt/prediction-market-ingestion
- **Database**: Alibaba Cloud RDS PostgreSQL

---

## Error Handling & Resilience

### Retry Mechanisms
1. **Database writes**: 5 retries, exponential backoff
2. **WebSocket reconnect**: Auto-reconnect with backoff
3. **API calls**: Retry with jitter

### Graceful Shutdown
- Listens for SIGTERM/SIGINT
- Flushes all pending batch writers
- Closes WebSocket connections
- Closes database pool

---

## Data Retention

### Partition Management
A server-side cron job (`/opt/manage-partitions.sh`) creates and drops partitions every 5 minutes:
- **order_books**: Hourly partitions, 4h retention
- **trades**: Daily partitions, 48h retention

### Closed Market Cleanup
Each listener runs periodic cleanup to remove closed markets and events after a configurable retention period (default 24h).

---

## Source & Exchange IDs

| Exchange | Source ID | Exchange ID |
|----------|-----------|-------------|
| Kalshi | `KALSHI_DIRECT` | `KALSHI` |
| Polymarket | `POLYMARKET_DIRECT` | `POLYMARKET` |
| Predict.fun | `PREDICT_DIRECT` | `PREDICT` |
| Opinion.trade | `OPINION_DIRECT` | `OPINION` |

---

## Performance

- **Batch Size**: 100 items per write
- **Flush Interval**: 100ms max latency
- **Connection Pool**: 5 connections per listener
- **Polymarket Limit**: 500 assets per WebSocket

---

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run in dev mode
pnpm dev:polymarket
pnpm dev:kalshi

# Type check
pnpm typecheck
```
