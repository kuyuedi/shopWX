# Feature: Arb API v7

**Status**: DEPLOYED
**Priority**: High
**Created**: 2026-03-12

---

## Summary

Enhance `GET /api/v1/arb` with enriched response fields, sub-type filtering, APY calculations, per-leg depth, trade URLs, spread direction, and type counts to power the v7 Arb Page frontend.

---

## Problem

The current API returns flat DB rows with raw leg data (leg1_vwap, leg2_liquidity_qty, etc.). The v7 Arb Page PRD requires:
- Structured `legs[]` array with per-leg depth bars, trade URLs, and exchange branding
- APY derived from spread + days to expiry
- Sub-type tabs (Cross-Platform, Time Decay, Liquidity Gap) with badge counts
- Spread direction indicator (up/down/flat)
- Sort by APY
- Scan metadata (last_scan_at, total_markets_streaming)

The frontend should not need to compute any of these — the API provides everything ready to render.

---

## Solution

Replace the response shape of `GET /api/v1/arb` in-place (only our frontend consumes it). Add:
1. Structured `legs[]` array with depth + trade URLs per leg
2. Computed `apy` and `days_to_expiry` fields
3. `spread_direction` derived from `prev_gross_spread_pct`
4. `arb_subtype` + `subtype_note` from the classification feature
5. New query params: `sort=apy`, `subtype` filter
6. `counts` object for tab badges
7. `meta` object with scan metadata

---

## Algorithm / Logic

### APY Calculation (query-time, server-side)

```
days_to_expiry = (expires_at - NOW()) / 86400000   // in milliseconds → days
apy = gross_spread_pct * (365 / days_to_expiry)

// Null cases:
IF expires_at IS NULL → apy = NULL, days_to_expiry = NULL
IF expires_at <= NOW() (expired) → apy = NULL, days_to_expiry = 0
IF days_to_expiry < 1 → cap days_to_expiry at 1 to prevent extreme APY values
```

APY is computed in the SQL query or application layer, not stored. This ensures it's always fresh relative to the current time.

### Spread Direction (query-time)

```
spread_direction = CASE
  WHEN prev_gross_spread_pct IS NULL THEN 'flat'
  WHEN gross_spread_pct > prev_gross_spread_pct THEN 'up'
  WHEN gross_spread_pct < prev_gross_spread_pct THEN 'down'
  ELSE 'flat'
END
```

### Subtype Note (query-time)

```
subtype_note = CASE arb_subtype
  WHEN 'TIME_DECAY' THEN 'Complement arb expiring within 14 days — spread may compress as expiry approaches'
  WHEN 'LIQUIDITY_GAP' THEN 'Same-side price discrepancy across exchanges'
  ELSE NULL
END
```

### Trade URL Construction

```
Kalshi:      'https://kalshi.com/markets/' || leg_market_id
Polymarket:  'https://polymarket.com/event/' || event_slug
             (requires JOIN: prediction_markets → events via event_id to get event slug)
Opinion:     NULL  (exchange not yet active, TBD)
```

For Polymarket, the event slug is derived from the `event_id` in the `events` table. The `events.source_specific_data` JSONB may contain a slug field, or the `event_id` itself may be the slug. This needs verification during implementation.

### Leg Depth Fields

Per-leg depth data comes from the existing `band_liquidity_qty_ask` / `band_liquidity_qty_bid` fields in `market_latest_data`, joined during the v7 query:

```
depth_qty = band_liquidity_qty relevant to the leg's action:
  - BUY action  → band_liquidity_qty_ask (available to buy into)
  - SELL action → band_liquidity_qty_bid (available to sell into)

depth_usd = depth_qty * leg_vwap

low_liquidity = depth_qty < 100 OR depth_usd < 50
```

### Exchange Short Names

```
KALSHI       → 'K'
POLYMARKET   → 'P'
OPINION      → 'O'
```

### Price Formatting

```
price_cents  = ROUND(leg_vwap * 100)        // e.g., 12
price_decimal = leg_vwap                      // e.g., 0.12
```

### Type Counts Query

```sql
SELECT
  COUNT(*) AS all,
  COUNT(*) FILTER (WHERE arb_subtype = 'CROSS_PLATFORM') AS cross_platform,
  COUNT(*) FILTER (WHERE arb_subtype = 'TIME_DECAY') AS time_decay,
  COUNT(*) FILTER (WHERE arb_subtype = 'LIQUIDITY_GAP') AS liquidity_gap
FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE'
```

This runs as part of the main query (or a parallel query) and is returned in every response.

### Scan Metadata

```sql
-- last_scan_at: most recent updated_at across all ACTIVE arbs
SELECT MAX(last_checked_at) AS last_scan_at
FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE'

-- total_markets_streaming: count of markets with fresh data
SELECT COUNT(DISTINCT market_id)
FROM direct_exchanges_data.market_latest_data
WHERE updated_at > NOW() - INTERVAL '60 seconds'
```

---

## Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `apy_min_days` | Minimum days_to_expiry before capping APY calculation | `1` |
| `low_liquidity_qty_threshold` | Contracts below this = low_liquidity flag | `100` |
| `low_liquidity_usd_threshold` | USD below this = low_liquidity flag | `50` |

---

## Input Data

| Source | Table | Fields Used |
|--------|-------|-------------|
| Arb opportunities | `arb_opportunities` | All existing fields + `arb_subtype`, `prev_gross_spread_pct` |
| Live depth data | `market_latest_data` | `band_liquidity_qty_ask`, `band_liquidity_qty_bid`, `band_vwap_ask`, `band_vwap_bid` |
| Market metadata | `prediction_markets` | `market_id`, `event_id`, `exchange_id` |
| Event data | `events` | `event_id`, `source_specific_data` (for Polymarket slug) |

### V7 Query (conceptual)

The main query joins `arb_opportunities` with `market_latest_data` (for live depth per leg) and `events` (for Polymarket trade URLs):

```sql
SELECT
  ao.*,
  -- Leg 1 depth
  mld1.band_liquidity_qty_ask AS leg1_depth_qty_ask,
  mld1.band_liquidity_qty_bid AS leg1_depth_qty_bid,
  -- Leg 2 depth
  mld2.band_liquidity_qty_ask AS leg2_depth_qty_ask,
  mld2.band_liquidity_qty_bid AS leg2_depth_qty_bid,
  -- Polymarket event slug (for trade URL)
  e_poly.event_id AS poly_event_slug
FROM direct_exchanges_data.arb_opportunities ao
-- Leg 1 live depth
LEFT JOIN direct_exchanges_data.market_latest_data mld1
  ON ao.leg1_source_id = mld1.source_id
 AND ao.leg1_exchange_id = mld1.exchange_id
 AND ao.leg1_market_id = mld1.market_id
 AND ao.leg1_side = mld1.outcome_side
-- Leg 2 live depth
LEFT JOIN direct_exchanges_data.market_latest_data mld2
  ON ao.leg2_source_id = mld2.source_id
 AND ao.leg2_exchange_id = mld2.exchange_id
 AND ao.leg2_market_id = mld2.market_id
 AND ao.leg2_side = mld2.outcome_side
-- Polymarket event slug for trade URL
LEFT JOIN direct_exchanges_data.prediction_markets pm_poly
  ON (ao.leg1_exchange_id = 'POLYMARKET' AND ao.leg1_market_id = pm_poly.market_id AND ao.leg1_source_id = pm_poly.source_id AND ao.leg1_side = pm_poly.outcome_side)
  OR (ao.leg2_exchange_id = 'POLYMARKET' AND ao.leg2_market_id = pm_poly.market_id AND ao.leg2_source_id = pm_poly.source_id AND ao.leg2_side = pm_poly.outcome_side)
LEFT JOIN direct_exchanges_data.events e_poly
  ON pm_poly.source_id = e_poly.source_id
 AND pm_poly.exchange_id = e_poly.exchange_id
 AND pm_poly.event_id = e_poly.event_id
WHERE ao.status = 'ACTIVE'
ORDER BY ao.gross_spread_pct DESC
```

Note: The actual query will be refined during implementation. The Polymarket event JOIN in particular may need adjustment based on actual `event_id`/slug format.

---

## Output Data

### Full Response Shape

```typescript
interface ArbV7Response {
  arbs: ArbV7[];
  next_cursor: string | null;
  has_more: boolean;
  total: number;
  counts: {
    all: number;
    cross_platform: number;
    time_decay: number;
    liquidity_gap: number;
  };
  meta: {
    last_scan_at: string;            // ISO 8601
    total_markets_streaming: number;
  };
}

interface ArbV7 {
  // Identity
  arb_id: number;
  market_title: string;
  category: string | null;

  // Classification
  arb_type: 'DIRECT' | 'COMPLEMENT';
  arb_subtype: 'CROSS_PLATFORM' | 'TIME_DECAY' | 'LIQUIDITY_GAP';

  // Spread
  gross_spread_pct: number;    // e.g., 0.031 = 3.1%
  gross_spread: number;        // raw price difference, e.g., 0.03
  gross_profit: number;        // spread * executable_qty in USD
  executable_qty: number;

  // Time value
  apy: number | null;          // annualized return, e.g., 8.92 = 892%
  days_to_expiry: number | null;
  expires_at: string | null;   // ISO 8601

  // Direction
  spread_direction: 'up' | 'down' | 'flat';

  // Timestamps
  updated_at: string;          // ISO 8601
  detected_at: string;         // ISO 8601

  // Confidence
  mapping_confidence: number;

  // Sub-type context
  subtype_note: string | null;

  // Legs (always 2 for v7; multi-leg = future)
  legs: ArbV7Leg[];
}

interface ArbV7Leg {
  exchange: string;            // 'KALSHI' | 'POLYMARKET' | 'OPINION'
  exchange_short: string;      // 'K' | 'P' | 'O'
  action: string;              // 'BUY' | 'SELL'
  side: 'YES' | 'NO';

  // Price
  price_cents: number;         // e.g., 12
  price_decimal: number;       // e.g., 0.12

  // Depth
  depth_qty: number | null;    // contracts available
  depth_usd: number | null;    // depth_qty * price_decimal
  low_liquidity: boolean;      // true if depth below thresholds

  // Trade link
  trade_url: string | null;    // direct link to trade on exchange
}
```

### Query Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `sort` | string | `spread` | `spread` (gross_spread_pct DESC), `profit` (gross_profit DESC), `detected` (detected_at DESC), `apy` (apy DESC NULLS LAST) |
| `category` | string | — | Filter by market category |
| `arb_type` | string | — | `DIRECT` or `COMPLEMENT` |
| `subtype` | string | — | `CROSS_PLATFORM`, `TIME_DECAY`, or `LIQUIDITY_GAP` |
| `limit` | number | `20` | Page size (max 100) |
| `cursor` | string | — | arb_id for cursor-based pagination |

---

## Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| `expires_at` is NULL | `apy` = null, `days_to_expiry` = null |
| Market already expired | `apy` = null, `days_to_expiry` = 0 |
| `days_to_expiry` < 1 day | Cap at 1 to prevent extreme APY (e.g., 36,500%) |
| Leg has no depth data (market_latest_data missing) | `depth_qty` = null, `depth_usd` = null, `low_liquidity` = true |
| Exchange has no trade URL pattern (Opinion) | `trade_url` = null |
| Polymarket event slug unavailable | `trade_url` = null (graceful degradation) |
| `arb_subtype` is NULL (un-backfilled row) | Default to 'CROSS_PLATFORM' in API response |
| `sort=apy` with NULL APY values | NULL APY sorts last (NULLS LAST) |
| No active arbs | Return `{ arbs: [], counts: { all: 0, ... }, meta: { ... } }` |

---

## Acceptance Criteria

- [ ] Response matches the `ArbV7Response` shape above
- [ ] Each arb includes structured `legs[]` array (2 legs per arb)
- [ ] `apy` is computed correctly from `gross_spread_pct` and `expires_at`
- [ ] `spread_direction` is derived from `prev_gross_spread_pct`
- [ ] `trade_url` is populated for Kalshi and Polymarket legs
- [ ] `depth_qty`, `depth_usd`, and `low_liquidity` are populated per leg
- [ ] `counts` object returns accurate per-subtype counts
- [ ] `meta.last_scan_at` and `meta.total_markets_streaming` are populated
- [ ] `sort=apy` sorts by annualized return descending
- [ ] `subtype` query param filters by arb_subtype
- [ ] `subtype_note` is populated for TIME_DECAY and LIQUIDITY_GAP arbs
- [ ] Pagination (cursor + limit) works correctly
- [ ] Existing `sort`, `category`, `arb_type` params continue to work

---

## Examples

### Example 1: Complement Arb (Cross-Platform, with APY)

**Request:**
```
GET /api/v1/arb?sort=apy&limit=1
```

**Response:**
```json
{
  "arbs": [{
    "arb_id": 42,
    "market_title": "Will Bitcoin exceed $150K by Dec 31, 2026?",
    "category": "crypto",
    "arb_type": "COMPLEMENT",
    "arb_subtype": "CROSS_PLATFORM",
    "gross_spread_pct": 0.031,
    "gross_spread": 0.03,
    "gross_profit": 4.50,
    "executable_qty": 150,
    "apy": 8.92,
    "days_to_expiry": 294,
    "expires_at": "2026-12-31T00:00:00Z",
    "spread_direction": "up",
    "updated_at": "2026-03-12T14:30:00Z",
    "detected_at": "2026-03-12T14:25:00Z",
    "mapping_confidence": 0.97,
    "subtype_note": null,
    "legs": [
      {
        "exchange": "KALSHI",
        "exchange_short": "K",
        "action": "BUY",
        "side": "YES",
        "price_cents": 12,
        "price_decimal": 0.12,
        "depth_qty": 842,
        "depth_usd": 101.04,
        "low_liquidity": false,
        "trade_url": "https://kalshi.com/markets/KXBTC150K2026"
      },
      {
        "exchange": "POLYMARKET",
        "exchange_short": "P",
        "action": "BUY",
        "side": "NO",
        "price_cents": 85,
        "price_decimal": 0.85,
        "depth_qty": 1204,
        "depth_usd": 1023.40,
        "low_liquidity": false,
        "trade_url": "https://polymarket.com/event/bitcoin-150k-2026"
      }
    ]
  }],
  "next_cursor": null,
  "has_more": false,
  "total": 1,
  "counts": {
    "all": 12,
    "cross_platform": 7,
    "time_decay": 3,
    "liquidity_gap": 2
  },
  "meta": {
    "last_scan_at": "2026-03-12T14:30:05Z",
    "total_markets_streaming": 46200
  }
}
```

### Example 2: Time Decay Arb (APY boosted by short expiry)

**Request:**
```
GET /api/v1/arb?subtype=TIME_DECAY&sort=apy
```

**Response (first arb):**
```json
{
  "arbs": [{
    "arb_id": 87,
    "market_title": "Will the Fed cut rates at June 2026 meeting?",
    "category": "economics",
    "arb_type": "COMPLEMENT",
    "arb_subtype": "TIME_DECAY",
    "gross_spread_pct": 0.018,
    "gross_spread": 0.02,
    "gross_profit": 8.16,
    "executable_qty": 408,
    "apy": 6.46,
    "days_to_expiry": 10,
    "expires_at": "2026-03-22T00:00:00Z",
    "spread_direction": "down",
    "updated_at": "2026-03-12T14:30:00Z",
    "detected_at": "2026-03-12T13:00:00Z",
    "mapping_confidence": 0.99,
    "subtype_note": "Complement arb expiring within 14 days \u2014 spread may compress as expiry approaches",
    "legs": [
      {
        "exchange": "KALSHI",
        "exchange_short": "K",
        "action": "BUY",
        "side": "YES",
        "price_cents": 91,
        "price_decimal": 0.91,
        "depth_qty": 518,
        "depth_usd": 471.38,
        "low_liquidity": false,
        "trade_url": "https://kalshi.com/markets/KXFEDRATE-26JUN"
      },
      {
        "exchange": "POLYMARKET",
        "exchange_short": "P",
        "action": "BUY",
        "side": "NO",
        "price_cents": 7,
        "price_decimal": 0.07,
        "depth_qty": 402,
        "depth_usd": 28.14,
        "low_liquidity": true,
        "trade_url": "https://polymarket.com/event/fed-rate-cut-june-2026"
      }
    ]
  }],
  "next_cursor": "86",
  "has_more": true,
  "total": 3,
  "counts": {
    "all": 12,
    "cross_platform": 7,
    "time_decay": 3,
    "liquidity_gap": 2
  },
  "meta": {
    "last_scan_at": "2026-03-12T14:30:05Z",
    "total_markets_streaming": 46200
  }
}
```

### Example 3: Liquidity Gap (Direct Arb, no APY possible — expired market edge case)

**Response (arb object):**
```json
{
  "arb_id": 103,
  "market_title": "Will Apple announce AR glasses at WWDC 2026?",
  "arb_type": "DIRECT",
  "arb_subtype": "LIQUIDITY_GAP",
  "gross_spread_pct": 0.042,
  "apy": null,
  "days_to_expiry": null,
  "expires_at": null,
  "spread_direction": "up",
  "subtype_note": "Same-side price discrepancy across exchanges",
  "legs": [
    {
      "exchange": "KALSHI",
      "exchange_short": "K",
      "action": "BUY",
      "side": "YES",
      "price_cents": 38,
      "price_decimal": 0.38,
      "depth_qty": 47,
      "depth_usd": 17.86,
      "low_liquidity": true,
      "trade_url": "https://kalshi.com/markets/KXAAPL-AR-WWDC"
    },
    {
      "exchange": "POLYMARKET",
      "exchange_short": "P",
      "action": "SELL",
      "side": "YES",
      "price_cents": 42,
      "price_decimal": 0.42,
      "depth_qty": 890,
      "depth_usd": 373.80,
      "low_liquidity": false,
      "trade_url": "https://polymarket.com/event/apple-ar-wwdc-2026"
    }
  ]
}
```

---

## Frontend Implementation Guide

This section documents how the frontend should render each section of the v7 arb card using the API response. **No frontend code is in scope for this feature — this is a reference for the frontend team.**

### Card Header
- **Title:** `market_title`
- **Badge:** Render `arb_subtype` as colored badge (Cross-Platform = cyan, Time Decay = amber, Liquidity Gap = blue)
- **Spread:** Format `gross_spread_pct` as percentage with `+` prefix (e.g., `+3.1%`)
- **APY badge:** Show `apy` formatted as percentage if non-null. Tooltip: "Annualized return if spread held to expiry"
- **Freshness:** `updated_at` as relative time ("2s ago"). Show `spread_direction` as arrow icon (up = green triangle, down = red triangle, flat = hidden)

### Cost Breakdown (COMPLEMENT arbs only)
- Show per-leg cost: `legs[0].price_cents` + `legs[1].price_cents` = total
- "Payout is always $1.00"
- Edge = $1.00 - total cost (fees are frontend-computed from known fee rates)

### Per-Leg Cards
- Exchange icon: Use `exchange_short` (K/P/O) with exchange color
- Action badge: `action` + `side` (e.g., "BUY YES", "BUY NO", "SELL YES")
- Price: `price_cents` + "c" suffix
- Depth bar: `depth_qty` / max depth across legs = bar fill %. Show `depth_qty` contracts + `depth_usd` formatted
- Low liquidity warning: If `low_liquidity` = true, add warning icon
- Trade button: Link to `trade_url`. If null, show disabled button

### Calculate Returns (100% frontend)
- Input: user enters dollar amount
- Split: proportional to leg prices
- Shares: `Math.floor(investment / combined_cost_per_share)`
- Profit: `shares * spread`
- This section requires NO API data beyond what's already in the response

### Tab Badges
- Use `counts.cross_platform`, `counts.time_decay`, `counts.liquidity_gap` for tab badge numbers
- `counts.all` for the "All" tab

### Multi-Leg Arbs (Coming Soon)
- When `legs.length > 2`, render with the `.multi-leg` card style
- Not yet implemented in API — placeholder for future 3+ exchange arbs

---

## OpenAPI 3.0 Spec

```yaml
openapi: 3.0.3
info:
  title: 17B Arb API v7
  version: "7.0"
paths:
  /api/v1/arb:
    get:
      summary: List active arbitrage opportunities
      parameters:
        - name: sort
          in: query
          schema:
            type: string
            enum: [spread, profit, detected, apy]
            default: spread
        - name: category
          in: query
          schema:
            type: string
        - name: arb_type
          in: query
          schema:
            type: string
            enum: [DIRECT, COMPLEMENT]
        - name: subtype
          in: query
          schema:
            type: string
            enum: [CROSS_PLATFORM, TIME_DECAY, LIQUIDITY_GAP]
        - name: limit
          in: query
          schema:
            type: integer
            default: 20
            maximum: 100
        - name: cursor
          in: query
          schema:
            type: string
      responses:
        '200':
          description: Arb opportunities with enriched data
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ArbV7Response'
components:
  schemas:
    ArbV7Response:
      type: object
      required: [arbs, has_more, total, counts, meta]
      properties:
        arbs:
          type: array
          items:
            $ref: '#/components/schemas/ArbV7'
        next_cursor:
          type: string
          nullable: true
        has_more:
          type: boolean
        total:
          type: integer
        counts:
          type: object
          required: [all, cross_platform, time_decay, liquidity_gap]
          properties:
            all:
              type: integer
            cross_platform:
              type: integer
            time_decay:
              type: integer
            liquidity_gap:
              type: integer
        meta:
          type: object
          required: [last_scan_at, total_markets_streaming]
          properties:
            last_scan_at:
              type: string
              format: date-time
            total_markets_streaming:
              type: integer
    ArbV7:
      type: object
      required: [arb_id, market_title, arb_type, arb_subtype, gross_spread_pct,
                 gross_spread, gross_profit, executable_qty, spread_direction,
                 updated_at, detected_at, mapping_confidence, legs]
      properties:
        arb_id:
          type: integer
        market_title:
          type: string
        category:
          type: string
          nullable: true
        arb_type:
          type: string
          enum: [DIRECT, COMPLEMENT]
        arb_subtype:
          type: string
          enum: [CROSS_PLATFORM, TIME_DECAY, LIQUIDITY_GAP]
        gross_spread_pct:
          type: number
          description: "Spread as decimal (0.031 = 3.1%)"
        gross_spread:
          type: number
        gross_profit:
          type: number
        executable_qty:
          type: integer
        apy:
          type: number
          nullable: true
          description: "Annualized return (8.92 = 892%)"
        days_to_expiry:
          type: number
          nullable: true
        expires_at:
          type: string
          format: date-time
          nullable: true
        spread_direction:
          type: string
          enum: [up, down, flat]
        updated_at:
          type: string
          format: date-time
        detected_at:
          type: string
          format: date-time
        mapping_confidence:
          type: number
        subtype_note:
          type: string
          nullable: true
        legs:
          type: array
          items:
            $ref: '#/components/schemas/ArbV7Leg'
    ArbV7Leg:
      type: object
      required: [exchange, exchange_short, action, side, price_cents, price_decimal, low_liquidity]
      properties:
        exchange:
          type: string
        exchange_short:
          type: string
        action:
          type: string
          enum: [BUY, SELL]
        side:
          type: string
          enum: [YES, NO]
        price_cents:
          type: integer
        price_decimal:
          type: number
        depth_qty:
          type: integer
          nullable: true
        depth_usd:
          type: number
          nullable: true
        low_liquidity:
          type: boolean
        trade_url:
          type: string
          nullable: true
```

---

## Files to Modify

| File | Change |
|------|--------|
| `packages/homepage-api/src/routes/arb.ts` | Replace response shape, add subtype/apy sort/filter, add counts + meta |
| `packages/homepage-api/src/types.ts` | Add `ArbV7Response`, `ArbV7`, `ArbV7Leg` interfaces |
| `packages/shared/src/db/queries.ts` | Add v7 query with JOINs for depth + trade URLs, add counts query |

---

## Notes

- **Exchange APY:** The PRD mockup shows a "Kalshi offers 5.2% APY" tooltip. Kalshi does not currently expose APY/yield data via their API. This is **not implemented** in v7. If Kalshi adds yield data in the future, it can be added as an `exchange_apy` field on the leg.
- **Multi-Leg arbs:** The `legs[]` array supports >2 legs by design, but the current scanner only produces 2-leg arbs. Multi-leg (3+ exchange) arbs require active markets on 3+ exchanges and are documented as "Coming Soon."
- **Calculate Returns:** 100% frontend logic. The API provides all necessary inputs (leg prices, spread, executable_qty). No server-side calculation endpoint needed.
- **APY is informational only** — it assumes the spread persists until expiry, which is unlikely. The tooltip should communicate this.
- **This replaces the existing `/api/v1/arb` response** in-place. The existing `/:id/refresh` endpoint is unchanged.
- Depends on: `2026-03-12-arb-subtype-classification` (must be implemented first for `arb_subtype` and `prev_gross_spread_pct` columns).
