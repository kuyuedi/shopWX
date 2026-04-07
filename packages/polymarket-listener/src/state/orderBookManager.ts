import { createLogger } from '@prediction-market/shared';

const logger = createLogger('polymarket-orderbook-manager');

interface PriceLevel {
  price: number;
  quantity: number;
}

interface OrderBookState {
  bids: Map<number, number>;  // price → quantity
  asks: Map<number, number>;  // price → quantity
  lastUpdate: Date;
}

export class PolymarketOrderBookManager {
  private books: Map<string, OrderBookState> = new Map();

  /**
   * Apply full snapshot - replaces entire book for an asset
   */
  applySnapshot(
    assetId: string,
    bids: Array<[number, number]>,
    asks: Array<[number, number]>
  ): void {
    const bidMap = new Map<number, number>();
    const askMap = new Map<number, number>();

    for (const [price, quantity] of bids) {
      if (quantity > 0) {
        bidMap.set(price, quantity);
      }
    }

    for (const [price, quantity] of asks) {
      if (quantity > 0) {
        askMap.set(price, quantity);
      }
    }

    this.books.set(assetId, {
      bids: bidMap,
      asks: askMap,
      lastUpdate: new Date(),
    });
  }

  /**
   * Apply delta - updates single price level
   * Size of 0 removes the level
   */
  applyDelta(
    assetId: string,
    side: 'BUY' | 'SELL',
    price: number,
    size: number
  ): boolean {
    const book = this.books.get(assetId);
    if (!book) {
      // No snapshot received yet - skip delta
      return false;
    }

    const targetMap = side === 'BUY' ? book.bids : book.asks;

    if (size <= 0) {
      targetMap.delete(price);
    } else {
      targetMap.set(price, size);
    }

    book.lastUpdate = new Date();
    return true;
  }

  /**
   * Get current full orderbook for an asset
   * Returns null if no state exists
   */
  getOrderBook(assetId: string): {
    bids: PriceLevel[];
    asks: PriceLevel[];
  } | null {
    const book = this.books.get(assetId);
    if (!book) {
      return null;
    }

    const bids: PriceLevel[] = [];
    const asks: PriceLevel[] = [];

    for (const [price, quantity] of book.bids) {
      bids.push({ price, quantity });
    }

    for (const [price, quantity] of book.asks) {
      asks.push({ price, quantity });
    }

    return { bids, asks };
  }

  /**
   * Check if we have state for an asset
   */
  hasState(assetId: string): boolean {
    return this.books.has(assetId);
  }

  /**
   * Clear state for an asset (e.g., on unsubscribe)
   */
  clearMarket(assetId: string): void {
    this.books.delete(assetId);
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
   * Get stats for monitoring
   */
  getStats(): { assetCount: number; totalLevels: number } {
    let totalLevels = 0;
    for (const book of this.books.values()) {
      totalLevels += book.bids.size + book.asks.size;
    }
    return { assetCount: this.books.size, totalLevels };
  }
}

// Singleton instance
export const orderBookManager = new PolymarketOrderBookManager();
