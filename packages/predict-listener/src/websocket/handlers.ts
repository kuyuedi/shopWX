import {
  createLogger,
  BatchWriter,
  insertOrderBooksBatch,
  upsertMarketLatestDataBatch,
  calculateBandMetrics,
  PREDICT_SOURCE_ID,
  PREDICT_EXCHANGE_ID,
  type OrderBook,
  type MarketLatestData,
} from '@prediction-market/shared';
import { orderBookManager } from '../state/orderBookManager.js';
import type { PredictWsOrderbookPush, PredictOrderbookData } from '../types/api.js';

const logger = createLogger('predict-handlers');

// Periodic pruning every 5 minutes - remove stale orderbooks (not updated in 10 min)
setInterval(() => {
  orderBookManager.pruneStale(10 * 60 * 1000);
}, 5 * 60 * 1000);

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '100', 10);
const BATCH_INTERVAL_MS = parseInt(process.env.BATCH_INTERVAL_MS || '100', 10);

// Counters for debugging
let pushCount = 0;
let writeCount = 0;

const orderBookWriter = new BatchWriter<OrderBook>({
  maxSize: BATCH_SIZE,
  maxWaitMs: BATCH_INTERVAL_MS,
  writeFn: insertOrderBooksBatch,
  onError: (err, items) => {
    logger.error({ err, count: items.length }, 'Failed to write order books batch');
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

function handleOrderbookPush(data: PredictOrderbookData): void {
  const marketId = String(data.marketId);
  pushCount++;

  const now = new Date();
  const exchangeTime = data.updateTimestampMs
    ? new Date(data.updateTimestampMs)
    : now;

  // Parse YES side bids/asks from raw [price, qty] arrays
  const yesBids = (data.bids || []).map(([price, qty]) => ({ price, quantity: qty }));
  const yesAsks = (data.asks || []).map(([price, qty]) => ({ price, quantity: qty }));

  // Derive NO side: invert prices (1 - price), swap bids↔asks
  const noBids = yesAsks.map(a => ({ price: 1 - a.price, quantity: a.quantity }));
  const noAsks = yesBids.map(b => ({ price: 1 - b.price, quantity: b.quantity }));

  // Store both sides in orderbook manager
  orderBookManager.setSnapshot(marketId, 'YES', yesBids, yesAsks);
  orderBookManager.setSnapshot(marketId, 'NO', noBids, noAsks);

  // Process both YES and NO sides
  for (const side of ['YES', 'NO'] as const) {
    const book = orderBookManager.getOrderBook(marketId, side);
    if (!book || (book.bids.length === 0 && book.asks.length === 0)) {
      continue;
    }

    writeCount++;

    // Write orderbook snapshot to DB
    const orderBook: OrderBook = {
      source_id: PREDICT_SOURCE_ID,
      exchange_id: PREDICT_EXCHANGE_ID,
      market_id: marketId,
      outcome_side: side,
      bids: book.bids,
      asks: book.asks,
      entry_time: exchangeTime,
    };
    orderBookWriter.add(orderBook).catch((err) => {
      logger.error({ err }, 'Failed to add order book to batch');
    });

    // Calculate band metrics (prices already decimal 0-1)
    const metrics = calculateBandMetrics(book.bids, book.asks);

    const marketData: MarketLatestData = {
      source_id: PREDICT_SOURCE_ID,
      exchange_id: PREDICT_EXCHANGE_ID,
      market_id: marketId,
      outcome_side: side,
      reference_price: metrics.referencePrice ?? undefined,
      band_liquidity_qty_bid: metrics.bandLiquidityQtyBid ?? undefined,
      band_liquidity_qty_ask: metrics.bandLiquidityQtyAsk ?? undefined,
      band_vwap_bid: metrics.bandVwapBid ?? undefined,
      band_vwap_ask: metrics.bandVwapAsk ?? undefined,
      band_delta_used: metrics.bandDeltaUsed ?? undefined,
      entry_time: exchangeTime,
    };
    marketDataWriter.add(marketData).catch((err) => {
      logger.error({ err }, 'Failed to add market data to batch');
    });
  }

  // Extract last trade price from lastOrderSettled if present
  if (data.lastOrderSettled) {
    const tradePrice = parseFloat(data.lastOrderSettled.price);
    const outcome = data.lastOrderSettled.outcome;

    if (isNaN(tradePrice) || tradePrice < 0 || tradePrice > 1) {
      logger.warn({
        marketId,
        price: data.lastOrderSettled.price,
        outcome,
        side: data.lastOrderSettled.side,
      }, 'Invalid lastOrderSettled price, skipping price_close write');
    } else {
      const isNo = outcome === 'No' || outcome === 'NO';
      const isYes = outcome === 'Yes' || outcome === 'YES';

      if (!isYes && !isNo) {
        // Outcome is likely the outcome NAME (e.g. "Oklahoma City Thunder"), not "Yes"/"No".
        // Skip write to avoid inversion — we can't determine YES/NO price without metadata.
        logger.warn({
          marketId,
          outcome,
          price: data.lastOrderSettled.price,
          side: data.lastOrderSettled.side,
          kind: data.lastOrderSettled.kind,
        }, 'Unexpected lastOrderSettled outcome value, skipping price_close write');
      } else {
        const yesPrice = isNo ? 1 - tradePrice : tradePrice;
        const noPrice = 1 - yesPrice;

        // Write price_close for both sides
        for (const [side, price] of [['YES', yesPrice], ['NO', noPrice]] as const) {
          const priceData: MarketLatestData = {
            source_id: PREDICT_SOURCE_ID,
            exchange_id: PREDICT_EXCHANGE_ID,
            market_id: marketId,
            outcome_side: side,
            price_close: price,
            entry_time: exchangeTime,
          };
          marketDataWriter.add(priceData).catch((err) => {
            logger.error({ err }, 'Failed to add last trade price to batch');
          });
        }
      }
    }
  }

  // Log stats every 100 writes
  if (writeCount % 100 === 0) {
    const stats = orderBookManager.getStats();
    logger.info({
      received: pushCount,
      written: writeCount,
      activeBooks: stats.bookCount,
      totalLevels: stats.totalLevels,
    }, 'Orderbook ingestion stats');
  }

  logger.debug({
    marketId,
    yesBids: yesBids.length,
    yesAsks: yesAsks.length,
  }, 'Processed orderbook push');
}

export function handleMessage(message: Record<string, unknown>): void {
  const type = message.type as string;
  const topic = message.topic as string | undefined;

  // Only handle orderbook push messages (heartbeat/responses handled in client)
  if (type === 'M' && topic && topic.startsWith('predictOrderbook/')) {
    handleOrderbookPush(message.data as PredictOrderbookData);
  }
}

export async function flushAllWriters(): Promise<void> {
  await Promise.all([
    orderBookWriter.flush(),
    marketDataWriter.flush(),
  ]);
}

export async function shutdownWriters(): Promise<void> {
  await Promise.all([
    orderBookWriter.shutdown(),
    marketDataWriter.shutdown(),
  ]);
}
