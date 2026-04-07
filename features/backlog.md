# Website Issues Backlog

Ongoing list of bugs, improvements, and technical debt. Items are added as discovered and marked done when fixed.

---

## Open Issues

### #1 — Sports market type mismatch in matcher
**Severity:** High
**Status:** Fixed (2026-04-02) — "Completed match" classified as META, incompatible with WIN
**Discovered:** 2026-03-31
**Example:** Punjab Kings vs Gujarat Titans — Kalshi "Winner" market matched to Polymarket "Completed match" market via substring matcher. Same player/team name appears in both but they are fundamentally different bet types.
**Affected matches cleaned:** 3 IPL cricket events (Punjab/Gujarat, Lucknow/Delhi, Rajasthan/Chennai)
**Root cause:** Substring matcher (`substring-v1`) matches by team/player name without checking if the market type (Winner vs Completed, Win vs Draw, etc.) is compatible.
**Fix needed:** Add market type classification for "Completed match" pattern to `classifyMarketType()` in `marketMatcher.ts`, similar to the NRFI fix (#7 in dev backlog). Mark it incompatible with `WIN` type.
**Related:** Memory file `project_sports_matching_bug.md`, dev backlog issue #7 (NRFI fix)

### #2 — Polymarket abbreviations not matched
**Severity:** Medium
**Status:** Open
**Discovered:** 2026-03-31
**Example:** Polymarket uses "GUJ" and "PUN" for Gujarat Titans and Punjab Kings. Substring matcher can't match these to Kalshi's full names.
**Fix needed:** Abbreviation/alias lookup table or fuzzy matching for sports team names.

### #3 — Stale Gamma API prices on thin Polymarket markets
**Severity:** High
**Status:** Fixed (2026-03-31)
**Fix:** Changed COALESCE order in events.ts to prefer `mld.reference_price` (live orderbook) over `pm.price` (stale last-trade from Gamma API).
**Impact:** ~4,358 markets (6%) now show live prices instead of stale ones. Major improvement for multi-outcome events (golf, politics with many candidates).

### #4 — Market outcome labels showing full question instead of outcome name
**Severity:** Medium
**Status:** Fixed (2026-03-31)
**Fix:** Added `sub_title` to the SQL query and `getMarketLabel()` priority chain. Now uses `sub_title` (e.g., "After April 30") when `outcome_name` is generic "Yes"/"No".

### #7 — Post-match validator doesn't check expiry at market level
**Severity:** Critical
**Status:** Fixed (2026-04-02) — expires_at now passed to validateMatch() in market matcher
**Discovered:** 2026-03-31
**Root cause:** `validateMatch()` in `marketMatcher.ts` line 598 is called WITHOUT end dates — `validateMatch(title1, title2)` — so the EXPIRY_DIVERGENCE check never runs for market-level matches. Only event-level matching passes end dates. This allowed "Before 2028" vs "Before 2027" (1 year gap) and "During Trump's term" (2029) vs "Before 2027" (2 year gap) to pass.
**Additionally:** Pre-existing bad matches from before the validator was deployed are never re-validated. The validator only runs at creation time.
**Fix needed:**
  1. Pass `expires_at` from both markets to `validateMatch()` in the market matcher write loop
  2. Consider a one-time re-validation sweep of all existing market_mappings
  3. For titles without years (e.g., "During Trump's term"), extract timeframe from `expires_at` directly

### #8 — Substring matcher ignores qualifier differences in titles
**Severity:** High
**Status:** Workaround applied (manual cleanup)
**Discovered:** 2026-03-31
**Example:** Kalshi "Will Chuck Schumer win the next Senate **Democratic Leader** election?" matched to Polymarket "Will Chuck Schumer be the next Senate **Majority Leader**?" — same person, different question (party leader vs majority leader). Created a false 37% arb.
**Root cause:** Substring matcher matches on entity name ("Chuck Schumer") without comparing the surrounding context/qualifiers. "Democratic Leader" vs "Majority Leader" are fundamentally different roles.
**Fix needed:** After substring match, validate that key qualifiers in the title are compatible. Could use keyword comparison on the non-entity portion, or add an AI verification step for high-value matches.
**Related:** Issue #1 (sports type mismatch), same class — correct entity, wrong market type.

### #5 — Exchange shown with no prices (dashes) on event cards
**Severity:** Medium
**Status:** Open
**Discovered:** 2026-03-31
**Example:** "Number of rate cuts in 2026?" — Kalshi shows "—" for all outcomes while Polymarket and Predict show prices. Kalshi has the markets but they're in separate canonical groups (not matched to Poly/Predict).
**Root cause:** When an event is matched across exchanges but the individual markets within it are NOT matched, the exchange badge appears but all outcomes show dashes. This is confusing — users expect prices if the badge is shown.
**Fix needed:** In the events API, only include an exchange in the event card if at least one market in that event has a price for that exchange. If all prices are null/dash, hide the exchange badge entirely.

### #6 — Different naming conventions prevent market matching
**Severity:** Medium
**Status:** Open
**Discovered:** 2026-03-31
**Example:** Fed rate cuts — Kalshi uses "Exactly 2 cuts", Polymarket uses "2 (50 bps)". Substring matcher can't match these. Same issue for many financial/economic markets where exchanges use different labeling conventions.
**Fix needed:** Normalize outcome names before matching (strip "Exactly", convert "bps" to "cuts", etc.), or improve AI matcher to handle naming variations within matched events.
**Related:** Issue #2 (abbreviation matching) — same class of problem.

---

### #9 — NRFI markets still being matched (Predict↔Polymarket)
**Severity:** High
**Status:** Fixed (2026-04-01) — bare "Team vs Team" classified as WIN, incompatible with FIRST_HALF
**Discovered:** 2026-03-31
**Example:** Predict "Boston Red Sox vs. Houston Astros" (moneyline) matched to Polymarket "NRFI: Boston Red Sox vs. Houston Astros" via `algorithmic-v1`. The NRFI fix (dev backlog #7) added classification to `classifyMarketType()` but it only runs for Tier 3 (AI verification) and binary (1:1) matches — **NOT for Tier 1 substring or Tier 2 Jaccard auto-accept**.
**Fix needed:** Run `classifyMarketType()` + `areMarketTypesCompatible()` for ALL match tiers, not just binary and AI tiers. Add it before pushing to `verified[]` in the substring and Jaccard sections.

---

## Completed Issues

| # | Issue | Fixed | Commit |
|---|-------|-------|--------|
| #3 | Stale Gamma API prices | 2026-03-31 | `16e83cb` |
| #4 | Outcome labels showing question | 2026-03-31 | `000e741` |
| #5 | Exchange badges with no prices | 2026-03-31 | `f74f9d1` |
| #7 | Validator now checks expiry at market level | 2026-04-02 | `ca029ae` |
| #1 | "Completed match" classified as META type | 2026-04-02 | `ca029ae` |
| #9 | NRFI: bare "Team vs Team" classified as WIN | 2026-04-01 | `c5ccee7` |

---

## Related Documents

- `features/2026-03-30-dev-issues-backlog/report.md` — Previous 8-issue sprint (dev)
- `features/2026-03-23-matching-overhaul-implementation/prd.md` — Matching overhaul plan
- Memory: `project_sports_matching_bug.md` — Sports matching bug history
- Memory: `matching_overhaul_status.md` — Matching overhaul status
