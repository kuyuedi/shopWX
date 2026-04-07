import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @prediction-market/shared BEFORE importing handlers
const mockGetOutcomeSide = vi.fn();

vi.mock('@prediction-market/shared', () => {
  return {
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    BatchWriter: vi.fn().mockImplementation(() => ({
      add: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    })),
    insertQuotesBatch: vi.fn(),
    insertOrderBooksBatch: vi.fn(),
    insertTradesBatch: vi.fn(),
    upsertMarketLatestDataBatch: vi.fn(),
    getOutcomeSide: (...args: unknown[]) => mockGetOutcomeSide(...args),
    isMatchedMarket: vi.fn().mockReturnValue(true),
    calculateBandMetrics: vi.fn().mockReturnValue({
      referencePrice: 0.5,
      bandLiquidityQtyBid: 100,
      bandLiquidityQtyAsk: 100,
      bandVwapBid: 0.49,
      bandVwapAsk: 0.51,
      bandDeltaUsed: 0.01,
    }),
    POLYMARKET_SOURCE_ID: 'POLYMARKET_DIRECT',
    POLYMARKET_EXCHANGE_ID: 'POLYMARKET',
  };
});

// Mock the orderBookManager
const mockApplySnapshot = vi.fn();
const mockApplyDelta = vi.fn().mockReturnValue(true);
const mockGetOrderBook = vi.fn().mockReturnValue({
  bids: [{ price: 0.50, quantity: 100 }],
  asks: [{ price: 0.55, quantity: 50 }],
});

vi.mock('../../state/orderBookManager.js', () => ({
  orderBookManager: {
    applySnapshot: (...args: unknown[]) => mockApplySnapshot(...args),
    applyDelta: (...args: unknown[]) => mockApplyDelta(...args),
    getOrderBook: (...args: unknown[]) => mockGetOrderBook(...args),
    clearAll: vi.fn(),
    getStats: vi.fn().mockReturnValue({ assetCount: 0, totalLevels: 0 }),
  },
}));

import { handleMessage } from '../handlers.js';
import { BatchWriter } from '@prediction-market/shared';

// Get references to the BatchWriter mock instances (4 created on import)
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

const SOURCE_ID = 'POLYMARKET_DIRECT';
const EXCHANGE_ID = 'POLYMARKET';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetOutcomeSide.mockReturnValue('YES');
  mockApplyDelta.mockReturnValue(true);
  mockGetOrderBook.mockReturnValue({
    bids: [{ price: 0.50, quantity: 100 }],
    asks: [{ price: 0.55, quantity: 50 }],
  });
});

describe('handleMessage', () => {
  it('routes book events to handleBook', () => {
    handleMessage(
      {
        event_type: 'book',
        asset_id: 'asset-1',
        bids: [{ price: '0.50', size: '100' }],
        asks: [{ price: '0.55', size: '50' }],
      },
      SOURCE_ID,
      EXCHANGE_ID
    );

    const obAdds = getWriterAdds(ORDERBOOK_WRITER);
    expect(obAdds.length).toBe(1);
  });

  it('routes last_trade_price events', () => {
    handleMessage(
      {
        event_type: 'last_trade_price',
        asset_id: 'asset-1',
        price: '0.75',
        size: '10',
        side: 'BUY',
        transaction_hash: 'tx-hash-1',
      },
      SOURCE_ID,
      EXCHANGE_ID
    );

    const tradeAdds = getWriterAdds(TRADE_WRITER);
    expect(tradeAdds.length).toBe(1);
  });

  it('requires asset_id for book events', () => {
    handleMessage(
      { event_type: 'book', bids: [], asks: [] },
      SOURCE_ID,
      EXCHANGE_ID
    );

    const obAdds = getWriterAdds(ORDERBOOK_WRITER);
    expect(obAdds.length).toBe(0);
  });

  it('requires asset_id for last_trade_price events', () => {
    handleMessage(
      { event_type: 'last_trade_price', price: '0.5', size: '1' },
      SOURCE_ID,
      EXCHANGE_ID
    );

    const tradeAdds = getWriterAdds(TRADE_WRITER);
    expect(tradeAdds.length).toBe(0);
  });

  it('book: skips on cache miss (getOutcomeSide returns undefined)', () => {
    mockGetOutcomeSide.mockReturnValue(undefined);

    handleMessage(
      {
        event_type: 'book',
        asset_id: 'unknown-asset',
        bids: [{ price: '0.50', size: '100' }],
        asks: [{ price: '0.55', size: '50' }],
      },
      SOURCE_ID,
      EXCHANGE_ID
    );

    const obAdds = getWriterAdds(ORDERBOOK_WRITER);
    expect(obAdds.length).toBe(0);
  });

  it('book: parses string prices/sizes and writes order book', () => {
    handleMessage(
      {
        event_type: 'book',
        asset_id: 'asset-parsed',
        bids: [{ price: '0.50', size: '100.5' }],
        asks: [{ price: '0.55', size: '50.2' }],
      },
      SOURCE_ID,
      EXCHANGE_ID
    );

    const obAdds = getWriterAdds(ORDERBOOK_WRITER);
    const ob = obAdds[0] as {
      market_id: string;
      bids: Array<{ price: number; quantity: number }>;
      asks: Array<{ price: number; quantity: number }>;
    };
    expect(ob.market_id).toBe('asset-parsed');
    expect(ob.bids).toEqual([{ price: 0.50, quantity: 100.5 }]);
    expect(ob.asks).toEqual([{ price: 0.55, quantity: 50.2 }]);
  });

  it('book: writes market data with band metrics', () => {
    handleMessage(
      {
        event_type: 'book',
        asset_id: 'asset-band',
        bids: [{ price: '0.50', size: '100' }],
        asks: [{ price: '0.55', size: '50' }],
      },
      SOURCE_ID,
      EXCHANGE_ID
    );

    const mdAdds = getWriterAdds(MARKET_DATA_WRITER);
    expect(mdAdds.length).toBe(1);
    const md = mdAdds[0] as {
      market_id: string;
      outcome_side: string;
      reference_price: number;
      band_delta_used: number;
    };
    expect(md.market_id).toBe('asset-band');
    expect(md.outcome_side).toBe('YES');
    expect(md.reference_price).toBe(0.5);
    expect(md.band_delta_used).toBe(0.01);
  });

  it('price_change new format: applies deltas and writes band metrics', () => {
    mockGetOutcomeSide.mockReturnValue('NO');

    handleMessage(
      {
        event_type: 'price_change',
        asset_id: 'pc-asset',
        changes: [
          { price: '0.65', side: 'BUY', size: '10' },
          { price: '0.70', side: 'SELL', size: '5' },
        ],
      },
      SOURCE_ID,
      EXCHANGE_ID
    );

    // Should apply 2 deltas
    expect(mockApplyDelta).toHaveBeenCalledTimes(2);
    expect(mockApplyDelta).toHaveBeenCalledWith('pc-asset', 'BUY', 0.65, 10);
    expect(mockApplyDelta).toHaveBeenCalledWith('pc-asset', 'SELL', 0.70, 5);

    // Should write 1 orderbook and 1 market data (band metrics) from accumulated book
    const obAdds = getWriterAdds(ORDERBOOK_WRITER);
    expect(obAdds.length).toBe(1);

    const mdAdds = getWriterAdds(MARKET_DATA_WRITER);
    expect(mdAdds.length).toBe(1);
    const md = mdAdds[0] as { market_id: string; outcome_side: string; reference_price: number };
    expect(md.market_id).toBe('pc-asset');
    expect(md.outcome_side).toBe('NO');
    expect(md.reference_price).toBe(0.5);
  });

  it('price_change old format: applies delta and writes band metrics', () => {
    handleMessage(
      {
        event_type: 'price_change',
        price_changes: [
          {
            asset_id: 'old-asset-1',
            price: '0.80',
            size: '50',
            side: 'BUY',
            best_bid: '0.79',
            best_ask: '0.81',
          },
        ],
      },
      SOURCE_ID,
      EXCHANGE_ID
    );

    // Should apply delta
    expect(mockApplyDelta).toHaveBeenCalledWith('old-asset-1', 'BUY', 0.80, 50);

    // Should write orderbook + band metrics from accumulated book
    const obAdds = getWriterAdds(ORDERBOOK_WRITER);
    expect(obAdds.length).toBe(1);

    const mdAdds = getWriterAdds(MARKET_DATA_WRITER);
    expect(mdAdds.length).toBe(1);
    const md = mdAdds[0] as { market_id: string; reference_price: number };
    expect(md.market_id).toBe('old-asset-1');
    expect(md.reference_price).toBe(0.5);
  });

  it('price_change: skips on cache miss in new format', () => {
    mockGetOutcomeSide.mockReturnValue(undefined);

    handleMessage(
      {
        event_type: 'price_change',
        asset_id: 'unknown-pc',
        changes: [{ price: '0.65', side: 'BUY', size: '10' }],
      },
      SOURCE_ID,
      EXCHANGE_ID
    );

    const mdAdds = getWriterAdds(MARKET_DATA_WRITER);
    expect(mdAdds.length).toBe(0);
  });

  it('price_change new format: drops delta when no snapshot exists', () => {
    mockApplyDelta.mockReturnValue(false);

    handleMessage(
      {
        event_type: 'price_change',
        asset_id: 'no-snapshot-asset',
        changes: [{ price: '0.65', side: 'BUY', size: '10' }],
      },
      SOURCE_ID,
      EXCHANGE_ID
    );

    // Delta not applied - no orderbook or market data written
    const obAdds = getWriterAdds(ORDERBOOK_WRITER);
    expect(obAdds.length).toBe(0);
    const mdAdds = getWriterAdds(MARKET_DATA_WRITER);
    expect(mdAdds.length).toBe(0);
  });

  it('book: stores snapshot in OrderBookManager', () => {
    handleMessage(
      {
        event_type: 'book',
        asset_id: 'snap-asset',
        bids: [{ price: '0.50', size: '100' }],
        asks: [{ price: '0.55', size: '50' }],
      },
      SOURCE_ID,
      EXCHANGE_ID
    );

    expect(mockApplySnapshot).toHaveBeenCalledWith(
      'snap-asset',
      [[0.50, 100]],
      [[0.55, 50]]
    );
  });

  it('last_trade_price: parses price/size and maps side', () => {
    handleMessage(
      {
        event_type: 'last_trade_price',
        asset_id: 'ltp-asset',
        price: '0.72',
        size: '25',
        side: 'SELL',
        transaction_hash: 'tx-abc',
        timestamp: '1700000000000',
      },
      SOURCE_ID,
      EXCHANGE_ID
    );

    const tradeAdds = getWriterAdds(TRADE_WRITER);
    const trade = tradeAdds[0] as {
      market_id: string;
      price: number;
      quantity: number;
      side: string;
      trade_id: string;
    };
    expect(trade.market_id).toBe('ltp-asset');
    expect(trade.price).toBe(0.72);
    expect(trade.quantity).toBe(25);
    expect(trade.side).toBe('Sell');
    expect(trade.trade_id).toBe('tx-abc');
  });

  it('ignores tick_size_change events', () => {
    handleMessage(
      { event_type: 'tick_size_change', asset_id: 'tick-asset' },
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
