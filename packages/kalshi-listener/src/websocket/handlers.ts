import {
  createLogger,
  BatchWriter,
  insertQuotesBatch,
  insertOrderBooksBatch,
  insertTradesBatch,
  upsertMarketLatestDataBatch,
  calculateBandMetrics,
  type Quote,
  type OrderBook,
  type Trade,
  type MarketLatestData,
} from '@prediction-market/shared';
import { orderBookManager } from '../state/orderBookManager.js';

const logger = createLogger('kalshi-handlers');

// Feature flag to disable quote writes (defaults to disabled to stop table growth)
const ENABLE_QUOTE_WRITES = process.env.ENABLE_QUOTE_WRITES === 'true';

// Counters for debugging
let orderbookMsgCount = 0;
let orderbookWriteCount = 0;
let droppedDeltaCount = 0;

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '100', 10);
const BATCH_INTERVAL_MS = parseInt(process.env.BATCH_INTERVAL_MS || '100', 10);

const quoteWriter = new BatchWriter<Quote>({
  maxSize: BATCH_SIZE,
  maxWaitMs: BATCH_INTERVAL_MS,
  writeFn: insertQuotesBatch,
  onError: (err, items) => {
    logger.error({ err, count: items.length }, 'Failed to write quotes batch');
  },
});

const orderBookWriter = new BatchWriter<OrderBook>({
  maxSize: BATCH_SIZE,
  maxWaitMs: BATCH_INTERVAL_MS,
  writeFn: insertOrderBooksBatch,
  onError: (err, items) => {
    logger.error({ err, count: items.length }, 'Failed to write order books batch');
  },
});

const tradeWriter = new BatchWriter<Trade>({
  maxSize: BATCH_SIZE,
  maxWaitMs: BATCH_INTERVAL_MS,
  writeFn: insertTradesBatch,
  onError: (err, items) => {
    logger.error({ err, count: items.length }, 'Failed to write trades batch');
  },
});

const marketDataWriter = new BatchWriter<MarketLatestData>({
  maxSize: BATCH_SIZE,
  maxWaitMs: BATCH_INTERVAL_MS,
  writeFn: upsertMarketLatestDataBatch,
  onError: (err, items) => {
    logger.error({ err, count: items.length }, 'Failed to write market data batch');
  },
});

export interface KalshiTickerMessage {
  type: 'ticker';
  msg: {
    market_ticker: string;
    yes_bid?: number;
    yes_ask?: number;
    no_bid?: number;
    no_ask?: number;
    last_price?: number;
    volume?: number;
    volume_24h?: number;
    open_interest?: number;
  };
}

export interface KalshiOrderBookDeltaMessage {
  type: 'orderbook_delta';
  msg: {
    market_ticker: string;
    yes?: {
      bids?: Array<[number, number]>;
      asks?: Array<[number, number]>;
    };
    no?: {
      bids?: Array<[number, number]>;
      asks?: Array<[number, number]>;
    };
  };
}

export interface KalshiTradeMessage {
  type: 'trade';
  msg: {
    market_ticker: string;
    trade_id?: string;
    yes_price_dollars?: string;
    no_price_dollars?: string;
    price?: number;          // legacy cent field
    count_fp?: string;       // new: quantity as string (e.g. "808.00")
    count?: number;          // legacy: quantity as number
    taker_side?: string;
    ts?: number;
  };
}

export function handleMessage(
  message: Record<string, unknown>,
  sourceId: string,
  exchangeId: string
): void {
  const type = message.type as string;
  const msg = message.msg as Record<string, unknown> | undefined;

  if (!msg) {
    // Log data messages that have no inner msg (shouldn't happen for data types)
    if (type === 'ticker' || type === 'orderbook_delta' || type === 'orderbook_snapshot' || type === 'trade') {
      logger.info({ type, keys: Object.keys(message) }, 'SKIPPED: Data message without msg field');
    }
    return;
  }

  switch (type) {
    case 'ticker':
      handleTicker(msg, sourceId, exchangeId);
      break;
    case 'orderbook_delta':
    case 'orderbook_snapshot':
    case 'orderbook_update':
      orderbookMsgCount++;
      handleOrderBookDelta(msg, sourceId, exchangeId);
      break;
    case 'trade':
      handleTrade(msg, sourceId, exchangeId);
      break;
    default:
      logger.debug({ type }, 'Unhandled message type');
  }
}

function handleTicker(
  msg: Record<string, unknown>,
  sourceId: string,
  exchangeId: string
): void {
  const ticker = msg.market_ticker as string;
  if (!ticker) return;

  const now = new Date();

  // Kalshi ticker: new API uses dollar fields, legacy used cent fields
  // Dollar fields (0-1): last_price_dollars, yes_bid_dollars, etc.
  // Legacy fields (0-100): last_price, yes_bid, etc.
  const lastPriceDollars = msg.last_price_dollars as number | undefined;
  const lastPriceCents = msg.last_price as number | undefined;
  const lastPrice = lastPriceDollars !== undefined
    ? lastPriceDollars * 100 // convert to cents for consistency
    : lastPriceCents;
  const rawVolume = msg.volume_24h_fp ?? msg.volume_24h ?? msg.volume_fp ?? msg.volume;
  const volume = rawVolume !== undefined ? Math.round(Number(rawVolume)) : undefined;

  // Create YES market latest data record with raw prices (cents)
  const yesMarketData: MarketLatestData = {
    source_id: sourceId,
    exchange_id: exchangeId,
    market_id: ticker,
    outcome_side: 'YES',
    price_close: lastPrice,
    volume_traded: volume,
    entry_time: now,
  };
  marketDataWriter.add(yesMarketData).catch((err) => {
    logger.error({ err }, 'Failed to add YES market data to batch');
  });

  // Create NO market latest data record with inverted price (cents 0-100)
  const noMarketData: MarketLatestData = {
    source_id: sourceId,
    exchange_id: exchangeId,
    market_id: ticker,
    outcome_side: 'NO',
    price_close: lastPrice !== undefined ? 100 - lastPrice : undefined,
    volume_traded: volume,
    entry_time: now,
  };
  marketDataWriter.add(noMarketData).catch((err) => {
    logger.error({ err }, 'Failed to add NO market data to batch');
  });

  // Only write quotes if feature flag is enabled
  if (ENABLE_QUOTE_WRITES) {
    const yesBid = (msg.yes_bid_dollars as number | undefined) ?? (msg.yes_bid as number | undefined);
    const yesAsk = (msg.yes_ask_dollars as number | undefined) ?? (msg.yes_ask as number | undefined);
    const noBid = (msg.no_bid_dollars as number | undefined) ?? (msg.no_bid as number | undefined);
    const noAsk = (msg.no_ask_dollars as number | undefined) ?? (msg.no_ask as number | undefined);

    // YES quote record
    const yesQuote: Quote = {
      source_id: sourceId,
      exchange_id: exchangeId,
      market_id: ticker,
      outcome_side: 'YES',
      bid: yesBid,
      bid_size: undefined,
      ask: yesAsk,
      ask_size: undefined,
      entry_time: now,
    };
    quoteWriter.add(yesQuote).catch((err) => {
      logger.error({ err }, 'Failed to add YES quote to batch');
    });

    // NO quote record
    const noQuote: Quote = {
      source_id: sourceId,
      exchange_id: exchangeId,
      market_id: ticker,
      outcome_side: 'NO',
      bid: noBid,
      bid_size: undefined,
      ask: noAsk,
      ask_size: undefined,
      entry_time: now,
    };
    quoteWriter.add(noQuote).catch((err) => {
      logger.error({ err }, 'Failed to add NO quote to batch');
    });
  }

  logger.debug({ ticker, lastPrice }, 'Processed ticker (YES + NO)');
}

function handleOrderBookDelta(
  msg: Record<string, unknown>,
  sourceId: string,
  exchangeId: string
): void {
  const ticker = msg.market_ticker as string;
  if (!ticker) {
    logger.debug({ msg }, 'Orderbook message without market_ticker');
    return;
  }

  const now = new Date();

  // Parse message - Kalshi has multiple orderbook message formats:
  // Legacy:
  //   1. Full book (orderbook_snapshot): { yes: [[p,q], ...], no: [[p,q], ...] } (cents 0-100)
  //   2. Level delta (orderbook_delta): { price: X, delta: D, side: "yes"/"no" } (cents 0-100)
  // New (2026-03):
  //   3. Full book: { yes_dollars_fp: [[p,q], ...], no_dollars_fp: [[p,q], ...] } (dollars 0-1)
  //   4. Level delta: { price_dollars: X, delta_fp: D, side: "yes"/"no" } (dollars 0-1)

  // Check for snapshot formats (legacy cents or new dollars)
  const yesOrdersCents = msg.yes as Array<[number, number]> | undefined;
  const noOrdersCents = msg.no as Array<[number, number]> | undefined;
  // Note: yes_dollars_fp/no_dollars_fp contain string tuples from Kalshi API, e.g. [["0.0800","300.00"]]
  const yesOrdersDollars = msg.yes_dollars_fp as Array<[string | number, string | number]> | undefined;
  const noOrdersDollars = msg.no_dollars_fp as Array<[string | number, string | number]> | undefined;

  // Check for delta formats (legacy cents or new dollars)
  // Note: price_dollars and delta_fp are strings from Kalshi API, e.g. "0.960", "-54.00"
  const deltaPriceCents = msg.price as number | undefined;
  const deltaQtyCents = msg.delta as number | undefined;
  const deltaPriceDollarsRaw = msg.price_dollars as string | number | undefined;
  const deltaQtyDollarsRaw = msg.delta_fp as string | number | undefined;
  const deltaSide = msg.side as string | undefined;

  // Parse string values to numbers
  const deltaPriceDollars = deltaPriceDollarsRaw !== undefined ? parseFloat(String(deltaPriceDollarsRaw)) : undefined;
  const deltaQtyDollars = deltaQtyDollarsRaw !== undefined ? parseFloat(String(deltaQtyDollarsRaw)) : undefined;

  // Apply to state manager
  if (yesOrdersDollars || noOrdersDollars) {
    // New snapshot format (dollars 0-1) — convert to cents for consistency with existing state
    // Convert dollars to cents, preserving fractional cents (e.g. 0.274 → 27.4, not 27)
    // toFixed(1) ensures clean Map keys for delta accumulation (avoids floating point mismatch)
    const yesCents = (yesOrdersDollars || []).map(([p, q]): [number, number] => [parseFloat((parseFloat(String(p)) * 100).toFixed(1)), parseFloat(String(q))]);
    const noCents = (noOrdersDollars || []).map(([p, q]): [number, number] => [parseFloat((parseFloat(String(p)) * 100).toFixed(1)), parseFloat(String(q))]);
    orderBookManager.applySnapshot(ticker, yesCents, noCents);
  } else if (yesOrdersCents || noOrdersCents) {
    // Legacy snapshot format (cents 0-100)
    orderBookManager.applySnapshot(ticker, yesOrdersCents || [], noOrdersCents || []);
  } else if (deltaPriceDollars !== undefined && !isNaN(deltaPriceDollars) && deltaQtyDollars !== undefined && !isNaN(deltaQtyDollars) && deltaSide) {
    // New delta format (dollars 0-1) — convert to cents
    const applied = orderBookManager.applyDelta(
      ticker,
      deltaSide as 'yes' | 'no',
      parseFloat((deltaPriceDollars * 100).toFixed(1)), // preserve fractional cents, clean for Map key
      deltaQtyDollars
    );
    if (!applied) {
      droppedDeltaCount++;
      if (droppedDeltaCount % 1000 === 1) {
        logger.warn({ ticker, totalDropped: droppedDeltaCount }, 'Delta dropped: no snapshot state');
      }
      return;
    }
  } else if (deltaPriceCents !== undefined && deltaQtyCents !== undefined && deltaSide) {
    // Legacy delta format (cents 0-100)
    const applied = orderBookManager.applyDelta(
      ticker,
      deltaSide as 'yes' | 'no',
      deltaPriceCents,
      deltaQtyCents
    );
    if (!applied) {
      droppedDeltaCount++;
      if (droppedDeltaCount % 1000 === 1) {
        logger.warn({ ticker, totalDropped: droppedDeltaCount }, 'Delta dropped: no snapshot state');
      }
      return;
    }
  } else {
    // Empty updates (e.g. just market_ticker + market_id) — skip silently
    const keys = Object.keys(msg).filter(k => k !== 'market_ticker' && k !== 'market_id');
    if (keys.length > 0) {
      logger.info({ ticker, msgKeys: Object.keys(msg) }, 'SKIPPED: Orderbook unrecognized format');
    }
    return;
  }

  // Get accumulated state
  const fullBook = orderBookManager.getOrderBook(ticker);
  if (!fullBook || (fullBook.yesBids.length === 0 && fullBook.noBids.length === 0)) {
    return;
  }

  orderbookWriteCount++;

  // Build orderbooks from accumulated state
  // YES side: yesBids direct, yesAsks from inverted noBids
  const yesBids = fullBook.yesBids;
  const yesAsks = fullBook.noBids.map(({ price, quantity }) => ({
    price: 100 - price,
    quantity,
  }));

  // NO side: noBids direct, noAsks from inverted yesBids
  const noBids = fullBook.noBids;
  const noAsks = fullBook.yesBids.map(({ price, quantity }) => ({
    price: 100 - price,
    quantity,
  }));

  const hasYesData = yesBids.length > 0 || yesAsks.length > 0;
  const hasNoData = noBids.length > 0 || noAsks.length > 0;

  if (!hasYesData && !hasNoData) {
    return;
  }

  // Create YES order book and market data
  if (hasYesData) {
    const yesOrderBook: OrderBook = {
      source_id: sourceId,
      exchange_id: exchangeId,
      market_id: ticker,
      outcome_side: 'YES',
      bids: yesBids,
      asks: yesAsks,
      entry_time: now,
    };
    orderBookWriter.add(yesOrderBook).catch((err) => {
      logger.error({ err }, 'Failed to add YES order book to batch');
    });

    // Calculate YES band metrics from FULL accumulated state
    const normalizedYesBids = yesBids.map(b => ({ price: b.price / 100, quantity: b.quantity }));
    const normalizedYesAsks = yesAsks.map(a => ({ price: a.price / 100, quantity: a.quantity }));
    const yesMetrics = calculateBandMetrics(normalizedYesBids, normalizedYesAsks);

    const yesMarketData: MarketLatestData = {
      source_id: sourceId,
      exchange_id: exchangeId,
      market_id: ticker,
      outcome_side: 'YES',
      reference_price: yesMetrics.referencePrice ?? undefined,
      band_liquidity_qty_ask: yesMetrics.bandLiquidityQtyAsk ?? undefined,
      band_liquidity_qty_bid: yesMetrics.bandLiquidityQtyBid ?? undefined,
      band_vwap_ask: yesMetrics.bandVwapAsk ?? undefined,
      band_vwap_bid: yesMetrics.bandVwapBid ?? undefined,
      band_delta_used: yesMetrics.bandDeltaUsed ?? undefined,
      entry_time: now,
    };
    marketDataWriter.add(yesMarketData).catch((err) => {
      logger.error({ err }, 'Failed to add YES market data to batch');
    });
  }

  // Create NO order book and market data
  if (hasNoData) {
    const noOrderBook: OrderBook = {
      source_id: sourceId,
      exchange_id: exchangeId,
      market_id: ticker,
      outcome_side: 'NO',
      bids: noBids,
      asks: noAsks,
      entry_time: now,
    };
    orderBookWriter.add(noOrderBook).catch((err) => {
      logger.error({ err }, 'Failed to add NO order book to batch');
    });

    // Calculate NO band metrics from FULL accumulated state
    const normalizedNoBids = noBids.map(b => ({ price: b.price / 100, quantity: b.quantity }));
    const normalizedNoAsks = noAsks.map(a => ({ price: a.price / 100, quantity: a.quantity }));
    const noMetrics = calculateBandMetrics(normalizedNoBids, normalizedNoAsks);

    const noMarketData: MarketLatestData = {
      source_id: sourceId,
      exchange_id: exchangeId,
      market_id: ticker,
      outcome_side: 'NO',
      reference_price: noMetrics.referencePrice ?? undefined,
      band_liquidity_qty_ask: noMetrics.bandLiquidityQtyAsk ?? undefined,
      band_liquidity_qty_bid: noMetrics.bandLiquidityQtyBid ?? undefined,
      band_vwap_ask: noMetrics.bandVwapAsk ?? undefined,
      band_vwap_bid: noMetrics.bandVwapBid ?? undefined,
      band_delta_used: noMetrics.bandDeltaUsed ?? undefined,
      entry_time: now,
    };
    marketDataWriter.add(noMarketData).catch((err) => {
      logger.error({ err }, 'Failed to add NO market data to batch');
    });
  }

  // Log stats every 100 writes
  if (orderbookWriteCount % 100 === 0) {
    const stats = orderBookManager.getStats();
    logger.info({
      received: orderbookMsgCount,
      written: orderbookWriteCount,
      activeMarkets: stats.marketCount,
      totalLevels: stats.totalLevels,
    }, 'Orderbook ingestion stats');
  }

  logger.debug(
    { ticker, yesBids: yesBids.length, yesAsks: yesAsks.length, noBids: noBids.length, noAsks: noAsks.length },
    'Processed order book (YES + NO)'
  );
}

function handleTrade(
  msg: Record<string, unknown>,
  sourceId: string,
  exchangeId: string
): void {
  const ticker = msg.market_ticker as string;
  if (!ticker) return;

  // Kalshi trade prices: new API sends string dollar fields (yes_price_dollars, no_price_dollars),
  // legacy API sent numeric cent fields (yes_price, price)
  const priceDollars = parseFloat(msg.yes_price_dollars as string) || parseFloat(msg.price_dollars as string) || undefined;
  const priceCents = (msg.yes_price as number | undefined) ?? (msg.price as number | undefined);
  const price = priceDollars ?? (priceCents !== undefined ? priceCents / 100 : undefined);

  // Skip trades with no valid price — avoids phantom records with price=0
  if (price === undefined) {
    logger.warn({ ticker, msg }, 'Skipping trade with missing price');
    return;
  }

  const timestamp = msg.ts ? new Date((msg.ts as number) * 1000) : new Date();

  // Quantity: new API uses count_fp (string), legacy used count (number)
  const countFp = msg.count_fp ? parseFloat(msg.count_fp as string) : NaN;
  const quantity = !isNaN(countFp) ? countFp : (msg.count as number | undefined) ?? 1;

  // taker_side from Kalshi is the outcome (yes/no), not buy/sell direction
  const takerSide = msg.taker_side as string | undefined;

  const trade: Trade = {
    source_id: sourceId,
    exchange_id: exchangeId,
    market_id: ticker,
    trade_id: msg.trade_id as string | undefined,
    price,
    quantity,
    side: mapTakerSide(takerSide),
    outcome: takerSide?.toLowerCase() === 'yes' ? 'YES' : takerSide?.toLowerCase() === 'no' ? 'NO' : undefined,
    entry_time: timestamp,
  };

  tradeWriter.add(trade).catch((err) => {
    logger.error({ err }, 'Failed to add trade to batch');
  });

  logger.debug({ ticker, price: trade.price, quantity: trade.quantity }, 'Processed trade');
}

function mapTakerSide(side: string | undefined): 'Buy' | 'Sell' | undefined {
  if (!side) return undefined;
  if (side.toLowerCase() === 'yes') return 'Buy';
  if (side.toLowerCase() === 'no') return 'Sell';
  return undefined;
}

export async function flushAllWriters(): Promise<void> {
  await Promise.all([
    quoteWriter.flush(),
    orderBookWriter.flush(),
    tradeWriter.flush(),
    marketDataWriter.flush(),
  ]);
}

export async function shutdownWriters(): Promise<void> {
  await Promise.all([
    quoteWriter.shutdown(),
    orderBookWriter.shutdown(),
    tradeWriter.shutdown(),
    marketDataWriter.shutdown(),
  ]);
}
