# Configuration Guide

Runtime-configurable parameters for the prediction market ingestion system. These are managed via database tables and do not require redeployment.

---

## Arb Scanner Configuration

**Table:** `direct_exchanges_data.arb_config`

**Schema:**

| Column | Type | Description |
|--------|------|-------------|
| `config_key` | VARCHAR(100) | Primary key — parameter name |
| `config_value` | VARCHAR(255) | Parameter value (stored as string, parsed at runtime) |
| `description` | TEXT | Human-readable description |
| `updated_at` | TIMESTAMPTZ | Last modified timestamp |

**Reload behavior:** The arb scanner reads this table every 30 scan cycles (~5 minutes). Changes take effect without restarting the service.

---

### Parameters

#### Data Quality Filters

| Key | Type | Current Value | Description |
|-----|------|---------------|-------------|
| `max_staleness_sec` | Integer (seconds) | `900` | Maximum age of orderbook data before a market leg is excluded from arb detection. Only orderbook updates (not price-only updates) refresh the timestamp. Markets with infrequent trading may go 10-30 minutes between orderbook updates. **Lowering this reduces the number of eligible market pairs significantly.** |
| `min_confidence` | Decimal (0-1) | `0.95` | Minimum confidence score from the market matching algorithm. Markets matched with lower confidence are excluded. The matching pipeline produces scores of 0.85-1.0; most production matches are 0.95+. |

#### Opportunity Thresholds

| Key | Type | Current Value | Description |
|-----|------|---------------|-------------|
| `min_arb_pct` | Decimal (0-1) | `0.01` | Minimum gross spread percentage to qualify as an opportunity. A value of `0.01` means 1%. Real cross-exchange spreads are typically 1-3%. Setting this too low produces noise; too high misses real opportunities. |
| `min_executable_qty` | Integer (contracts) | `5` | Minimum number of contracts executable on both legs. This is the lesser of the two legs' available liquidity. Filters out arbs that are too small to trade profitably after fees. |
| `min_liquidity_usd` | Decimal (USD) | `2` | Minimum gross profit in USD (spread x executable quantity). Filters out opportunities where the absolute dollar profit is too small to justify execution. |

#### Scanner Timing

| Key | Type | Current Value | Description |
|-----|------|---------------|-------------|
| `scan_interval_sec` | Integer (seconds) | `10` | How often the scanner runs its detection cycle. Each cycle queries all matched markets, computes spreads, upserts opportunities, and expires stale ones. **Lowering this increases database load.** |

#### Expiry Logic

The scanner uses two grace periods to manage when active arbs are marked as expired:

| Key | Type | Current Value | Description |
|-----|------|---------------|-------------|
| `expire_grace_sec` | Integer (seconds) | `902` | Grace period for arbs whose underlying market **was evaluated** in the current scan cycle (both legs had fresh data). If an arb was last updated more than this many seconds ago but its market was still scanned, it gets expired. **Must be >= `max_staleness_sec`** to avoid oscillation where arbs expire and reappear each cycle. |
| `expire_long_grace_sec` | Integer (seconds) | `600` | Grace period for arbs whose underlying market **could not be evaluated** this cycle (one or both legs had stale data). Keeps arbs alive longer when the issue is just temporarily stale data, not a genuinely closed opportunity. |

#### Fee Rates

Fee rates are stored for future net profit calculations (v2). They are **not currently used** in arb detection or filtering.

| Key | Type | Current Value | Description |
|-----|------|---------------|-------------|
| `kalshi_fee_rate` | Decimal (0-1) | `0.07` | Kalshi charges fees on **profit** (not on trade value). 7% of profit per contract. |
| `polymarket_fee_rate` | Decimal (0-1) | `0.02` | Polymarket charges a taker fee on trade value. 2% of trade amount. |
| `default_fee_rate` | Decimal (0-1) | `0.01` | Fallback fee rate for exchanges not explicitly configured. |

---

### How to Modify

#### Via SQL (direct)

```sql
-- Update a single parameter
UPDATE direct_exchanges_data.arb_config
SET config_value = '0.02', updated_at = NOW()
WHERE config_key = 'min_arb_pct';

-- View all current values
SELECT config_key, config_value, description, updated_at
FROM direct_exchanges_data.arb_config
ORDER BY config_key;
```

#### Via Appsmith Admin Panel

Connect to the `arb_config` table with a simple CRUD interface:
- **Data source:** PostgreSQL (same RDS connection)
- **Schema:** `direct_exchanges_data`
- **Table:** `arb_config`
- **Primary key:** `config_key`
- **Editable columns:** `config_value`
- **Read-only columns:** `config_key`, `description`, `updated_at`

Recommended UI: Table widget with inline editing on `config_value`, plus a "Save" button that runs the UPDATE query and sets `updated_at = NOW()`.

---

### Parameter Dependencies

```
max_staleness_sec ──► expire_grace_sec (must be >=)
                  ──► expire_long_grace_sec (should be proportional)

min_arb_pct ────────► Affects number of active arbs directly
min_executable_qty ─► Filters after spread calculation
min_liquidity_usd ──► Filters after quantity calculation
```

**Key constraint:** `expire_grace_sec` must be >= `max_staleness_sec`. If grace is shorter than staleness, arbs will oscillate between ACTIVE and EXPIRED every scan cycle.

---

### Tuning Impact

| Change | Effect | Risk |
|--------|--------|------|
| Lower `max_staleness_sec` | Fewer eligible markets (both legs must be fresh) | May reduce active arbs to near zero |
| Raise `max_staleness_sec` | More markets eligible, but prices may be outdated | Stale arbs that no longer exist in the live market |
| Lower `min_arb_pct` | More arbs detected, including smaller spreads | More noise, potentially unprofitable after fees |
| Raise `min_arb_pct` | Only large spreads flagged | May miss real opportunities |
| Lower `min_executable_qty` | Smaller arbs included | Higher % of arbs too small to execute profitably |
| Lower `min_liquidity_usd` | Lower-profit arbs included | Similar risk as above |

---

## Environment Variable Configuration

These require redeployment to change (set in `docker-compose.yml` or `.env`).

### Listener Services

| Variable | Service | Default | Description |
|----------|---------|---------|-------------|
| `MARKETS_PER_SOCKET` | polymarket-listener | `500` | Max assets per WebSocket connection |
| `KALSHI_MARKETS_PER_SOCKET` | kalshi-listener | `2000` | Max subscriptions per WebSocket connection |
| `OPINION_MARKETS_PER_SOCKET` | opinion-listener | `200` | Max markets per WebSocket connection |
| `PREDICT_MARKETS_PER_SOCKET` | predict-listener | `500` | Max markets per WebSocket connection |
| `PREDICT_REST_URL` | predict-listener | `https://api.predict.fun` | Predict.fun REST API URL |
| `PREDICT_WS_URL` | predict-listener | `wss://ws.predict.fun/ws` | Predict.fun WebSocket URL |
| `PREDICT_API_KEY` | predict-listener | (optional) | Predict.fun API key |
| `ENABLE_CROSS_MAPPING` | predict-listener | `true` | Enable cross-exchange market mapping from Predict API links |
| `ENABLE_QUOTE_WRITES` | all listeners | `false` | Enable writing to quotes table (disabled to save storage) |

### Event Matcher

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | (required) | OpenAI API key for semantic matching |
| `OPENAI_MODEL` | `gpt-5-nano` | Model used for event/market comparison |
| `MATCHER_CONCURRENCY` | `20` | Concurrent AI workers |
| `MATCHER_INTERVAL_MS` | `300000` | Cycle interval (5 min) |
| `MATCHER_CONFIDENCE_THRESHOLD` | `0.85` | Min confidence to accept a match |
| `MATCHER_RECHECK_INTERVAL_MS` | `86400000` | Recheck unmatched events after 24h |
| `MARKET_MATCH_THRESHOLD` | `0.85` | Jaccard auto-accept threshold |
| `MARKET_MATCH_AI_THRESHOLD` | `0.3` | Min Jaccard to trigger AI verification |
| `ENABLE_PHASE2` | `true` (prod: `false`) | Enable Phase 2 cross-event market matching |
| `MATCHER_PHASE2_CONCURRENCY` | `100` | Concurrent workers for Phase 2 |
| `MATCHER_CANDIDATES_PER_BATCH` | `10` | Max candidates per AI event comparison |
| `MATCHER_MIN_EVENT_VOLUME` | `0` | Min total volume to consider for event matching |

### Healthcheck

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | (required) | Telegram bot token for alerts |
| `TELEGRAM_CHAT_ID` | (required) | Chat ID for alert messages |
| `HEALTHCHECK_INTERVAL_MS` | `60000` | Check interval (1 min) |
| `DISK_WARNING_THRESHOLD` | `70` | Disk % warning level |
| `DISK_CRITICAL_THRESHOLD` | `85` | Disk % critical level |
| `ALERT_COOLDOWN_MS` | `300000` | Cooldown between repeated alerts (5 min) |
