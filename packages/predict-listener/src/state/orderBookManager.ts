import { createLogger } from '@prediction-market/shared';

const logger = createLogger('predict-orderbook-manager');

interface BookState {
  bids: Map<number, number>;  // price → quantity
  asks: Map<number, number>;  // price → quantity
  lastUpdate: Date;
}

/**
 * Simplified orderbook manager — snapshot-only, no delta accumulation.
 * Predict.fun WS sends full orderbook snapshots on every push.
 */
export class PredictOrderBookManager {
  // Key: `${marketId}:${outcomeSide}` e.g. "393:YES"
  private books = new Map<string, BookState>();

  /**
   * Replace entire book with new snapshot
   */
  setSnapshot(
    marketId: string,
    outcomeSide: 'YES' | 'NO',
    bids: Array<{ price: number; quantity: number }>,
    asks: Array<{ price: number; quantity: number }>,
  ): void {
    const key = `${marketId}:${outcomeSide}`;
    this.books.set(key, {
      bids: new Map(bids.map(b => [b.price, b.quantity])),
      asks: new Map(asks.map(a => [a.price, a.quantity])),
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
   * Clear all state (e.g., on WebSocket disconnect)
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
export const orderBookManager = new PredictOrderBookManager();
