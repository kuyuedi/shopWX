import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track all items added to batch writers
const addedItems: Record<string, unknown[]> = {
  quotes: [],
  orderBooks: [],
  trades: [],
  marketData: [],
};

function resetAddedItems() {
  addedItems.quotes = [];
  addedItems.orderBooks = [];
  addedItems.trades = [];
  addedItems.marketData = [];
}

// Mock the orderBookManager BEFORE importing handlers
const mockApplySnapshot = vi.fn();
const mockApplyDelta = vi.fn().mockReturnValue(true);
const mockGetOrderBook = vi.fn();
const mockPruneStale = vi.fn();
const mockGetStats = vi.fn().mockReturnValue({ marketCount: 0, totalLevels: 0 });

vi.mock('../../state/orderBookManager.js', () => ({
  orderBookManager: {
    applySnapshot: (...args: unknown[]) => mockApplySnapshot(...args),
    applyDelta: (...args: unknown[]) => mockApplyDelta(...args),
    getOrderBook: (...args: unknown[]) => mockGetOrderBook(...args),
    pruneStale: (...args: unknown[]) => mockPruneStale(...args),
    getStats: () => mockGetStats(),
  },
}));

// Mock @prediction-market/shared
vi.mock('@prediction-market/shared', () => {
  return {
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    BatchWriter: vi.fn().mockImplementation((opts: { writeFn: unknown }) => {
      // Determine which writer this is based on the writeFn
      return {
        add: vi.fn().mockImplementation(async (item: unknown) => {
          // We'll track via the market data and order book captures below
        }),
        flush: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
      };
    }),
    insertQuotesBatch: vi.fn(),
    insertOrderBooksBatch: vi.fn(),
    insertTradesBatch: vi.fn(),
    upsertMarketLatestDataBatch: vi.fn(),
    calculateBandMetrics: vi.fn().mockReturnValue({
      referencePrice: 0.5,
      bandLiquidityQtyBid: 100,
      bandLiquidityQtyAsk: 100,
      bandVwapBid: 0.49,
      bandVwapAsk: 0.51,
      bandDeltaUsed: 0.01,
    }),
    KALSHI_SOURCE_ID: 'KALSHI_DIRECT',
    KALSHI_EXCHANGE_ID: 'KALSHI',
  };
});

// Now import handlers (after mocks are set up)
import { handleMessage } from '../handlers.js';
import { BatchWriter } from '@prediction-market/shared';

// Get references to the BatchWriter mock instances
// The module creates 4 BatchWriter instances on import
const batchWriterInstances = vi.mocked(BatchWriter).mock.results.map(r => r.value);

function getWriterAdds(writerIndex: number) {
  return batchWriterInstances[writerIndex]?.add.mock.calls.map(
    (call: unknown[]) => call[0]
  ) ?? [];
}

// Writer indices by construction order in handlers.ts
const QUOTE_WRITER = 0;
const ORDERBOOK_WRITER = 1;
const TRADE_WRITER = 2;
const MARKET_DATA_WRITER = 3;

const SOURCE_ID = 'KALSHI_DIRECT';
const EXCHANGE_ID = 'KALSHI';

beforeEach(() => {
  vi.clearAllMocks();
  resetAddedItems();
  mockApplyDelta.mockReturnValue(true);
  mockGetOrderBook.mockReturnValue(null);
});

describe('handleMessage', () => {
  it('routes ticker messages to handleTicker', () => {
    handleMessage(
      { type: 'ticker', msg: { market_ticker: 'TICKER-1', last_price: 65 } },
      SOURCE_ID,
      EXCHANGE_ID
    );
    const marketDataAdds = getWriterAdds(MARKET_DATA_WRITER);
    expect(marketDataAdds.length).toBe(2); // YES + NO
  });

  it('routes orderbook_snapshot to handleOrderBookDelta', () => {
    mockGetOrderBook.mockReturnValue({
      yesBids: [{ price: 50, quantity: 100 }],
      noBids: [{ price: 40, quantity: 100 }],
    });

    handleMessage(
      {
        type: 'orderbook_snapshot',
        msg: {
          market_ticker: 'OB-1',
          yes: [[50, 100]],
          no: [[40, 100]],
        },
      },
      SOURCE_ID,
      EXCHANGE_ID
    );
    expect(mockApplySnapshot).toHaveBeenCalledWith('OB-1', [[50, 100]], [[40, 100]]);
  });

  it('routes orderbook_delta to handleOrderBookDelta', () => {
    mockGetOrderBook.mockReturnValue({
      yesBids: [{ price: 50, quantity: 100 }],
      noBids: [],
    });

    handleMessage(
      {
        type: 'orderbook_delta',
        msg: {
          market_ticker: 'OB-1',
          price: 50,
          delta: 10,
          side: 'yes',
        },
      },
      SOURCE_ID,
      EXCHANGE_ID
    );
    expect(mockApplyDelta).toHaveBeenCalledWith('OB-1', 'yes', 50, 10);
  });

  it('skips messages without msg field', () => {
    handleMessage({ type: 'ticker' }, SOURCE_ID, EXCHANGE_ID);
    const marketDataAdds = getWriterAdds(MARKET_DATA_WRITER);
    expect(marketDataAdds.length).toBe(0);
  });

  it('ticker: YES gets raw lastPrice, NO gets 100 - lastPrice', () => {
    handleMessage(
      { type: 'ticker', msg: { market_ticker: 'TICK-1', last_price: 65 } },
      SOURCE_ID,
      EXCHANGE_ID
    );
    const marketDataAdds = getWriterAdds(MARKET_DATA_WRITER);
    const yesData = marketDataAdds[0] as { outcome_side: string; price_close: number };
    const noData = marketDataAdds[1] as { outcome_side: string; price_close: number };

    expect(yesData.outcome_side).toBe('YES');
    expect(yesData.price_close).toBe(65);
    expect(noData.outcome_side).toBe('NO');
    expect(noData.price_close).toBe(35);
  });

  it('ticker: undefined lastPrice results in undefined for both sides', () => {
    handleMessage(
      { type: 'ticker', msg: { market_ticker: 'TICK-2' } },
      SOURCE_ID,
      EXCHANGE_ID
    );
    const marketDataAdds = getWriterAdds(MARKET_DATA_WRITER);
    const yesData = marketDataAdds[0] as { price_close: number | undefined };
    const noData = marketDataAdds[1] as { price_close: number | undefined };

    expect(yesData.price_close).toBeUndefined();
    expect(noData.price_close).toBeUndefined();
  });

  it('orderbook: delta skipped when applyDelta returns false (no snapshot yet)', () => {
    mockApplyDelta.mockReturnValue(false);

    handleMessage(
      {
        type: 'orderbook_delta',
        msg: {
          market_ticker: 'OB-NO-SNAP',
          price: 50,
          delta: 10,
          side: 'yes',
        },
      },
      SOURCE_ID,
      EXCHANGE_ID
    );

    // Should not write anything since delta wasn't applied
    const obAdds = getWriterAdds(ORDERBOOK_WRITER);
    expect(obAdds.length).toBe(0);
  });

  it('orderbook: YES bids are direct, YES asks are inverted noBids (100 - price)', () => {
    mockGetOrderBook.mockReturnValue({
      yesBids: [{ price: 50, quantity: 100 }],
      noBids: [{ price: 40, quantity: 200 }],
    });

    handleMessage(
      {
        type: 'orderbook_snapshot',
        msg: {
          market_ticker: 'OB-INV',
          yes: [[50, 100]],
          no: [[40, 200]],
        },
      },
      SOURCE_ID,
      EXCHANGE_ID
    );

    const obAdds = getWriterAdds(ORDERBOOK_WRITER);
    // First OB should be YES
    const yesOB = obAdds[0] as { outcome_side: string; bids: Array<{price: number}>; asks: Array<{price: number}> };
    expect(yesOB.outcome_side).toBe('YES');
    expect(yesOB.bids).toEqual([{ price: 50, quantity: 100 }]);
    expect(yesOB.asks).toEqual([{ price: 60, quantity: 200 }]); // 100 - 40 = 60
  });

  it('trade: routes new API format (string dollar prices, count_fp)', () => {
    handleMessage(
      {
        type: 'trade',
        msg: {
          market_ticker: 'TR-1',
          trade_id: 't1',
          yes_price_dollars: '0.1910',
          no_price_dollars: '0.8090',
          count_fp: '808.00',
          taker_side: 'yes',
          ts: 1700000000,
        },
      },
      SOURCE_ID,
      EXCHANGE_ID
    );

    const tradeAdds = getWriterAdds(TRADE_WRITER);
    expect(tradeAdds.length).toBe(1);
    const trade = tradeAdds[0] as { market_id: string; price: number; side: string; quantity: number };
    expect(trade.market_id).toBe('TR-1');
    expect(trade.price).toBeCloseTo(0.191);
    expect(trade.side).toBe('Buy');
    expect(trade.quantity).toBe(808);
  });

  it('trade: routes legacy format (cent prices, count)', () => {
    handleMessage(
      {
        type: 'trade',
        msg: {
          market_ticker: 'TR-1b',
          trade_id: 't1b',
          yes_price: 75,
          count: 10,
          taker_side: 'yes',
          ts: 1700000000,
        },
      },
      SOURCE_ID,
      EXCHANGE_ID
    );

    const tradeAdds = getWriterAdds(TRADE_WRITER);
    expect(tradeAdds.length).toBe(1);
    const trade = tradeAdds[0] as { market_id: string; price: number; side: string; quantity: number };
    expect(trade.market_id).toBe('TR-1b');
    expect(trade.price).toBe(0.75);
    expect(trade.side).toBe('Buy');
    expect(trade.quantity).toBe(10);
  });

  it('trade: maps taker_side no→Sell', () => {
    handleMessage(
      {
        type: 'trade',
        msg: { market_ticker: 'TR-2', yes_price: 50, count: 5, taker_side: 'no' },
      },
      SOURCE_ID,
      EXCHANGE_ID
    );

    const tradeAdds = getWriterAdds(TRADE_WRITER);
    const trade = tradeAdds[0] as { side: string | undefined };
    expect(trade.side).toBe('Sell');
  });

  it('trade: uses yes_price_dollars over legacy cents', () => {
    handleMessage(
      {
        type: 'trade',
        msg: { market_ticker: 'TR-3', yes_price_dollars: '0.42', count_fp: '1.00' },
      },
      SOURCE_ID,
      EXCHANGE_ID
    );

    const tradeAdds = getWriterAdds(TRADE_WRITER);
    const trade = tradeAdds[0] as { price: number; quantity: number };
    expect(trade.price).toBe(0.42);
    expect(trade.quantity).toBe(1);
  });

  it('trade: falls back to legacy price/count when new fields absent', () => {
    handleMessage(
      {
        type: 'trade',
        msg: { market_ticker: 'TR-4', price: 42, count: 1 },
      },
      SOURCE_ID,
      EXCHANGE_ID
    );

    const tradeAdds = getWriterAdds(TRADE_WRITER);
    const trade = tradeAdds[0] as { price: number; quantity: number };
    expect(trade.price).toBe(0.42);
    expect(trade.quantity).toBe(1);
  });

  it('handles unknown message types gracefully', () => {
    // Should not throw
    handleMessage(
      { type: 'unknown_type', msg: { data: 'test' } },
      SOURCE_ID,
      EXCHANGE_ID
    );
    const allAdds = [
      ...getWriterAdds(QUOTE_WRITER),
      ...getWriterAdds(ORDERBOOK_WRITER),
      ...getWriterAdds(TRADE_WRITER),
      ...getWriterAdds(MARKET_DATA_WRITER),
    ];
    expect(allAdds.length).toBe(0);
  });
});
