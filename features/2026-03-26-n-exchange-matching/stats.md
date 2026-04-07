# N-Exchange Matching — Production Stats (2026-03-26)

## Event Matching

| Exchange | Open Events | Matched | % |
|----------|------------|---------|---|
| Kalshi | 4,168 | 938 | 22.5% |
| Polymarket | 8,962 | 1,000 | 11.2% |
| Predict | 446 | 81 | 18.2% |

> **Note (2026-03-26):** Predict events jumped from 13→446 after fixing categories API pagination (was only fetching first page of 20). Markets are now extracted from the paginated categories response (`GET /v1/categories?status=OPEN`) instead of a separate `/v1/markets` call. Predict matched events went from 1→81 after the fix.

### Event Matching by Method

| Method | Description | Kalshi | Polymarket | Predict |
|--------|-------------|--------|------------|---------|
| `gpt-5-nano` | AI semantic comparison (Phase 1) | 938 | 1,000 | — |
| `derived-from-market-mappings-v1` | Inferred from existing market links | — | — | 81 |

**How each exchange's events get matched:**
- **Kalshi ↔ Polymarket:** AI matching (`gpt-5-nano`). Events are compared semantically via OpenAI.
- **Predict ↔ Polymarket (81 pairs):** Derived. Predict's API provides `polymarketConditionIds` on each market → `predict-api-link-v1` market_mappings → event-matcher infers event_mappings from those market links.
- **Predict ↔ Kalshi (46 pairs):** Derived. Same flow via `kalshiMarketTicker`. Fewer pairs because not all Predict markets have a Kalshi counterpart.

### Canonical Event Groups

| Exchanges in Group | Groups |
|-------------------|--------|
| 1 (orphan) | 6 |
| 2 (pair) | 2,498 |
| 3 (triple) | 46 |

## Market Matching

| Exchange | Matched Markets (YES) | Total Open (YES) | % |
|----------|----------------------|-------------------|---|
| Kalshi | 7,211 | 38,562 | 18.7% |
| Polymarket | 7,299 | 23,599 | 30.9% |
| Predict | 476 | 921 | 51.7% |

### Market Matching by Method

| Method | Description | Kalshi | Polymarket | Predict |
|--------|-------------|--------|------------|---------|
| `substring-v1` | Outcome name substring match within event pair | 8,716 | 8,398 | — |
| `gpt-5-nano` | AI event match → inline market match | 2,279 | 2,155 | — |
| `cross-event-ai-v1` | Phase 2 cross-event AI verification | 1,652 | 1,356 | — |
| `algorithmic-v1` | Binary 1:1 or Jaccard >= 0.85 auto-match | 1,294 | 1,264 | — |
| `ai-verified-v1` | Borderline Jaccard + AI verification | 438 | 432 | — |
| `predict-api-link-v1` | Predict API provides direct links | — | 952 | 952 |
| `manual-v1` | Manual mapping | 4 | 4 | — |

Note: counts include both YES and NO sides (2 rows per matched market per exchange).

**How each exchange's markets get matched:**
- **Kalshi ↔ Polymarket:** Multi-tier. When an event pair is matched (AI), markets within are matched by: (1) binary 1:1, (2) substring, (3) Jaccard auto-accept, (4) AI verification. Phase 2 cross-event matching catches markets missed by inline matching.
- **Predict ↔ Polymarket / Kalshi:** API-provided links. Each Predict market has `polymarketConditionIds` and/or `kalshiMarketTicker` from Predict's API. The predict-listener creates `market_mappings` directly from these links — no AI needed.

### Confidence Score Distribution (Event Mappings)

| Bucket | Count |
|--------|-------|
| 0.95–1.00 | 520 |
| 0.90–0.94 | 3,088 |
| 0.85–0.89 | 1,526 |

## Assessment

**What's working well:**
- Substring matching is the workhorse (~60% of K↔P market matches) — fast and accurate
- ~2,500 matched event pairs across K↔P is solid
- Predict API links work well (476 matched markets, 51.7%) — zero AI cost
- Predict event matching at 18.2% (81 events derived from market links)
- 46 three-exchange canonical groups (events matched across K, P, and Predict)
- High confidence scores — 90%+ on most AI matches

**Gaps:**
- **Polymarket at 11.2% event match rate** — it has 8,962 open events vs Kalshi's 4,168, so many Polymarket events simply don't have Kalshi counterparts
- **Kalshi at 22.5%** — many Kalshi events are niche/low-volume with no Polymarket equivalent
- **Predict at 18.2%** — many Predict events are platform-exclusive (esports, crypto up/down) with no K/P counterpart. The 81 matched events are all that have cross-exchange market links.

The low match rates are mostly structural (different event coverage across exchanges), not matching failures.
