import { describe, it, expect, beforeEach } from 'vitest';
import { OrderBookManager } from '../orderBookManager.js';

describe('OrderBookManager', () => {
  let manager: OrderBookManager;

  beforeEach(() => {
    manager = new OrderBookManager();
  });

  describe('applySnapshot', () => {
    it('should store a full orderbook snapshot', () => {
      const yesOrders: Array<[number, number]> = [
        [50, 100],
        [49, 200],
      ];
      const noOrders: Array<[number, number]> = [
        [51, 150],
        [52, 250],
      ];

      manager.applySnapshot('MARKET-1', yesOrders, noOrders);

      const book = manager.getOrderBook('MARKET-1');
      expect(book).not.toBeNull();
      expect(book!.yesBids).toHaveLength(2);
      expect(book!.noBids).toHaveLength(2);
      expect(book!.yesBids).toContainEqual({ price: 50, quantity: 100 });
      expect(book!.yesBids).toContainEqual({ price: 49, quantity: 200 });
      expect(book!.noBids).toContainEqual({ price: 51, quantity: 150 });
      expect(book!.noBids).toContainEqual({ price: 52, quantity: 250 });
    });

    it('should replace existing snapshot with new one', () => {
      manager.applySnapshot('MARKET-1', [[50, 100]], [[51, 100]]);
      manager.applySnapshot('MARKET-1', [[60, 200]], [[61, 200]]);

      const book = manager.getOrderBook('MARKET-1');
      expect(book!.yesBids).toHaveLength(1);
      expect(book!.yesBids[0]).toEqual({ price: 60, quantity: 200 });
      expect(book!.noBids[0]).toEqual({ price: 61, quantity: 200 });
    });

    it('should filter out zero quantity orders in snapshot', () => {
      const yesOrders: Array<[number, number]> = [
        [50, 100],
        [49, 0], // zero quantity should be filtered
      ];
      const noOrders: Array<[number, number]> = [
        [51, 150],
        [52, 0], // zero quantity should be filtered
      ];

      manager.applySnapshot('MARKET-1', yesOrders, noOrders);

      const book = manager.getOrderBook('MARKET-1');
      expect(book!.yesBids).toHaveLength(1);
      expect(book!.noBids).toHaveLength(1);
    });

    it('should handle empty snapshots', () => {
      manager.applySnapshot('MARKET-1', [], []);

      const book = manager.getOrderBook('MARKET-1');
      expect(book).not.toBeNull();
      expect(book!.yesBids).toHaveLength(0);
      expect(book!.noBids).toHaveLength(0);
    });

    it('should handle one-sided snapshots', () => {
      manager.applySnapshot('MARKET-1', [[50, 100]], []);

      const book = manager.getOrderBook('MARKET-1');
      expect(book!.yesBids).toHaveLength(1);
      expect(book!.noBids).toHaveLength(0);
    });
  });

  describe('applyDelta', () => {
    it('should return false if no snapshot exists', () => {
      const result = manager.applyDelta('MARKET-1', 'yes', 50, 100);
      expect(result).toBe(false);
    });

    it('should update existing yes bid level', () => {
      manager.applySnapshot('MARKET-1', [[50, 100]], [[51, 100]]);

      const result = manager.applyDelta('MARKET-1', 'yes', 50, 200);
      expect(result).toBe(true);

      const book = manager.getOrderBook('MARKET-1');
      expect(book!.yesBids).toContainEqual({ price: 50, quantity: 200 });
    });

    it('should add new yes bid level', () => {
      manager.applySnapshot('MARKET-1', [[50, 100]], [[51, 100]]);

      manager.applyDelta('MARKET-1', 'yes', 49, 150);

      const book = manager.getOrderBook('MARKET-1');
      expect(book!.yesBids).toHaveLength(2);
      expect(book!.yesBids).toContainEqual({ price: 49, quantity: 150 });
    });

    it('should update existing no bid level', () => {
      manager.applySnapshot('MARKET-1', [[50, 100]], [[51, 100]]);

      manager.applyDelta('MARKET-1', 'no', 51, 200);

      const book = manager.getOrderBook('MARKET-1');
      expect(book!.noBids).toContainEqual({ price: 51, quantity: 200 });
    });

    it('should add new no bid level', () => {
      manager.applySnapshot('MARKET-1', [[50, 100]], [[51, 100]]);

      manager.applyDelta('MARKET-1', 'no', 52, 150);

      const book = manager.getOrderBook('MARKET-1');
      expect(book!.noBids).toHaveLength(2);
      expect(book!.noBids).toContainEqual({ price: 52, quantity: 150 });
    });

    it('should remove level when quantity is zero', () => {
      manager.applySnapshot('MARKET-1', [[50, 100], [49, 200]], [[51, 100]]);

      manager.applyDelta('MARKET-1', 'yes', 50, 0);

      const book = manager.getOrderBook('MARKET-1');
      expect(book!.yesBids).toHaveLength(1);
      expect(book!.yesBids[0]).toEqual({ price: 49, quantity: 200 });
    });

    it('should remove level when quantity is negative', () => {
      manager.applySnapshot('MARKET-1', [[50, 100]], [[51, 100]]);

      manager.applyDelta('MARKET-1', 'yes', 50, -1);

      const book = manager.getOrderBook('MARKET-1');
      expect(book!.yesBids).toHaveLength(0);
    });

    it('should handle multiple sequential deltas', () => {
      manager.applySnapshot('MARKET-1', [[50, 100]], [[51, 100]]);

      manager.applyDelta('MARKET-1', 'yes', 49, 200);
      manager.applyDelta('MARKET-1', 'yes', 48, 300);
      manager.applyDelta('MARKET-1', 'no', 52, 250);
      manager.applyDelta('MARKET-1', 'yes', 50, 0); // remove

      const book = manager.getOrderBook('MARKET-1');
      expect(book!.yesBids).toHaveLength(2);
      expect(book!.yesBids).toContainEqual({ price: 49, quantity: 200 });
      expect(book!.yesBids).toContainEqual({ price: 48, quantity: 300 });
      expect(book!.noBids).toHaveLength(2);
    });
  });

  describe('getOrderBook', () => {
    it('should return null for unknown market', () => {
      const book = manager.getOrderBook('UNKNOWN-MARKET');
      expect(book).toBeNull();
    });

    it('should return a copy of the orderbook data', () => {
      manager.applySnapshot('MARKET-1', [[50, 100]], [[51, 100]]);

      const book1 = manager.getOrderBook('MARKET-1');
      const book2 = manager.getOrderBook('MARKET-1');

      // Should be equal but not same reference
      expect(book1).toEqual(book2);
      expect(book1).not.toBe(book2);
      expect(book1!.yesBids).not.toBe(book2!.yesBids);
    });
  });

  describe('hasState', () => {
    it('should return false for unknown market', () => {
      expect(manager.hasState('UNKNOWN-MARKET')).toBe(false);
    });

    it('should return true after snapshot', () => {
      manager.applySnapshot('MARKET-1', [], []);
      expect(manager.hasState('MARKET-1')).toBe(true);
    });
  });

  describe('clearMarket', () => {
    it('should remove market state', () => {
      manager.applySnapshot('MARKET-1', [[50, 100]], [[51, 100]]);
      expect(manager.hasState('MARKET-1')).toBe(true);

      manager.clearMarket('MARKET-1');

      expect(manager.hasState('MARKET-1')).toBe(false);
      expect(manager.getOrderBook('MARKET-1')).toBeNull();
    });

    it('should not affect other markets', () => {
      manager.applySnapshot('MARKET-1', [[50, 100]], [[51, 100]]);
      manager.applySnapshot('MARKET-2', [[60, 200]], [[61, 200]]);

      manager.clearMarket('MARKET-1');

      expect(manager.hasState('MARKET-1')).toBe(false);
      expect(manager.hasState('MARKET-2')).toBe(true);
    });
  });

  describe('pruneStale', () => {
    it('should remove markets older than maxAgeMs', async () => {
      manager.applySnapshot('MARKET-1', [[50, 100]], [[51, 100]]);

      // Wait a bit then prune with very short max age
      await new Promise(resolve => setTimeout(resolve, 50));

      const pruned = manager.pruneStale(10); // 10ms max age

      expect(pruned).toBe(1);
      expect(manager.hasState('MARKET-1')).toBe(false);
    });

    it('should keep recently updated markets', async () => {
      manager.applySnapshot('MARKET-1', [[50, 100]], [[51, 100]]);

      const pruned = manager.pruneStale(10000); // 10 second max age

      expect(pruned).toBe(0);
      expect(manager.hasState('MARKET-1')).toBe(true);
    });

    it('should keep markets updated by delta', async () => {
      manager.applySnapshot('MARKET-1', [[50, 100]], [[51, 100]]);

      // Wait then apply delta
      await new Promise(resolve => setTimeout(resolve, 50));
      manager.applyDelta('MARKET-1', 'yes', 49, 200);

      // Short wait then prune
      await new Promise(resolve => setTimeout(resolve, 10));
      const pruned = manager.pruneStale(30); // 30ms max age (longer than 10ms wait)

      expect(pruned).toBe(0);
      expect(manager.hasState('MARKET-1')).toBe(true);
    });
  });

  describe('getStats', () => {
    it('should return zero stats for empty manager', () => {
      const stats = manager.getStats();
      expect(stats.marketCount).toBe(0);
      expect(stats.totalLevels).toBe(0);
    });

    it('should count markets and levels correctly', () => {
      manager.applySnapshot('MARKET-1', [[50, 100], [49, 200]], [[51, 100]]);
      manager.applySnapshot('MARKET-2', [[60, 200]], [[61, 200], [62, 300]]);

      const stats = manager.getStats();
      expect(stats.marketCount).toBe(2);
      expect(stats.totalLevels).toBe(6); // 2 + 1 + 1 + 2 = 6
    });

    it('should update stats after deltas', () => {
      manager.applySnapshot('MARKET-1', [[50, 100]], [[51, 100]]);

      let stats = manager.getStats();
      expect(stats.totalLevels).toBe(2);

      manager.applyDelta('MARKET-1', 'yes', 49, 200);
      stats = manager.getStats();
      expect(stats.totalLevels).toBe(3);

      manager.applyDelta('MARKET-1', 'yes', 50, 0); // remove
      stats = manager.getStats();
      expect(stats.totalLevels).toBe(2);
    });
  });

  describe('integration: accumulated state for band metrics', () => {
    it('should accumulate deltas correctly for YES/NO orderbook construction', () => {
      // Simulate Kalshi message flow:
      // 1. Snapshot with multiple levels
      // 2. Several deltas updating individual levels
      // 3. Final state should reflect all changes

      // Initial snapshot
      manager.applySnapshot('KXBTC-100K',
        [[7, 100], [6, 200], [5, 300]], // YES bids at 7, 6, 5 cents
        [[92, 150], [93, 250]]          // NO bids at 92, 93 cents
      );

      // Delta: new YES bid at 8 cents
      manager.applyDelta('KXBTC-100K', 'yes', 8, 50);

      // Delta: update YES bid at 7 cents
      manager.applyDelta('KXBTC-100K', 'yes', 7, 120);

      // Delta: remove YES bid at 5 cents
      manager.applyDelta('KXBTC-100K', 'yes', 5, 0);

      // Delta: new NO bid at 91 cents
      manager.applyDelta('KXBTC-100K', 'no', 91, 100);

      const book = manager.getOrderBook('KXBTC-100K');

      // YES bids: 8 (50), 7 (120), 6 (200) - 5 was removed
      expect(book!.yesBids).toHaveLength(3);
      expect(book!.yesBids).toContainEqual({ price: 8, quantity: 50 });
      expect(book!.yesBids).toContainEqual({ price: 7, quantity: 120 });
      expect(book!.yesBids).toContainEqual({ price: 6, quantity: 200 });

      // NO bids: 91 (100), 92 (150), 93 (250)
      expect(book!.noBids).toHaveLength(3);
      expect(book!.noBids).toContainEqual({ price: 91, quantity: 100 });
      expect(book!.noBids).toContainEqual({ price: 92, quantity: 150 });
      expect(book!.noBids).toContainEqual({ price: 93, quantity: 250 });
    });

    it('should correctly derive YES asks from NO bids (inverted prices)', () => {
      // Per Kalshi API: YES ask at price X = NO bid at (100 - X)
      manager.applySnapshot('MARKET-1',
        [[50, 100]],  // YES bid at 50
        [[60, 200]]   // NO bid at 60 → YES ask at 40
      );

      const book = manager.getOrderBook('MARKET-1');

      // The handler.ts will convert NO bids to YES asks by inverting price
      // Here we just verify the raw data is stored correctly
      expect(book!.yesBids[0]).toEqual({ price: 50, quantity: 100 });
      expect(book!.noBids[0]).toEqual({ price: 60, quantity: 200 });

      // The actual inversion (100 - 60 = 40) happens in handlers.ts when building YES asks
    });

    it('should handle high-frequency delta updates without losing state', () => {
      manager.applySnapshot('MARKET-1', [[50, 100]], [[51, 100]]);

      // Simulate rapid updates
      for (let i = 0; i < 100; i++) {
        manager.applyDelta('MARKET-1', 'yes', 50, 100 + i);
        manager.applyDelta('MARKET-1', 'no', 51, 100 + i);
      }

      const book = manager.getOrderBook('MARKET-1');
      expect(book!.yesBids).toContainEqual({ price: 50, quantity: 199 }); // 100 + 99
      expect(book!.noBids).toContainEqual({ price: 51, quantity: 199 });
    });
  });
});
