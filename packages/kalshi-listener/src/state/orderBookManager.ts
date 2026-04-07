import { createLogger } from '@prediction-market/shared';

const logger = createLogger('kalshi-orderbook-manager');

interface PriceLevel {
  price: number;
  quantity: number;
}

interface OrderBookState {
  yesBids: Map<number, number>;  // price → quantity
  noBids: Map<number, number>;   // price → quantity
  lastUpdate: Date;
}

export class OrderBookManager {
  private books: Map<string, OrderBookState> = new Map();

  /**
   * Apply full snapshot - replaces entire book for a market
   */
  applySnapshot(
    marketId: string,
    yesOrders: Array<[number, number]>,
    noOrders: Array<[number, number]>
  ): void {
    const yesBids = new Map<number, number>();
    const noBids = new Map<number, number>();

    for (const [price, quantity] of yesOrders) {
      if (quantity > 0) {
        yesBids.set(price, quantity);
      }
    }

    for (const [price, quantity] of noOrders) {
      if (quantity > 0) {
        noBids.set(price, quantity);
      }
    }

    this.books.set(marketId, {
      yesBids,
      noBids,
      lastUpdate: new Date(),
    });
  }

  /**
   * Apply delta - updates single price level
   * Quantity of 0 or negative removes the level
   */
  applyDelta(
    marketId: string,
    side: 'yes' | 'no',
    price: number,
    quantity: number
  ): boolean {
    const book = this.books.get(marketId);
    if (!book) {
      // No snapshot received yet - skip delta
      return false;
    }

    const targetMap = side === 'yes' ? book.yesBids : book.noBids;

    if (quantity <= 0) {
      targetMap.delete(price);
    } else {
      targetMap.set(price, quantity);
    }

    book.lastUpdate = new Date();
    return true;
  }

  /**
   * Get current full orderbook for a market
   * Returns null if no state exists
   */
  getOrderBook(marketId: string): {
    yesBids: PriceLevel[];
    noBids: PriceLevel[];
  } | null {
    const book = this.books.get(marketId);
    if (!book) {
      return null;
    }

    const yesBids: PriceLevel[] = [];
    const noBids: PriceLevel[] = [];

    for (const [price, quantity] of book.yesBids) {
      yesBids.push({ price, quantity });
    }

    for (const [price, quantity] of book.noBids) {
      noBids.push({ price, quantity });
    }

    return { yesBids, noBids };
  }

  /**
   * Check if we have state for a market
   */
  hasState(marketId: string): boolean {
    return this.books.has(marketId);
  }

  /**
   * Clear state for a market (e.g., on unsubscribe)
   */
  clearMarket(marketId: string): void {
    this.books.delete(marketId);
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
   * Clear all stale entries (markets not updated in maxAgeMs)
   */
  pruneStale(maxAgeMs: number): number {
    const now = Date.now();
    let pruned = 0;

    for (const [marketId, book] of this.books) {
      if (now - book.lastUpdate.getTime() > maxAgeMs) {
        this.books.delete(marketId);
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
  getStats(): { marketCount: number; totalLevels: number } {
    let totalLevels = 0;
    for (const book of this.books.values()) {
      totalLevels += book.yesBids.size + book.noBids.size;
    }
    return { marketCount: this.books.size, totalLevels };
  }
}

// Singleton instance
export const orderBookManager = new OrderBookManager();
