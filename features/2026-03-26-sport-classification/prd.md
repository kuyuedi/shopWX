# Sport Classification Layer — PRD

**Status**: Ready for implementation
**Priority**: P0 — prevents phantom arbs from cross-sport mismatches
**Date**: 2026-03-26

---

## Problem

The event matcher pairs events from different sports when they share structural similarity. Example that caused 5 phantom arbs:

- Kalshi: "Which Conference Wins the National Championship?" (→ College Football)
- Polymarket: "NCAA Tournament: National Champion Conference" (→ College Basketball)

Same conferences (SEC, Big 12, ACC, Big Ten) exist in both sports, so the market matcher happily pairs them. The existing `classifyMarketType()` (Fix A) detects structural types (spread, over/under, BTTS) but does NOT detect which **sport** a market belongs to.

### Verified Cross-Sport Mismatches Found in Production

| Kalshi | Polymarket | Sport Conflict |
|--------|-----------|----------------|
| SEC wins College Football Championship | NCAA basketball Champion from SEC | Football ↔ Basketball |
| Big 12 wins College Football Championship | NCAA basketball Champion from Big 12 | Football ↔ Basketball |
| ACC wins College Football Championship | NCAA basketball Champion from ACC | Football ↔ Basketball |
| Big Ten wins College Football Championship | NCAA basketball Champion from Big Ten | Football ↔ Basketball |
| Any Other Conference wins Football Championship | NCAA basketball Champion from Big East | Football ↔ Basketball |

All 5 stemmed from one bad event mapping. Manually deleted on 2026-03-26.

### Why This Matters for Sportsbook Integration

When we add sportsbooks (Bet365, DraftKings, etc.), the problem gets much worse:
- Sportsbooks have hundreds of markets per game across multiple sports
- Same team names appear in different sports (e.g., "Manchester City" in EPL vs Champions League)
- Same player names appear across sports seasons
- Without sport classification, cross-sport false matches will multiply

---

## Solution: Sport Detection Function

### New function: `detectSport()`

**File**: `packages/event-matcher/src/services/marketMatcher.ts`

Add after the existing `classifyMarketType()` function:

```typescript
type SportType =
  | 'NFL' | 'NBA' | 'MLB' | 'NHL' | 'MLS'
  | 'COLLEGE_FOOTBALL' | 'COLLEGE_BASKETBALL'
  | 'EPL' | 'LA_LIGA' | 'BUNDESLIGA' | 'SERIE_A' | 'LIGUE_1'
  | 'CHAMPIONS_LEAGUE' | 'EUROPA_LEAGUE'
  | 'UFC_MMA' | 'BOXING'
  | 'TENNIS' | 'GOLF' | 'CRICKET' | 'F1'
  | 'ESPORTS'
  | 'GENERIC_SPORT'  // detected as sport but can't identify which
  | null;            // not a sport market

/**
 * Detect which sport a market belongs to.
 * Checks market title, event title, and category.
 * Returns null if not a sport market.
 */
function detectSport(
  marketTitle: string,
  eventTitle?: string,
  category?: string
): SportType {
  const text = [marketTitle, eventTitle, category]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  // === US College Sports (must check before generic football/basketball) ===
  if (/college football|cfp|football national champ|bowl game|heisman/.test(text))
    return 'COLLEGE_FOOTBALL';
  if (/ncaa basketball|march madness|ncaa tournament|final four|college basketball/.test(text))
    return 'COLLEGE_BASKETBALL';

  // === US Pro Sports ===
  if (/\bnfl\b|pro football|super bowl|\bnfc\b|\bafc\b|touchdown|quarterback/.test(text))
    return 'NFL';
  if (/\bnba\b|pro basketball|nba finals|nba mvp|nba champion/.test(text))
    return 'NBA';
  if (/\bmlb\b|pro baseball|world series|home run|batting|pitcher|cy young/.test(text))
    return 'MLB';
  if (/\bnhl\b|pro hockey|stanley cup|hockey/.test(text))
    return 'NHL';
  if (/\bmls\b/.test(text))
    return 'MLS';

  // === European Football/Soccer ===
  if (/premier league|\bepl\b|english premier/.test(text))
    return 'EPL';
  if (/la liga|spanish league/.test(text))
    return 'LA_LIGA';
  if (/bundesliga|german league/.test(text))
    return 'BUNDESLIGA';
  if (/serie a|italian league/.test(text))
    return 'SERIE_A';
  if (/ligue 1|french league/.test(text))
    return 'LIGUE_1';
  if (/champions league|\bucl\b/.test(text))
    return 'CHAMPIONS_LEAGUE';
  if (/europa league|\buel\b|europa conference/.test(text))
    return 'EUROPA_LEAGUE';

  // === Combat Sports ===
  if (/\bufc\b|\bmma\b|mixed martial|octagon/.test(text))
    return 'UFC_MMA';
  if (/\bboxing\b|heavyweight champ|undisputed/.test(text))
    return 'BOXING';

  // === Other Sports ===
  if (/\btennis\b|grand slam|wimbledon|french open|us open tennis|\batp\b|\bwta\b/.test(text))
    return 'TENNIS';
  if (/\bgolf\b|\bpga\b|masters tournament|the open championship/.test(text))
    return 'GOLF';
  if (/\bcricket\b|\bipl\b|test match|t20|one day international/.test(text))
    return 'CRICKET';
  if (/formula 1|\bf1\b|grand prix|constructor/.test(text))
    return 'F1';

  // === Esports ===
  if (/esports|dota|league of legends|counter-strike|\bcs2\b|valorant|overwatch/.test(text))
    return 'ESPORTS';

  // === Generic Sport Detection (fallback) ===
  if (/championship|tournament|playoff|finals|season|division|conference winner/.test(text))
    return 'GENERIC_SPORT';

  return null;
}
```

### Sport compatibility check

```typescript
/**
 * Check if two detected sports are compatible for matching.
 *
 * Rules:
 * - null (non-sport) is compatible with everything
 * - GENERIC_SPORT is compatible with any specific sport
 * - Same sport = compatible
 * - Different specific sports = NOT compatible
 */
function areSportsCompatible(sport1: SportType, sport2: SportType): boolean {
  if (sport1 === null || sport2 === null) return true;
  if (sport1 === 'GENERIC_SPORT' || sport2 === 'GENERIC_SPORT') return true;
  return sport1 === sport2;
}
```

---

## Where to Apply

### Location 1: Market matcher — before writing to DB

**File**: `packages/event-matcher/src/services/marketMatcher.ts`

In the `matchMarketsForSinglePair()` function, in the "Write results" loop (around line 366), add sport check alongside the existing modifier guard:

```typescript
// After modifier guard check, before writing:
const leg1Sport = detectSport(match.kalshi.title || '', kalshiEventTitle, kalshiCategory);
const leg2Sport = detectSport(match.poly.title || '', polyEventTitle, polyCategory);
if (!areSportsCompatible(leg1Sport, leg2Sport)) {
  logger.info({
    kalshiMarket: match.kalshi.market_id,
    polyMarket: match.poly.market_id,
    kalshiSport: leg1Sport,
    polySport: leg2Sport,
  }, 'Match rejected: cross-sport mismatch');
  continue;
}
```

### Location 2: Greedy substring match — early rejection

**File**: `packages/event-matcher/src/services/marketMatcher.ts`

In `greedySubstringMatch()`, after finding `bestPoly` and before `matches.push()`:

```typescript
const kSport = detectSport(kalshi.title || '');
const pSport = detectSport(bestPoly.title || '');
if (!areSportsCompatible(kSport, pSport)) {
  continue;
}
```

### Location 3: Greedy Jaccard match — early rejection

**File**: `packages/event-matcher/src/services/marketMatcher.ts`

In `greedyMatch()`, inside the candidate building loop, after the existing `classifyMarketType` check:

```typescript
const kSport = detectSport(kalshi.title || '');
const pSport = detectSport(poly.title || '');
if (!areSportsCompatible(kSport, pSport)) {
  continue;
}
```

### Location 4 (Optional): Event matcher — post-validation

**File**: `packages/event-matcher/src/services/matchingCycle.ts`

After an event match is confirmed by AI but before writing to `event_mappings`, check if the event titles suggest different sports. This is a safety net — the market-level check (Location 1) catches most cases, but this prevents the bad event mapping from being created in the first place.

This is optional because:
- Event titles often don't mention the sport ("Which Conference Wins the National Championship?")
- The market-level check is more reliable (market titles are more specific)
- But when event titles DO mention different sports, this catches it earlier

---

## Event Title Context

The `detectSport()` function accepts optional `eventTitle` and `category` parameters. When called from the market matcher, pass the event titles to improve detection:

```typescript
// In matchMarketsForSinglePair(), the function already receives:
// kalshiEventId, polyEventId
// Fetch event titles at the start:
const kalshiEvent = await fetchEventById(kalshiSourceId, KALSHI_EXCHANGE_ID, kalshiEventId);
const polyEvent = await fetchEventById(polySourceId, POLYMARKET_EXCHANGE_ID, polyEventId);

// Then pass to detectSport:
detectSport(market.title, kalshiEvent?.title, kalshiEvent?.category);
```

If fetching event data adds too much overhead, the market title alone is usually sufficient — the conference championship case would have been caught because the market titles explicitly say "College Football" and "NCAA basketball".

---

## Testing

### Unit tests

**File**: `packages/event-matcher/src/__tests__/sportDetection.test.ts`

```typescript
describe('detectSport', () => {
  // College sports
  it('detects college football', () => {
    expect(detectSport('Will the SEC win the College Football National Championship?'))
      .toBe('COLLEGE_FOOTBALL');
  });
  it('detects college basketball', () => {
    expect(detectSport('Will the 2026 NCAA basketball National Champion come from the SEC?'))
      .toBe('COLLEGE_BASKETBALL');
  });

  // Cross-sport rejection
  it('rejects football vs basketball', () => {
    expect(areSportsCompatible('COLLEGE_FOOTBALL', 'COLLEGE_BASKETBALL')).toBe(false);
  });
  it('allows same sport', () => {
    expect(areSportsCompatible('NFL', 'NFL')).toBe(true);
  });
  it('allows null (non-sport)', () => {
    expect(areSportsCompatible(null, 'NFL')).toBe(true);
  });
  it('allows generic sport with specific', () => {
    expect(areSportsCompatible('GENERIC_SPORT', 'NBA')).toBe(true);
  });

  // Pro sports
  it('detects NFL', () => {
    expect(detectSport('Will Washington win the Pro Football NFC East Division?')).toBe('NFL');
  });
  it('detects NBA', () => {
    expect(detectSport('Who will win the NBA MVP?')).toBe('NBA');
  });

  // European football
  it('detects EPL', () => {
    expect(detectSport('Will Manchester City win the Premier League?')).toBe('EPL');
  });
  it('detects Champions League', () => {
    expect(detectSport('Champions League Winner 2026')).toBe('CHAMPIONS_LEAGUE');
  });

  // Non-sport
  it('returns null for politics', () => {
    expect(detectSport('Will Trump win the 2028 election?')).toBe(null);
  });
  it('returns null for crypto', () => {
    expect(detectSport('Bitcoin price above $100k?')).toBe(null);
  });
});
```

### Integration verification

After deploying, run this SQL to verify no cross-sport matches exist:

```sql
-- This should return 0 rows after deployment
WITH pairs AS (
  SELECT
    mm1.canonical_market_id,
    pk.title as k_title,
    pp.title as p_title
  FROM direct_exchanges_data.market_mappings mm1
  JOIN direct_exchanges_data.market_mappings mm2
    ON mm1.canonical_market_id = mm2.canonical_market_id
    AND mm1.outcome_side = mm2.outcome_side
    AND mm1.exchange_id = 'KALSHI' AND mm2.exchange_id = 'POLYMARKET'
  JOIN direct_exchanges_data.prediction_markets pk
    ON pk.market_id = mm1.market_id AND pk.exchange_id = 'KALSHI' AND pk.outcome_side = 'YES'
  JOIN direct_exchanges_data.prediction_markets pp
    ON pp.market_id = mm2.market_id AND pp.exchange_id = 'POLYMARKET' AND pp.outcome_side = 'YES'
  WHERE mm1.outcome_side = 'YES'
    AND pk.status = 'Open' AND pp.status = 'Open'
)
SELECT * FROM pairs
WHERE (
  (k_title ~* 'football|college football|CFP' AND p_title ~* 'basketball|NCAA basketball|march madness')
  OR (p_title ~* 'football|college football|CFP' AND k_title ~* 'basketball|NCAA basketball|march madness')
  OR (k_title ~* '\bNFL\b|pro football' AND p_title ~* '\bNBA\b|pro basketball')
  OR (p_title ~* '\bNFL\b|pro football' AND k_title ~* '\bNBA\b|pro basketball')
  OR (k_title ~* '\bMLB\b|baseball' AND p_title ~* '\bNBA\b|\bNFL\b|basketball|football')
  OR (p_title ~* '\bMLB\b|baseball' AND k_title ~* '\bNBA\b|\bNFL\b|basketball|football')
);
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `packages/event-matcher/src/services/marketMatcher.ts` | Add `detectSport()`, `areSportsCompatible()`, apply in 3 locations |
| `packages/event-matcher/src/__tests__/sportDetection.test.ts` | NEW — unit tests |

## Future: Sportsbook Integration

When adding sportsbooks, `detectSport()` becomes the **primary matching dimension**:
1. First match by sport type (NFL ↔ NFL only)
2. Then match by team/event (within same sport)
3. Then match by market type (moneyline ↔ win, spread ↔ spread)

The sport classification layer built now directly enables sportsbook matching later.
