# Appsmith: Add Event-Level Unmatch Feature

## Why This Is Needed

Sometimes events are incorrectly matched at the event level (e.g., "College Football Conference Championship" matched to "NCAA Basketball Conference Championship"). When this happens, all market mappings within the event are wrong. Currently the dashboard only supports unmatching individual markets — we need to be able to unmatch an entire event pair.

## New Query: `unmatchEvent`

**Name:** `unmatchEvent`
**Type:** DELETE + INSERT

```sql
-- Step 1: Get all market mappings for this event pair
WITH event_markets AS (
  SELECT DISTINCT mm.canonical_market_id
  FROM direct_exchanges_data.event_mappings em
  JOIN direct_exchanges_data.market_mappings mm
    ON mm.exchange_id = em.exchange_id
  JOIN direct_exchanges_data.prediction_markets pm
    ON pm.market_id = mm.market_id AND pm.exchange_id = mm.exchange_id AND pm.outcome_side = mm.outcome_side
  WHERE em.canonical_event_id = '{{eventsTable.triggeredRow.canonical_event_id}}'
    AND pm.event_id = em.event_id
)
-- Step 2: Delete arb opportunities
DELETE FROM direct_exchanges_data.arb_opportunities
WHERE canonical_market_id IN (SELECT canonical_market_id FROM event_markets);

-- Step 3: Delete market titles
DELETE FROM direct_exchanges_data.market_titles
WHERE canonical_market_id IN (
  SELECT DISTINCT mm.canonical_market_id
  FROM direct_exchanges_data.event_mappings em
  JOIN direct_exchanges_data.market_mappings mm
    ON mm.exchange_id = em.exchange_id
  JOIN direct_exchanges_data.prediction_markets pm
    ON pm.market_id = mm.market_id AND pm.exchange_id = mm.exchange_id AND pm.outcome_side = mm.outcome_side
  WHERE em.canonical_event_id = '{{eventsTable.triggeredRow.canonical_event_id}}'
    AND pm.event_id = em.event_id
);

-- Step 4: Delete market mappings
DELETE FROM direct_exchanges_data.market_mappings
WHERE canonical_market_id IN (
  SELECT DISTINCT mm.canonical_market_id
  FROM direct_exchanges_data.event_mappings em
  JOIN direct_exchanges_data.market_mappings mm2 AS mm
    ON mm.exchange_id = em.exchange_id
  JOIN direct_exchanges_data.prediction_markets pm
    ON pm.market_id = mm.market_id AND pm.exchange_id = mm.exchange_id AND pm.outcome_side = mm.outcome_side
  WHERE em.canonical_event_id = '{{eventsTable.triggeredRow.canonical_event_id}}'
    AND pm.event_id = em.event_id
);

-- Step 5: Delete event mapping
DELETE FROM direct_exchanges_data.event_mappings
WHERE canonical_event_id = '{{eventsTable.triggeredRow.canonical_event_id}}';

-- Step 6: Log the action
INSERT INTO direct_exchanges_data.match_reviews
  (canonical_market_id, action, reviewed_by, reviewed_at, notes)
VALUES
  ('{{eventsTable.triggeredRow.canonical_event_id}}', 'UNMATCHED', '{{appsmith.user.email}}', NOW(),
   'Event-level unmatch: {{eventsTable.triggeredRow.k_title}} ↔ {{eventsTable.triggeredRow.p_title}}');
```

**Note:** Appsmith may not support multiple statements in one query. If so, split into 6 separate queries and chain them:
1. `unmatchEvent_deleteArbs`
2. `unmatchEvent_deleteTitles`
3. `unmatchEvent_deleteMappings`
4. `unmatchEvent_deleteEvent`
5. `unmatchEvent_log`

Wire them: Button onClick → Run `unmatchEvent_deleteArbs` → onSuccess → Run `unmatchEvent_deleteTitles` → etc.

Or use a **JS Object**:

```javascript
export default {
  async unmatchEvent() {
    const ceId = eventsTable.triggeredRow.canonical_event_id;
    await unmatchEvent_deleteArbs.run();
    await unmatchEvent_deleteTitles.run();
    await unmatchEvent_deleteMappings.run();
    await unmatchEvent_deleteEvent.run();
    await unmatchEvent_log.run();
    showAlert('Event unmatched successfully!', 'success');
    await getSuspiciousEvents.run(); // refresh table
  }
}
```

## New Query: `getSuspiciousEvents`

Add a new table on Tab 1 (or a new Tab) showing suspicious EVENT pairs:

```sql
SELECT
  a.canonical_event_id,
  ke.title AS k_title,
  pe.title AS p_title,
  ke.category AS k_category,
  pe.category AS p_category,
  a.confidence_score,
  a.model_id,
  COUNT(DISTINCT mm.canonical_market_id) AS market_count
FROM direct_exchanges_data.event_mappings a
JOIN direct_exchanges_data.event_mappings b
  ON a.canonical_event_id = b.canonical_event_id
  AND a.exchange_id = 'KALSHI' AND b.exchange_id = 'POLYMARKET'
JOIN direct_exchanges_data.events ke
  ON a.event_id = ke.event_id AND a.exchange_id = ke.exchange_id
JOIN direct_exchanges_data.events pe
  ON b.event_id = pe.event_id AND b.exchange_id = pe.exchange_id
LEFT JOIN direct_exchanges_data.market_mappings mm
  ON mm.exchange_id = 'KALSHI'
  AND mm.canonical_market_id IN (
    SELECT mm2.canonical_market_id
    FROM direct_exchanges_data.market_mappings mm2
    JOIN direct_exchanges_data.prediction_markets pm2
      ON pm2.market_id = mm2.market_id AND pm2.exchange_id = mm2.exchange_id
    WHERE pm2.event_id = a.event_id AND mm2.outcome_side = 'YES'
  )
WHERE ke.status = 'Open' AND pe.status = 'Open'
  AND a.canonical_event_id NOT IN (
    SELECT canonical_market_id FROM direct_exchanges_data.match_reviews WHERE action = 'UNMATCHED'
  )
  AND (
    '{{eventSearchInput.text}}' = ''
    OR ke.title ILIKE '%{{eventSearchInput.text}}%'
    OR pe.title ILIKE '%{{eventSearchInput.text}}%'
  )
GROUP BY a.canonical_event_id, ke.title, pe.title, ke.category, pe.category, a.confidence_score, a.model_id
ORDER BY ke.title;
```

## UI: Add to Tab 1

Add a section below the existing suspicious matches table:

### "Suspicious Events" section

**Table columns:**
| Column | Source | Notes |
|--------|--------|-------|
| Kalshi Event | `k_title` | Truncate 60 chars |
| Polymarket Event | `p_title` | Truncate 60 chars |
| K Category | `k_category` | — |
| P Category | `p_category` | Red if different |
| Markets | `market_count` | Number of matched markets inside |
| Confidence | `confidence_score` | — |
| Actions | — | Unmatch Event button (red) |

**Unmatch Event button:**
- onClick → Show Modal → "This will unmatch the event AND all X markets inside it. Are you sure?"
- Confirm → Run `unmatchEvent` JS Object function
- Confirmation dialog should show both event titles

## Widget Names

| Widget | Name | Used in queries |
|--------|------|----------------|
| Events table | `eventsTable` | `unmatchEvent` queries |
| Search input | `eventSearchInput` | `getSuspiciousEvents` |
