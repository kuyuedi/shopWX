# Sub-Feature 3: OrderBook Delta Manager

**Depends on**: Sub-feature 2 (called from WS handlers)

---

## Scope

Implement in-memory orderbook state management for Opinion.trade, which sends orderbook updates as individual level deltas (like Kalshi), not full snapshots (like Polymarket).

---

## Problem

Opinion's `market.depth.diff` sends one level at a time:
```json
{"marketId":1274, "outcomeSide":1, "side":"bids", "price":"0.55", "size":"100"}
```

We need to accumulate these into full orderbook state to:
1. Write complete orderbook snapshots to `order_books` table
2. Calculate band metrics (requires full bid/ask arrays)

---

## Design

### Key Difference from Kalshi's OrderBookManager

Kalshi's manager keys by `marketId` only and stores `yesBids` + `noBids` maps. Opinion's messages already include `outcomeSide`, so we key by `marketId + outcomeSide` and store separate `bids` + `asks` maps.

### File: `src/state/orderBookManager.ts`

```typescript
interface BookState {
  bids: Map<number, number>;  // price → quantity
  asks: Map<number, number>;  // price → quantity
  lastUpdate: Date;
}

class OpinionOrderBookManager {
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
   * Get full orderbook state for a market+side
   * Returns bids sorted descending, asks sorted ascending
   */
  getOrderBook(
    marketId: string,
    outcomeSide: 'YES' | 'NO',
  ): { bids: { price: number; quantity: number }[]; asks: { price: number; quantity: number }[] } | null {
    const key = `${marketId}:${outcomeSide}`;
    const book = this.books.get(key);
    if (!book) return null;

    return {
      bids: Array.from(book.bids.entries())
        .map(([price, quantity]) => ({ price, quantity }))
        .sort((a, b) => b.price - a.price),  // descending
      asks: Array.from(book.asks.entries())
        .map(([price, quantity]) => ({ price, quantity }))
        .sort((a, b) => a.price - b.price),  // ascending
    };
  }

  /**
   * Set full snapshot (if Opinion ever sends one, or for REST-fetched initial state)
   */
  setSnapshot(
    marketId: string,
    outcomeSide: 'YES' | 'NO',
    bids: { price: number; quantity: number }[],
    asks: { price: number; quantity: number }[],
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

    return pruned;
  }

  /** Number of tracked books */
  get size(): number {
    return this.books.size;
  }
}

// Singleton
export const orderBookManager = new OpinionOrderBookManager();
```

---

## Initial State Bootstrap

Opinion doesn't send orderbook snapshots on WS connect. Two options:

### Option A: REST bootstrap (recommended)

On startup, fetch initial orderbook for each market via REST:

```typescript
async function bootstrapOrderbooks(
  restUrl: string,
  apiKey: string,
  markets: OpinionMarketData[],
): Promise<void> {
  for (const market of markets) {
    const tokenIds = [market.yesTokenId, market.noTokenId];

    for (const tokenId of tokenIds) {
      const url = `${restUrl}/token/orderbook?token_id=${tokenId}`;
      const res = await fetch(url, { headers: { apikey: apiKey } });
      const data: OpinionApiResponse<OpinionOrderbookResponse> = await res.json();

      if (data.code !== 0) continue;

      const outcomeSide = tokenId === market.yesTokenId ? 'YES' : 'NO';
      const bids = data.result.bids.map(l => ({ price: parseFloat(l.price), quantity: parseFloat(l.size) }));
      const asks = data.result.asks.map(l => ({ price: parseFloat(l.price), quantity: parseFloat(l.size) }));

      orderBookManager.setSnapshot(String(market.marketId), outcomeSide, bids, asks);
      await sleep(70); // rate limit: 15 req/s
    }
  }
}
```

**Rate limit concern:** 2 tokens per market × N markets × 70ms delay. For 500 markets: ~70 seconds. Run at startup only, not every sync cycle.

### Option B: Lazy accumulation

Skip REST bootstrap. Let deltas accumulate from zero. Book will be incomplete initially but converges to correct state as all levels get updated. Band metrics may be inaccurate for the first few minutes.

**Recommendation:** Use Option A for the first deployment. If startup time is too long, switch to Option B and accept brief inaccuracy.

---

## Pruning

Run every 5 minutes, remove books not updated in 10 minutes:

```typescript
setInterval(() => {
  const pruned = orderBookManager.pruneStale(600_000);
  if (pruned > 0) {
    logger.info({ pruned, remaining: orderBookManager.size }, 'Pruned stale orderbooks');
  }
}, 300_000);
```

---

## Unit Tests

### File: `src/state/__tests__/orderBookManager.test.ts`

Follow Kalshi's test pattern:

| Test | Input | Expected |
|------|-------|----------|
| Apply delta to empty book | bid at 0.55 qty 100 | Book has 1 bid level |
| Apply multiple deltas | 3 bid levels, 2 ask levels | Sorted correctly |
| Remove level (size=0) | Existing level, then size=0 delta | Level removed |
| Update existing level | Same price, new size | Size updated |
| Set snapshot | Full bid/ask arrays | Replaces all levels |
| Snapshot then delta | Snapshot + 1 delta | Merged correctly |
| Prune stale | 2 books, 1 stale | Stale removed, fresh kept |
| Get nonexistent book | Unknown marketId | Returns null |

---

## Verification

```sql
-- Check orderbook depth is realistic
SELECT market_id, outcome_side,
       jsonb_array_length(bids::jsonb) as bid_levels,
       jsonb_array_length(asks::jsonb) as ask_levels
FROM direct_exchanges_data.order_books
WHERE exchange_id = 'OPINIONTRADE'
  AND entry_time > NOW() - INTERVAL '1 minute'
ORDER BY entry_time DESC
LIMIT 10;

-- Expect: multiple bid/ask levels (not 0 or 1), indicating accumulation works
```
