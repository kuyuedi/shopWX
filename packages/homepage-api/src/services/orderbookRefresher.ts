import crypto from 'crypto';
import fs from 'fs';
import {
  createLogger,
  calculateBandMetrics,
  upsertMarketLatestData,
} from '@prediction-market/shared';
import type { MarketLeg, MarketLatestData, OrderBookLevel } from '@prediction-market/shared';

const logger = createLogger('orderbook-refresher');

interface RefresherConfig {
  kalshiApiKey: string;
  kalshiPrivateKeyPath: string;
  kalshiRestUrl: string;
  polymarketClobUrl: string;
  predictRestUrl: string;
  predictApiKey: string;
}

let config: RefresherConfig | null = null;
let kalshiPrivateKey: string | null = null;

const cooldownMap = new Map<string, number>();

export function initRefresher(cfg: RefresherConfig): void {
  config = cfg;
  if (cfg.kalshiPrivateKeyPath) {
    try {
      kalshiPrivateKey = fs.readFileSync(cfg.kalshiPrivateKeyPath, 'utf8');
      logger.info('Kalshi private key loaded for REST orderbook fallback');
    } catch (err) {
      logger.warn({ err }, 'Failed to load Kalshi private key — Kalshi REST fallback disabled');
    }
  }
}

function generateKalshiAuthHeaders(method: string, path: string): Record<string, string> {
  if (!config?.kalshiApiKey || !kalshiPrivateKey) {
    throw new Error('Kalshi auth not configured');
  }
  const timestamp = Date.now().toString();
  const message = timestamp + method + path;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message);
  sign.end();

  const signature = sign.sign(
    {
      key: kalshiPrivateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    },
    'base64',
  );

  return {
    'KALSHI-ACCESS-KEY': config.kalshiApiKey,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
  };
}

interface KalshiOrderbookResponse {
  orderbook?: {
    yes?: [number, number][];
    no?: [number, number][];
  };
  orderbook_fp?: {
    yes_dollars?: [string, string][];
    no_dollars?: [string, string][];
  };
}

interface PolymarketBookResponse {
  bids: { price: string; size: string }[];
  asks: { price: string; size: string }[];
}

export async function fetchKalshiOrderbook(
  marketId: string,
  outcomeSide: 'YES' | 'NO',
  timeoutMs: number,
): Promise<{ bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null> {
  if (!config || !kalshiPrivateKey) return null;

  const path = `/trade-api/v2/markets/${marketId}/orderbook`;
  const url = `${config.kalshiRestUrl}/markets/${marketId}/orderbook`;
  const headers = generateKalshiAuthHeaders('GET', path);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: { ...headers, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });

    if (res.status === 429) {
      throw Object.assign(new Error('Rate limited'), { status: 429 });
    }
    if (!res.ok) {
      logger.warn({ status: res.status, marketId }, 'Kalshi orderbook fetch failed');
      return null;
    }

    const data = (await res.json()) as KalshiOrderbookResponse;

    // Support both old format (orderbook.yes/no in cents) and new format (orderbook_fp.yes_dollars/no_dollars)
    let yesLevels: [number, number][];
    let noLevels: [number, number][];

    if (data.orderbook_fp) {
      // New format: string dollar values → convert to [decimal_price, quantity]
      yesLevels = (data.orderbook_fp.yes_dollars || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]);
      noLevels = (data.orderbook_fp.no_dollars || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]);
    } else {
      // Old format: cent values → convert to [decimal_price, quantity]
      yesLevels = (data.orderbook?.yes || []).map(([p, q]) => [p / 100, q]);
      noLevels = (data.orderbook?.no || []).map(([p, q]) => [p / 100, q]);
    }

    let bids: OrderBookLevel[];
    let asks: OrderBookLevel[];

    if (outcomeSide === 'YES') {
      // YES bids = yes levels, YES asks = inverted no levels (1 - no_price)
      bids = yesLevels.map(([p, q]) => ({ price: p, quantity: q }));
      asks = noLevels.map(([p, q]) => ({ price: 1 - p, quantity: q }));
    } else {
      // NO bids = no levels, NO asks = inverted yes levels (1 - yes_price)
      bids = noLevels.map(([p, q]) => ({ price: p, quantity: q }));
      asks = yesLevels.map(([p, q]) => ({ price: 1 - p, quantity: q }));
    }

    return { bids, asks };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPolymarketOrderbook(
  tokenId: string,
  timeoutMs: number,
): Promise<{ bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null> {
  if (!config) return null;

  const url = `${config.polymarketClobUrl}/book?token_id=${tokenId}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });

    if (res.status === 429) {
      throw Object.assign(new Error('Rate limited'), { status: 429 });
    }
    if (!res.ok) {
      logger.warn({ status: res.status, tokenId }, 'Polymarket orderbook fetch failed');
      return null;
    }

    const data = (await res.json()) as PolymarketBookResponse;

    const bids: OrderBookLevel[] = (data.bids || []).map(b => ({
      price: parseFloat(b.price),
      quantity: parseFloat(b.size),
    }));
    const asks: OrderBookLevel[] = (data.asks || []).map(a => ({
      price: parseFloat(a.price),
      quantity: parseFloat(a.size),
    }));

    return { bids, asks };
  } finally {
    clearTimeout(timer);
  }
}

interface PredictOrderbookResponse {
  data: {
    marketId: number;
    updateTimestampMs: number;
    asks: [number, number][];
    bids: [number, number][];
  };
}

async function fetchPredictOrderbook(
  marketId: string,
  outcomeSide: 'YES' | 'NO',
  timeoutMs: number,
): Promise<{ bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null> {
  if (!config) return null;

  const url = `${config.predictRestUrl}/v1/markets/${marketId}/orderbook`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.predictApiKey) {
    headers['x-api-key'] = config.predictApiKey;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers,
      signal: controller.signal,
    });

    if (res.status === 429) {
      throw Object.assign(new Error('Rate limited'), { status: 429 });
    }
    if (!res.ok) {
      logger.warn({ status: res.status, marketId }, 'Predict orderbook fetch failed');
      return null;
    }

    const data = (await res.json()) as PredictOrderbookResponse;
    const rawBids = data.data?.bids || [];
    const rawAsks = data.data?.asks || [];

    let bids: OrderBookLevel[];
    let asks: OrderBookLevel[];

    if (outcomeSide === 'YES') {
      bids = rawBids.map(([p, q]) => ({ price: p, quantity: q }));
      asks = rawAsks.map(([p, q]) => ({ price: p, quantity: q }));
    } else {
      // NO side: invert prices, swap bids↔asks
      bids = rawAsks.map(([p, q]) => ({ price: 1 - p, quantity: q }));
      asks = rawBids.map(([p, q]) => ({ price: 1 - p, quantity: q }));
    }

    return { bids, asks };
  } finally {
    clearTimeout(timer);
  }
}

async function refreshSingleLeg(
  leg: MarketLeg,
  timeoutMs: number,
): Promise<MarketLeg | null> {
  let book: { bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null = null;

  if (leg.exchange_id === 'KALSHI') {
    book = await fetchKalshiOrderbook(leg.market_id, leg.outcome_side, timeoutMs);
  } else if (leg.exchange_id === 'POLYMARKET') {
    if (!leg.token_id) {
      logger.debug({ marketId: leg.market_id }, 'No token_id for Polymarket leg, skipping REST refresh');
      return null;
    }
    book = await fetchPolymarketOrderbook(leg.token_id, timeoutMs);
  } else if (leg.exchange_id === 'PREDICT') {
    book = await fetchPredictOrderbook(leg.market_id, leg.outcome_side, timeoutMs);
  } else {
    return null;
  }

  if (!book || (book.bids.length === 0 && book.asks.length === 0)) {
    return null; // Empty orderbook — market has no liquidity
  }

  const metrics = calculateBandMetrics(book.bids, book.asks);
  if (metrics.referencePrice === null) {
    return null;
  }

  const now = new Date();
  const mld: MarketLatestData = {
    source_id: leg.source_id,
    exchange_id: leg.exchange_id,
    market_id: leg.market_id,
    outcome_side: leg.outcome_side,
    reference_price: metrics.referencePrice ?? undefined,
    band_liquidity_qty_ask: metrics.bandLiquidityQtyAsk ?? undefined,
    band_liquidity_qty_bid: metrics.bandLiquidityQtyBid ?? undefined,
    band_vwap_ask: metrics.bandVwapAsk ?? undefined,
    band_vwap_bid: metrics.bandVwapBid ?? undefined,
    band_delta_used: metrics.bandDeltaUsed ?? undefined,
    entry_time: now,
  };

  await upsertMarketLatestData(mld);

  return {
    ...leg,
    band_vwap_ask: metrics.bandVwapAsk,
    band_vwap_bid: metrics.bandVwapBid,
    band_liquidity_qty_ask: metrics.bandLiquidityQtyAsk,
    band_liquidity_qty_bid: metrics.bandLiquidityQtyBid,
    reference_price: metrics.referencePrice,
    data_updated_at: now,
  };
}

export async function refreshStaleLegs(
  staleLegs: MarketLeg[],
  concurrency: number,
  cooldownSec: number,
  timeoutMs: number,
): Promise<{ refreshed: MarketLeg[]; failed: number; emptyBooks: number }> {
  if (!config) {
    return { refreshed: [], failed: 0, emptyBooks: 0 };
  }

  const cooldownMs = cooldownSec * 1000;
  const now = Date.now();
  let rateLimited = false;
  let failed = 0;

  // Filter out legs within cooldown
  const eligible = staleLegs.filter(leg => {
    const key = `${leg.exchange_id}:${leg.market_id}:${leg.outcome_side}`;
    const lastFetch = cooldownMap.get(key);
    return !lastFetch || (now - lastFetch) >= cooldownMs;
  });

  const refreshed: MarketLeg[] = [];
  let emptyBooks = 0;
  const active = new Set<Promise<void>>();

  for (const leg of eligible) {
    if (rateLimited) break;

    const task = (async () => {
      const key = `${leg.exchange_id}:${leg.market_id}:${leg.outcome_side}`;
      try {
        const result = await refreshSingleLeg(leg, timeoutMs);
        cooldownMap.set(key, Date.now());
        if (result) {
          refreshed.push(result);
        } else {
          emptyBooks++;
        }
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 429) {
          rateLimited = true;
          logger.warn({ exchange: leg.exchange_id }, 'Rate limited — skipping remaining REST fetches this cycle');
        } else {
          failed++;
          logger.warn({ err, marketId: leg.market_id, exchange: leg.exchange_id }, 'REST orderbook fetch error');
        }
      }
    })();

    active.add(task);
    task.then(() => active.delete(task));

    // Wait if pool is full
    if (active.size >= concurrency) {
      await Promise.race(active);
    }
  }

  // Wait for remaining
  if (active.size > 0) {
    await Promise.allSettled([...active]);
  }

  return { refreshed, failed, emptyBooks };
}
