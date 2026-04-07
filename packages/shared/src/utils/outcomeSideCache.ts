/**
 * In-memory cache for market_id -> outcome_side mapping.
 * Populated during market sync from Gamma API.
 * Used by WebSocket handlers when inserting order books and quotes.
 */

const cache = new Map<string, 'YES' | 'NO'>();

/**
 * Get the outcome side for a given market ID (asset_id/token_id).
 * Returns undefined if the market is not in the cache.
 */
export function getOutcomeSide(marketId: string): 'YES' | 'NO' | undefined {
  return cache.get(marketId);
}

/**
 * Bulk set outcome sides for multiple markets.
 * Used during market sync to populate the cache.
 */
export function bulkSetOutcomeSide(entries: Map<string, 'YES' | 'NO'>): void {
  for (const [marketId, outcomeSide] of entries) {
    cache.set(marketId, outcomeSide);
  }
}

/**
 * Get the current cache size (for debugging/monitoring).
 */
export function getOutcomeSideCacheSize(): number {
  return cache.size;
}

/**
 * In-memory cache for conditionId → Gamma market ID mapping.
 * Populated during market sync from Gamma API.
 * Used by WebSocket handlers to resolve the numeric Gamma market ID from condition_id.
 */
const conditionIdCache = new Map<string, string>();

/**
 * Get the Gamma market ID for a given condition ID.
 * Returns undefined if the condition ID is not in the cache.
 */
export function getGammaMarketId(conditionId: string): string | undefined {
  return conditionIdCache.get(conditionId);
}

/**
 * Bulk set Gamma market IDs for multiple condition IDs.
 * Used during market sync to populate the cache.
 */
export function bulkSetGammaMarketId(entries: Map<string, string>): void {
  for (const [conditionId, gammaId] of entries) {
    conditionIdCache.set(conditionId, gammaId);
  }
}

/**
 * Get the current conditionId cache size (for debugging/monitoring).
 */
export function getConditionIdCacheSize(): number {
  return conditionIdCache.size;
}

/**
 * In-memory set of matched Polymarket market IDs (Gamma market IDs).
 * Only matched markets (those in market_mappings) need DB writes for price_change messages.
 */
let matchedMarketIds = new Set<string>();

/**
 * Replace the set of matched market IDs.
 * Called during market sync after querying market_mappings.
 */
export function setMatchedMarketIds(ids: Set<string>): void {
  matchedMarketIds = ids;
}

/**
 * Check if a market ID is in the matched set.
 * Used to gate expensive DB writes on price_change messages.
 */
export function isMatchedMarket(marketId: string): boolean {
  return matchedMarketIds.has(marketId);
}

/**
 * Get the current matched market set size (for debugging/monitoring).
 */
export function getMatchedMarketCount(): number {
  return matchedMarketIds.size;
}

/**
 * Clear the cache (mainly for testing).
 */
export function clearOutcomeSideCache(): void {
  cache.clear();
  conditionIdCache.clear();
  matchedMarketIds.clear();
}
