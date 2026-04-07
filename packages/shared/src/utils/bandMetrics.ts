import type { OrderBookLevel } from '../db/types.js';

export interface BandMetricsConfig {
  minExecutableQtyForReference: number;  // default: 25
  maxReferenceSpread: number;            // default: 0.20
  executionBandDelta: number;            // default: 0.01
  executionCapQty: number;               // default: 500
  minBookLevels: number;                 // default: 1
}

export interface BandMetricsResult {
  referencePrice: number | null;
  bestAsk: number | null;
  bestBid: number | null;
  bandLiquidityQtyAsk: number | null;
  bandLiquidityQtyBid: number | null;
  bandVwapAsk: number | null;
  bandVwapBid: number | null;
  bandDeltaUsed: number | null;
}

const DEFAULT_CONFIG: BandMetricsConfig = {
  minExecutableQtyForReference: 25,
  maxReferenceSpread: 0.20,
  executionBandDelta: 0.01,
  executionCapQty: 500,
  minBookLevels: 1,
};

/**
 * Calculate band metrics for an order book.
 *
 * Algorithm:
 * 1. Dust filter (qty >= minExecutableQtyForReference)
 * 2. Raw best prices (min ask, max bid from filtered)
 * 3. Reference validity (spread <= maxReferenceSpread, both sides exist)
 * 4. Reference price = (best_ask_raw + best_bid_raw) / 2
 * 5. Band filter (within executionBandDelta of reference)
 * 6. Band liquidity (sum qty, capped at executionCapQty)
 * 7. VWAP = sum(price * qty) / sum(qty)
 */
export function calculateBandMetrics(
  bids: OrderBookLevel[],
  asks: OrderBookLevel[],
  config?: Partial<BandMetricsConfig>
): BandMetricsResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Initialize result with nulls
  const result: BandMetricsResult = {
    referencePrice: null,
    bestAsk: null,
    bestBid: null,
    bandLiquidityQtyAsk: null,
    bandLiquidityQtyBid: null,
    bandVwapAsk: null,
    bandVwapBid: null,
    bandDeltaUsed: null,
  };

  // Step 1: Dust filter - remove orders with qty < minExecutableQtyForReference
  const filteredBids = bids.filter(b => b.quantity >= cfg.minExecutableQtyForReference);
  const filteredAsks = asks.filter(a => a.quantity >= cfg.minExecutableQtyForReference);

  // Check minimum book levels
  if (filteredBids.length < cfg.minBookLevels || filteredAsks.length < cfg.minBookLevels) {
    return result;
  }

  // Step 2: Raw best prices
  // Best bid = highest bid price
  // Best ask = lowest ask price
  const bestBid = Math.max(...filteredBids.map(b => b.price));
  const bestAsk = Math.min(...filteredAsks.map(a => a.price));

  result.bestBid = bestBid;
  result.bestAsk = bestAsk;

  // Step 3: Reference validity - check spread
  const spread = bestAsk - bestBid;
  if (spread > cfg.maxReferenceSpread || spread < 0) {
    // Invalid spread (too wide or crossed book)
    return result;
  }

  // Step 4: Reference price
  const referencePrice = (bestAsk + bestBid) / 2;
  result.referencePrice = referencePrice;

  // Step 5: Band filter - levels within executionBandDelta of reference
  // Adaptive delta: ensure band always reaches best bid and best ask
  const adaptiveDelta = Math.max(cfg.executionBandDelta, spread / 2);
  result.bandDeltaUsed = adaptiveDelta;
  const bandLowerBound = referencePrice - adaptiveDelta;
  const bandUpperBound = referencePrice + adaptiveDelta;

  const bandBids = filteredBids.filter(b => b.price >= bandLowerBound && b.price <= bandUpperBound);
  const bandAsks = filteredAsks.filter(a => a.price >= bandLowerBound && a.price <= bandUpperBound);

  // Step 6 & 7: Calculate band liquidity and VWAP for bids
  if (bandBids.length > 0) {
    let totalQty = 0;
    let weightedSum = 0;

    // Sort bids by price descending (best first) to apply cap correctly
    const sortedBids = [...bandBids].sort((a, b) => b.price - a.price);

    for (const bid of sortedBids) {
      const remainingCap = cfg.executionCapQty - totalQty;
      if (remainingCap <= 0) break;

      const qtyToUse = Math.min(bid.quantity, remainingCap);
      totalQty += qtyToUse;
      weightedSum += bid.price * qtyToUse;
    }

    result.bandLiquidityQtyBid = totalQty;
    result.bandVwapBid = totalQty > 0 ? weightedSum / totalQty : null;
  }

  // Step 6 & 7: Calculate band liquidity and VWAP for asks
  if (bandAsks.length > 0) {
    let totalQty = 0;
    let weightedSum = 0;

    // Sort asks by price ascending (best first) to apply cap correctly
    const sortedAsks = [...bandAsks].sort((a, b) => a.price - b.price);

    for (const ask of sortedAsks) {
      const remainingCap = cfg.executionCapQty - totalQty;
      if (remainingCap <= 0) break;

      const qtyToUse = Math.min(ask.quantity, remainingCap);
      totalQty += qtyToUse;
      weightedSum += ask.price * qtyToUse;
    }

    result.bandLiquidityQtyAsk = totalQty;
    result.bandVwapAsk = totalQty > 0 ? weightedSum / totalQty : null;
  }

  // Clamp reference price to VWAP band (inverted VWAP guard)
  if (result.bandVwapBid !== null && result.bandVwapAsk !== null && result.referencePrice !== null) {
    result.referencePrice = Math.max(result.bandVwapBid, Math.min(result.referencePrice, result.bandVwapAsk));
  }

  // Sanity check: if VWAPs are inverted (bid > ask), null them out
  // This should never happen with valid data, but guards against edge cases
  if (result.bandVwapBid !== null && result.bandVwapAsk !== null &&
      result.bandVwapBid > result.bandVwapAsk) {
    result.bandVwapBid = null;
    result.bandVwapAsk = null;
    result.bandLiquidityQtyBid = null;
    result.bandLiquidityQtyAsk = null;
  }

  return result;
}
