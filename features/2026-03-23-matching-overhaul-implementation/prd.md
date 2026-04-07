# Market Matching Quality Overhaul — Backend Implementation PRD

**Status**: Pending
**Priority**: P0 (must complete before launch)
**Date**: 2026-03-23

---

## Table of Contents

1. [Background & Current State](#1-background--current-state)
2. [Fix A: Incompatible Market Type Detection](#2-fix-a-incompatible-market-type-detection)
3. [Fix B: Normalization & Modifier Guard](#3-fix-b-normalization--modifier-guard)
4. [Fix C: Display Filtering](#4-fix-c-display-filtering)
5. [Fix D: Backfill Re-match](#5-fix-d-backfill-re-match)
6. [Fix E: Regression Tests](#6-fix-e-regression-tests)
7. [Deployment & Verification](#7-deployment--verification)

---

## 1. Background & Current State

### Problem

Market match rate is only **59.9%** (target: 80%). There are **296 suspicious matches** (price gap >20%) causing phantom arb signals. The frontend shows market cards with single-side missing prices.

### Current DB Metrics (2026-03-23)

```
Matched pairs: 6,421
Kalshi mapped / open: 12,657 / 59,144 (21.4%)
Poly mapped / open: 12,347 / 43,480 (28.4%)
Match rate within matched events: 59.9%
Suspicious matches (>20% gap): 296
Unmatched within events (Kalshi): 2,654
Unmatched within events (Poly): 2,198
```

### Already Deployed ✅

1. **Sports Win/Draw/Lose fix** — `classifyOutcome()` deployed in all 4 tiers of `marketMatcher.ts`
2. **REST orderbook fallback** — stale legs refreshed via REST in arb scanner
3. **Arb config thresholds lowered** — `min_confidence=0.90`, `min_executable_qty=25`, `min_liquidity_usd=25`

### Expected Impact

| Fix | Bad Matches Removed | New Good Matches | Match Rate Impact |
|-----|-------------------|-----------------|-------------------|
| A (incompatible types) | ~100-150 | 0 (prevents creation) | Eliminates phantom arbs |
| B1-B4 (normalization) | 0 | ~170-270 | +5-8% |
| B5 (modifier guard) | ~150-200 | 0 (prevents creation) | Eliminates remaining phantoms |
| C (display filter) | 0 (hidden) | 0 | Clean frontend |
| D (backfill) | 0 | ~100-200 | +3-5% |
| **Total** | **~250-350** | **~270-470** | **59.9% → ~72-78%** |

---

## 2. Fix A: Incompatible Market Type Detection

### Goal

Prevent the matcher from pairing structurally incompatible market types. The existing `classifyOutcome()` only handles Win/Draw/Lose. Fix A extends this to broader market type incompatibility (spreads, totals, BTTS, over/under, etc.).

### File to Modify

**`packages/event-matcher/src/services/marketMatcher.ts`**

### Step 1: Add market type classification function

Add after `classifyOutcome()` (around line 164):

```typescript
/**
 * Classify a market's structural type to prevent incompatible matches.
 * Broader than classifyOutcome() which only handles Win/Draw/Lose.
 */
type MarketStructuralType =
  | 'BINARY'           // Standard binary market (Will X happen?)
  | 'WIN'              // Which team/person wins
  | 'DRAW'             // Draw/tie
  | 'SPREAD'           // Handicap/spread (Team -1.5)
  | 'OVER_UNDER'       // Over/under totals (Over 2.5 goals)
  | 'BTTS'             // Both teams to score
  | 'CORRECT_SCORE'    // Exact score
  | 'FIRST_HALF'       // First half results
  | 'WIN_METHOD'       // Victory method (by KO, by submission)
  | 'ROUND'            // Round predictions (fight ends in round X)
  | 'RANGE_BUCKET'     // Range buckets (price 1400-1500, temp 80-85°F)
  | 'MARGIN'           // Margin of victory (win by 6-9%)
  | 'UNKNOWN';

function classifyMarketType(title: string): MarketStructuralType {
  const lower = title.toLowerCase();

  // Sports — specific types
  if (/\b(spread|handicap)\b/.test(lower) || /[+-]\d+\.5/.test(lower)) return 'SPREAD';
  if (/\b(over|under)\s+\d+\.?\d*\s*(goals?|points?|runs?|total)/i.test(lower)) return 'OVER_UNDER';
  if (/\btotal\s+(goals?|points?|runs?)\b/i.test(lower)) return 'OVER_UNDER';
  if (/\bboth teams to score\b/i.test(lower) || /\bBTTS\b/.test(title)) return 'BTTS';
  if (/\bcorrect score\b/i.test(lower)) return 'CORRECT_SCORE';
  if (/\b(halftime|half-time|first half|leading at half)\b/i.test(lower)) return 'FIRST_HALF';
  if (/\bclean sheet\b/i.test(lower)) return 'BTTS'; // Same incompatible family
  if (/\b(draw|tie|tied)\b/.test(lower)) return 'DRAW';
  if (/\bby (KO|TKO|knockout|submission|decision|stoppage|split decision|unanimous|majority)\b/i.test(lower)) return 'WIN_METHOD';
  if (/\b(round \d|go the distance|ends in round)\b/i.test(lower)) return 'ROUND';

  // Range buckets — price, temperature, seat thresholds
  if (/\d+[\s-]+\d+/.test(title) && /\b(above|below|between|range|bucket)\b/i.test(lower)) return 'RANGE_BUCKET';
  if (/\b(margin|win by \d)/i.test(lower)) return 'MARGIN';

  // Win category
  if (/\b(win|winner|wins)\b/i.test(lower)) return 'WIN';

  return 'UNKNOWN';
}
```

### Step 2: Add compatibility check function

```typescript
/**
 * Check if two market types are compatible for matching.
 * Only same-type matches allowed for specific types.
 * UNKNOWN and BINARY are compatible with everything (non-sports markets).
 */
function areMarketTypesCompatible(type1: MarketStructuralType, type2: MarketStructuralType): boolean {
  if (type1 === 'UNKNOWN' || type2 === 'UNKNOWN') return true;
  if (type1 === 'BINARY' || type2 === 'BINARY') return true;
  return type1 === type2;
}
```

### Step 3: Call in all four matching paths

**3a. Binary 1:1 auto-match** (around lines 283-303)

After the existing `classifyOutcome` compatibility check, add:

```typescript
// After the existing compatible check (around line 296), add market type check:
if (compatible) {
  const kType = classifyMarketType(k.title || '');
  const pType = classifyMarketType(p.title || '');
  if (!areMarketTypesCompatible(kType, pType)) {
    compatible = false;
    logger.debug({ kType, pType, kTitle: k.title, pTitle: p.title },
      'Binary match rejected: incompatible market types');
  }
}
```

**3b. Inside `greedySubstringMatch()`** (around lines 68-124)

After finding `bestPoly`, before `matches.push()`:

```typescript
// Before matches.push({ kalshi, poly: bestPoly, similarity: 1.0 })
const kStructType = classifyMarketType(kalshi.title || '');
const pStructType = classifyMarketType(bestPoly.title || '');
if (!areMarketTypesCompatible(kStructType, pStructType)) {
  continue; // Incompatible structural type — skip
}
```

**3c. Inside `greedyMatch()`** (around lines 454-501)

After the existing `classifyOutcome` check, add:

```typescript
// Before candidates.push() (around line 478)
const kStructType = classifyMarketType(kalshi.title || '');
const pStructType = classifyMarketType(poly.title || '');
if (!areMarketTypesCompatible(kStructType, pStructType)) {
  continue;
}
```

**3d. Tier 3 AI verification** (around lines 337-361)

Before AI verification:

```typescript
for (const pair of borderline) {
  // Check market type compatibility first
  const kStructType = classifyMarketType(pair.kalshi.title || '');
  const pStructType = classifyMarketType(pair.poly.title || '');
  if (!areMarketTypesCompatible(kStructType, pStructType)) {
    continue;
  }
  // ... existing AI verification code ...
}
```

---

## 3. Fix B: Normalization & Modifier Guard

### B1. Export & apply synonym normalization

**File**: `packages/event-matcher/src/services/preFilter.ts`

Find `normalizeSynonyms()` (currently a private function) and export it:

```typescript
// Change to export
export function normalizeSynonyms(text: string): string {
  // ... existing code ...
}
```

**Expand the synonym map** (add to existing map):

```typescript
const SYNONYM_MAP: Record<string, string> = {
  // existing synonyms...
  'above': 'exceed',
  'exceed': 'exceed',
  'exceeds': 'exceed',
  'none': 'no',
  'before': 'by',
  'maintains': 'no change',
  'maintained': 'no change',
  'unchanged': 'no change',
  'hike': 'increase',
  'raise': 'increase',
  'cut': 'decrease',
  'lower': 'decrease',
  'reduction': 'decrease',
  // ... add more as needed
};
```

**File**: `packages/event-matcher/src/services/marketMatcher.ts`

Import and use in `normalizeOutcomeName()`:

```typescript
import { stripAccents, normalizeSynonyms } from './preFilter.js';

function normalizeOutcomeName(name: string): string {
  let result = stripAccents(name)
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Apply synonym normalization
  result = normalizeSynonyms(result);

  return result;
}
```

Also apply in `computeSimilarity()`:

```typescript
function computeSimilarity(a: string, b: string): number {
  const tokensA = new Set(normalizeOutcomeName(normalizeSynonyms(a)).split(' ').filter(Boolean));
  const tokensB = new Set(normalizeOutcomeName(normalizeSynonyms(b)).split(' ').filter(Boolean));
  // ... rest unchanged
}
```

---

### B2. Bidirectional substring matching

**File**: `packages/event-matcher/src/services/marketMatcher.ts`

Modify `substringMatch()` (around lines 42-61) to add reverse check:

```typescript
function substringMatch(kalshiName: string, polyTitle: string): boolean {
  const normName = normalizeOutcomeName(kalshiName);
  const normPoly = normalizeOutcomeName(polyTitle);

  // Forward: Kalshi name found in Polymarket title
  if (normName.length <= 4) {
    const escaped = normName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('\\b' + escaped + '\\b', 'i');
    if (re.test(normPoly)) return true;
  } else {
    if (normPoly.includes(normName)) return true;
  }

  // Reverse: Polymarket entity found in Kalshi name (NEW)
  if (normPoly.length <= 4) {
    const escaped = normPoly.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('\\b' + escaped + '\\b', 'i');
    if (re.test(normName)) return true;
  } else {
    if (normName.includes(normPoly)) return true;
  }

  // Special case: tie ↔ draw
  if (normName === 'tie' && /\bdraw\b/.test(normPoly)) return true;
  if (normName === 'draw' && /\btie\b/.test(normPoly)) return true;

  return false;
}
```

**Fixes**: "Andrea Kimi Antonelli" (Kalshi) contains "Kimi Antonelli" (Poly) → match succeeds

---

### B3. Abbreviation expansion

**File**: `packages/event-matcher/src/services/marketMatcher.ts`

Add constant at file top:

```typescript
const ABBREVIATION_MAP: Record<string, string> = {
  'man city': 'manchester city',
  'man utd': 'manchester united',
  'man united': 'manchester united',
  'spurs': 'tottenham hotspur',
  'wolves': 'wolverhampton wanderers',
  'barca': 'barcelona',
  'atleti': 'atletico madrid',
  'inter': 'inter milan',
  'bayern': 'bayern munich',
  'psg': 'paris saint germain',
  'rb leipzig': 'rasenballsport leipzig',
  'dortmund': 'borussia dortmund',
  'lakers': 'los angeles lakers',
  'celtics': 'boston celtics',
  'niners': 'san francisco 49ers',
  'bucs': 'tampa bay buccaneers',
  'pats': 'new england patriots',
};

function expandAbbreviations(text: string): string {
  let result = text.toLowerCase();
  for (const [abbr, full] of Object.entries(ABBREVIATION_MAP)) {
    const re = new RegExp('\\b' + abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
    result = result.replace(re, full);
  }
  return result;
}
```

Call in `normalizeOutcomeName()`:

```typescript
function normalizeOutcomeName(name: string): string {
  let result = stripAccents(name)
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  result = expandAbbreviations(result);  // NEW
  result = normalizeSynonyms(result);

  return result;
}
```

---

### B4. Strip junk tokens

**File**: `packages/event-matcher/src/services/marketMatcher.ts`

Add to `normalizeOutcomeName()`:

```typescript
const FILLER_WORDS = new Set(['exactly', 'least', 'most', 'approximately', 'about', 'around']);

function normalizeOutcomeName(name: string): string {
  let result = stripAccents(name)
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  result = expandAbbreviations(result);
  result = normalizeSynonyms(result);

  // Strip numeric-only tokens and filler words (NEW)
  result = result.split(' ')
    .filter(token => {
      if (/^\d+$/.test(token)) return false;  // Pure numbers
      if (FILLER_WORDS.has(token)) return false;
      return true;
    })
    .join(' ');

  return result;
}
```

**Fixes**: "Talarico, 6-9%" extracts "talarico 69" → normalizes to just "talarico" → correct match

---

### B5. Three-Tier Modifier Guard — THE KEY FIX

#### Goal

Prevent "same entity, different question" false matches. Examples:
- "Axel Sola wins fight" ↔ "Axel Sola wins by KO" (same entity, different question)
- "47 Senate seats" ↔ "47 or fewer Senate seats" (different range)
- "Greenland before 2027" ↔ "Greenland by March 31" (different timeframe)

#### Step 1: Add modifier rules constant

**File**: `packages/event-matcher/src/services/marketMatcher.ts`

Add near `classifyOutcome()`:

```typescript
type ModifierTier = 'AUTO_REJECT' | 'AI_VERIFY';

interface ModifierRule {
  category: string;
  tier: ModifierTier;
  patterns: RegExp[];
}

const MODIFIER_RULES: ModifierRule[] = [
  // ===== TIER 1: Auto-reject (100% precision, no AI needed) =====
  {
    category: 'WIN_METHOD',
    tier: 'AUTO_REJECT',
    patterns: [
      /\bby KO\b/i, /\bby TKO\b/i, /\bby knockout\b/i,
      /\bby submission\b/i, /\bby decision\b/i, /\bby stoppage\b/i,
      /\bby split decision\b/i, /\bby unanimous\b/i, /\bby majority\b/i,
    ],
  },
  {
    category: 'MARKET_TYPE_SPORTS',
    tier: 'AUTO_REJECT',
    patterns: [
      /\bboth teams to score\b/i, /\bBTTS\b/,
      /\btotal goals\b/i, /\bover \d+\.?\d* goals\b/i, /\bunder \d+\.?\d* goals\b/i,
      /\bhalftime\b/i, /\bhalf-time\b/i, /\bleading at half\b/i,
      /\bclean sheet\b/i,
    ],
  },
  {
    category: 'SCOPE_QUALIFIER',
    tier: 'AUTO_REJECT',
    patterns: [
      /\bor any of its\b/i, /\baffiliates?\b/i, /\bsubsidiaries?\b/i,
    ],
  },

  // ===== TIER 2: AI-verify (nuanced, needs judgment) =====
  {
    category: 'RANGE_QUALIFIER',
    tier: 'AI_VERIFY',
    patterns: [
      /\bor fewer\b/i, /\bor more\b/i, /\bor less\b/i, /\bor above\b/i,
      /\bat least\b/i, /\bat most\b/i,
      /\bfewer than\b/i, /\bmore than\b/i, /\bgreater than\b/i,
      /\bno more than\b/i, /\bno fewer than\b/i,
    ],
  },
  {
    category: 'TIME_SCOPE',
    tier: 'AI_VERIFY',
    patterns: [
      /\bby (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*/i,
      /\bbefore (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*/i,
      /\bin (Q[1-4])\b/i, /\bbefore (Q[1-4])\b/i,
      /\bin 202[4-9]\b/i, /\bin 203\d\b/i,
      /\bbefore 202[4-9]\b/i, /\bbefore 203\d\b/i,
      /\bby 202[4-9]\b/i, /\bby 203\d\b/i,
    ],
  },
];
```

#### Step 2: Add modifier conflict check function

```typescript
/**
 * Check for modifier conflicts between two market titles.
 *
 * Logic: Only flag when ONE side has a modifier pattern and the other doesn't.
 * If both have it or neither has it → no conflict.
 *
 * Tier 1 (AUTO_REJECT): Immediately reject — 100% precision, no AI needed.
 * Tier 2 (AI_VERIFY): Send to GPT-5-nano for yes/no check.
 */
async function checkModifierConflict(
  kalshiTitle: string,
  polyTitle: string,
  config: Config
): Promise<{ reject: boolean; reason?: string }> {
  for (const rule of MODIFIER_RULES) {
    const kHas = rule.patterns.some(p => p.test(kalshiTitle));
    const pHas = rule.patterns.some(p => p.test(polyTitle));

    // Both have or neither has → no conflict
    if (kHas === pHas) continue;

    if (rule.tier === 'AUTO_REJECT') {
      logger.debug({
        category: rule.category,
        kalshiTitle,
        polyTitle,
      }, 'Modifier guard: auto-reject');
      return { reject: true, reason: `${rule.category}: auto-reject` };
    }

    if (rule.tier === 'AI_VERIFY') {
      const aiResult = await verifyModifierConflict(kalshiTitle, polyTitle, config);
      if (aiResult === 'DIFFERENT') {
        logger.debug({
          category: rule.category,
          kalshiTitle,
          polyTitle,
        }, 'Modifier guard: AI-rejected');
        return { reject: true, reason: `${rule.category}: AI-rejected` };
      }
      // AI said SAME → allow the match
      logger.debug({
        category: rule.category,
        kalshiTitle,
        polyTitle,
      }, 'Modifier guard: AI-approved');
    }
  }
  return { reject: false };
}
```

#### Step 3: Add AI verification function

**File**: `packages/event-matcher/src/services/aiComparer.ts`

Add new exported function:

```typescript
/**
 * Quick AI check for modifier conflicts.
 * Returns 'SAME' or 'DIFFERENT'.
 */
export async function verifyModifierConflict(
  titleA: string,
  titleB: string,
  config: Config
): Promise<'SAME' | 'DIFFERENT'> {
  const prompt = `You are comparing two prediction market titles to determine if they ask the same question.

Title A: ${titleA}
Title B: ${titleB}

Do these two titles ask the same question? Consider:
- Different date formats for the same deadline are the SAME question
  (e.g., "before 2027" and "before Jan 1, 2027")
- Different timeframes are DIFFERENT questions
  (e.g., "by March 31" vs "in 2026")
- "exactly N" and "N" alone are the SAME question
- "N" and "N or fewer/more" are DIFFERENT questions

Answer SAME or DIFFERENT (one word only).`;

  try {
    // Use existing OpenAI client and rate limiter
    // See how verifyMarketMatch() calls OpenAI — use the same pattern
    const response = await callOpenAI(prompt, config);
    const answer = response.trim().toUpperCase();
    return answer === 'SAME' ? 'SAME' : 'DIFFERENT';
  } catch (err) {
    logger.error({ err, titleA, titleB }, 'Modifier AI verification failed');
    return 'SAME'; // On error, default to allowing the match (conservative)
  }
}
```

> **Note**: `callOpenAI` may need to be extracted from the existing AI call logic. Look at how `verifyMarketMatch()` calls OpenAI and replicate the same pattern.

**File**: `packages/event-matcher/src/services/marketMatcher.ts`

Import the new function:

```typescript
import { verifyMarketMatch, verifyModifierConflict } from './aiComparer.js';
```

#### Step 4: Call modifier guard in the matching flow

**Recommended approach**: Check before writing to DB (in the "Write results" section, around line 365):

```typescript
// In the "Write results" loop (around line 365), modify:
let marketsMatched = 0;
for (const match of verified) {
  // Modifier guard check (NEW)
  const modifierCheck = await checkModifierConflict(
    match.kalshi.title || '',
    match.poly.title || '',
    config
  );
  if (modifierCheck.reject) {
    logger.info({
      kalshiMarket: match.kalshi.market_id,
      polyMarket: match.poly.market_id,
      reason: modifierCheck.reason,
      kalshiTitle: match.kalshi.title,
      polyTitle: match.poly.title,
    }, 'Match rejected by modifier guard');
    continue; // Skip this match
  }

  // ... existing canonicalMarketId generation and write code ...
}
```

#### Verification Examples

| Kalshi Title | Poly Title | Category | Tier | Result |
|-------------|-----------|----------|------|--------|
| "Axel Sola wins fight" | "Axel Sola wins by KO" | WIN_METHOD | 1 | Auto-reject ✅ |
| "Wolfsburg wins" | "Both Teams to Score" | MARKET_TYPE_SPORTS | 1 | Auto-reject ✅ |
| "47 Senate seats" | "47 or fewer seats" | RANGE_QUALIFIER | 2 | AI → DIFFERENT → reject |
| "Starmer before 2027" | "Starmer before Jan 1, 2027" | TIME_SCOPE | 2 | AI → SAME → allow ✅ |
| "Bitcoin $150k" | "Bitcoin $150k" | None | 3 | Pass ✅ |

#### Known Gap: Numeric Threshold Comparison (B5b)

**Discovered 2026-03-26.** The modifier guard only flags when ONE side has a range modifier and the other doesn't (`kHas !== pHas`). But it misses cases where BOTH sides have range/threshold words but with **different numbers**:

| Kalshi | Polymarket | Why guard missed it |
|--------|-----------|-------------------|
| "Republican Party win 193 seats" | "Republican Party hold below 190 seats" | Both have "below" + number → `kHas === pHas` → no conflict |
| "Democratic Party hold 47 seats" | "Republican Party hold 47 or fewer seats" | "or fewer" on Poly only → SHOULD have been caught but match was created pre-deployment |

**Fix needed:** Add a NUMERIC_THRESHOLD check that extracts numbers from both titles and compares them when range/threshold words are present:

```typescript
{
  category: 'NUMERIC_THRESHOLD',
  tier: 'AI_VERIFY',
  patterns: [
    /\b(above|below|over|under|at least|at most|fewer|more)\s+\d/i,
    /\d+\s*(seats?|goals?|points?|contracts?|cuts?|hikes?)/i,
  ],
}
```

**Logic change:** For NUMERIC_THRESHOLD, don't use `kHas !== pHas`. Instead:
1. Extract all numbers from both titles
2. If both titles contain numbers AND the numbers are different → AI_VERIFY
3. If same numbers → pass (probably the same market)

```typescript
// Special handling for NUMERIC_THRESHOLD
if (rule.category === 'NUMERIC_THRESHOLD') {
  const kNums = (kalshiTitle.match(/\d+/g) || []).map(Number);
  const pNums = (polyTitle.match(/\d+/g) || []).map(Number);
  // Only flag if both have numbers and they differ
  const kSet = new Set(kNums);
  const pSet = new Set(pNums);
  const overlap = kNums.filter(n => pSet.has(n));
  if (overlap.length === 0 && kNums.length > 0 && pNums.length > 0) {
    // Different numbers with threshold words → AI verify
    const aiResult = await verifyModifierConflict(kalshiTitle, polyTitle, config);
    if (aiResult === 'DIFFERENT') {
      return { reject: true, reason: 'NUMERIC_THRESHOLD: different numbers' };
    }
  }
  continue; // skip normal kHas/pHas check for this rule
}
```

**Verified examples this would catch:**
- "193 seats" vs "below 190 seats" → numbers 193 ≠ 190 → AI verify → DIFFERENT → reject ✅
- "47 seats" vs "47 or fewer seats" → number 47 = 47 BUT "or fewer" modifier → caught by existing RANGE_QUALIFIER ✅
- "Bitcoin $150k" vs "Bitcoin $150k" → same number → pass ✅

---

## 4. Fix C: Display Filtering

### Goal

Unmatched markets within events should not appear on the frontend. Users see only correctly matched markets.

### File to Modify

**`packages/homepage-api/src/routes/events.ts`**

### Implementation

Find the route that returns event details with market lists. Add filtering logic:

```typescript
// Filter: only return markets that have mappings on BOTH exchanges
// i.e., canonical_market_id exists with both KALSHI and POLYMARKET rows

// In the market list query, add a JOIN condition to ensure
// each canonical_market_id has mappings from both exchanges
```

**Specific changes**:

1. Find the market query in `events.ts` that returns market lists
2. Add filter condition: only return markets with complete pairs (both exchanges mapped for the canonical_market_id)
3. Test: frontend page no longer shows single-side missing-price market cards

### Verification SQL

```sql
-- Check: how many markets currently have only single-side data
SELECT count(DISTINCT canonical_market_id) as single_side_only
FROM direct_exchanges_data.market_mappings mm
WHERE canonical_market_id NOT IN (
  SELECT canonical_market_id
  FROM direct_exchanges_data.market_mappings
  GROUP BY canonical_market_id
  HAVING count(DISTINCT exchange_id) = 2
);
```

---

## 5. Fix D: Backfill Re-match

### Goal

After deploying Fix A + B, re-run market matching for all existing event pairs with the improved logic.

### Implementation

**Option 1 — One-time script**:

```typescript
// scripts/backfill-market-matching.ts
import { matchMarketsForSinglePair } from '../packages/event-matcher/src/services/marketMatcher.js';

// 1. Query all event pairs from event_mappings
// 2. For each pair, call matchMarketsForSinglePair()
// 3. Log results

// Note: matchMarketsForSinglePair() internally calls fetchExistingMappedMarketIds()
// to skip already-matched markets. So it will only process NEW unmatched markets,
// not re-match existing ones.
```

**Option 2 — Modify matching cycle temporarily**:

Temporarily modify `matchingCycle.ts` to remove the skip logic for already-matched events, run one full cycle, then revert.

### Important Notes

- `matchMarketsForSinglePair()` skips already-matched markets via `fetchExistingMappedMarketIds()`
- The backfill will only match NEW markets — it won't modify existing matches
- If you need to delete existing bad matches first, do it via the Appsmith dashboard or SQL before running the backfill

---

## 6. Fix E: Regression Tests

### Goal

Create test file to ensure future changes don't break matching logic.

### File

**New**: `packages/event-matcher/src/__tests__/marketMatcher.test.ts`

### Test Cases (based on the 14 verified bug trace examples)

```typescript
import { describe, it, expect } from 'vitest'; // or jest

describe('Market Matcher', () => {
  describe('classifyMarketType', () => {
    it('should classify spread markets', () => {
      expect(classifyMarketType('Team A -1.5')).toBe('SPREAD');
    });
    it('should classify BTTS markets', () => {
      expect(classifyMarketType('Both Teams to Score')).toBe('BTTS');
    });
    it('should classify win method markets', () => {
      expect(classifyMarketType('Fighter wins by KO')).toBe('WIN_METHOD');
    });
    it('should classify over/under markets', () => {
      expect(classifyMarketType('Over 2.5 goals in match')).toBe('OVER_UNDER');
    });
    it('should return UNKNOWN for non-sports binary', () => {
      expect(classifyMarketType('Will Bitcoin hit $150k?')).toBe('UNKNOWN');
    });
  });

  describe('areMarketTypesCompatible', () => {
    it('should reject WIN vs BTTS', () => {
      expect(areMarketTypesCompatible('WIN', 'BTTS')).toBe(false);
    });
    it('should reject WIN vs DRAW', () => {
      expect(areMarketTypesCompatible('WIN', 'DRAW')).toBe(false);
    });
    it('should allow WIN vs WIN', () => {
      expect(areMarketTypesCompatible('WIN', 'WIN')).toBe(true);
    });
    it('should allow UNKNOWN vs anything', () => {
      expect(areMarketTypesCompatible('UNKNOWN', 'WIN')).toBe(true);
    });
  });

  describe('substringMatch', () => {
    it('should match "Man City" after abbreviation expansion', () => {
      expect(substringMatch('Man City', 'Will Manchester City win?')).toBe(true);
    });
    it('should match bidirectionally', () => {
      expect(substringMatch('Andrea Kimi Antonelli', 'Will Kimi Antonelli be...?')).toBe(true);
    });
    it('should handle tie/draw synonyms', () => {
      expect(substringMatch('Tie', 'Will the match end in a draw?')).toBe(true);
    });
  });

  describe('checkModifierConflict', () => {
    it('should auto-reject WIN_METHOD mismatch', async () => {
      const result = await checkModifierConflict(
        'Will Axel Sola win the fight?',
        'Will Axel Sola win by KO?',
        config
      );
      expect(result.reject).toBe(true);
      expect(result.reason).toContain('WIN_METHOD');
    });

    it('should auto-reject BTTS mismatch', async () => {
      const result = await checkModifierConflict(
        'Will Wolfsburg win?',
        'Both Teams to Score in Wolfsburg match',
        config
      );
      expect(result.reject).toBe(true);
    });

    it('should pass when no modifier conflict', async () => {
      const result = await checkModifierConflict(
        'Will Bitcoin hit $150k?',
        'Bitcoin to reach $150,000?',
        config
      );
      expect(result.reject).toBe(false);
    });
  });
});
```

---

## 7. Deployment & Verification

### Deployment Order

1. **Deploy Fix A + B** (`event-matcher` package)
2. **Run Fix D** (backfill script)
3. **Deploy Fix C** (`homepage-api` package)
4. **Run Fix E** (tests)

### Deploy Commands

```bash
# 1. Commit and push to GitHub
git add packages/event-matcher packages/homepage-api
git commit -m "Matching overhaul: incompatible type detection, normalization, modifier guard, display filter"
git push origin main

# 2. Deploy event-matcher
./deploy-event-matcher.sh

# 3. Deploy homepage-api
./deploy.sh

# 4. Run backfill on server (if using option 2)
ssh root@8.216.43.26
# Temporarily trigger backfill...
```

### Verification Queries (run on server after deployment)

```sql
-- 1. Suspicious matches should drop from 296 to <100
SELECT count(*) as suspicious
FROM (
  SELECT mm1.canonical_market_id
  FROM direct_exchanges_data.market_mappings mm1
  JOIN direct_exchanges_data.market_mappings mm2
    ON mm1.canonical_market_id = mm2.canonical_market_id
    AND mm1.outcome_side = mm2.outcome_side
    AND mm1.exchange_id = 'KALSHI' AND mm2.exchange_id = 'POLYMARKET'
  JOIN direct_exchanges_data.market_latest_data k
    ON k.market_id = mm1.market_id AND k.exchange_id = 'KALSHI' AND k.outcome_side = mm1.outcome_side
  JOIN direct_exchanges_data.market_latest_data p
    ON p.market_id = mm2.market_id AND p.exchange_id = 'POLYMARKET' AND p.outcome_side = mm2.outcome_side
  WHERE mm1.outcome_side = 'YES'
    AND k.reference_price IS NOT NULL AND p.reference_price IS NOT NULL
    AND abs(k.reference_price - p.reference_price) > 0.20
) s;

-- 2. Match rate within events should rise from 59.9% to ~72-78%
WITH matched_events AS (
  SELECT DISTINCT a.event_id as kalshi_event
  FROM direct_exchanges_data.event_mappings a
  JOIN direct_exchanges_data.event_mappings b
    ON a.canonical_event_id = b.canonical_event_id
  WHERE a.exchange_id = 'KALSHI' AND b.exchange_id = 'POLYMARKET'
),
kalshi_matched AS (
  SELECT DISTINCT market_id FROM direct_exchanges_data.market_mappings WHERE exchange_id = 'KALSHI'
)
SELECT
  count(DISTINCT pm.market_id) FILTER (WHERE pm.market_id IN (SELECT market_id FROM kalshi_matched)) as matched,
  count(DISTINCT pm.market_id) as total,
  round(100.0 * count(DISTINCT pm.market_id) FILTER (WHERE pm.market_id IN (SELECT market_id FROM kalshi_matched)) / count(DISTINCT pm.market_id), 1) as match_rate_pct
FROM direct_exchanges_data.prediction_markets pm
WHERE pm.status = 'Open'
  AND pm.exchange_id = 'KALSHI'
  AND pm.event_id IN (SELECT kalshi_event FROM matched_events);

-- 3. No phantom arbs (>20% spread)
SELECT count(*) FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE' AND gross_spread_pct > 0.20;

-- 4. Total matched pairs should increase
SELECT count(DISTINCT canonical_market_id) FROM direct_exchanges_data.market_mappings;
```

### Acceptance Criteria

- [ ] Suspicious matches drop from 296 to <100
- [ ] Match rate within events rises from 59.9% to >70%
- [ ] No phantom active arbs with >20% spread
- [ ] Frontend shows no single-side missing-price market cards
- [ ] All regression tests pass
- [ ] `classifyMarketType()` correctly identifies sports market subtypes
- [ ] `checkModifierConflict()` auto-rejects WIN_METHOD and BTTS conflicts
- [ ] `substringMatch()` supports bidirectional matching and abbreviation expansion
