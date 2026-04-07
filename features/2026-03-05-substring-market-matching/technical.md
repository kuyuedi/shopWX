# Technical: Substring Market Matching

Enhancement to market-within-event matching that adds substring matching as the primary matching strategy.

---

## Matching Algorithm

### Kalshi Title Pattern

Kalshi multi-outcome market titles follow the pattern:
```
"Will OKC win the 2026 Pro Basketball Finals? — Oklahoma City"
```

The text after ` — ` (em-dash) is the **outcome name** — the differentiating part.

### Substring Matching Flow

```
matchMarketsForSinglePair()
        │
        ├── Binary (1:1)? ──► auto-match (confidence=1.0, algorithmic-v1)
        │
        └── Multi-outcome?
                │
                ├── Tier 1: Substring matching (NEW, primary)
                │       │
                │       ├── extractOutcomeName(kalshi.title) → text after " — "
                │       ├── normalize: lowercase, strip punctuation
                │       ├── special: "tie" also matches "draw"
                │       ├── if poly.title contains outcome name → candidate
                │       ├── 1 candidate → match (confidence=1.0, substring-v1)
                │       └── N candidates → pick closest price (confidence=1.0, substring-v1)
                │
                ├── Tier 2: Jaccard >= 0.5 (fallback for remaining)
                │       └── auto-accept (algorithmic-v1)
                │
                └── Tier 3: Jaccard 0.3–0.5 (fallback for remaining)
                        └── AI verification (ai-verified-v1)
```

### Key Functions Added

| Function | Purpose |
|----------|---------|
| `extractOutcomeName(title)` | Extract text after ` — ` from Kalshi titles |
| `substringMatch(kalshiName, polyTitle)` | Case-insensitive substring check with tie/draw handling |
| `greedySubstringMatch(kalshiMarkets, polyMarkets)` | Greedy matching: for each Kalshi market, find Poly markets containing the outcome name |

---

## Data Flow

```
For each Kalshi market:
  name = extractOutcomeName(kalshi.title)
  if !name → skip to Jaccard fallback

  normalize name: lowercase, strip punctuation
  special: if name == "tie" → also match "draw"

  For each unmatched Poly market:
    normalize poly.title: lowercase, strip punctuation
    if poly.title contains name → candidate match

  0 candidates → skip (Jaccard fallback)
  1 candidate → pair them
  N candidates → pick closest price

  Greedy assignment: no Poly market reused
```

---

## Files Modified

| File | Action | Purpose |
|------|--------|---------|
| `packages/event-matcher/src/services/marketMatcher.ts` | Modified | Added `extractOutcomeName`, `substringMatch`, `greedySubstringMatch`; integrated as Tier 1 before Jaccard |
| `scripts/backfill-market-matching.ts` | Created | Backfill script to re-run matching for all existing event pairs |

---

## Model IDs

| model_id | Used When | Description |
|----------|-----------|-------------|
| `substring-v1` | Outcome name substring match found | Primary strategy for multi-outcome markets |
| `algorithmic-v1` | Binary auto-match or Jaccard >= 0.5 | Fallback algorithmic matching |
| `ai-verified-v1` | Jaccard 0.3–0.5 with AI confidence >= 0.8 | Borderline match verified by OpenAI |

---

## Backfill

### Script

`scripts/backfill-market-matching.ts` — iterates all active event pairs from `event_mappings` and re-runs `matchMarketsForSinglePair` for each.

### Running

The Docker container only has compiled dist files, so the backfill must be run as a `.mjs` file inside the event-matcher container:

```bash
# On server: create backfill.mjs with dist imports, then:
docker cp /tmp/backfill.mjs event-matcher:/app/packages/event-matcher/backfill.mjs
docker compose exec -w /app/packages/event-matcher event-matcher node backfill.mjs
```

### Results (2026-03-05)

| Model | Before | After | Delta |
|-------|--------|-------|-------|
| `algorithmic-v1` | 9,412 | 9,428 | +16 |
| `substring-v1` | 0 | 6,784 | +6,784 |
| `gpt-5-nano` (legacy) | 3,512 | 3,512 | 0 |
| `ai-verified-v1` | 0 | 164 | +164 |
| **Total** | **12,924** | **19,888** | **+6,964** |

Substring matching contributed **6,784 rows** (1,696 market pairs) — the single largest improvement.

---

## Verification

```sql
-- Market mappings by model
SELECT model_id, COUNT(*)
FROM direct_exchanges_data.market_mappings
GROUP BY model_id ORDER BY count DESC;

-- Distinct matched market pairs
SELECT COUNT(DISTINCT canonical_market_id)
FROM direct_exchanges_data.market_mappings;

-- Example: NBA Champion markets with both prices
SELECT mt.generated_title, mm.exchange_id, mm.market_id, pm.price
FROM direct_exchanges_data.market_mappings mm
JOIN direct_exchanges_data.market_titles mt ON mm.canonical_market_id = mt.canonical_market_id
JOIN direct_exchanges_data.prediction_markets pm
  ON mm.market_id = pm.market_id AND mm.exchange_id = pm.exchange_id AND mm.outcome_side = pm.outcome_side
WHERE mm.model_id = 'substring-v1' AND mm.outcome_side = 'YES'
ORDER BY mt.generated_title, mm.exchange_id
LIMIT 20;
```

```bash
# API check: events should show merged rows with both K and P prices
curl -s 'http://8.216.43.26:3100/api/v1/events?sort=volume&limit=3'
```
