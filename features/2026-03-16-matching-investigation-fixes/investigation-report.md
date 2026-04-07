# Market Matching Investigation Report

**Root Cause Analysis & Recommended Fixes**
**March 16, 2026 | Priority: P0**

## Executive Summary

We investigated market matching quality across the platform and found significant issues affecting data accuracy on both the homepage and arbitrage pages.

| Metric | Value | Assessment |
|--------|-------|------------|
| Total markets in multi-exchange events | 25,884 | |
| Matched markets | 14,590 | |
| Unmatched markets | 11,294 | 43.6% missing |
| Match rate | 56.4% | POOR - should be >90% |

43.6% of markets that SHOULD have cross-exchange price comparison are missing their match. Users see single-exchange rows instead of side-by-side comparison.

### Confidence Score Distribution

The good news: when matches ARE made, quality is high.

| Confidence | Count | % of Total |
|------------|-------|------------|
| 1.00 | 261 | 91.9% |
| 0.98 | 1 | 0.4% |
| 0.97 | 1 | 0.4% |
| 0.95 | 21 | 7.4% |

92% of existing matches have perfect confidence (1.00). The matching AI is accurate when it runs. The problem is that many market pairs never reach the AI due to the pre-filter rejecting them.

---

## Problem 1: Title Structure Mismatch (Main Issue)

### Description

The two exchanges use completely different title formats for identical markets. The keyword pre-filter (which decides whether to send a pair to GPT for comparison) rejects these pairs because the word overlap is too low.

### Examples

**Example A: LA Mayor Election**

| | Kalshi Title | Polymarket Title |
|---|---|---|
| Market | Who will win Los Angeles Mayoral Election? — Adam Miller | Will Adam Miller win the 2026 Los Angeles mayoral election? |
| Matched? | NO — Missed by pre-filter | NO — Missed by pre-filter |

Why it fails: Kalshi puts the candidate name after a dash (—) as a subtitle. The pre-filter tokenizes titles and looks for keyword overlap, but the sentence structures are too different.

**Example B: Fed Rate Decision**

| | Kalshi Title | Polymarket Title |
|---|---|---|
| Cut 25bps | Federal Funds Rate Decision: Cut 25bps | Will the Fed decrease interest rates by 25 bps? |
| No change | Federal Funds Rate Decision: No Change | Will there be no change in Fed interest rates? |
| Matched? | Some matched, some missed | "Cut" vs "decrease" not recognized as equivalent |

**Example C: Sports / Accented Characters**

| | Kalshi Title | Polymarket Title |
|---|---|---|
| Match | Sao Paulo vs Palmeiras? — Sao Paulo | Will São Paulo FC win on 2026-03-21? |
| Issue | "Sao" vs "São" (accent mismatch) | Pre-filter keyword match fails on Unicode |

### Root Cause

The pre-filter in the market matcher compares keyword overlap between titles before sending to GPT. When titles use different sentence structures, synonyms, or character encodings, the overlap score falls below the threshold and the pair is NEVER sent to GPT for evaluation.

This explains the 43.6% gap: these markets exist in the same event but are filtered out before the AI can assess them.

---

## Problem 2: Wrong Matches at Low Confidence

### Description

Some markets were incorrectly matched because GPT confused threshold markets ("above X%") with exact-value markets ("be X%"). These are fundamentally different market types.

### Examples Found in Fed Rate Event (CE-68897a77d5ac64ba)

| Kalshi Market | Polymarket Market | Conf. | Correct? | Why Wrong |
|---|---|---|---|---|
| above 2.75% following Oct meeting | be 2.75% at end of 2026 | 0.55 | WRONG | Threshold vs exact + different dates |
| above 3.25% following Oct meeting | be 3.25% at end of 2026 | 0.55 | WRONG | Same issue |
| above 3.75% following Oct meeting | be 3.75% at end of 2026 | 0.55 | WRONG | Same issue |
| above 4.25% following Oct meeting | be 4.25% at end of 2026 | 0.55 | WRONG | Same issue |

"Will rate be ABOVE 3.25%" is a cumulative/threshold market. "Will rate BE 3.25%" is an exact-value market. These are fundamentally different and must NEVER be matched. Also note the different dates: "Oct meeting" vs "end of 2026".

**Impact:** These bad matches currently have confidence 0.55, which is below the arb scanner threshold of 0.95, so they do NOT create false arb alerts. However, they DO pollute the homepage comparison display, showing incorrect side-by-side prices.

---

## Problem 3: Asymmetric Side Matching

### Description

Many markets are matched on the YES side only. The NO side of the same market is left unmatched, creating duplicate rows in the UI where the same market appears twice: once with Kalshi price only and once with Polymarket price only.

### Example: March 2026 Fed Rate Decision

| Market | Side | Matched? | Kalshi | Poly |
|---|---|---|---|---|
| Will there be no change in Fed rates? | YES | YES (CM-76c...) | 99% | 100% |
| Will there be no change in Fed rates? | NO | NOT MATCHED | 1% | — |

This is the exact bug shown in the screenshot: the user sees the same market split across two rows with prices only on one exchange per row.

### Root Cause

The market matcher creates mappings per outcome_side independently. When GPT confirms a YES-side match, the code should automatically create the corresponding NO-side mapping (since YES and NO are always complementary), but it does not.

---

## Problem 4: Cross-Event Date-Variant Market Structure Mismatch

### Description

Kalshi and Polymarket organize date-variant markets completely differently. Kalshi groups all date variations under ONE event, while Polymarket creates SEPARATE events for each date. Our event matcher groups some together, but the market matcher cannot pair them because they live in different event structures.

This is a structural problem that cannot be solved by improving the pre-filter alone. It requires cross-event matching logic.

### Real Example: Greenland Acquisition

**How Kalshi Organizes It: ONE Event, Multiple Markets**

Kalshi event "KXGREENLAND" contains all date variants as sub-markets:

| Kalshi Ticker | Title | Expiry | Price |
|---|---|---|---|
| KXGREENTERRITORY-29 | Will the US acquire any part of Greenland before Jan 21, 2029? | Jan 2029 | 39% |
| KXGREENLAND-29 | Will Trump buy at least part of Greenland before 2029? | 2029 | 28% |
| KXGREENLAND-27 | Will Trump buy at least part of Greenland before 2027? | 2027 | 12% |
| KXGREENLAND-26JUL01 | Will Trump buy at least part of Greenland before Jul 1, 2026? | Jul 2026 | 4% |
| KXGREENLAND-26APR01 | Will Trump buy at least part of Greenland before Apr 2026? | Apr 2026 | 1% |

**How Polymarket Organizes It: SEPARATE Events Per Date**

Polymarket creates independent events, each with its own event ID, slug, and URL:

| Poly Event ID | Title | Expiry | Price |
|---|---|---|---|
| 997488 | Will Trump acquire Greenland before 2027? | Dec 2026 | 9% |
| 148292 | Will the US acquire part of Greenland in 2026? | Dec 2026 | 17% |

**What The User Sees (Broken)**

Our UI shows TWO separate event cards, each with split rows:

| Row in UI | Source | Kalshi | Poly | Problem |
|---|---|---|---|---|
| Before January 20, 2029 | Kalshi only | 28% | — | No Poly match |
| Before 2027 | Kalshi only | 12% | — | No Poly match |
| Will Trump acquire Greenland b... | Poly only | — | 9% | No Kalshi match |

The correct match should be: Kalshi KXGREENLAND-27 ("before 2027", 12%) paired with Polymarket 997488 ("before 2027", 9%). These are the SAME market but our system cannot connect them.

### Root Cause Analysis

The market matcher currently only compares markets WITHIN the same canonical event. But in this case:
- Kalshi's "before 2027" market lives in Kalshi event KXGREENLAND
- Polymarket's "before 2027" market lives in Poly event 997488
- These may or may not be in the same canonical event, depending on how the event matcher grouped them
- Even if they ARE in the same canonical event, the title differences ("buy" vs "acquire", "Trump" vs "US") cause the pre-filter to reject the pair

This is a compound problem: event structure mismatch + title mismatch happening together.

### Additional Complexity: Similar But NOT Identical Markets

Some date variants look similar but are NOT the same market:

| Kalshi | Polymarket | Same Market? |
|---|---|---|
| buy Greenland before 2027 | acquire Greenland before 2027 | YES — same date, same question |
| acquire Greenland before Jan 21, 2029 | (no Poly equivalent) | N/A — no match exists |
| buy Greenland before Jul 1, 2026 | acquire part of Greenland in 2026 | NO — "before Jul 2026" is NOT "in 2026" |

The matcher MUST compare expiry dates, not just the core question. "Before Jul 2026" and "in 2026" cover different time windows and must NOT be matched.

---

## Problem 5: One-to-Many Event Structure Mismatch (Mega-Events)

### Description

Kalshi creates single "mega-events" containing 20-60+ markets covering many different entities (people, countries, teams), while Polymarket splits these into separate per-entity events. Our event matcher incorrectly maps the Kalshi mega-event to ONE Polymarket event, leaving all other Polymarket events unlinked.

This is a DIFFERENT pattern from Problem 4 (date variants). Problem 4 is about the same entity split across dates. Problem 5 is about MANY different entities grouped under one umbrella event on Kalshi but separated into individual events on Polymarket.

### Real Example: World Leaders Leaving Office

**How Kalshi Organizes It: ONE Mega-Event**

Kalshi event KXLEADERSOUT-27JAN01 "Which world leaders will leave office in 2026?" contains 66+ markets, one per leader:

| Kalshi Ticker | Leader | Country | YES Price |
|---|---|---|---|
| GPETCOL | Gustavo Petro | Colombia | 94% |
| KSTAUK | Keir Starmer | UK | 71% |
| VORBHUN | Viktor Orban | Hungary | 66% |
| MDIACPC | Miguel Diaz-Canel | Cuba | 64% |
| AKHAIRA | Ali Khamenei | Iran | 63% (Finalized) |
| BNETISR | Benjamin Netanyahu | Israel | 38% |
| EMACFRA | Emmanuel Macron | France | 17% |
| VPUTRUS | Vladimir Putin | Russia | 10% |
| XJINCHI | Xi Jinping | China | 8% |
| ... | ...60+ more leaders | | |

**How Polymarket Organizes It: SEPARATE Events Per Leader**

Polymarket creates independent events for each leader, each with date-variant sub-markets:

| Poly Event ID | Event Title | Sub-Markets | Key Price |
|---|---|---|---|
| 143568 | Gustavo Petro out as leader of Colombia by...? | By Jun 30 (3%), By Dec 31 (93.5%) | 93.5% |
| 17725 | Starmer out by...? | By Mar 31 (3%), By Jun 30 (46%), By Dec 31 (69%) | 69% |
| 143567 | Miguel Diaz-Canel out as leader of Cuba by...? | By Mar 31 (8%), By Jun 30 (51%), By Dec 31 (68%) | 68% |
| 237598 | Iran leader end of 2026? | Mojtaba Khamenei (33%), Reza Pahlavi (15%), ... | 33% |
| 143443 | Venezuela leader end of 2026? | Delcy Rodriguez (58%), Maria Corina (14%), ... | 58% |

**What Happens in Our System (Broken)**

The event matcher mapped the Kalshi mega-event to Polymarket event 237598 (Iran leader), probably because both mention "leaders" and "2026". Result:

| Leader | Kalshi Price | Poly Price | Correct Poly | Status |
|---|---|---|---|---|
| Petro (Colombia) | 94% | — (missing) | 93.5% | NOT MATCHED |
| Starmer (UK) | 71% | — (missing) | 69% | NOT MATCHED |
| Diaz-Canel (Cuba) | 64% | — (missing) | 68% | NOT MATCHED |
| Orban (Hungary) | 66% | — (missing) | ~66% | NOT MATCHED |

All these leaders have matching markets on BOTH exchanges with very similar prices, but our system shows Kalshi-only because the Polymarket events are not linked to the same canonical event.

### How This Differs From Problem 4

| | Problem 4 (Date Variants) | Problem 5 (Mega-Events) |
|---|---|---|
| Pattern | Same entity, different dates | Different entities under one umbrella |
| Example | Greenland: before 2027 vs before Jul 2026 | World Leaders: Petro vs Starmer vs Orban |
| Kalshi | 1 event, N date-variant markets | 1 mega-event, 20-60+ entity markets |
| Polymarket | Separate events per date | Separate events per entity |
| Fix needed | Cross-event date matching (Fix 6) | Mega-event decomposition (Fix 7) |

### Root Cause

The event matcher treats each Kalshi event as a single unit and tries to find ONE matching Polymarket event. It does not detect that a Kalshi event is a "mega-event" containing many independent sub-topics, each of which has its own separate event on Polymarket.

The detection signal is clear: when a Kalshi event has 20+ markets all following the pattern "Main question? — Entity Name", it is almost certainly a mega-event that Polymarket will organize differently.

---

## Recommended Fixes

### Fix 1: Delete Bad Low-Confidence Matches (Immediate, 5 min)

**Priority:** P0 — Do this first, no code deploy needed
**Impact:** Removes incorrect threshold-vs-exact matches from homepage display

```sql
-- Delete all matches with confidence below 0.80
-- These are the incorrect threshold-vs-exact matches
DELETE FROM direct_exchanges_data.market_mappings
WHERE confidence_score < 0.80;

-- Verify: check how many remain
SELECT
  COUNT(*) as total_remaining,
  MIN(confidence_score) as min_confidence,
  AVG(confidence_score) as avg_confidence
FROM direct_exchanges_data.market_mappings;
```

### Fix 2: Raise Minimum Confidence for Future Matches (Immediate, 5 min)

**Priority:** P0 — Prevents new bad matches from being stored
**File:** Market matcher config or code where min_confidence is set

Change the minimum confidence threshold from 0.50 to 0.85:

```typescript
// In the matcher code, find where matches are written to DB
// Add/update the minimum confidence check:

const MIN_MATCH_CONFIDENCE = 0.85; // was 0.50 or no minimum

if (confidence >= MIN_MATCH_CONFIDENCE) {
  // Write match to market_mappings
} else {
  // Log as rejected: too low confidence
  logger.info('Match rejected: confidence too low',
    { kalshi: kalshiId, poly: polyId, confidence });
}
```

### Fix 3: Improve Pre-Filter to Catch More Valid Matches (1-2 days)

**Priority:** P1 — This is the biggest impact fix, raises match rate from 56% to ~85%+
**File:** Market matcher pre-filter logic (keyword overlap calculation)

The pre-filter needs these improvements:

**3a. Extract entity names from Kalshi subtitle pattern**

```typescript
// Kalshi pattern: "Who will win X? — Candidate Name"
// Extract the part after the dash as the entity name

function extractEntity(title: string): string | null {
  const dashMatch = title.match(/—\s*(.+)$/);
  if (dashMatch) return dashMatch[1].trim();
  return null;
}

// When comparing, also check if the entity name appears
// anywhere in the other exchange's title
const kalshiEntity = extractEntity(kalshiTitle);
if (kalshiEntity && polyTitle.toLowerCase()
    .includes(kalshiEntity.toLowerCase())) {
  // Force this pair to be sent to GPT
  sendToGPT = true;
}
```

**3b. Add synonym normalization**

```typescript
// Before keyword comparison, normalize synonyms:
const SYNONYMS = {
  'cut': 'decrease',
  'hike': 'increase',
  'no change': 'maintain',
  'raise': 'increase',
  'lower': 'decrease',
  'slash': 'decrease',
  'boost': 'increase',
};

function normalizeTitle(title: string): string {
  let normalized = title.toLowerCase();
  for (const [key, value] of Object.entries(SYNONYMS)) {
    normalized = normalized.replace(
      new RegExp(key, 'gi'), value);
  }
  return normalized;
}
```

**3c. Handle accented characters (Unicode normalization)**

```typescript
// Normalize accented characters before comparison
function stripAccents(str: string): string {
  return str.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// "São Paulo" -> "Sao Paulo"
// "González" -> "Gonzalez"
```

**3d. Lower the keyword overlap threshold for same-event markets**

```typescript
// If two markets are already in the same canonical event,
// use a LOWER keyword overlap threshold (or skip pre-filter
// entirely) since we already know they're related.

if (sameCanonicalEvent) {
  // Always send to GPT - the event mapping already
  // confirmed they're in the same category
  sendToGPT = true;
} else {
  // Use normal keyword overlap threshold
  sendToGPT = keywordOverlap >= THRESHOLD;
}
```

### Fix 4: Auto-Match Both Sides (YES + NO) (30 min)

**Priority:** P1 — Eliminates the split-row display bug
**File:** Market matcher — where matches are written to DB

When a YES-side match is confirmed, automatically create the NO-side match (and vice versa) since they are always complementary.

```typescript
async function writeMatch(kalshi, poly, side, confidence, model) {
  // Write the confirmed side
  await upsertMapping(kalshi, poly, side, confidence, model);

  // Auto-create the complementary side
  const otherSide = side === 'YES' ? 'NO' : 'YES';

  const kalshiOther = await findMarket(
    kalshi.exchangeId, kalshi.marketId, otherSide);
  const polyOther = await findMarket(
    poly.exchangeId, poly.marketId, otherSide);

  if (kalshiOther && polyOther) {
    await upsertMapping(
      kalshiOther, polyOther, otherSide,
      confidence, model
    );
    logger.info('Auto-matched complementary side',
      { side: otherSide, confidence });
  }
}
```

Also run this SQL to fix existing asymmetric matches:

```sql
-- Find YES-only matches and create NO counterparts
INSERT INTO direct_exchanges_data.market_mappings
  (source_id, exchange_id, market_id, outcome_side,
   canonical_market_id, confidence_score, matched_at,
   model_id, match_version, is_active)
SELECT
  mm.source_id, mm.exchange_id, pm_no.market_id, 'NO',
  mm.canonical_market_id, mm.confidence_score, NOW(),
  mm.model_id, mm.match_version, true
FROM direct_exchanges_data.market_mappings mm
JOIN direct_exchanges_data.prediction_markets pm_yes
  ON mm.source_id = pm_yes.source_id
  AND mm.exchange_id = pm_yes.exchange_id
  AND mm.market_id = pm_yes.market_id
  AND pm_yes.outcome_side = 'YES'
JOIN direct_exchanges_data.prediction_markets pm_no
  ON pm_yes.source_id = pm_no.source_id
  AND pm_yes.exchange_id = pm_no.exchange_id
  AND pm_yes.event_id = pm_no.event_id
  AND pm_no.outcome_side = 'NO'
  AND pm_yes.title = pm_no.title
WHERE mm.outcome_side = 'YES'
AND NOT EXISTS (
  SELECT 1 FROM direct_exchanges_data.market_mappings mm2
  WHERE mm2.canonical_market_id = mm.canonical_market_id
  AND mm2.exchange_id = mm.exchange_id
  AND mm2.outcome_side = 'NO'
);
```

### Fix 5: Improve GPT Prompt with Explicit Rejection Rules (30 min)

**Priority:** P2 — Prevents future wrong matches
**File:** Market matcher GPT prompt template

Add these explicit rejection criteria to the GPT prompt:

```
IMPORTANT REJECTION CRITERIA:

You MUST return confidence = 0 if ANY of these are true:

1. THRESHOLD vs EXACT VALUE: One market asks "above X%"
   or "at least X" while the other asks "exactly X%" or
   "be X%". These are DIFFERENT markets.
   Example: "above 3.25%" != "be 3.25%"

2. DIFFERENT DATES: Markets reference different time
   periods or meetings.
   Example: "Oct meeting" != "end of 2026"

3. DIFFERENT CANDIDATES/ENTITIES: Markets reference
   different people, teams, or entities.
   Example: "Adam Miller" != "Jessica Rodriguez"

4. DIFFERENT METRICS: One measures total/cumulative,
   the other measures incremental/change.
   Example: "total above 100" != "increase by 10"
```

### Fix 6: Cross-Event Date-Variant Matching (1-2 days)

**Priority:** P0 — Required before launch. Many high-profile markets (Greenland, Fed rates, elections) are affected.
**File:** Market matcher — main matching loop + new cross-event comparison step

#### The Problem

The matcher currently only compares markets WITHIN the same canonical event. But Kalshi groups date-variant markets under one event while Polymarket creates separate events per date. The matcher never compares across events.

#### Solution: Two-Phase Matching

Add a second matching phase that runs AFTER the normal within-event matching:

```typescript
// PHASE 2: Cross-event matching for date variants
// Run after Phase 1 (within-event matching) completes

async function crossEventMatching() {
  // Step 1: Find all unmatched markets
  const unmatched = await db.query(`
    SELECT pm.*, em.canonical_event_id
    FROM prediction_markets pm
    JOIN event_mappings em ON pm.source_id = em.source_id
      AND pm.exchange_id = em.exchange_id
      AND pm.event_id = em.event_id
    LEFT JOIN market_mappings mm ON pm.source_id = mm.source_id
      AND pm.exchange_id = mm.exchange_id
      AND pm.market_id = mm.market_id
      AND pm.outcome_side = mm.outcome_side
    WHERE mm.canonical_market_id IS NULL
      AND pm.status = 'Open'
      AND pm.outcome_side = 'YES'
  `);

  // Step 2: Group unmatched by exchange
  const kalshiUnmatched = unmatched
    .filter(m => m.exchange_id === 'KALSHI');
  const polyUnmatched = unmatched
    .filter(m => m.exchange_id === 'POLYMARKET');

  // Step 3: For each unmatched Kalshi market,
  //   find Poly candidates with similar core question
  for (const kalshi of kalshiUnmatched) {
    const coreQuestion = extractCoreQuestion(kalshi.title);
    const kalshiExpiry = kalshi.expires_at;

    // Find Poly markets with similar core + matching expiry
    const candidates = polyUnmatched.filter(poly => {
      const polyCoreQ = extractCoreQuestion(poly.title);
      const coreOverlap = calculateOverlap(
        coreQuestion, polyCoreQ);
      const expiryMatch = isExpiryCompatible(
        kalshiExpiry, poly.expires_at, 30); // 30 day tolerance
      return coreOverlap > 0.5 && expiryMatch;
    });

    // Send candidates to GPT for confirmation
    for (const poly of candidates) {
      const result = await askGPT(kalshi, poly);
      if (result.confidence >= 0.85) {
        await writeMatch(
          kalshi, poly, 'YES',
          result.confidence, result.model);
      }
    }
  }
}
```

#### Key Helper Functions

```typescript
// Extract core question by removing dates and time references
function extractCoreQuestion(title: string): string {
  return title
    .replace(/before \w+ \d{1,2},? \d{4}/gi, '')
    .replace(/before \d{4}/gi, '')
    .replace(/in \d{4}/gi, '')
    .replace(/by \w+ \d{4}/gi, '')
    .replace(/—.*$/, '')  // Remove Kalshi subtitle
    .replace(/\?$/, '')
    .trim()
    .toLowerCase();
}

// Check if two expiry dates are within tolerance
function isExpiryCompatible(
  date1: Date, date2: Date, toleranceDays: number
): boolean {
  const diff = Math.abs(
    date1.getTime() - date2.getTime()
  );
  return diff <= toleranceDays * 24 * 60 * 60 * 1000;
}
```

#### GPT Prompt Addition for Date-Variant Matching

```
IMPORTANT: These markets are from DIFFERENT events but may
be asking the same question about the same timeframe.

You MUST verify BOTH of these conditions:
1. Core question is the same (ignore wording differences
   like 'buy' vs 'acquire', 'Trump' vs 'US')
2. Time window is the SAME or very similar:
   - 'before 2027' == 'before 2027' => MATCH
   - 'before Jan 21, 2029' == 'before 2029' => MATCH
     (within 21 days)
   - 'before Jul 2026' != 'in 2026' => NO MATCH
     (different time windows)
   - 'before Apr 2026' != 'before 2027' => NO MATCH
     (different dates)

Return confidence = 0 if the dates/time windows differ.
```

#### Expiry Matching Rules

| Kalshi Expiry | Poly Expiry | Match? | Reason |
|---|---|---|---|
| before 2027 | before 2027 | YES | Identical date |
| before Jan 21, 2029 | before 2029 | YES | Within 21 days tolerance |
| before Jul 1, 2026 | in 2026 (Dec 31) | NO | 6 month gap, different window |
| before Apr 2026 | before 2027 | NO | 9 month gap, different question |

#### Fix 6 Acceptance Criteria

- Kalshi KXGREENLAND-27 ("before 2027") is matched with Polymarket 997488 ("before 2027")
- Kalshi KXGREENLAND-26JUL01 ("before Jul 2026") is NOT matched with Poly 148292 ("in 2026")
- Cross-event matches appear with both K and P prices on the same row in the UI
- No false matches between different date windows
- Both YES and NO sides are matched (uses Fix 4 auto-match logic)

### Fix 7: Mega-Event Decomposition and Cross-Event Entity Matching (2-3 days)

**Priority:** P0 — Required before launch. Many high-value events affected: World Leaders ($4.6M vol), country-specific leader events, sports tournaments, etc.
**File:** Event matcher + Market matcher — new decomposition phase

#### Step 1: Detect Mega-Events

Identify Kalshi events that contain many entity-specific sub-markets:

```typescript
// Detection criteria for mega-events:
// 1. Event has 20+ markets on Kalshi
// 2. Market titles follow pattern: "Question? — Entity"
// 3. Each entity is a different person/team/country

async function detectMegaEvents(): Promise<MegaEvent[]> {
  const candidates = await db.query(`
    SELECT event_id, COUNT(DISTINCT market_id) as mkt_count
    FROM direct_exchanges_data.prediction_markets
    WHERE exchange_id = 'KALSHI'
      AND status = 'Open'
    GROUP BY event_id
    HAVING COUNT(DISTINCT market_id) > 20
  `);

  const megaEvents: MegaEvent[] = [];
  for (const evt of candidates) {
    const markets = await getMarkets(evt.event_id);
    // Check if titles follow "Question — Entity" pattern
    const dashPattern = /—\s*(.+)$/;
    const entities = markets
      .map(m => m.title.match(dashPattern)?.[1]?.trim())
      .filter(Boolean);

    // If >60% of markets have the dash pattern,
    // it's a mega-event
    if (entities.length / markets.length > 0.6) {
      megaEvents.push({
        eventId: evt.event_id,
        entities: entities,
        baseQuestion: extractBaseQuestion(markets[0].title)
      });
    }
  }
  return megaEvents;
}
```

#### Step 2: Extract and Normalize Entity Names

```typescript
function extractBaseQuestion(title: string): string {
  // "Who will leave office? — Gustavo Petro"
  // => "Who will leave office"
  return title.split('—')[0]
    .replace(/\?$/, '').trim();
}

function extractEntity(title: string): string | null {
  const match = title.match(/—\s*(.+)$/);
  if (!match) return null;
  return stripAccents(match[1].trim().toLowerCase());
}
```

#### Step 3: Search Polymarket for Matching Per-Entity Events

```typescript
async function matchMegaEventEntities(mega: MegaEvent) {
  for (const entity of mega.entities) {
    // Search for Polymarket events containing this entity
    const polyEvents = await db.query(`
      SELECT DISTINCT em.event_id, em.canonical_event_id
      FROM direct_exchanges_data.event_mappings em
      JOIN direct_exchanges_data.prediction_markets pm
        ON em.source_id = pm.source_id
        AND em.exchange_id = pm.exchange_id
        AND em.event_id = pm.event_id
      WHERE em.exchange_id = 'POLYMARKET'
        AND (
          LOWER(pm.title) LIKE '%' || $1 || '%'
          OR LOWER(pm.title) LIKE '%' || $2 || '%'
        )
    `, [entity.fullName, entity.lastName]);

    // For each candidate Poly event, send to GPT
    for (const polyEvt of polyEvents) {
      const polyMarkets = await getMarkets(polyEvt.event_id);
      for (const polyMkt of polyMarkets) {
        const result = await askGPT(
          entity.kalshiMarket, polyMkt);
        if (result.confidence >= 0.85) {
          await writeMatch(
            entity.kalshiMarket, polyMkt,
            'YES', result.confidence, result.model
          );
        }
      }
    }
  }
}
```

#### Step 4: Handle Date-Variant Sub-Markets

Polymarket's per-entity events often contain date-variant sub-markets ("out by Jun 30?", "out by Dec 31?"). The matcher must pick the correct date:

```typescript
// When matching Kalshi entity market to Poly sub-markets,
// compare expiry dates to find the right one.

// Example: Kalshi KXLEADERSOUT-27JAN01-GPETCOL
//   expires Jan 1, 2027
// Poly event 143568 has:
//   "Petro out by Jun 30?" (expires Jun 30, 2026) => NO MATCH
//   "Petro out by Dec 31?" (expires Dec 31, 2026) => MATCH!

function findBestDateMatch(
  kalshiExpiry: Date,
  polyMarkets: Market[]
): Market | null {
  // Sort by closest expiry date to Kalshi market
  const sorted = polyMarkets
    .map(m => ({
      market: m,
      diff: Math.abs(
        kalshiExpiry.getTime() - m.expiresAt.getTime())
    }))
    .sort((a, b) => a.diff - b.diff);

  // Only match if within 30 day tolerance
  if (sorted[0] && sorted[0].diff <= 30 * 86400000) {
    return sorted[0].market;
  }
  return null;
}
```

#### Fix 7 Acceptance Criteria

- Kalshi GPETCOL (Petro, 94%) is matched with Poly event 143568 "out by Dec 31" (93.5%)
- Kalshi KSTAUK (Starmer, 71%) is matched with Poly event 17725 "out by Dec 31, 2026" (69%)
- Kalshi MDIACPC (Diaz-Canel, 64%) is matched with Poly event 143567 "out by Dec 31" (68%)
- Kalshi AKHAIRA (Khamenei, finalized) is correctly linked to Poly event 237598 (Iran leader)
- Cross-matched markets show both K and P prices side by side in the UI
- Date-variant Poly sub-markets are correctly matched to Kalshi expiry (Dec 31 not Jun 30)
- No false cross-entity matches (Petro not matched to Starmer, etc.)

---

## Execution Plan

| Order | Fix | Type | Effort | Impact |
|---|---|---|---|---|
| 1 | Fix 1: Delete bad matches | SQL only | 5 min | Removes wrong data from homepage |
| 2 | Fix 2: Raise min confidence | Config/code | 5 min | Prevents future bad matches |
| 3 | Fix 4: Auto-match both sides | Code + SQL | 30 min | Fixes split-row display bug |
| 4 | Fix 3: Improve pre-filter | Code | 1-2 days | Raises match rate 56% to 85%+ |
| 5 | Fix 5: Improve GPT prompt | Config | 30 min | Better accuracy on edge cases |
| 6 | Fix 6: Cross-event date matching | Code | 1-2 days | Matches Greenland, Fed, etc. |
| 7 | Fix 7: Mega-event decomposition | Code | 2-3 days | Matches World Leaders, tournaments, etc. |

Fixes 1 and 2 can be done immediately with no risk. Fixes 3, 6, and 7 can be developed in parallel as they address different matching phases. Fix 7 should reuse Fix 3 improvements (synonym normalization, accent handling, entity extraction) and Fix 6 logic (expiry date comparison). All fixes are required before launch.

---

## Validation Queries (Run After All Fixes)

```sql
-- 1. Verify no low-confidence matches remain
SELECT MIN(confidence_score) as min_conf,
  COUNT(*) FILTER (WHERE confidence_score < 0.80) as bad
FROM direct_exchanges_data.market_mappings;
-- Expected: min_conf >= 0.85, bad = 0

-- 2. Check new match coverage rate
SELECT
  COUNT(*) as total,
  COUNT(mm.canonical_market_id) as matched,
  ROUND(100.0 * COUNT(mm.canonical_market_id)
    / NULLIF(COUNT(*), 0), 1) as match_rate_pct
FROM direct_exchanges_data.prediction_markets pm
JOIN direct_exchanges_data.event_mappings em
  ON pm.source_id = em.source_id
  AND pm.exchange_id = em.exchange_id
  AND pm.event_id = em.event_id
LEFT JOIN direct_exchanges_data.market_mappings mm
  ON pm.source_id = mm.source_id
  AND pm.exchange_id = mm.exchange_id
  AND pm.market_id = mm.market_id
  AND pm.outcome_side = mm.outcome_side
WHERE em.canonical_event_id IN (
  SELECT canonical_event_id
  FROM direct_exchanges_data.event_mappings
  GROUP BY canonical_event_id
  HAVING COUNT(DISTINCT exchange_id) > 1
)
AND pm.status = 'Open';
-- Target: match_rate_pct > 85%

-- 3. Verify no asymmetric matches remain
SELECT outcome_side, COUNT(*) as count
FROM direct_exchanges_data.market_mappings
GROUP BY outcome_side;
-- Expected: YES and NO counts should be roughly equal
```
