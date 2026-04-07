# Feature: Homepage API

**Status**: DEPLOYED
**Priority**: High
**Created**: 2026-03-02

---

## Summary

A Fastify-based REST API (`homepage-api`) serving the 17B prediction market dashboard. The UI displays an **event-centric** feed where each card shows a market question with multiple outcomes, and each outcome has per-exchange prices across up to 4 exchanges (Kalshi, Polymarket, Manifold, Premarket). The API supports category filtering, text search, volume/deadline sorting, infinite-scroll pagination, and a scrolling ticker.

---

## Problem

The 17B platform has no API to serve a unified prediction market dashboard. Market data exists across Kalshi and Polymarket in `prediction_markets`, `market_latest_data`, `market_mappings`, and `trades` tables, but there is no service that:
- Presents markets as **events with multiple outcomes** and per-exchange prices in a single feed
- Supports cross-exchange price comparison (highlighting best price per outcome)
- Provides a consistent category taxonomy (Kalshi has 15 categories, Polymarket has 393+)
- Generates clean titles for matched market pairs
- Supports text search, category/exchange filtering, and infinite-scroll pagination

---

## Solution

A new service (`packages/homepage-api/`) that:
1. Pre-computes a **ranking score** for every market on a periodic cycle (every 30–60s)
2. Serves ranked markets via REST endpoints with filtering, pagination, and a multi-outcome × multi-exchange price matrix
3. Extends the market-matcher pipeline to generate **unified titles** for matched market pairs via OpenAI
4. Maps Kalshi's 15 categories to a simplified 17B taxonomy (6 categories)
5. Auto-generates OpenAPI documentation via `@fastify/swagger`

---

## UI Reference

The API serves the dashboard defined in `index_v3_latest.html`. Key UI elements the API must support:

```
┌─────────────────────────────────────────────────────────────────────┐
│ TICKER: Scrolling marquee with top market highlights               │
├─────────────────────────────────────────────────────────────────────┤
│ TOPBAR: 17B LIVE │ Markets │ Arbitrage │ Smart Money │ EN/ZH       │
├─────────────────────────────────────────────────────────────────────┤
│ CATBAR: Trending Markets │ All │ Politics │ Economics │ Crypto │    │
│         Sports │ Entertainment │ ⛓ Matched │ 🔍 Search            │
├─────────────────────────────────────────────────────────────────────┤
│ SUBBAR: [Kalshi] [Polymarket] [Manifold] [Premarket] │ Cards/Rows  │
│         │ Sort: Volume ↓ / Closes Soon                             │
├─────────────────────────────────────────────────────────────────────┤
│ MAIN: Card grid (3-col) or Row table view                          │
│                                                                     │
│  ┌─ MARKET CARD ──────────────────────────────────────┐            │
│  │ 🏛 Who will Trump nominate as Fed Chair?            │            │
│  │    Dec 31, 2026                                     │            │
│  │                        [KAL]  [POLY]  [MAN]         │            │
│  │  Kevin Warsh            95%    94%     91%          │            │
│  │  Judy Shelton             5%     4%      9%         │            │
│  │ ────────────────────────────────────────            │            │
│  │  $21.3M vol  + 6 more Markets │ View Analysis ★    │            │
│  └─────────────────────────────────────────────────────┘            │
│                                                                     │
│ ⋮ Scroll for more (infinite scroll)                                │
├─────────────────────────────────────────────────────────────────────┤
│ FOOTER: 847 markets │ 24h vol $1.2B │ 4 exchanges │ UTC 00:00:00  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Data Model

### Event-Centric Structure

Each item in the API response represents a **market event** (a question) with:
- **Multiple outcomes** (e.g., "Kevin Warsh", "Judy Shelton" — or simple "Yes"/"No")
- **Per-exchange prices** for each outcome (the outcome × exchange price matrix)
- **Best price highlighting** — the UI highlights the highest price per outcome across exchanges

### How Markets Map to Events

| Source | Grouping | Example |
|--------|----------|---------|
| Binary matched market (Kalshi + Poly) | `canonical_market_id` from `market_mappings` | "Fed no-change?" → Yes/No across 2 exchanges |
| Multi-outcome event (same exchange) | `event_id` or `series_id` from `prediction_markets` | "2028 Dem Nominee" → multiple candidates on Kalshi |
| Cross-exchange multi-outcome | `canonical_market_id` per outcome within same event group | "2028 Dem Nominee" → candidates across Kalshi + Poly |
| Unmatched single market | Standalone with synthetic ID (`K:{id}` or `P:{id}`) | Kalshi-only market with Yes/No |

### Exchanges

The API supports 4 exchanges. Phase 1 has data for Kalshi and Polymarket only.

| Key | Label | Short | Status |
|-----|-------|-------|--------|
| `kal` | Kalshi | KAL | Active (has data) |
| `poly` | Polymarket | POLY | Active (has data) |
| `man` | Manifold | MAN | Planned (no data yet) |
| `pre` | Premarket | PRE | Planned (no data yet) |

### Price Format

All prices are in **percentage (0–100)** matching the UI display. Kalshi prices (stored in cents 0-100) pass through as-is. Polymarket prices (stored as decimal 0-1) are multiplied by 100.

---

## API Specification (OpenAPI 3.0)

All endpoints are prefixed with `/api/v1`. The service auto-generates OpenAPI docs at `GET /api/v1/docs` (Swagger UI) and `GET /api/v1/openapi.json` (raw JSON spec for Postman/codegen).

### `GET /api/v1/markets`

Returns ranked market events with per-outcome, per-exchange prices. Supports infinite scroll via cursor pagination.

**Query Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `category` | string | No | (all) | Filter by 17B category: `politics`, `economics`, `crypto`, `sports`, `entertainment` |
| `exchange` | string (csv) | No | (all) | Filter: only show markets available on these exchanges. Comma-separated: `kal,poly,man,pre` |
| `matched` | string | No | `true` | `true` (default): only cross-exchange matched markets. `false`: only single-exchange. `all`: both. |
| `search` | string | No | (none) | Case-insensitive text search on market title |
| `sort` | string | No | `score` | Sort: `score` (default, by composite ranking score), `closes_soon` |
| `limit` | integer | No | `30` | Page size (1–100) |
| `cursor` | string | No | (none) | Opaque cursor for next page (base64-encoded) |

**Response (200):**

```json
{
  "markets": [
    {
      "id": "CM-abc1234567890def",
      "title": "Who will Trump nominate as Fed Chair?",
      "thumb": "🏛",
      "category": "politics",
      "end_date": "Dec 31, 2026",
      "volume": "$21.3M",
      "exchanges": ["kal", "poly", "man"],
      "outcomes": [
        {
          "label": "Kevin Warsh",
          "prices": { "kal": 95, "poly": 94, "man": 91 }
        },
        {
          "label": "Judy Shelton",
          "prices": { "kal": 5, "poly": 4, "man": 9 }
        }
      ],
      "updated_at": "2026-03-02T14:30:00Z"
    },
    {
      "id": "K:FED-26MAR-NOCHANGE",
      "title": "Fed decision in March 2026 — no change?",
      "thumb": "🏦",
      "category": "economics",
      "end_date": "Mar 19, 2026",
      "volume": "$14.7M",
      "exchanges": ["kal", "poly"],
      "outcomes": [
        {
          "label": "No change",
          "prices": { "kal": 91, "poly": 92 }
        },
        {
          "label": "25bps decrease",
          "prices": { "kal": 8, "poly": 7 }
        }
      ],
      "updated_at": "2026-03-02T14:25:00Z"
    }
  ],
  "next_cursor": "eyJ2IjoiMTQuN00iLCJ0IjoiMjAyNi0wMy0wMlQxNDoyNTowMFoiLCJpIjoiSzpGRUQtMjZNQVItTk9DSEFOR0UifQ==",
  "has_more": true,
  "total": 847
}
```

**Field descriptions:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique market ID. `CM-{hash}` for matched, `K:{id}` or `P:{id}` for unmatched |
| `title` | string | Display title (AI-generated for matched, source title for unmatched) |
| `thumb` | string | Emoji or image URL for visual identification |
| `category` | string | Mapped 17B category slug |
| `end_date` | string | Human-readable deadline (e.g., "Dec 31, 2026") |
| `volume` | string | Formatted 24h volume (e.g., "$21.3M") |
| `exchanges` | string[] | Exchange keys where this market is available |
| `outcomes` | array | List of outcomes, each with label and per-exchange prices |
| `outcomes[].label` | string | Outcome name (e.g., "Kevin Warsh", "Yes", "No") |
| `outcomes[].prices` | object | Map of exchange key → price (0–100 percentage) |
| `updated_at` | string | ISO 8601 timestamp of most recent data update |

**Best price logic:** The UI determines the best (highest) price per outcome across visible exchanges client-side. The API provides raw prices; highlighting is a UI concern.

**Error Responses:**

| Status | Description |
|--------|-------------|
| 400 | Invalid query parameter (bad category, limit out of range, malformed cursor) |
| 500 | Internal server error |

---

### `GET /api/v1/markets/ticker`

Returns a lightweight list of top markets for the scrolling marquee ticker.

**Query Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `limit` | integer | No | `10` | Number of markets (1–50) |

**Response (200):**

```json
{
  "items": [
    {
      "tag": "🔴 LIVE",
      "text": "Kevin Warsh Fed Chair: KAL 95% / MAN 91% / POLY 94%"
    },
    {
      "tag": "₿ CRYPTO",
      "text": "Bitcoin $150k: POLY 67% / KAL 65% / MAN 69%"
    },
    {
      "tag": "💰 VOLUME",
      "text": "2028 Democratic Nominee crosses $107.4M volume"
    }
  ]
}
```

The ticker items are pre-formatted text strings. The API selects top markets by volume and formats them with exchange price comparisons.

---

### `GET /api/v1/categories`

Returns available categories with market counts (for category pill rendering).

**Response (200):**

```json
{
  "categories": [
    { "slug": "all", "label": "All", "count": 847 },
    { "slug": "politics", "label": "Politics", "count": 234 },
    { "slug": "economics", "label": "Economics", "count": 156 },
    { "slug": "crypto", "label": "Crypto", "count": 198 },
    { "slug": "sports", "label": "Sports", "count": 167 },
    { "slug": "entertainment", "label": "Entertainment", "count": 92 }
  ]
}
```

---

### `GET /api/v1/stats`

Returns platform-level aggregate statistics for the footer bar.

**Response (200):**

```json
{
  "total_markets": 847,
  "volume_24h": "$1.2B",
  "exchange_count": 4,
  "exchanges": ["kalshi", "polymarket", "manifold", "premarket"],
  "last_updated": "2026-03-02T14:30:00Z"
}
```

---

### `GET /health`

Health check endpoint (not versioned).

**Response (200):**

```json
{
  "status": "ok",
  "uptime_seconds": 3600,
  "db_connected": true,
  "last_score_computation": "2026-03-02T14:30:15Z"
}
```

---

## Ranking Algorithm

Markets are ranked by a composite score combining three normalized components. The score determines **default ordering** (used by volume sort as tiebreaker and ticker selection).

```
score = 0.55 × n + 0.30 × d + 0.15 × v
```

### Components

| Symbol | Weight | Name | Description |
|--------|--------|------|-------------|
| `n` | 0.55 (55%) | Notional activity | Recent trading notional value (price × quantity) over configurable trailing window (default 10 min) |
| `d` | 0.30 (30%) | Near-mid depth | Average band liquidity: `(bid + ask) / 2` near the midpoint |
| `v` | 0.15 (15%) | Volume breadth | `SUM(volume_traded)` from `market_latest_data` (24h cumulative volume) |

### Normalization (Spec V1: Max-Based)

Each component is normalized to [0, 1] using max-based normalization, clamped:

```
n_normalized = min(market.notional_recent / max(all_markets.notional_recent), 1)
d_normalized = min(market.depth / max(all_markets.depth), 1)
v_normalized = min(market.volume_24h / max(all_markets.volume_24h), 1)
```

Where:
- `notional_recent` = SUM(price × quantity) for all trades in the last X minutes (configurable via `RECENT_WINDOW_MINUTES`, default 10)
- `depth` = `(band_liquidity_qty_bid + band_liquidity_qty_ask) / 2` from `market_latest_data`
- `volume_24h` = `SUM(volume_traded)` from `market_latest_data`

### Matched Market Score Aggregation

For matched markets (same `canonical_market_id`), metrics are **combined** across exchanges:

```
matched.notional_recent = SUM across all exchanges (recent trades)
matched.depth = MAX of (bid + ask) / 2 across exchanges
matched.volume_24h = SUM of volume_traded across exchanges
```

### Sort Modes

| Sort | Behavior |
|------|----------|
| `score` (default) | `score DESC, updated_at DESC, id ASC` (Spec V1 sort order) |
| `closes_soon` | `end_date ASC NULLS LAST, updated_at DESC, id ASC` |

---

## Category Mapping

Kalshi uses 15 categories. These map to 5 named 17B categories (no "other" in UI pills):

| Kalshi Category | Record Count | 17B Category |
|---|---|---|
| Sports | 44,736 | `sports` |
| Crypto | 39,652 | `crypto` |
| Entertainment | 8,032 | `entertainment` |
| Politics | 6,228 | `politics` |
| Elections | 4,850 | `politics` |
| Economics | 4,802 | `economics` |
| Climate and Weather | 1,064 | (included in "All" only) |
| Mentions | 930 | (included in "All" only) |
| Financials | 924 | `economics` |
| Companies | 550 | `economics` |
| Science and Technology | 396 | (included in "All" only) |
| Social | 294 | (included in "All" only) |
| World | 268 | (included in "All" only) |
| Health | 44 | (included in "All" only) |
| Transportation | 2 | (included in "All" only) |

Markets in unmapped Kalshi categories appear in the "All" view but not under any named category pill.

**For matched markets:** Use the Kalshi side's category.

**For unmatched Polymarket markets:** Default to uncategorized (included in "All" only). Future: keyword-based category inference.

---

## Title Generation

### When

Title generation runs as part of the market-matcher cycle. After a match is confirmed (confidence >= 0.85), a second OpenAI call generates a unified title.

### Prompt Design

**System prompt:**
```
You are a financial market title editor. Given two prediction market titles from different exchanges
for the same real-world event, generate a single clean, concise title (max 80 characters) that:
1. Captures the core question being asked
2. Uses clear, plain English (no exchange-specific jargon)
3. Includes the key entity, action, and timeframe if present
4. Starts with a verb or question word when natural

Respond with JSON: { "title": "..." }
```

**User prompt:**
```
Kalshi: "{kalshi_title}"
Polymarket: "{polymarket_title}"
```

### Storage

Generated titles are stored in a new `market_titles` table:

| Field | Type | Description |
|-------|------|-------------|
| canonical_market_id | VARCHAR(50) | FK to market_mappings.canonical_market_id |
| generated_title | VARCHAR(500) | AI-generated unified title |
| kalshi_title | TEXT | Original Kalshi title (for reference) |
| polymarket_title | TEXT | Original Polymarket title (for reference) |
| model_id | VARCHAR(50) | Model used for generation |
| created_at | TIMESTAMPTZ | When title was generated |

### Fallback

If title generation fails (API timeout, invalid response), the Kalshi title is used as fallback. Titles can be regenerated later without affecting matches.

---

## Cursor-Based Pagination (Infinite Scroll)

The UI uses IntersectionObserver-based infinite scroll. The API implements cursor-based pagination underneath.

### Cursor Components

The cursor encodes three values for stable, stateless pagination:

For `score` sort (default):
```
cursor = base64({
  "s": <score>,           // number — last item's composite score
  "t": <updated_at>,      // ISO 8601 — last item's updated_at (tiebreaker)
  "i": <market_id>        // string — last item's id (final tiebreaker, ASC)
})
```

For `closes_soon` sort:
```
cursor = base64({
  "d": <end_date>,        // ISO 8601 — last item's end_date
  "t": <updated_at>,      // tiebreaker
  "i": <market_id>        // final tiebreaker (ASC)
})
```

### Market ID Strategy

| Market Type | ID Format | Example |
|-------------|-----------|---------|
| Matched (cross-exchange) | `canonical_market_id` | `CM-abc1234567890def` |
| Unmatched Kalshi | `K:{market_id}` | `K:FED-26MAR-T4.25` |
| Unmatched Polymarket | `P:{market_id}` | `P:0x1234abcd...` |

---

## Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `PORT` | HTTP listen port | `3100` |
| `HOST` | HTTP listen host | `0.0.0.0` |
| `DATABASE_URL` | PostgreSQL connection string | (required) |
| `DB_SCHEMA` | Database schema | `direct_exchanges_data` |
| `SCORE_INTERVAL_MS` | Score recomputation interval | `30000` (30s) |
| `RECENT_WINDOW_MINUTES` | Trailing window for recent trade notional (N metric) | `10` |
| `DEFAULT_PAGE_SIZE` | Default number of markets per page | `30` |
| `MAX_PAGE_SIZE` | Maximum allowed page size | `100` |
| `TICKER_SIZE` | Number of markets in ticker endpoint | `10` |
| `LOG_LEVEL` | Pino log level | `info` |
| `TITLE_GENERATION_MODEL` | OpenAI model for title generation | `gpt-5-nano` |

---

## Input Data

| Source | Table | Fields Used |
|--------|-------|-------------|
| Markets | `prediction_markets` | source_id, exchange_id, market_id, event_id, series_id, outcome_side, outcome_name, title, sub_title, category, price, end_date, status, updated_at |
| Metrics | `market_latest_data` | source_id, exchange_id, market_id, outcome_side, band_liquidity_qty_bid, band_liquidity_qty_ask, volume_traded, updated_at |
| Mappings | `market_mappings` | source_id, exchange_id, market_id, outcome_side, canonical_market_id, confidence_score |
| Trades | `trades` | source_id, exchange_id, market_id, price, quantity, entry_time |
| Titles | `market_titles` | canonical_market_id, generated_title |

---

## Output Data

| Table | Field | Type | Description |
|-------|-------|------|-------------|
| `market_scores` | id | VARCHAR(255) | Market ID (canonical or synthetic K:/P:) |
| `market_scores` | score | DOUBLE PRECISION | Composite ranking score (0.0–1.0) |
| `market_scores` | notional_24h | DOUBLE PRECISION | Raw 24h notional volume |
| `market_scores` | depth | DOUBLE PRECISION | Raw near-mid depth |
| `market_scores` | trades_24h | INTEGER | Raw trade count |
| `market_scores` | category | VARCHAR(50) | Mapped 17B category |
| `market_scores` | is_matched | BOOLEAN | Whether market has cross-exchange match |
| `market_scores` | volume_formatted | VARCHAR(20) | Pre-formatted volume string (e.g., "$21.3M") |
| `market_scores` | computed_at | TIMESTAMPTZ | When score was last computed |
| `market_titles` | canonical_market_id | VARCHAR(50) | Market pair identifier |
| `market_titles` | generated_title | VARCHAR(500) | AI-generated title |
| `market_titles` | model_id | VARCHAR(50) | Model used |

---

## Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| Market has no recent trades | `n` component = 0, score from `d` and `v` only |
| Market has no band liquidity data | `d` component = 0, score from `n` and `v` only |
| All three components are 0 | score = 0, market appears at bottom of ranking |
| Matched market where one exchange has no data | Use available exchange's data only |
| Category filter returns no results | Return empty `markets` array, `has_more: false` |
| Invalid cursor string | Return 400 with `"Invalid cursor"` message |
| Market closes during pagination | May disappear from results (acceptable for infinite scroll) |
| Score recomputation in progress during request | Serve from latest completed computation |
| Title generation fails for a match | Use Kalshi title as fallback |
| Exchange filter hides all exchanges for a market | Market excluded from results |
| Multi-outcome event with >10 outcomes | Return top 3 by price, note total count |
| Search query matches no markets | Return empty array |
| Price is null for an exchange on one outcome | Omit that exchange key from the outcome's prices map |
| Polymarket price (decimal 0-1) normalization | Multiply by 100 to get percentage |
| Kalshi price (cents 0-100) normalization | Use as-is (already percentage) |
| `closes_soon` sort with null end_date | Markets with null end_date appear last |
| `score` sort with equal scores | Fall back to `updated_at DESC`, then `id ASC` |

---

## Acceptance Criteria

- [x] `GET /api/v1/markets` returns markets with outcomes × exchanges price matrix
- [x] Multi-outcome events group related markets under one card
- [x] Binary (Yes/No) markets show two outcomes with per-exchange prices
- [x] Prices are in percentage format (0–100)
- [x] `category` filter correctly maps Kalshi categories to 17B taxonomy
- [x] `exchange` filter excludes markets not available on selected exchanges
- [x] `search` parameter filters by title (case-insensitive substring match)
- [x] `sort=score` orders by composite score descending (Spec V1)
- [x] `sort=closes_soon` orders by end_date ascending, null last
- [x] Cursor pagination produces no duplicates under stable data
- [x] `GET /api/v1/markets/ticker` returns pre-formatted ticker items
- [x] `GET /api/v1/categories` returns accurate counts per category
- [x] `GET /api/v1/stats` returns footer stats (total markets, 24h vol, exchange count)
- [x] `GET /health` returns database connectivity and last score computation time
- [x] Score recomputation runs every 30s without blocking API requests
- [x] Title generation produces clean, readable titles for matched markets
- [x] Title generation failure does not block matching or API responses
- [x] OpenAPI spec auto-generated at `/api/v1/docs`
- [x] Handles SIGTERM gracefully (drain in-flight requests)

---

## Examples

### Example 1: Multi-Outcome Matched Market

**Data:** "2028 US Presidential Democratic Nominee" exists on Kalshi, Polymarket, and Manifold. Each candidate is a separate binary market grouped by `event_id`. Markets are matched across exchanges via `market_mappings`.

**API response item:**
```json
{
  "id": "CM-pres2028dem",
  "title": "2028 US Presidential Democratic Nominee",
  "thumb": "🐴",
  "category": "politics",
  "end_date": "Aug 1, 2028",
  "volume": "$107.4M",
  "exchanges": ["kal", "man", "poly"],
  "outcomes": [
    { "label": "Gavin Newsom",          "prices": { "kal": 26, "man": 31, "poly": 27 } },
    { "label": "Kamala Harris",         "prices": { "kal": 6,  "man": 11, "poly": 7  } },
    { "label": "Alexandria Ocasio-Cor…", "prices": { "kal": 9,  "man": 11, "poly": 9  } }
  ]
}
```

**Best price highlighting (UI-side):** For "Gavin Newsom", Manifold (31%) is highlighted as best price.

### Example 2: Binary Market on Two Exchanges

**Data:** "Fed decision in March 2026 — no change?" on Kalshi and Polymarket.

**API response item:**
```json
{
  "id": "CM-fed26mar",
  "title": "Fed decision in March 2026 — no change?",
  "thumb": "🏦",
  "category": "economics",
  "end_date": "Mar 19, 2026",
  "volume": "$14.7M",
  "exchanges": ["kal", "poly"],
  "outcomes": [
    { "label": "No change",      "prices": { "kal": 91, "poly": 92 } },
    { "label": "25bps decrease", "prices": { "kal": 8,  "poly": 7  } }
  ]
}
```

### Example 3: Single-Exchange Market

**Data:** "2026 NHL Stanley Cup — Oilers?" exists only on Polymarket.

**API response item:**
```json
{
  "id": "P:nhl-oilers-2026",
  "title": "2026 NHL Stanley Cup — Oilers?",
  "thumb": "🏒",
  "category": "sports",
  "end_date": "Jun 2026",
  "volume": "$4.9M",
  "exchanges": ["poly"],
  "outcomes": [
    { "label": "Edmonton Oilers",  "prices": { "poly": 18 } },
    { "label": "Florida Panthers", "prices": { "poly": 14 } }
  ]
}
```

### Example 4: All-Exchange Market with Premarket

**Data:** "S&P 500 above 7000 by Dec 2026?" on all 4 exchanges.

**API response item:**
```json
{
  "id": "CM-sp500-7k",
  "title": "S&P 500 above 7000 by Dec 2026?",
  "thumb": "📈",
  "category": "economics",
  "end_date": "Dec 2026",
  "volume": "$15.2M",
  "exchanges": ["kal", "man", "poly", "pre"],
  "outcomes": [
    { "label": "Yes", "prices": { "kal": 44, "man": 48, "poly": 46, "pre": 42 } },
    { "label": "No",  "prices": { "kal": 56, "man": 52, "poly": 54, "pre": 58 } }
  ]
}
```

---

## Integration Test Scenarios

These tests run against the **deployed API** after each deployment to verify correctness. They hit real endpoints with real data.

### T1: Basic Markets Endpoint

```
GET /api/v1/markets
Assert:
  - Status 200
  - Response has "markets" array (non-empty)
  - Response has "has_more" boolean
  - Response has "total" integer > 0
  - Each market has: id, title, category, exchanges, outcomes
  - Each outcome has: label, prices (non-empty object)
  - All prices are numbers between 0 and 100
  - Markets are sorted by volume descending (first item has highest volume)
```

### T2: Category Filter

```
For each category in [politics, economics, crypto, sports, entertainment]:
  GET /api/v1/markets?category={cat}
  Assert:
    - Status 200
    - All returned markets have category == {cat}
    - Count matches GET /api/v1/categories count for that category
```

### T3: Exchange Filter

```
GET /api/v1/markets?exchange=kal
Assert:
  - Status 200
  - Every market has "kal" in its exchanges array
  - No market is returned that only has "poly" data

GET /api/v1/markets?exchange=kal,poly
Assert:
  - Status 200
  - Every market has at least "kal" or "poly" in its exchanges array
```

### T4: Search Filter

```
GET /api/v1/markets?search=bitcoin
Assert:
  - Status 200
  - Every returned market title contains "bitcoin" (case-insensitive)
  - No markets without "bitcoin" in title are returned
```

### T5: Sort Order — Score (Default)

```
GET /api/v1/markets?sort=score&limit=10
Assert:
  - Status 200
  - Markets are sorted by composite score descending
  - First market has the highest score
```

### T6: Sort Order — Closes Soon

```
GET /api/v1/markets?sort=closes_soon&limit=10
Assert:
  - Status 200
  - markets[0].end_date <= markets[1].end_date <= ... (chronological)
  - Markets with null end_date appear last
```

### T7: Pagination Consistency

```
page1 = GET /api/v1/markets?limit=5
page2 = GET /api/v1/markets?limit=5&cursor={page1.next_cursor}
Assert:
  - page1.has_more == true (if total > 5)
  - page2 markets are different from page1 markets (no duplicates)
  - All page1 market IDs ∩ page2 market IDs == ∅
  - page2 markets follow page1 in sort order
```

### T8: Pagination Exhaustion

```
Fetch all pages by following next_cursor until has_more == false
Assert:
  - Total collected market count == response.total (±5% tolerance for score changes)
  - No duplicate market IDs across all pages
```

### T9: Ticker Endpoint

```
GET /api/v1/markets/ticker
Assert:
  - Status 200
  - Response has "items" array
  - Each item has "tag" and "text" strings
  - items.length <= 10
  - At least one item references a known exchange (KAL, POLY)
```

### T10: Categories Endpoint

```
GET /api/v1/categories
Assert:
  - Status 200
  - Has "categories" array with at least 2 entries
  - First entry has slug "all"
  - Each category has slug, label, count
  - "all" count >= sum of other category counts
```

### T11: Stats Endpoint

```
GET /api/v1/stats
Assert:
  - Status 200
  - total_markets > 0
  - volume_24h is a non-empty string starting with "$"
  - exchange_count >= 2
  - exchanges array contains "kalshi" and "polymarket"
```

### T12: Health Check

```
GET /health
Assert:
  - Status 200
  - status == "ok"
  - db_connected == true
  - last_score_computation is a valid ISO 8601 timestamp within last 2 minutes
```

### T13: Error Handling

```
GET /api/v1/markets?category=invalid_category
Assert: Status 400

GET /api/v1/markets?limit=999
Assert: Status 400 (exceeds MAX_PAGE_SIZE)

GET /api/v1/markets?cursor=not_valid_base64
Assert: Status 400

GET /api/v1/markets?limit=0
Assert: Status 400
```

### T14: Price Normalization

```
GET /api/v1/markets?limit=5
Assert:
  - All prices in outcomes[].prices are integers or floats in range [0, 100]
  - No prices are in decimal (0-1) range (would indicate Polymarket not normalized)
  - No prices exceed 100
```

### T15: Default Returns Matched Markets Only

```
GET /api/v1/markets?limit=5
Assert:
  - Every market has exchanges.length >= 2 (matched by default)
  - At least one outcome has prices from 2+ exchanges
  - Market ID starts with "CM-"

GET /api/v1/markets?matched=all&limit=5
Assert:
  - May include both matched (CM-) and unmatched (K:/P:) markets

GET /api/v1/markets?matched=false&limit=5
Assert:
  - Every market has exchanges.length == 1
  - Market ID starts with "K:" or "P:"
```

### T16: Data Freshness

```
GET /health
Assert:
  - last_score_computation is within last 90 seconds (should recompute every 30s)

GET /api/v1/markets?limit=1
Assert:
  - updated_at is within the last 24 hours
```

---

## Notes

- The API defaults to matched markets only (`matched=true`). Use `matched=all` to include single-exchange markets, or `matched=false` for single-exchange only.
- Manifold and Premarket exchanges have no data ingestion yet — they appear in the UI mockup but will return no prices until ingestion is built.
- The UI handles view mode switching (cards vs rows) client-side — the API returns the same data for both views.
- Volume formatting (e.g., "$21.3M") is done server-side to match the UI's display format.
- The `thumb` field is an emoji string in Phase 1. Future: could be an image URL from exchange market metadata.
- The "+ N more Markets" count in the UI footer is computed client-side from category data.
- i18n (EN/ZH) is handled client-side; the API returns English-only data.
- Score is the primary sort key per Spec V1 (`score DESC, updated_at DESC, id ASC`). The score value is used internally for ranking and available in the `market_scores` table but not directly in the API market response.
