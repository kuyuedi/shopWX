# Event-Level Matching — Requirements

## Problem

The current market-matcher matches markets 1-to-1 across Kalshi and Polymarket. This has two issues:

1. **Inefficient**: Every Kalshi market is compared against every Polymarket market (O(n*m) AI calls)
2. **Wrong frontend structure**: Produces one card per market instead of one card per event with multiple outcomes

## Solution

Switch to event-level matching:
1. Match events first (fewer, higher-signal comparisons)
2. Match markets only within matched events (dramatically reduced scope)
3. Frontend displays one box per event with multiple outcomes underneath

## Phases

### Phase 1: Event Ingestion (this phase)

- Create `events` table in the database
- Pull and persist events from both Kalshi and Polymarket
- Extract event data alongside market data during existing sync cycles
- Remove the current `market-matcher` package (replaced by event matching in Phase 2)
- Keep existing `market_mappings` and `market_titles` tables (valid data used by homepage-api)

### Phase 2: Event Matching (IMPLEMENTED)

- [x] Analyze ingested event data to determine optimal pre-filtering strategy
- [x] Build `event_mappings` table for cross-exchange event matching
- [x] Concurrent worker pool (20 workers) with OpenAI rate limiting via response headers
- [x] Rate limiting via `x-ratelimit-remaining-*` / `x-ratelimit-limit-*` OpenAI headers (gate at 90% capacity)
- [x] Match markets inline immediately after each event match (see `features/2026-03-04-market-within-event-matching/`)
- [x] Recheck interval: unmatched events skipped for 24h via `match_checked_at` column (`MATCHER_RECHECK_INTERVAL_MS`)
- [x] Homepage-api `/api/v1/events` endpoint with matched/unmatched filtering

## Data Sources

### Kalshi Events

- API: `GET /events?with_nested_markets=true&status=open`
- Already fetched during market sync (events with nested markets)
- Event fields: `event_ticker`, `series_ticker`, `category`, `title`, `sub_title`, `strike_date`, `mutually_exclusive`, `strike_period`, `collateral_return_type`

### Polymarket Events

- API: `GET /events?active=true&closed=false&limit=100`
- Switch from separate `/markets` + `/events` fetches to unified `/events` with nested markets
- Event fields: `id`, `title`, `subtitle`, `endDate`, `image`, `slug`, `negRisk`, `enableNegRisk`, `volume`, `liquidity`, `volume24hr`, `categories[]`, `series[]`, `tags[]`

## Routine Operation

There is no separate "initial" vs "routine" mode. The matcher runs the same cycle every 5 minutes (`MATCHER_INTERVAL_MS`):

1. **First run:** Most events are unmatched, so the cycle processes many events across multiple cycles (rate-limited by OpenAI)
2. **Steady state:** Only newly-appeared events from either exchange are eligible — they get picked up in the next cycle
3. **On event match:** Markets within the matched event pair are matched inline immediately (see `features/2026-03-04-market-within-event-matching/`)
4. **On no match:** The event's `match_checked_at` is updated; it won't be retried for 24h (`MATCHER_RECHECK_INTERVAL_MS`)
5. **After 24h:** Previously-unmatched events become eligible again, in case a counterpart appeared on the other exchange

## Acceptance Criteria

- [ ] `events` table created with correct schema
- [ ] Kalshi events persisted during each sync cycle
- [ ] Polymarket events persisted during each sync cycle
- [ ] Stale events marked as closed (same pattern as markets)
- [ ] market-matcher package removed (container, code, docker-compose, docs)
- [ ] Existing market ingestion continues working correctly
- [ ] All packages build and existing tests pass
