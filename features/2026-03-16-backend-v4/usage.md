# Usage: Backend V4

How to use and verify the Backend V4 features.

---

## Signals Subscribe

### Endpoint

`POST /api/v1/signals/subscribe`

### Request Body

```json
{
  "contact": "trader@example.com",
  "contact_type": "email",
  "signals": ["arb", "whale"]
}
```

- `contact_type` is optional — auto-detected from format (@ prefix = telegram, otherwise email)
- Valid signal types: `arb`, `whale`, `volume_spike`, `new_market`, `price_move`

### Response

```json
{
  "success": true,
  "subscription_id": "sub_42"
}
```

---

## Verification Queries

### 1. Check signal subscriptions

```sql
SELECT id, contact, contact_type, signals, is_active, created_at
FROM direct_exchanges_data.signal_subscriptions
ORDER BY created_at DESC
LIMIT 10;
```

### 2. Check search index exists

```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'direct_exchanges_data'
  AND indexname = 'idx_events_search_vector';
```

---

## API Testing

### Signal Subscribe (email)

```bash
curl -X POST https://marketsapi.17b.com/api/v1/signals/subscribe \
  -H "Content-Type: application/json" \
  -d '{"contact":"test@example.com","signals":["arb","whale"]}'
```

### Signal Subscribe (telegram)

```bash
curl -X POST https://marketsapi.17b.com/api/v1/signals/subscribe \
  -H "Content-Type: application/json" \
  -d '{"contact":"@mytelegram","signals":["arb"]}'
```

### Search events (title + subtitle)

```bash
curl "https://marketsapi.17b.com/api/v1/events?search=bitcoin"
```

### Sort by spread

```bash
curl "https://marketsapi.17b.com/api/v1/events?sort=spread"
curl "https://marketsapi.17b.com/api/v1/events?sort=spread&matched=true"
```

---

## Troubleshooting

### Rate limit hit (429)

The endpoint allows 10 requests per hour per IP. Wait for the window to reset or test from a different IP.

### Search not finding subtitle matches

Verify the GIN index was created:
```sql
SELECT indexname FROM pg_indexes
WHERE schemaname = 'direct_exchanges_data'
  AND indexname = 'idx_events_search_vector';
```

If missing, create it:
```sql
CREATE INDEX IF NOT EXISTS idx_events_search_vector
ON direct_exchanges_data.events
USING gin(to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(subtitle, '')));
```
