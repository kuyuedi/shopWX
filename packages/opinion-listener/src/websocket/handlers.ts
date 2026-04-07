import {
  createLogger,
  BatchWriter,
  insertOrderBooksBatch,
  insertTradesBatch,
  upsertMarketLatestDataBatch,
  calculateBandMetrics,
  OPINION_SOURCE_ID,
  OPINION_EXCHANGE_ID,
  type OrderBook,
  type Trade,
  type MarketLatestData,
} from '@prediction-market/shared';
import { orderBookManager } from '../state/orderBookManager.js';
import type {
  OpinionWsDepthDiff,
  OpinionWsLastPrice,
  OpinionWsLastTrade,
} from '../types/api.js';

const logger = createLogger('opinion-handlers');

// Periodic pruning every 5 minutes - remove stale orderbooks (not updated in 10 min)
setInterval(() => {
  orderBookManager.pruneStale(10 * 60 * 1000);
}, 5 * 60 * 1000);

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '100', 10);
const BATCH_INTERVAL_MS = parseInt(process.env.BATCH_INTERVAL_MS || '100', 10);

// Counters for debugging
let depthMsgCount = 0;
let depthWriteCount = 0;

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

function mapOutcomeSide(outcomeSide: number): 'YES' | 'NO' {
  return outcomeSide === 1 ? 'YES' : 'NO';
}

function handleDepthDiff(msg: OpinionWsDepthDiff): void {
  const marketId = String(msg.marketId);
  const outcomeSide = mapOutcomeSide(msg.outcomeSide);
  const side = msg.side as 'bids' | 'asks';
  const price = parseFloat(msg.price);
  const size = parseFloat(msg.size);

  depthMsgCount++;

  // Apply delta to in-memory orderbook
  orderBookManager.applyDelta(marketId, outcomeSide, side, price, size);

  // Get full accumulated state
  const fullBook = orderBookManager.getOrderBook(marketId, outcomeSide);
  if (!fullBook || (fullBook.bids.length === 0 && fullBook.asks.length === 0)) {
    return;
  }

  depthWriteCount++;

  const now = new Date();

  // Write orderbook snapshot to DB
  const orderBook: OrderBook = {
    source_id: OPINION_SOURCE_ID,
    exchange_id: OPINION_EXCHANGE_ID,
    market_id: marketId,
    outcome_side: outcomeSide,
    bids: fullBook.bids,
    asks: fullBook.asks,
    entry_time: now,
  };
  orderBookWriter.add(orderBook).catch((err) => {
    logger.error({ err }, 'Failed to add order book to batch');
  });

  // Calculate band metrics (prices already decimal 0-1, no conversion needed)
  const metrics = calculateBandMetrics(fullBook.bids, fullBook.asks);

  const marketData: MarketLatestData = {
    source_id: OPINION_SOURCE_ID,
    exchange_id: OPINION_EXCHANGE_ID,
    market_id: marketId,
    outcome_side: outcomeSide,
    reference_price: metrics.referencePrice ?? undefined,
    band_liquidity_qty_bid: metrics.bandLiquidityQtyBid ?? undefined,
    band_liquidity_qty_ask: metrics.bandLiquidityQtyAsk ?? undefined,
    band_vwap_bid: metrics.bandVwapBid ?? undefined,
    band_vwap_ask: metrics.bandVwapAsk ?? undefined,
    band_delta_used: metrics.bandDeltaUsed ?? undefined,
    entry_time: now,
  };
  marketDataWriter.add(marketData).catch((err) => {
    logger.error({ err }, 'Failed to add market data to batch');
  });

  // Log stats every 100 writes
  if (depthWriteCount % 100 === 0) {
    const stats = orderBookManager.getStats();
    logger.info({
      received: depthMsgCount,
      written: depthWriteCount,
      activeBooks: stats.bookCount,
      totalLevels: stats.totalLevels,
    }, 'Orderbook ingestion stats');
  }

  logger.debug({ marketId, outcomeSide, bids: fullBook.bids.length, asks: fullBook.asks.length }, 'Processed depth diff');
}

function handleLastPrice(msg: OpinionWsLastPrice): void {
  const marketId = String(msg.marketId);
  const outcomeSide = mapOutcomeSide(msg.outcomeSide);
  const price = parseFloat(msg.price);

  const marketData: MarketLatestData = {
    source_id: OPINION_SOURCE_ID,
    exchange_id: OPINION_EXCHANGE_ID,
    market_id: marketId,
    outcome_side: outcomeSide,
    price_close: price,
    entry_time: new Date(),
  };
  marketDataWriter.add(marketData).catch((err) => {
    logger.error({ err }, 'Failed to add last price to batch');
  });

  logger.debug({ marketId, outcomeSide, price }, 'Processed last price');
}

function handleLastTrade(msg: OpinionWsLastTrade): void {
  const marketId = String(msg.marketId);
  const outcomeSide = mapOutcomeSide(msg.outcomeSide);

  const trade: Trade = {
    source_id: OPINION_SOURCE_ID,
    exchange_id: OPINION_EXCHANGE_ID,
    market_id: marketId,
    price: parseFloat(msg.price),
    quantity: parseFloat(msg.shares),
    side: msg.side === 'Buy' ? 'Buy' : msg.side === 'Sell' ? 'Sell' : undefined,
    outcome: outcomeSide,
    entry_time: new Date(),
  };
  tradeWriter.add(trade).catch((err) => {
    logger.error({ err }, 'Failed to add trade to batch');
  });

  logger.debug({ marketId, outcomeSide, price: trade.price, qty: trade.quantity }, 'Processed trade');
}

export function handleMessage(message: Record<string, unknown>): void {
  const msgType = message.msgType as string;

  switch (msgType) {
    case 'market.depth.diff':
      handleDepthDiff(message as unknown as OpinionWsDepthDiff);
      break;
    case 'market.last.price':
      handleLastPrice(message as unknown as OpinionWsLastPrice);
      break;
    case 'market.last.trade':
      handleLastTrade(message as unknown as OpinionWsLastTrade);
      break;
    default:
      // Ignore unknown message types (heartbeat responses, subscription confirmations, etc.)
      break;
  }
}

export async function flushAllWriters(): Promise<void> {
  await Promise.all([
    orderBookWriter.flush(),
    tradeWriter.flush(),
    marketDataWriter.flush(),
  ]);
}

export async function shutdownWriters(): Promise<void> {
  await Promise.all([
    orderBookWriter.shutdown(),
    tradeWriter.shutdown(),
    marketDataWriter.shutdown(),
  ]);
}
