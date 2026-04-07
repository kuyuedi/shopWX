# Technical: Backend V4

Technical implementation details for signals subscribe, search enhancement, and spread sort.

---

## Database Schema Changes

### New Tables

```sql
CREATE TABLE IF NOT EXISTS direct_exchanges_data.signal_subscriptions (
  id SERIAL PRIMARY KEY,
  contact VARCHAR(255) NOT NULL,
  contact_type VARCHAR(10) NOT NULL CHECK (contact_type IN ('email', 'telegram')),
  signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unsubscribe_token UUID NOT NULL DEFAULT gen_random_uuid()
);
CREATE UNIQUE INDEX idx_signal_sub_contact ON direct_exchanges_data.signal_subscriptions(contact);
CREATE INDEX idx_signal_sub_active ON direct_exchanges_data.signal_subscriptions(is_active);
CREATE UNIQUE INDEX idx_signal_sub_unsub_token ON direct_exchanges_data.signal_subscriptions(unsubscribe_token);
```

### New Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_events_search_vector
ON direct_exchanges_data.events
USING gin(to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(subtitle, '')));
```

---

## Data Flow

### Signals Subscribe
```
┌──────────────┐     ┌──────────────┐     ┌──────────────────────┐
│  HTTP POST   │ --> │  Validate +  │ --> │ signal_subscriptions  │
│  Request     │     │  Rate Limit  │     │      (upsert)        │
└──────────────┘     └──────────────┘     └──────────────────────┘
```

### Spread Sort
```
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│   events +   │ --> │ market_mappings + │ --> │  Compute max │
│ event_mappings│     │ prediction_markets│     │   spread     │
└──────────────┘     └──────────────────┘     └──────────────┘
```

---

## Dependencies

### Prerequisites

1. Database migration must be run (signal_subscriptions table + GIN index)

### Runtime Dependencies

| Component | Required For |
|-----------|-------------|
| homepage-api | All three endpoints |
| PostgreSQL | Data storage and queries |

---

## Migration Checklist

- [x] Run signal_subscriptions table creation SQL
- [x] Run GIN index creation SQL
- [x] Deploy homepage-api
- [x] Verify endpoints with curl

---

## Rollback Plan

```sql
-- Rollback signal_subscriptions
DROP TABLE IF EXISTS direct_exchanges_data.signal_subscriptions;

-- Rollback GIN index
DROP INDEX IF EXISTS direct_exchanges_data.idx_events_search_vector;
```

---

## Performance Considerations

- GIN index on `to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(subtitle, ''))` for fast full-text search
- Spread sort uses a subquery joining market_mappings + market_latest_data; performance is acceptable for the current dataset size (~46k events)
- In-memory rate limiting avoids additional DB queries; state is lost on restart (acceptable)
