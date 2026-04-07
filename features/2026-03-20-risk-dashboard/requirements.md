# Feature: Risk & Matching Dashboard (Appsmith)

**Status**: NEW
**Priority**: High
**Created**: 2026-03-20
**Team**: Chinese dev team
**Platform**: Appsmith (existing instance, already connected to PostgreSQL)

---

## Summary

Internal admin dashboard for the risk team to monitor matching quality, fix bad matches, and manually create missing matches. Built on the existing Appsmith instance using the same PostgreSQL datasource used for the `arb_config` panel.

---

## Problem

1. **~124 phantom matches** exist in production — markets incorrectly paired across exchanges, causing fake arb signals and bad UX on the frontend
2. **~2,029 missing matches** — markets that should be paired but the algorithm couldn't match (abbreviations, synonyms, name variants)
3. **No visibility** — the team currently has no way to see matching quality or fix problems without running raw SQL
4. When a user sees a bad match on the website, there is no quick way to find and fix it

---

## Solution

A 3-tab Appsmith dashboard:
- **Tab 1**: Suspicious Matches — auto-detected bad matches for review (Confirm / Unmatch)
- **Tab 2**: Manual Matching — pair markets that the algorithm missed
- **Tab 3**: Matching Overview — real-time health metrics and stats

---

## Database Migration

Run this SQL before deploying the dashboard:

```sql
CREATE TABLE IF NOT EXISTS direct_exchanges_data.match_reviews (
  id BIGSERIAL PRIMARY KEY,
  canonical_market_id VARCHAR(100) NOT NULL,
  action VARCHAR(20) NOT NULL CHECK (action IN ('CONFIRMED', 'UNMATCHED', 'REJECTED')),
  reviewed_by VARCHAR(100),
  reviewed_at TIMESTAMPTZ DEFAULT NOW(),
  notes TEXT
);

CREATE INDEX idx_match_reviews_canonical ON direct_exchanges_data.match_reviews(canonical_market_id);
```

---

## Tab 1: Suspicious Matches Review

### Purpose

Auto-detect matched market pairs that are likely incorrect, based on live price divergence between exchanges. If two markets are truly the same, their prices should be close. A large gap (>20%) is a strong signal of a bad match.

### Global Search Bar

At the top of the tab, add a **search input** field that filters results by market title. This allows the team to quickly locate a bad match they spotted on the website.

**Usage example**: User sees "Czestochowa vs Fiorentina" on the website with wrong prices → types "Fiorentina" in the search bar → finds the exact suspicious match → clicks Unmatch.

The search should filter on both `kalshi_title` and `poly_title` columns using `ILIKE '%{{search}}%'`.

### Data Source Query

```sql
WITH pairs AS (
  SELECT
    mm1.canonical_market_id,
    mm1.market_id AS kalshi_market_id,
    mm2.market_id AS poly_market_id,
    mm1.model_id,
    mm1.confidence_score,
    mm1.matched_at,
    pk.title AS kalshi_title,
    pp.title AS poly_title,
    pk.event_id AS kalshi_event_id,
    pp.event_id AS poly_event_id,
    k.reference_price AS kalshi_price,
    p.reference_price AS poly_price,
    abs(k.reference_price - p.reference_price) AS price_gap
  FROM direct_exchanges_data.market_mappings mm1
  JOIN direct_exchanges_data.market_mappings mm2
    ON mm1.canonical_market_id = mm2.canonical_market_id
    AND mm1.outcome_side = mm2.outcome_side
    AND mm1.exchange_id = 'KALSHI' AND mm2.exchange_id = 'POLYMARKET'
  LEFT JOIN direct_exchanges_data.market_latest_data k
    ON k.market_id = mm1.market_id AND k.exchange_id = 'KALSHI' AND k.outcome_side = mm1.outcome_side
  LEFT JOIN direct_exchanges_data.market_latest_data p
    ON p.market_id = mm2.market_id AND p.exchange_id = 'POLYMARKET' AND p.outcome_side = mm2.outcome_side
  LEFT JOIN direct_exchanges_data.prediction_markets pk
    ON pk.market_id = mm1.market_id AND pk.exchange_id = 'KALSHI'
  LEFT JOIN direct_exchanges_data.prediction_markets pp
    ON pp.market_id = mm2.market_id AND pp.exchange_id = 'POLYMARKET'
  WHERE mm1.outcome_side = 'YES'
    AND k.reference_price IS NOT NULL
    AND p.reference_price IS NOT NULL
    AND abs(k.reference_price - p.reference_price) > {{priceGapThreshold || 0.20}}
    AND mm1.canonical_market_id NOT IN (
      SELECT canonical_market_id FROM direct_exchanges_data.match_reviews
    )
    AND (
      '{{searchInput}}' = ''
      OR pk.title ILIKE '%{{searchInput}}%'
      OR pp.title ILIKE '%{{searchInput}}%'
    )
)
SELECT * FROM pairs
ORDER BY price_gap DESC;
```

### UI Layout

**Search bar** at top: Text input with placeholder "Search by market title..."

**Table Widget** with columns:

| Column | Source | Format |
|--------|--------|--------|
| Kalshi Title | `kalshi_title` | Text, truncate at 60 chars, tooltip shows full |
| Poly Title | `poly_title` | Text, truncate at 60 chars, tooltip shows full |
| Kalshi Price | `kalshi_price` | Percentage (x100), 1 decimal |
| Poly Price | `poly_price` | Percentage (x100), 1 decimal |
| Price Gap | `price_gap` | Percentage (x100), 1 decimal, **red if > 50%** |
| Model | `model_id` | Tag/badge |
| Matched At | `matched_at` | Date |
| Actions | — | Two buttons (see below) |

### Action Buttons

1. **Confirm** (green button) — Mark as reviewed/valid (price gap is real, not a bad match):
   ```sql
   INSERT INTO direct_exchanges_data.match_reviews
     (canonical_market_id, action, reviewed_by, reviewed_at)
   VALUES
     ({{currentRow.canonical_market_id}}, 'CONFIRMED', {{appsmith.user.email}}, NOW());
   ```

2. **Unmatch** (red button) — Delete the bad mapping and clean up related arbs:
   ```sql
   -- Step 1: Delete any arb opportunities referencing this market
   DELETE FROM direct_exchanges_data.arb_opportunities
   WHERE canonical_market_id = {{currentRow.canonical_market_id}};

   -- Step 2: Delete the market mappings (4 rows: YES+NO for both exchanges)
   DELETE FROM direct_exchanges_data.market_mappings
   WHERE canonical_market_id = {{currentRow.canonical_market_id}};

   -- Step 3: Log the review action
   INSERT INTO direct_exchanges_data.match_reviews
     (canonical_market_id, action, reviewed_by, reviewed_at)
   VALUES
     ({{currentRow.canonical_market_id}}, 'UNMATCHED', {{appsmith.user.email}}, NOW());
   ```
   **Important:** Show a confirmation dialog before executing.

### Filters

- **Search**: Text input — filters on both Kalshi and Polymarket titles (ILIKE)
- **Price gap threshold**: Slider (default 20%, range 10%-80%)
- **Model ID**: Dropdown filter (substring-v1, algorithmic-v1, cross-event-ai-v1, gpt-5-nano, ai-verified-v1)
- **Date range**: Filter on `matched_at`

### Stats Bar (top of tab)

```sql
SELECT
  count(DISTINCT mm1.canonical_market_id) AS total_suspicious,
  count(DISTINCT mm1.canonical_market_id) FILTER (
    WHERE abs(k.reference_price - p.reference_price) > 0.50
  ) AS critical_50pct,
  count(DISTINCT mm1.canonical_market_id) FILTER (
    WHERE mm1.model_id = 'cross-event-ai-v1'
  ) AS cross_event_matches
FROM direct_exchanges_data.market_mappings mm1
JOIN direct_exchanges_data.market_mappings mm2
  ON mm1.canonical_market_id = mm2.canonical_market_id
  AND mm1.outcome_side = mm2.outcome_side
  AND mm1.exchange_id = 'KALSHI' AND mm2.exchange_id = 'POLYMARKET'
LEFT JOIN direct_exchanges_data.market_latest_data k
  ON k.market_id = mm1.market_id AND k.exchange_id = 'KALSHI' AND k.outcome_side = mm1.outcome_side
LEFT JOIN direct_exchanges_data.market_latest_data p
  ON p.market_id = mm2.market_id AND p.exchange_id = 'POLYMARKET' AND p.outcome_side = mm2.outcome_side
WHERE mm1.outcome_side = 'YES'
  AND k.reference_price IS NOT NULL AND p.reference_price IS NOT NULL
  AND abs(k.reference_price - p.reference_price) > 0.20
  AND mm1.canonical_market_id NOT IN (
    SELECT canonical_market_id FROM direct_exchanges_data.match_reviews
  );
```

---

## Tab 2: Manual Matching

### Purpose

Allow the risk team to manually match markets that the algorithm couldn't pair. Scope: ~30-40 events where the semantic gap is too large for automated matching (rate decisions, date variants, player name abbreviations).

### Step 1: Select Event Pair

**Dropdown/Search** to select an event pair with unmatched markets:

```sql
WITH event_pairs AS (
  SELECT
    a.canonical_event_id,
    a.event_id AS kalshi_event_id,
    b.event_id AS poly_event_id,
    ka.title AS kalshi_title,
    ka.market_count AS kalshi_mc,
    pa.market_count AS poly_mc
  FROM direct_exchanges_data.event_mappings a
  JOIN direct_exchanges_data.event_mappings b
    ON a.canonical_event_id = b.canonical_event_id
  JOIN direct_exchanges_data.events ka
    ON a.source_id = ka.source_id AND a.exchange_id = ka.exchange_id AND a.event_id = ka.event_id
  JOIN direct_exchanges_data.events pa
    ON b.source_id = pa.source_id AND b.exchange_id = pa.exchange_id AND b.event_id = pa.event_id
  WHERE a.exchange_id = 'KALSHI' AND b.exchange_id = 'POLYMARKET'
    AND ka.status = 'Open' AND pa.status = 'Open'
),
kalshi_matched AS (
  SELECT DISTINCT mm.market_id
  FROM direct_exchanges_data.market_mappings mm
  WHERE mm.exchange_id = 'KALSHI'
),
unmatched_counts AS (
  SELECT ep.canonical_event_id, ep.kalshi_title,
    ep.kalshi_mc, ep.poly_mc, ep.kalshi_event_id, ep.poly_event_id,
    count(DISTINCT pm.market_id) FILTER (
      WHERE pm.market_id NOT IN (SELECT market_id FROM kalshi_matched)
    ) AS unmatched_kalshi
  FROM event_pairs ep
  JOIN direct_exchanges_data.prediction_markets pm
    ON pm.event_id = ep.kalshi_event_id AND pm.exchange_id = 'KALSHI' AND pm.status = 'Open'
  GROUP BY ep.canonical_event_id, ep.kalshi_title, ep.kalshi_mc, ep.poly_mc,
           ep.kalshi_event_id, ep.poly_event_id
)
SELECT * FROM unmatched_counts
WHERE unmatched_kalshi > 0
  AND (
    '{{eventSearchInput}}' = ''
    OR kalshi_title ILIKE '%{{eventSearchInput}}%'
  )
ORDER BY unmatched_kalshi DESC;
```

### Step 2: Show Unmatched Markets Side by Side

When an event pair is selected, show two tables:

**Left Table — Unmatched Kalshi Markets:**
```sql
SELECT pm.market_id, pm.title, mld.reference_price
FROM direct_exchanges_data.prediction_markets pm
LEFT JOIN direct_exchanges_data.market_latest_data mld
  ON mld.market_id = pm.market_id AND mld.exchange_id = 'KALSHI' AND mld.outcome_side = 'YES'
WHERE pm.event_id = {{selectedEvent.kalshi_event_id}}
  AND pm.exchange_id = 'KALSHI'
  AND pm.status = 'Open'
  AND pm.market_id NOT IN (
    SELECT market_id FROM direct_exchanges_data.market_mappings WHERE exchange_id = 'KALSHI'
  )
ORDER BY pm.title;
```

**Right Table — Unmatched Polymarket Markets:**
```sql
SELECT pm.market_id, pm.title, mld.reference_price
FROM direct_exchanges_data.prediction_markets pm
LEFT JOIN direct_exchanges_data.market_latest_data mld
  ON mld.market_id = pm.market_id AND mld.exchange_id = 'POLYMARKET' AND mld.outcome_side = 'YES'
WHERE pm.event_id = {{selectedEvent.poly_event_id}}
  AND pm.exchange_id = 'POLYMARKET'
  AND pm.status = 'Open'
  AND pm.market_id NOT IN (
    SELECT market_id FROM direct_exchanges_data.market_mappings WHERE exchange_id = 'POLYMARKET'
  )
ORDER BY pm.title;
```

### Step 3: Force Match Action

User selects one row from each table and clicks **"Force Match"** button.

**Insert query** (creates 4 rows: YES+NO for each exchange):

```sql
WITH new_id AS (
  SELECT 'CM-' || md5({{kalshiRow.market_id}} || {{polyRow.market_id}}) AS canonical_market_id
)
INSERT INTO direct_exchanges_data.market_mappings
  (source_id, exchange_id, market_id, outcome_side, canonical_market_id,
   is_active, confidence_score, matched_at, model_id, match_version)
VALUES
  ('KALSHI_DIRECT', 'KALSHI', {{kalshiRow.market_id}}, 'YES',
   (SELECT canonical_market_id FROM new_id), true, 1.0, NOW(), 'manual-v1', 1),
  ('KALSHI_DIRECT', 'KALSHI', {{kalshiRow.market_id}}, 'NO',
   (SELECT canonical_market_id FROM new_id), true, 1.0, NOW(), 'manual-v1', 1),
  ('POLYMARKET_DIRECT', 'POLYMARKET', {{polyRow.market_id}}, 'YES',
   (SELECT canonical_market_id FROM new_id), true, 1.0, NOW(), 'manual-v1', 1),
  ('POLYMARKET_DIRECT', 'POLYMARKET', {{polyRow.market_id}}, 'NO',
   (SELECT canonical_market_id FROM new_id), true, 1.0, NOW(), 'manual-v1', 1)
ON CONFLICT (source_id, exchange_id, market_id, outcome_side)
DO UPDATE SET
  canonical_market_id = EXCLUDED.canonical_market_id,
  confidence_score = EXCLUDED.confidence_score,
  matched_at = EXCLUDED.matched_at,
  model_id = EXCLUDED.model_id,
  match_version = EXCLUDED.match_version,
  updated_at = NOW();
```

**Also insert into market_titles** (for homepage display):
```sql
INSERT INTO direct_exchanges_data.market_titles
  (canonical_market_id, generated_title, updated_at)
VALUES
  ((SELECT 'CM-' || md5({{kalshiRow.market_id}} || {{polyRow.market_id}})),
   {{kalshiRow.title}}, NOW())
ON CONFLICT (canonical_market_id) DO UPDATE SET
  generated_title = EXCLUDED.generated_title,
  updated_at = NOW();
```

### Step 4: Reject Action

User selects a Kalshi market and clicks **"Reject / Incompatible"** to mark it as unmatchable (no equivalent exists on the other exchange):

```sql
INSERT INTO direct_exchanges_data.match_reviews
  (canonical_market_id, action, reviewed_by, reviewed_at, notes)
VALUES
  ('REJECTED:' || {{kalshiRow.market_id}}, 'REJECTED', {{appsmith.user.email}}, NOW(),
   'Marked as incompatible - no matching market on other exchange');
```

---

## Tab 3: Matching Overview (Read-Only)

### Purpose

Real-time dashboard showing overall matching health metrics.

### Summary Stats Query

```sql
SELECT
  (SELECT count(*) FROM direct_exchanges_data.market_mappings
   WHERE exchange_id = 'KALSHI') AS kalshi_mapped,
  (SELECT count(*) FROM direct_exchanges_data.prediction_markets
   WHERE exchange_id = 'KALSHI' AND status = 'Open') AS kalshi_total,
  (SELECT count(*) FROM direct_exchanges_data.market_mappings
   WHERE exchange_id = 'POLYMARKET') AS poly_mapped,
  (SELECT count(*) FROM direct_exchanges_data.prediction_markets
   WHERE exchange_id = 'POLYMARKET' AND status = 'Open') AS poly_total,
  (SELECT count(DISTINCT canonical_market_id)
   FROM direct_exchanges_data.market_mappings) AS unique_pairs,
  (SELECT count(*) FROM direct_exchanges_data.arb_opportunities
   WHERE status = 'ACTIVE') AS active_arbs;
```

### Match Quality by Model Query

```sql
WITH pairs AS (
  SELECT mm1.model_id,
    abs(k.reference_price - p.reference_price) AS gap
  FROM direct_exchanges_data.market_mappings mm1
  JOIN direct_exchanges_data.market_mappings mm2
    ON mm1.canonical_market_id = mm2.canonical_market_id
    AND mm1.outcome_side = mm2.outcome_side
    AND mm1.exchange_id = 'KALSHI' AND mm2.exchange_id = 'POLYMARKET'
  LEFT JOIN direct_exchanges_data.market_latest_data k
    ON k.market_id = mm1.market_id AND k.exchange_id = 'KALSHI'
    AND k.outcome_side = mm1.outcome_side
  LEFT JOIN direct_exchanges_data.market_latest_data p
    ON p.market_id = mm2.market_id AND p.exchange_id = 'POLYMARKET'
    AND p.outcome_side = mm2.outcome_side
  WHERE mm1.outcome_side = 'YES'
    AND k.reference_price IS NOT NULL AND p.reference_price IS NOT NULL
)
SELECT model_id,
  count(*) AS total,
  count(*) FILTER (WHERE gap <= 0.10) AS good,
  count(*) FILTER (WHERE gap > 0.20) AS suspicious,
  round(100.0 * count(*) FILTER (WHERE gap <= 0.10) / count(*), 1) AS good_rate_pct
FROM pairs
GROUP BY model_id
ORDER BY good_rate_pct;
```

### UI Layout

- **Stat widgets** at top: Total Pairs, Match Rate %, Active Arbs, Suspicious Count
- **Bar chart**: Match quality by model (good vs suspicious)
- **Table**: Top 20 events with most unmatched markets

---

## Data Safety & Service Interaction

### Will services overwrite manual changes?

| Action | Safe? | Why |
|--------|-------|-----|
| **Force Match** (INSERT) | YES | Event matcher skips already-mapped markets via `fetchExistingMappedMarketIds()`. Manual matches won't be overwritten. |
| **Unmatch** (DELETE) | YES (currently) | Market matching only runs once per event pair (at creation time). Already-matched events are skipped. The deleted mapping won't be re-created. |
| **Unmatch** if Phase 2 enabled | RISK | Phase 2 cross-event matching (`ENABLE_PHASE2`) scans ALL unmatched markets and could re-match a deleted pair. **Currently disabled in production.** If enabled later, add a check against `match_reviews` table. |

### Data consistency checklist

| Concern | Handled? | How |
|---------|----------|-----|
| Duplicate key on INSERT | YES | `ON CONFLICT DO UPDATE` on unique key `(source_id, exchange_id, market_id, outcome_side)` |
| Orphaned arb_opportunities after DELETE | YES | Unmatch query deletes arbs first, then mappings |
| Missing market_titles after Force Match | YES | INSERT with `ON CONFLICT DO UPDATE` on `market_titles` |
| Audit trail | YES | All actions logged in `match_reviews` with user email + timestamp |

---

## Implementation Notes

1. **Appsmith Datasource:** Use the existing PostgreSQL connection (same one used for `arb_config` panel). Schema: `direct_exchanges_data`.
2. **Permissions:** Dashboard should be accessible only to risk team members. Use Appsmith's built-in role management.
3. **Refresh:** Add a "Refresh" button on each tab that re-runs the queries. No auto-refresh needed.
4. **Confirmation dialogs:** All destructive actions (Unmatch, Delete) must show a confirmation dialog with the market titles before executing.
5. **Audit trail:** All actions are logged in `match_reviews` table with user email and timestamp.
6. **model_id = 'manual-v1':** All manual matches use this model_id for easy querying and audit.

---

## Effort Estimate

| Component | Effort (with AI) |
|-----------|-----------------|
| Tab 1: Suspicious Matches + Search | 3 hours |
| Tab 2: Manual Matching | 4 hours |
| Tab 3: Matching Overview | 2 hours |
| DB migration + testing | 1 hour |
| **Total** | **~10 hours** |

---

## Acceptance Criteria

- [ ] Search bar in Tab 1 finds matches by typing any part of market title
- [ ] Unmatch button deletes mapping + arbs + logs to match_reviews
- [ ] Confirm button adds to match_reviews and hides from suspicious list
- [ ] Force Match creates 4 rows in market_mappings with model_id 'manual-v1'
- [ ] Force Match also creates market_titles entry
- [ ] Stats bar shows total suspicious, critical (>50%), and cross-event counts
- [ ] Tab 3 shows overall match rate and quality by model
- [ ] All actions require confirmation dialog
- [ ] All actions are logged with user email and timestamp
