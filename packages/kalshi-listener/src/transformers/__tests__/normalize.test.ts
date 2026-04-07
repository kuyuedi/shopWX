import { describe, it, expect } from 'vitest';
import {
  normalizeMarket,
  normalizeTicker,
  normalizeOrderBook,
  normalizeTrade,
  type KalshiMarket,
} from '../normalize.js';

const baseMarket: KalshiMarket = {
  ticker: 'KXTICKER-YES',
  event_ticker: 'KXEVENT',
  series_ticker: 'KXSERIES',
  title: 'Will SOL price be above 100?',
  yes_sub_title: '101 or above',
  status: 'open',
  yes_bid: 65,
  yes_ask: 70,
  last_price: 67,
  volume: 5000,
  volume_24h: 1200,
  open_interest: 300,
  close_time: '2026-03-01T00:00:00Z',
  expiration_time: '2026-03-15T00:00:00Z',
};

describe('normalizeMarket', () => {
  it('emits both YES and NO entries from a single market', () => {
    const results = normalizeMarket(baseMarket);
    expect(results).toHaveLength(2);
    expect(results[0].outcomeSide).toBe('YES');
    expect(results[1].outcomeSide).toBe('NO');
  });

  it('YES price uses last_price, NO price is 1 - last_price', () => {
    const results = normalizeMarket(baseMarket);
    // last_price = 67 cents → 0.67
    expect(results[0].price).toBe(0.67);
    // NO = 1 - 0.67 = 0.33
    expect(results[1].price).toBeCloseTo(0.33, 10);
  });

  it('falls back to yes_bid/yes_ask when last_price is missing', () => {
    const results = normalizeMarket({ ...baseMarket, last_price: undefined });
    // yes_bid = 65 cents → 0.65
    expect(results[0].price).toBe(0.65);
    // NO = 1 - yes_ask/100 = 1 - 0.70 = 0.30
    expect(results[1].price).toBeCloseTo(0.30, 10);
  });

  it('NO price is undefined when both last_price and yes_ask are undefined', () => {
    const results = normalizeMarket({ ...baseMarket, last_price: undefined, yes_ask: undefined });
    expect(results[1].price).toBeUndefined();
  });

  it('composes title from title + yes_sub_title', () => {
    const results = normalizeMarket(baseMarket);
    expect(results[0].marketName).toBe('Will SOL price be above 100? — 101 or above');
  });

  it('falls back to subtitle when yes_sub_title is missing', () => {
    const market = { ...baseMarket, yes_sub_title: undefined, subtitle: 'Fallback sub' };
    const results = normalizeMarket(market);
    expect(results[0].marketName).toBe('Will SOL price be above 100? — Fallback sub');
  });

  it('uses title alone when no subtitle is available', () => {
    const market = { ...baseMarket, yes_sub_title: undefined, subtitle: undefined };
    const results = normalizeMarket(market);
    expect(results[0].marketName).toBe('Will SOL price be above 100?');
  });

  it('truncates title at 512 chars', () => {
    const longTitle = 'A'.repeat(600);
    const results = normalizeMarket({ ...baseMarket, title: longTitle, yes_sub_title: undefined });
    expect(results[0].marketName.length).toBeLessThanOrEqual(512);
    expect(results[0].marketName.endsWith('...')).toBe(true);
  });

  it('truncates market_id at 255 chars', () => {
    const longTicker = 'T'.repeat(300);
    const results = normalizeMarket({ ...baseMarket, ticker: longTicker });
    expect(results[0].marketId.length).toBe(255);
  });

  it('truncates event_id at 255 chars', () => {
    const longEvent = 'E'.repeat(300);
    const results = normalizeMarket({ ...baseMarket, event_ticker: longEvent });
    expect(results[0].eventId!.length).toBe(255);
  });

  it('maps seriesId from series_ticker', () => {
    const results = normalizeMarket(baseMarket);
    expect(results[0].seriesId).toBe('KXSERIES');
    expect(results[1].seriesId).toBe('KXSERIES');
  });

  it('seriesId is undefined when series_ticker is missing', () => {
    const results = normalizeMarket({ ...baseMarket, series_ticker: undefined });
    expect(results[0].seriesId).toBeUndefined();
  });

  it('truncates series_id at 255 chars', () => {
    const longSeries = 'S'.repeat(300);
    const results = normalizeMarket({ ...baseMarket, series_ticker: longSeries });
    expect(results[0].seriesId!.length).toBe(255);
  });

  it('YES subTitle is yes_sub_title', () => {
    const results = normalizeMarket(baseMarket);
    expect(results[0].subTitle).toBe('101 or above');
  });

  it('NO subTitle is no_sub_title when present', () => {
    const market = { ...baseMarket, no_sub_title: '100 or below' };
    const results = normalizeMarket(market);
    expect(results[1].subTitle).toBe('100 or below');
  });

  it('NO subTitle falls back to yes_sub_title when no_sub_title is missing', () => {
    const results = normalizeMarket(baseMarket);
    expect(results[1].subTitle).toBe('101 or above');
  });

  it('maps status: open→Open, closed→Closed, resolved→Resolved, cancelled→Cancelled', () => {
    const statuses: Array<[string, string]> = [
      ['open', 'Open'],
      ['active', 'Open'],
      ['closed', 'Closed'],
      ['resolved', 'Resolved'],
      ['finalized', 'Resolved'],
      ['cancelled', 'Cancelled'],
      ['canceled', 'Cancelled'],
    ];
    for (const [input, expected] of statuses) {
      const results = normalizeMarket({ ...baseMarket, status: input });
      expect(results[0].status).toBe(expected);
    }
  });

  it('defaults unknown status to Open', () => {
    const results = normalizeMarket({ ...baseMarket, status: 'unknown_status' });
    expect(results[0].status).toBe('Open');
  });

  it('clamps negative price to 0', () => {
    const results = normalizeMarket({ ...baseMarket, last_price: -50 });
    expect(results[0].price).toBe(0);
  });

  it('clamps price > 1 to 1', () => {
    const results = normalizeMarket({ ...baseMarket, last_price: 150 });
    expect(results[0].price).toBe(1);
  });

  it('prefers expiration_time over close_time for endDate', () => {
    const results = normalizeMarket(baseMarket);
    expect(results[0].endDate).toEqual(new Date('2026-03-15T00:00:00Z'));
  });

  it('falls back to close_time when expiration_time is missing', () => {
    const results = normalizeMarket({ ...baseMarket, expiration_time: undefined });
    expect(results[0].endDate).toEqual(new Date('2026-03-01T00:00:00Z'));
  });

  it('sets sourceId and exchangeId correctly', () => {
    const results = normalizeMarket(baseMarket);
    expect(results[0].sourceId).toBe('KALSHI_DIRECT');
    expect(results[0].exchangeId).toBe('KALSHI');
  });
});

describe('normalizeTicker', () => {
  it('maps all fields correctly', () => {
    const result = normalizeTicker('MY-TICKER', {
      yes_bid: 0.5,
      yes_ask: 0.6,
      last_price: 0.55,
      volume_24h: 100,
      open_interest: 50,
    });
    expect(result.marketId).toBe('MY-TICKER');
    expect(result.price).toBe(0.55);
    expect(result.volume24h).toBe(100);
    expect(result.openInterest).toBe(50);
    expect(result.bid).toBe(0.5);
    expect(result.ask).toBe(0.6);
    expect(result.sourceId).toBe('KALSHI_DIRECT');
    expect(result.exchangeId).toBe('KALSHI');
    expect(result.timestamp).toBeInstanceOf(Date);
  });
});

describe('normalizeOrderBook', () => {
  it('maps bids and asks tuples to objects', () => {
    const result = normalizeOrderBook(
      'OB-TICKER',
      [[50, 100], [45, 200]],
      [[55, 150], [60, 50]]
    );
    expect(result.marketId).toBe('OB-TICKER');
    expect(result.bids).toEqual([
      { price: 50, quantity: 100 },
      { price: 45, quantity: 200 },
    ]);
    expect(result.asks).toEqual([
      { price: 55, quantity: 150 },
      { price: 60, quantity: 50 },
    ]);
    expect(result.sourceId).toBe('KALSHI_DIRECT');
  });
});

describe('normalizeTrade', () => {
  it('maps taker_side yes→Buy', () => {
    const result = normalizeTrade('TR-TICKER', {
      trade_id: 'trade-1',
      price: 0.75,
      count: 10,
      taker_side: 'yes',
      created_time: '2026-02-16T12:00:00Z',
    });
    expect(result.side).toBe('Buy');
    expect(result.price).toBe(0.75);
    expect(result.quantity).toBe(10);
    expect(result.tradeId).toBe('trade-1');
    expect(result.timestamp).toEqual(new Date('2026-02-16T12:00:00Z'));
  });

  it('maps taker_side no→Sell', () => {
    const result = normalizeTrade('TR-TICKER', {
      price: 0.5,
      count: 5,
      taker_side: 'no',
    });
    expect(result.side).toBe('Sell');
  });

  it('maps undefined taker_side to undefined', () => {
    const result = normalizeTrade('TR-TICKER', {
      price: 0.5,
      count: 5,
    });
    expect(result.side).toBeUndefined();
  });
});
