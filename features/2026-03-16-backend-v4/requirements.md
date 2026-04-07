# Feature: Backend V4 — Signals Subscribe, Search Enhancement, Spread Sort

**Status**: DEPLOYED
**Priority**: High
**Created**: 2026-03-16

---

## Summary

Three backend deliverables for Homepage V4: a signals subscription endpoint, full-text search enhancement, and sort-by-spread for the events API.

---

## Problem

1. Users need a way to subscribe to trading signals (arb alerts, whale trades, etc.) via email or Telegram.
2. Full-text search currently only covers event title, but should also search subtitle.
3. Frontend needs to sort events by cross-exchange spread to surface arbitrage opportunities.

---

## Solution

### P0: POST /api/v1/signals/subscribe
- Accept contact info (email or Telegram handle) and an array of signal types
- Auto-detect contact type from format
- Upsert into `signal_subscriptions` table (merge signals on conflict)
- In-memory rate limiting (10 requests/hour per IP)

### P1: Full-text search enhancement
- Extend `to_tsvector` to include `subtitle` in addition to `title`
- Add GIN index for performance

### P1: GET /api/v1/events?sort=spread
- New sort option computing max cross-exchange spread per event
- Events with matched markets across exchanges sorted by largest spread first
- Single-exchange events get spread = 0, sort to bottom

---

## Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| Rate limit max requests | Max signal subscribe requests per IP per hour | 10 |
| Rate limit window | Time window for rate limiting | 1 hour |

---

## Input Data

| Source | Table/API | Fields Used |
|--------|-----------|-------------|
| Signal subscription request | HTTP POST body | contact, contact_type, signals |
| Events search | events table | title, subtitle |
| Spread sort | market_latest_data, market_mappings | band_vwap_bid, band_vwap_ask |

---

## Output Data

| Table | Field | Type | Description |
|-------|-------|------|-------------|
| signal_subscriptions | contact | VARCHAR(255) | Email or Telegram handle |
| signal_subscriptions | contact_type | VARCHAR(10) | 'email' or 'telegram' |
| signal_subscriptions | signals | JSONB | Array of signal types |
| signal_subscriptions | is_active | BOOLEAN | Whether subscription is active |
| signal_subscriptions | unsubscribe_token | UUID | Token for unsubscribe link |

---

## Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| Duplicate contact | Upsert — merge signals, reactivate if inactive |
| Invalid email format | Return 400 with validation error |
| Invalid telegram handle | Return 400 with validation error |
| Empty signals array | Return 400 with validation error |
| Rate limit exceeded | Return 429 |
| No matched markets for spread sort | spread = 0, sorted to bottom |

---

## Acceptance Criteria

- [x] POST /api/v1/signals/subscribe accepts email and telegram contacts
- [x] Auto-detects contact_type when omitted
- [x] Rate limits to 10 requests/hour per IP
- [x] Upserts on duplicate contact
- [x] Full-text search covers title and subtitle
- [x] GIN index created for search performance
- [x] sort=spread returns events ordered by max cross-exchange spread
- [x] Single-exchange events sort to bottom with sort=spread

---

## Examples

### Example 1: Signal Subscribe (email)

**Request:**
```json
POST /api/v1/signals/subscribe
{
  "contact": "trader@example.com",
  "signals": ["arb", "whale"]
}
```

**Response:**
```json
{
  "success": true,
  "subscription_id": "sub_42"
}
```

### Example 2: Sort by spread

**Request:**
```
GET /api/v1/events?sort=spread&matched=true
```

**Response:** Events ordered by largest cross-exchange price spread.
