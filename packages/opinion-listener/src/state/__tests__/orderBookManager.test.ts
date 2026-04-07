import { describe, it, expect, beforeEach } from 'vitest';
import { OpinionOrderBookManager } from '../orderBookManager.js';

describe('OpinionOrderBookManager', () => {
  let manager: OpinionOrderBookManager;

  beforeEach(() => {
    manager = new OpinionOrderBookManager();
  });

  it('should apply delta to empty book', () => {
    manager.applyDelta('100', 'YES', 'bids', 0.55, 100);

    const book = manager.getOrderBook('100', 'YES');
    expect(book).not.toBeNull();
    expect(book!.bids).toHaveLength(1);
    expect(book!.bids[0]).toEqual({ price: 0.55, quantity: 100 });
    expect(book!.asks).toHaveLength(0);
  });

  it('should apply multiple deltas and sort correctly', () => {
    manager.applyDelta('100', 'YES', 'bids', 0.55, 100);
    manager.applyDelta('100', 'YES', 'bids', 0.50, 200);
    manager.applyDelta('100', 'YES', 'bids', 0.60, 50);
    manager.applyDelta('100', 'YES', 'asks', 0.65, 80);
    manager.applyDelta('100', 'YES', 'asks', 0.70, 120);

    const book = manager.getOrderBook('100', 'YES');
    expect(book!.bids).toHaveLength(3);
    // Bids sorted descending
    expect(book!.bids[0]!.price).toBe(0.60);
    expect(book!.bids[1]!.price).toBe(0.55);
    expect(book!.bids[2]!.price).toBe(0.50);
    // Asks sorted ascending
    expect(book!.asks).toHaveLength(2);
    expect(book!.asks[0]!.price).toBe(0.65);
    expect(book!.asks[1]!.price).toBe(0.70);
  });

  it('should remove level when size=0', () => {
    manager.applyDelta('100', 'YES', 'bids', 0.55, 100);
    manager.applyDelta('100', 'YES', 'bids', 0.50, 200);

    // Remove the 0.55 level
    manager.applyDelta('100', 'YES', 'bids', 0.55, 0);

    const book = manager.getOrderBook('100', 'YES');
    expect(book!.bids).toHaveLength(1);
    expect(book!.bids[0]!.price).toBe(0.50);
  });

  it('should update existing level', () => {
    manager.applyDelta('100', 'YES', 'bids', 0.55, 100);
    manager.applyDelta('100', 'YES', 'bids', 0.55, 250);

    const book = manager.getOrderBook('100', 'YES');
    expect(book!.bids).toHaveLength(1);
    expect(book!.bids[0]!.quantity).toBe(250);
  });

  it('should set snapshot and replace all levels', () => {
    // Add some deltas first
    manager.applyDelta('100', 'YES', 'bids', 0.55, 100);
    manager.applyDelta('100', 'YES', 'asks', 0.65, 80);

    // Replace with snapshot
    manager.setSnapshot(
      '100', 'YES',
      [{ price: 0.40, quantity: 500 }, { price: 0.45, quantity: 300 }],
      [{ price: 0.60, quantity: 200 }],
    );

    const book = manager.getOrderBook('100', 'YES');
    expect(book!.bids).toHaveLength(2);
    expect(book!.asks).toHaveLength(1);
    expect(book!.bids[0]!.price).toBe(0.45);
    expect(book!.asks[0]!.price).toBe(0.60);
  });

  it('should apply delta after snapshot', () => {
    manager.setSnapshot(
      '100', 'YES',
      [{ price: 0.50, quantity: 100 }],
      [{ price: 0.60, quantity: 200 }],
    );

    manager.applyDelta('100', 'YES', 'bids', 0.55, 150);

    const book = manager.getOrderBook('100', 'YES');
    expect(book!.bids).toHaveLength(2);
    expect(book!.bids[0]!.price).toBe(0.55);
    expect(book!.bids[1]!.price).toBe(0.50);
  });

  it('should return null for nonexistent book', () => {
    expect(manager.getOrderBook('999', 'YES')).toBeNull();
  });

  it('should track YES and NO sides independently', () => {
    manager.applyDelta('100', 'YES', 'bids', 0.55, 100);
    manager.applyDelta('100', 'NO', 'bids', 0.45, 200);

    const yesBook = manager.getOrderBook('100', 'YES');
    const noBook = manager.getOrderBook('100', 'NO');

    expect(yesBook!.bids[0]!.quantity).toBe(100);
    expect(noBook!.bids[0]!.quantity).toBe(200);
  });

  it('should prune stale books', async () => {
    manager.applyDelta('100', 'YES', 'bids', 0.55, 100);
    manager.applyDelta('200', 'YES', 'bids', 0.60, 50);

    // Wait a small amount so entries become stale
    await new Promise(resolve => setTimeout(resolve, 10));

    // Prune with 1ms age = everything created >1ms ago is stale
    const pruned = manager.pruneStale(1);
    expect(pruned).toBe(2);
    expect(manager.size).toBe(0);
  });

  it('should report correct stats', () => {
    manager.applyDelta('100', 'YES', 'bids', 0.55, 100);
    manager.applyDelta('100', 'YES', 'asks', 0.65, 80);
    manager.applyDelta('200', 'NO', 'bids', 0.45, 200);

    const stats = manager.getStats();
    expect(stats.bookCount).toBe(2);
    expect(stats.totalLevels).toBe(3);
  });
});
