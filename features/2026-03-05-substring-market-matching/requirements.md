# Requirements: Substring Market Matching

## Problem

Matched events (e.g., "Pro Basketball Champion?") showed Kalshi and Polymarket markets as separate rows because `market_mappings` didn't exist for them. The Jaccard-based matching failed because:
- Kalshi uses brand names ("Pro Basketball" vs "NBA")
- Different team name granularity ("Oklahoma City" vs "Oklahoma City Thunder")
- Different phrasing patterns across exchanges

## Solution

Since markets are already known to be from the same matched event, extract the outcome name from Kalshi titles (text after `—`) and do substring matching against Polymarket titles. This is simpler and more reliable than token-based similarity for multi-outcome events.

## Acceptance Criteria

1. Markets within matched events that share an outcome name (via substring) are paired automatically
2. Substring matching runs as the primary strategy before Jaccard fallback
3. Existing Jaccard + AI verification remains as fallback for markets without the `—` pattern
4. A backfill script re-processes all existing matched event pairs
5. No database schema changes required
