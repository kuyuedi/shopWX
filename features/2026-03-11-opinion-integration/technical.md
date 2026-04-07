# Technical: Opinion.trade Integration

---

## Architecture

```
                    ┌─────────────────────────┐
                    │   Opinion.trade APIs     │
                    │  REST: /market, /token   │
                    │  WS: depth, price, trade │
                    └──────────┬──────────────┘
                               │
                    ┌──────────▼──────────────┐
                    │   opinion-listener       │
                    │  ┌───────────────────┐   │
                    │  │ marketSync.ts      │   │  Every 5 min: paginated REST fetch
                    │  │ (REST → DB)        │   │  → prediction_markets + events
                    │  └───────────────────┘   │
                    │  ┌───────────────────┐   │
                    │  │ pool.ts + client.ts│   │  Persistent WS connections
                    │  │ (WS connections)   │   │  3 channels × N markets
                    │  └────────┬──────────┘   │
                    │           │               │
                    │  ┌────────▼──────────┐   │
                    │  │ handlers.ts        │   │  Route by msgType
                    │  └────────┬──────────┘   │
                    │           │               │
                    │  ┌────────▼──────────┐   │
                    │  │ orderBookManager   │   │  Delta accumulation (in-memory)
                    │  │ + bandMetrics      │   │  → full snapshots + VWAP
                    │  └────────┬──────────┘   │
                    │           │               │
                    │  ┌────────▼──────────┐   │
                    │  │ BatchWriters       │   │  Buffered DB writes
                    │  │ (100 items/100ms)  │   │
                    │  └───────────────────┘   │
                    └──────────┬──────────────┘
                               │
                    ┌──────────▼──────────────┐
                    │   PostgreSQL             │
                    │  prediction_markets      │
                    │  events                  │
                    │  order_books             │
                    │  market_latest_data      │
                    │  trades                  │
                    └──────────┬──────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
    ┌─────────▼────┐  ┌───────▼──────┐  ┌──────▼───────┐
    │ event-matcher │  │ arb-scanner  │  │ homepage-api │
    │ (auto-match)  │  │ (auto-detect)│  │ (auto-serve) │
    └──────────────┘  └──────────────┘  └──────────────┘
```

---

## Files to Create

| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `packages/opinion-listener/package.json` | Package manifest | 25 |
| `packages/opinion-listener/tsconfig.json` | TypeScript config | 10 |
| `packages/opinion-listener/Dockerfile` | Multi-stage Docker build | 25 |
| `packages/opinion-listener/src/index.ts` | Entry point + scheduler | 60 |
| `packages/opinion-listener/src/config.ts` | Environment config | 30 |
| `packages/opinion-listener/src/types/api.ts` | Opinion API types | 120 |
| `packages/opinion-listener/src/services/marketSync.ts` | REST market/event sync | 200 |
| `packages/opinion-listener/src/transformers/normalize.ts` | Market normalization | 150 |
| `packages/opinion-listener/src/websocket/client.ts` | Single WS client | 120 |
| `packages/opinion-listener/src/websocket/pool.ts` | WS connection pool | 80 |
| `packages/opinion-listener/src/websocket/handlers.ts` | Message handlers | 150 |
| `packages/opinion-listener/src/state/orderBookManager.ts` | Delta accumulation | 100 |
| `deploy-opinion.sh` | Deploy script | 40 |
| **Total** | | **~1,110** |

## Files to Modify

| File | Change | Lines (est.) |
|------|--------|-------------|
| `docker-compose.yml` | Add opinion-listener service | 20 |
| `root package.json` | Add `dev:opinion` script | 1 |
| `packages/healthcheck/src/checks/containers.ts` | Add container to monitor list | 1 |
| `CLAUDE.md` | Add Opinion listener documentation | 20 |

---

## No Database Migrations Required

All existing tables are exchange-agnostic:
- `prediction_markets`: keyed by `(source_id, exchange_id, market_id, outcome_side)`
- `events`: keyed by `(source_id, exchange_id, event_id)`
- `order_books`: keyed by `(source_id, exchange_id, market_id, outcome_side, time_exchange)`
- `market_latest_data`: keyed by `(source_id, exchange_id, market_id, outcome_side)`
- `trades`: append-only, no unique constraint

Opinion data flows into these tables with `source_id='OPINION_DIRECT'` and `exchange_id='OPINIONTRADE'`.

---

## Comparison: Opinion vs Kalshi vs Polymarket Implementation

| Aspect | Kalshi | Polymarket | Opinion |
|--------|--------|------------|---------|
| **Market sync API** | `/events?with_nested_markets=true` (cursor) | `/markets` + `/events` (offset) | `/market?status=activated` (page) |
| **Page size** | 100 | 100 | 20 (max) |
| **WS protocol** | Custom binary + JSON | Custom JSON | Plain JSON |
| **WS auth** | RSA-PSS per-connection | None (public) | API key in URL query |
| **WS subscription** | `{"cmd":"subscribe","params":{"channels":["ticker","orderbook_delta"],"market_tickers":[...]}}` | `{"type":"subscribe","assets_ids":[...],"channels":["book"]}` | `{"action":"SUBSCRIBE","channel":"market.depth.diff","marketId":N}` |
| **WS heartbeat** | Not needed | Not needed | `{"action":"HEARTBEAT"}` every 30s |
| **Markets per socket** | ~2000 | 500 | Unknown (start at 200) |
| **Orderbook delivery** | Snapshot + deltas | Full snapshots per message | Deltas only (no initial snapshot) |
| **OrderBookManager?** | YES (delta accumulation) | NO (full snapshots) | YES (delta accumulation) |
| **Outcome side source** | Implicit (YES+NO emitted per ticker) | Cached from Gamma API sync | In every message (`outcomeSide` field) |
| **Price format** | Cents (0-100), divide by 100 | Decimal (0-1), no conversion | Decimal strings, parseFloat() |
| **Auth complexity** | High (RSA-PSS signing) | Low (API key) | Low (API key) |

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| API key application rejected/delayed | Blocker | Apply early, have backup contact |
| WS subscription limit too low | High — more sockets needed | Start at 200/socket, tune up |
| Low market overlap with Kalshi/Poly | Medium — fewer arbs | Check market titles before full build |
| Orderbook deltas without initial snapshot | Medium — incomplete books at startup | REST bootstrap (`/token/orderbook`) |
| 15 req/s rate limit on REST | Low — pagination is slow but OK | 100ms delay between pages, ~4s per sync |
| Opinion.trade API changes/downtime | Low | Standard reconnect + retry patterns |

---

## Implementation Order

```
Week 1: Sub-feature 1 (scaffold + market sync)
  ├── Package scaffold, types, config
  ├── Market sync service + normalizer
  ├── Entry point with market sync only
  └── Deploy, verify markets in DB

Week 1-2: Sub-feature 3 (orderbook manager)
  ├── OrderBookManager class
  ├── Unit tests
  └── REST bootstrap for initial state

Week 2: Sub-feature 2 (WebSocket listener)
  ├── WS client with heartbeat + reconnect
  ├── WS pool
  ├── Message handlers (depth, price, trade)
  └── Wire into entry point

Week 2: Sub-feature 4 (deploy + healthcheck)
  ├── Dockerfile + docker-compose
  ├── Deploy script
  ├── Healthcheck updates
  └── End-to-end verification
```

---

## Post-Launch Monitoring

After deployment, monitor for 24h:

1. **Container stability**: `docker compose logs -f opinion-listener` — no crash loops
2. **Data flow**: market_latest_data records flowing for OPINIONTRADE
3. **Event matching**: event_mappings appearing for OPINIONTRADE pairs
4. **Arb detection**: arb_opportunities with OPINIONTRADE legs
5. **Memory usage**: OrderBookManager memory growth (should stabilize)
6. **WS reconnects**: frequency of reconnects (should be rare)
