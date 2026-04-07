import { createLogger } from '@prediction-market/shared';

const logger = createLogger('opinion-orderbook-manager');

interface BookState {
  bids: Map<number, number>;  // price → quantity
  asks: Map<number, number>;  // price → quantity
  lastUpdate: Date;
}

export class OpinionOrderBookManager {
  // Key: `${marketId}:${outcomeSide}` e.g. "1274:YES"
  private books = new Map<string, BookState>();

  /**
   * Apply a single delta from market.depth.diff
   * size=0 means remove the level
   */
  applyDelta(
    marketId: string,
    outcomeSide: 'YES' | 'NO',
    side: 'bids' | 'asks',
    price: number,
    size: number,
  ): void {
    const key = `${marketId}:${outcomeSide}`;
    let book = this.books.get(key);

    if (!book) {
      book = {
        bids: new Map(),
        asks: new Map(),
        lastUpdate: new Date(),
      };
      this.books.set(key, book);
    }

    const levels = side === 'bids' ? book.bids : book.asks;

    if (size <= 0) {
      levels.delete(price);
    } else {
      levels.set(price, size);
    }

    book.lastUpdate = new Date();
  }

  /**
   * Set full snapshot (for REST-bootstrapped initial state)
   */
  setSnapshot(
    marketId: string,
    outcomeSide: 'YES' | 'NO',
    bids: Array<{ price: number; quantity: number }>,
    asks: Array<{ price: number; quantity: number }>,
  ): void {
    const key = `${marketId}:${outcomeSide}`;
    const bidMap = new Map(bids.map(b => [b.price, b.quantity]));
    const askMap = new Map(asks.map(a => [a.price, a.quantity]));

    this.books.set(key, {
      bids: bidMap,
      asks: askMap,
      lastUpdate: new Date(),
    });
  }

  /**
   * Get full orderbook state for a market+side
   * Returns bids sorted descending, asks sorted ascending
   */
  getOrderBook(
    marketId: string,
    outcomeSide: 'YES' | 'NO',
  ): { bids: Array<{ price: number; quantity: number }>; asks: Array<{ price: number; quantity: number }> } | null {
    const key = `${marketId}:${outcomeSide}`;
    const book = this.books.get(key);
    if (!book) return null;

    return {
      bids: Array.from(book.bids.entries())
        .map(([price, quantity]) => ({ price, quantity }))
        .sort((a, b) => b.price - a.price),
      asks: Array.from(book.asks.entries())
        .map(([price, quantity]) => ({ price, quantity }))
        .sort((a, b) => a.price - b.price),
    };
  }

  /**
   * Check if we have state for a market+side
   */
  hasState(marketId: string, outcomeSide: 'YES' | 'NO'): boolean {
    return this.books.has(`${marketId}:${outcomeSide}`);
  }

  /**
   * Clear state for a specific market+side
   */
  clearMarket(marketId: string, outcomeSide: 'YES' | 'NO'): void {
    this.books.delete(`${marketId}:${outcomeSide}`);
  }

  /**
   * Clear all state (e.g., on WebSocket disconnect to prevent stale deltas)
   */
  clearAll(): void {
    const count = this.books.size;
    this.books.clear();
    if (count > 0) {
      logger.info({ cleared: count }, 'Cleared all orderbook state');
    }
  }

  /**
   * Prune books not updated in maxAgeMs
   */
  pruneStale(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;

    for (const [key, book] of this.books) {
      if (book.lastUpdate.getTime() < cutoff) {
        this.books.delete(key);
        pruned++;
      }
    }

    if (pruned > 0) {
      logger.info({ pruned, remaining: this.books.size }, 'Pruned stale orderbooks');
    }

    return pruned;
  }

  /**
   * Get stats for monitoring
   */
  getStats(): { bookCount: number; totalLevels: number } {
    let totalLevels = 0;
    for (const book of this.books.values()) {
      totalLevels += book.bids.size + book.asks.size;
    }
    return { bookCount: this.books.size, totalLevels };
  }

  get size(): number {
    return this.books.size;
  }
}

// Singleton instance
export const orderBookManager = new OpinionOrderBookManager();
