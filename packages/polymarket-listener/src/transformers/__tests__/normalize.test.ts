import { describe, it, expect } from 'vitest';
import {
  normalizeMarket,
  normalizeOrderBook,
  normalizeTrade,
  type PolymarketMarket,
} from '../normalize.js';

const baseMarket: PolymarketMarket = {
  id: 'condition-123',
  question: 'Will Bitcoin hit 100k?',
  description: 'Resolves if BTC >= 100000',
  category: 'Crypto',
  active: true,
  closed: false,
  clobTokenIds: '["token-yes-1","token-no-2"]',
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.65","0.35"]',
  volumeNum: 50000,
  liquidityNum: 12000,
  endDateIso: '2026-06-01T00:00:00Z',
  conditionId: 'cond-abc',
};

describe('normalizeMarket', () => {
  it('creates one entry per token with correct outcome side', () => {
    const results = normalizeMarket(baseMarket);
    expect(results).toHaveLength(2);
    expect(results[0].outcomeSide).toBe('YES');
    expect(results[0].marketId).toBe('token-yes-1');
    expect(results[1].outcomeSide).toBe('NO');
    expect(results[1].marketId).toBe('token-no-2');
  });

  it('parses JSON string fields correctly', () => {
    const results = normalizeMarket(baseMarket);
    expect(results[0].price).toBeCloseTo(0.65);
    expect(results[1].price).toBeCloseTo(0.35);
  });

  it('sets eventId to market.id', () => {
    const results = normalizeMarket(baseMarket);
    expect(results[0].eventId).toBe('condition-123');
  });

  it('returns empty array on invalid JSON', () => {
    const results = normalizeMarket({ ...baseMarket, clobTokenIds: 'not-json{' });
    expect(results).toEqual([]);
  });

  it('returns empty array when clobTokenIds is missing', () => {
    const results = normalizeMarket({ ...baseMarket, clobTokenIds: undefined });
    expect(results).toEqual([]);
  });

  it('maps status: closed=true→Closed', () => {
    const results = normalizeMarket({ ...baseMarket, closed: true, active: false });
    expect(results[0].status).toBe('Closed');
  });

  it('maps status: active=true, closed=false→Open', () => {
    const results = normalizeMarket({ ...baseMarket, closed: false, active: true });
    expect(results[0].status).toBe('Open');
  });

  it('maps status: active=false, closed=false→Cancelled', () => {
    const results = normalizeMarket({ ...baseMarket, closed: false, active: false });
    expect(results[0].status).toBe('Cancelled');
  });

  it('sets sourceId and exchangeId correctly', () => {
    const results = normalizeMarket(baseMarket);
    expect(results[0].sourceId).toBe('POLYMARKET_DIRECT');
    expect(results[0].exchangeId).toBe('POLYMARKET');
  });

  it('propagates category from market', () => {
    const results = normalizeMarket(baseMarket);
    expect(results[0].category).toBe('Crypto');
    expect(results[1].category).toBe('Crypto');
  });

  it('sets subTitle from groupItemTitle', () => {
    const market = { ...baseMarket, groupItemTitle: '800-900k' };
    const results = normalizeMarket(market);
    expect(results[0].subTitle).toBe('800-900k');
    expect(results[1].subTitle).toBe('800-900k');
  });

  it('subTitle is undefined when groupItemTitle is missing', () => {
    const results = normalizeMarket(baseMarket);
    expect(results[0].subTitle).toBeUndefined();
  });

  it('uses endDateIso for endDate', () => {
    const results = normalizeMarket(baseMarket);
    expect(results[0].endDate).toEqual(new Date('2026-06-01T00:00:00Z'));
  });
});

describe('normalizeOrderBook', () => {
  it('parses string prices and sizes to floats', () => {
    const result = normalizeOrderBook(
      'asset-1',
      [{ price: '0.65', size: '100.5' }, { price: '0.60', size: '200' }],
      [{ price: '0.70', size: '50' }]
    );
    expect(result.marketId).toBe('asset-1');
    expect(result.bids).toEqual([
      { price: 0.65, quantity: 100.5 },
      { price: 0.60, quantity: 200 },
    ]);
    expect(result.asks).toEqual([{ price: 0.70, quantity: 50 }]);
    expect(result.sourceId).toBe('POLYMARKET_DIRECT');
  });
});

describe('normalizeTrade', () => {
  it('normalizes BUY side to Buy', () => {
    const result = normalizeTrade('asset-1', 0.75, 10, 'BUY');
    expect(result.side).toBe('Buy');
    expect(result.price).toBe(0.75);
    expect(result.quantity).toBe(10);
  });

  it('normalizes SELL side to Sell', () => {
    const result = normalizeTrade('asset-1', 0.5, 5, 'SELL');
    expect(result.side).toBe('Sell');
  });

  it('normalizes mixed case (buy→Buy)', () => {
    const result = normalizeTrade('asset-1', 0.5, 5, 'buy');
    expect(result.side).toBe('Buy');
  });

  it('returns undefined side when not provided', () => {
    const result = normalizeTrade('asset-1', 0.5, 5);
    expect(result.side).toBeUndefined();
  });

  it('sets sourceId and exchangeId correctly', () => {
    const result = normalizeTrade('asset-1', 0.5, 5, 'BUY');
    expect(result.sourceId).toBe('POLYMARKET_DIRECT');
    expect(result.exchangeId).toBe('POLYMARKET');
  });
});
