import { describe, it, expect } from 'vitest';
import { calculateBandMetrics, type BandMetricsConfig } from '../bandMetrics.js';
import type { OrderBookLevel } from '../../db/types.js';

describe('calculateBandMetrics', () => {
  const defaultConfig: Partial<BandMetricsConfig> = {
    minExecutableQtyForReference: 25,
    maxReferenceSpread: 0.20,
    executionBandDelta: 0.01,
    executionCapQty: 500,
    minBookLevels: 1,
  };

  describe('normal market conditions', () => {
    it('should calculate reference price and band metrics correctly', () => {
      const bids: OrderBookLevel[] = [
        { price: 0.50, quantity: 100 },
        { price: 0.49, quantity: 200 },
      ];
      const asks: OrderBookLevel[] = [
        { price: 0.52, quantity: 100 },
        { price: 0.53, quantity: 200 },
      ];

      const result = calculateBandMetrics(bids, asks, defaultConfig);

      expect(result.bestBid).toBe(0.50);
      expect(result.bestAsk).toBe(0.52);
      expect(result.referencePrice).toBe(0.51); // (0.50 + 0.52) / 2
      expect(result.bandDeltaUsed).toBeCloseTo(0.01, 10);
    });

    it('should calculate band liquidity within band', () => {
      // Reference will be 0.505 (0.50 + 0.51) / 2
      // Band: 0.495 to 0.515
      const bids: OrderBookLevel[] = [
        { price: 0.50, quantity: 100 }, // within band
        { price: 0.48, quantity: 200 }, // outside band
      ];
      const asks: OrderBookLevel[] = [
        { price: 0.51, quantity: 100 }, // within band
        { price: 0.53, quantity: 200 }, // outside band
      ];

      const result = calculateBandMetrics(bids, asks, defaultConfig);

      expect(result.referencePrice).toBe(0.505);
      expect(result.bandLiquidityQtyBid).toBe(100); // only 0.50 level
      expect(result.bandLiquidityQtyAsk).toBe(100); // only 0.51 level
    });
  });

  describe('dust filtering', () => {
    it('should ignore orders with quantity below minExecutableQtyForReference', () => {
      const bids: OrderBookLevel[] = [
        { price: 0.55, quantity: 10 },  // dust, should be ignored
        { price: 0.50, quantity: 100 }, // valid
      ];
      const asks: OrderBookLevel[] = [
        { price: 0.51, quantity: 5 },   // dust, should be ignored
        { price: 0.52, quantity: 100 }, // valid
      ];

      const result = calculateBandMetrics(bids, asks, defaultConfig);

      expect(result.bestBid).toBe(0.50); // not 0.55 (dust)
      expect(result.bestAsk).toBe(0.52); // not 0.51 (dust)
      expect(result.referencePrice).toBe(0.51); // (0.50 + 0.52) / 2
    });

    it('should return nulls if all orders are dust', () => {
      const bids: OrderBookLevel[] = [
        { price: 0.50, quantity: 10 },
      ];
      const asks: OrderBookLevel[] = [
        { price: 0.52, quantity: 10 },
      ];

      const result = calculateBandMetrics(bids, asks, defaultConfig);

      expect(result.referencePrice).toBeNull();
      expect(result.bestBid).toBeNull();
      expect(result.bestAsk).toBeNull();
    });
  });

  describe('wide spread', () => {
    it('should return null reference price when spread exceeds maxReferenceSpread', () => {
      const bids: OrderBookLevel[] = [
        { price: 0.30, quantity: 100 },
      ];
      const asks: OrderBookLevel[] = [
        { price: 0.60, quantity: 100 }, // spread = 0.30 > 0.20 max
      ];

      const result = calculateBandMetrics(bids, asks, defaultConfig);

      expect(result.referencePrice).toBeNull();
      expect(result.bestBid).toBe(0.30);
      expect(result.bestAsk).toBe(0.60);
      expect(result.bandLiquidityQtyBid).toBeNull();
      expect(result.bandLiquidityQtyAsk).toBeNull();
    });
  });

  describe('one-sided book', () => {
    it('should return nulls with only bids', () => {
      const bids: OrderBookLevel[] = [
        { price: 0.50, quantity: 100 },
      ];
      const asks: OrderBookLevel[] = [];

      const result = calculateBandMetrics(bids, asks, defaultConfig);

      expect(result.referencePrice).toBeNull();
      expect(result.bestBid).toBeNull();
      expect(result.bestAsk).toBeNull();
    });

    it('should return nulls with only asks', () => {
      const bids: OrderBookLevel[] = [];
      const asks: OrderBookLevel[] = [
        { price: 0.52, quantity: 100 },
      ];

      const result = calculateBandMetrics(bids, asks, defaultConfig);

      expect(result.referencePrice).toBeNull();
      expect(result.bestBid).toBeNull();
      expect(result.bestAsk).toBeNull();
    });
  });

  describe('empty book', () => {
    it('should return nulls for empty order book', () => {
      const result = calculateBandMetrics([], [], defaultConfig);

      expect(result.referencePrice).toBeNull();
      expect(result.bestBid).toBeNull();
      expect(result.bestAsk).toBeNull();
      expect(result.bandLiquidityQtyBid).toBeNull();
      expect(result.bandLiquidityQtyAsk).toBeNull();
      expect(result.bandVwapBid).toBeNull();
      expect(result.bandVwapAsk).toBeNull();
      expect(result.bandDeltaUsed).toBeNull();
    });
  });

  describe('VWAP calculation', () => {
    it('should calculate correct VWAP for multiple levels', () => {
      // Reference = 0.50, band = 0.49 to 0.51 (reference +/- 0.01)
      const bids: OrderBookLevel[] = [
        { price: 0.50, quantity: 100 },
        { price: 0.495, quantity: 100 },
        { price: 0.49, quantity: 50 }, // within band (0.49 >= 0.49)
        { price: 0.48, quantity: 200 }, // outside band
      ];
      const asks: OrderBookLevel[] = [
        { price: 0.50, quantity: 100 },
        { price: 0.505, quantity: 100 },
        { price: 0.51, quantity: 50 }, // within band (0.51 <= 0.51)
        { price: 0.52, quantity: 200 }, // outside band
      ];

      const result = calculateBandMetrics(bids, asks, defaultConfig);

      expect(result.referencePrice).toBe(0.50);

      // Band bids: 0.50 (100), 0.495 (100), 0.49 (50)
      // VWAP = (0.50 * 100 + 0.495 * 100 + 0.49 * 50) / 250 = 124 / 250 = 0.496
      expect(result.bandLiquidityQtyBid).toBe(250);
      expect(result.bandVwapBid).toBeCloseTo(0.496, 4);

      // Band asks: 0.50 (100), 0.505 (100), 0.51 (50)
      // VWAP = (0.50 * 100 + 0.505 * 100 + 0.51 * 50) / 250 = 126 / 250 = 0.504
      expect(result.bandLiquidityQtyAsk).toBe(250);
      expect(result.bandVwapAsk).toBeCloseTo(0.504, 4);
    });
  });

  describe('execution cap', () => {
    it('should cap liquidity at executionCapQty', () => {
      const bids: OrderBookLevel[] = [
        { price: 0.50, quantity: 400 },
        { price: 0.495, quantity: 300 }, // total would be 700
      ];
      const asks: OrderBookLevel[] = [
        { price: 0.50, quantity: 600 }, // exceeds cap alone
      ];

      const result = calculateBandMetrics(bids, asks, defaultConfig);

      expect(result.bandLiquidityQtyBid).toBe(500); // capped at 500
      expect(result.bandLiquidityQtyAsk).toBe(500); // capped at 500

      // VWAP for bids: 400 at 0.50, 100 at 0.495 (capped)
      // VWAP = (0.50 * 400 + 0.495 * 100) / 500 = 249.5 / 500 = 0.499
      expect(result.bandVwapBid).toBeCloseTo(0.499, 4);

      // VWAP for asks: all 500 at 0.50
      expect(result.bandVwapAsk).toBe(0.50);
    });

    it('should apply cap in price priority order for bids', () => {
      // Bids should be processed best (highest) first
      const bids: OrderBookLevel[] = [
        { price: 0.49, quantity: 300 },  // second best
        { price: 0.50, quantity: 300 },  // best
      ];
      const asks: OrderBookLevel[] = [
        { price: 0.50, quantity: 100 },
      ];

      const result = calculateBandMetrics(bids, asks, defaultConfig);

      // Should take 300 at 0.50, then 200 at 0.49 (capped)
      // VWAP = (0.50 * 300 + 0.49 * 200) / 500 = 248 / 500 = 0.496
      expect(result.bandLiquidityQtyBid).toBe(500);
      expect(result.bandVwapBid).toBeCloseTo(0.496, 4);
    });
  });

  describe('crossed book', () => {
    it('should return null reference price for crossed book', () => {
      const bids: OrderBookLevel[] = [
        { price: 0.55, quantity: 100 }, // bid higher than ask
      ];
      const asks: OrderBookLevel[] = [
        { price: 0.50, quantity: 100 },
      ];

      const result = calculateBandMetrics(bids, asks, defaultConfig);

      expect(result.referencePrice).toBeNull();
      expect(result.bestBid).toBe(0.55);
      expect(result.bestAsk).toBe(0.50);
    });
  });

  describe('custom config', () => {
    it('should use default config when not provided', () => {
      const bids: OrderBookLevel[] = [{ price: 0.50, quantity: 100 }];
      const asks: OrderBookLevel[] = [{ price: 0.52, quantity: 100 }];

      const result = calculateBandMetrics(bids, asks);

      expect(result.bandDeltaUsed).toBeCloseTo(0.01, 10); // default
    });

    it('should respect custom executionBandDelta', () => {
      const bids: OrderBookLevel[] = [
        { price: 0.50, quantity: 100 },
        { price: 0.45, quantity: 100 }, // only included with larger delta
      ];
      const asks: OrderBookLevel[] = [
        { price: 0.52, quantity: 100 },
        { price: 0.57, quantity: 100 }, // only included with larger delta
      ];

      const resultSmallDelta = calculateBandMetrics(bids, asks, { executionBandDelta: 0.01 });
      const resultLargeDelta = calculateBandMetrics(bids, asks, { executionBandDelta: 0.10 });

      expect(resultSmallDelta.bandLiquidityQtyBid).toBeLessThan(resultLargeDelta.bandLiquidityQtyBid!);
      expect(resultSmallDelta.bandLiquidityQtyAsk).toBeLessThan(resultLargeDelta.bandLiquidityQtyAsk!);
    });
  });

  describe('Kalshi price normalization', () => {
    // These tests verify that Kalshi prices (in cents, 1-100) can be normalized
    // to decimal (0-1) range before calling calculateBandMetrics

    it('should work with normalized Kalshi cents prices', () => {
      // Simulate Kalshi order book in cents, then normalize
      const kalshiBids = [
        { price: 50, quantity: 100 },  // 50 cents = $0.50
        { price: 48, quantity: 200 },
      ];
      const kalshiAsks = [
        { price: 52, quantity: 100 },  // 52 cents = $0.52
        { price: 54, quantity: 200 },
      ];

      // Normalize prices from cents to decimal (as done in Kalshi handlers)
      const normalizedBids = kalshiBids.map(b => ({ price: b.price / 100, quantity: b.quantity }));
      const normalizedAsks = kalshiAsks.map(a => ({ price: a.price / 100, quantity: a.quantity }));

      const result = calculateBandMetrics(normalizedBids, normalizedAsks);

      // Reference price should be in 0-1 range, not 1-100
      expect(result.referencePrice).toBe(0.51); // (0.50 + 0.52) / 2
      expect(result.referencePrice).toBeLessThan(1);
      expect(result.bestBid).toBe(0.50);
      expect(result.bestAsk).toBe(0.52);
    });

    it('should handle normalized edge case prices at boundaries', () => {
      // Kalshi prices near 0 and 100 cents
      const kalshiBids = [{ price: 5, quantity: 100 }];   // 5 cents = $0.05
      const kalshiAsks = [{ price: 10, quantity: 100 }];  // 10 cents = $0.10

      const normalizedBids = kalshiBids.map(b => ({ price: b.price / 100, quantity: b.quantity }));
      const normalizedAsks = kalshiAsks.map(a => ({ price: a.price / 100, quantity: a.quantity }));

      const result = calculateBandMetrics(normalizedBids, normalizedAsks);

      expect(result.bestBid).toBe(0.05);
      expect(result.bestAsk).toBe(0.10);
      expect(result.referencePrice).toBeCloseTo(0.075, 10);
    });

    it('should handle normalized high probability markets', () => {
      const kalshiBids = [{ price: 90, quantity: 100 }];  // 90 cents = $0.90
      const kalshiAsks = [{ price: 95, quantity: 100 }];  // 95 cents = $0.95

      const normalizedBids = kalshiBids.map(b => ({ price: b.price / 100, quantity: b.quantity }));
      const normalizedAsks = kalshiAsks.map(a => ({ price: a.price / 100, quantity: a.quantity }));

      const result = calculateBandMetrics(normalizedBids, normalizedAsks);

      expect(result.bestBid).toBe(0.90);
      expect(result.bestAsk).toBe(0.95);
      expect(result.referencePrice).toBe(0.925);
    });

    it('should correctly apply band delta to normalized Kalshi prices', () => {
      // Reference will be 0.50 (midpoint of 0.49 and 0.51)
      // With default delta of 0.01, band is [0.49, 0.51]
      const kalshiBids = [
        { price: 49, quantity: 100 },  // 0.49 - within band
        { price: 45, quantity: 200 },  // 0.45 - outside band
      ];
      const kalshiAsks = [
        { price: 51, quantity: 100 },  // 0.51 - within band
        { price: 55, quantity: 200 },  // 0.55 - outside band
      ];

      const normalizedBids = kalshiBids.map(b => ({ price: b.price / 100, quantity: b.quantity }));
      const normalizedAsks = kalshiAsks.map(a => ({ price: a.price / 100, quantity: a.quantity }));

      const result = calculateBandMetrics(normalizedBids, normalizedAsks);

      expect(result.referencePrice).toBe(0.50);
      // Only the orders within +/-0.01 of reference should be counted
      expect(result.bandLiquidityQtyBid).toBe(100);
      expect(result.bandLiquidityQtyAsk).toBe(100);
    });
  });
});
