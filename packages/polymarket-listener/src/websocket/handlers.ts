import {
  createLogger,
  BatchWriter,
  insertQuotesBatch,
  insertOrderBooksBatch,
  insertTradesBatch,
  upsertMarketLatestDataBatch,
  getOutcomeSide,
  getGammaMarketId,
  isMatchedMarket,
  calculateBandMetrics,
  type Quote,
  type OrderBook,
  type Trade,
  type MarketLatestData,
} from '@prediction-market/shared';
import { orderBookManager } from '../state/orderBookManager.js';

const logger = createLogger('polymarket-handlers');

// Feature flag to disable quote writes (defaults to disabled to stop table growth)
const ENABLE_QUOTE_WRITES = process.env.ENABLE_QUOTE_WRITES === 'true';

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

export function handleMessage(
  message: Record<string, unknown>,
  sourceId: string,
  exchangeId: string
): void {
  const eventType = (message.event_type ?? message.type) as string;

  switch (eventType) {
    case 'book':
    case 'last_trade_price':
      // These events require asset_id at top level
      if (!message.asset_id) {
        logger.debug({ eventType }, 'Message without asset_id');
        return;
      }
      if (eventType === 'book') {
        handleBook(message, sourceId, exchangeId);
      } else {
        handleLastTradePrice(message, sourceId, exchangeId);
      }
      break;
    case 'price_change':
      // price_change has asset_id inside price_changes array
      handlePriceChange(message, sourceId, exchangeId);
      break;
    case 'tick_size_change':
      // Ignore tick size changes
      break;
    default:
      logger.debug({ eventType }, 'Unhandled message type');
  }
}

function handleBook(
  msg: Record<string, unknown>,
  sourceId: string,
  exchangeId: string
): void {
  const assetId = msg.asset_id as string;
  const conditionId = msg.market as string | undefined;
  const now = new Date();

  // Lookup outcome side from cache (keyed by clobTokenId)
  const outcomeSide = getOutcomeSide(assetId);

  // Skip if outcome_side not in cache - better to skip than write UNKNOWN
  if (!outcomeSide) {
    logger.warn({ assetId }, 'Cache miss for outcome_side in handleBook - skipping record');
    return;
  }

  // Resolve Gamma market ID from condition_id, fall back to assetId
  const marketId = (conditionId && getGammaMarketId(conditionId)) || assetId;

  // Parse bids and asks
  const bids = (msg.bids as Array<{ price: string; size: string }>) || [];
  const asks = (msg.asks as Array<{ price: string; size: string }>) || [];

  // Store snapshot in OrderBookManager for delta accumulation
  orderBookManager.applySnapshot(
    assetId,
    bids.map((b) => [parseFloat(b.price), parseFloat(b.size)]),
    asks.map((a) => [parseFloat(a.price), parseFloat(a.size)])
  );

  // Insert order book
  const orderBook: OrderBook = {
    source_id: sourceId,
    exchange_id: exchangeId,
    market_id: marketId,
    outcome_side: outcomeSide,
    bids: bids.map((b) => ({ price: parseFloat(b.price), quantity: parseFloat(b.size) })),
    asks: asks.map((a) => ({ price: parseFloat(a.price), quantity: parseFloat(a.size) })),
    entry_time: now,
  };

  orderBookWriter.add(orderBook).catch((err) => {
    logger.error({ err }, 'Failed to add order book to batch');
  });

  // Calculate band metrics and write to market_latest_data
  const metrics = calculateBandMetrics(orderBook.bids, orderBook.asks);

  const marketData: MarketLatestData = {
    source_id: sourceId,
    exchange_id: exchangeId,
    market_id: marketId,
    outcome_side: outcomeSide,
    reference_price: metrics.referencePrice ?? undefined,
    band_liquidity_qty_ask: metrics.bandLiquidityQtyAsk ?? undefined,
    band_liquidity_qty_bid: metrics.bandLiquidityQtyBid ?? undefined,
    band_vwap_ask: metrics.bandVwapAsk ?? undefined,
    band_vwap_bid: metrics.bandVwapBid ?? undefined,
    band_delta_used: metrics.bandDeltaUsed ?? undefined,
    entry_time: now,
  };

  marketDataWriter.add(marketData).catch((err) => {
    logger.error({ err }, 'Failed to add market data (band metrics) to batch');
  });

  // Also create a quote from best bid/ask
  const bestBid = bids.length > 0 ? bids[0] : undefined;
  const bestAsk = asks.length > 0 ? asks[0] : undefined;

  // Only write quotes if feature flag is enabled
  if (ENABLE_QUOTE_WRITES && (bestBid || bestAsk)) {
    const quote: Quote = {
      source_id: sourceId,
      exchange_id: exchangeId,
      market_id: marketId,
      outcome_side: outcomeSide,
      bid: bestBid ? parseFloat(bestBid.price) : undefined,
      bid_size: bestBid ? parseFloat(bestBid.size) : undefined,
      ask: bestAsk ? parseFloat(bestAsk.price) : undefined,
      ask_size: bestAsk ? parseFloat(bestAsk.size) : undefined,
      entry_time: now,
    };

    quoteWriter.add(quote).catch((err) => {
      logger.error({ err }, 'Failed to add quote to batch');
    });
  }

  logger.debug(
    { assetId, marketId, bids: orderBook.bids.length, asks: orderBook.asks.length },
    'Processed book'
  );
}

// Old format (before Sept 15, 2025)
interface PriceChangeEntryOld {
  asset_id: string;
  price: string;
  size: string;
  side: string;
  best_bid: string;
  best_ask: string;
}

// New format (after Sept 15, 2025)
interface PriceChangeEntryNew {
  price: string;
  side: string;
  size: string;
}

// Counters for price_change format debugging
let priceChangeNewFormat = 0;
let priceChangeOldFormat = 0;
let priceChangeOldWithQuotes = 0;
let priceChangeDeltaDrops = 0;

function handlePriceChange(
  msg: Record<string, unknown>,
  sourceId: string,
  exchangeId: string
): void {
  const now = new Date();
  const conditionId = msg.market as string | undefined;

  // Try new format first (after Sept 15, 2025)
  // New format has asset_id at top level and changes array
  const assetId = msg.asset_id as string | undefined;
  const changes = msg.changes as PriceChangeEntryNew[] | undefined;

  if (assetId && changes && Array.isArray(changes)) {
    // New format - process changes for this asset
    priceChangeNewFormat++;

    // Lookup outcome side from cache (keyed by clobTokenId)
    const outcomeSide = getOutcomeSide(assetId);

    // Skip if outcome_side not in cache - better to skip than write UNKNOWN
    if (!outcomeSide) {
      logger.warn({ assetId }, 'Cache miss for outcome_side in handlePriceChange (new format) - skipping record');
      return;
    }

    // Resolve Gamma market ID from condition_id, fall back to assetId
    const marketId = (conditionId && getGammaMarketId(conditionId)) || assetId;

    // Apply deltas to OrderBookManager
    let deltaApplied = false;
    for (const change of changes) {
      const applied = orderBookManager.applyDelta(
        assetId,
        change.side.toUpperCase() as 'BUY' | 'SELL',
        parseFloat(change.price),
        parseFloat(change.size)
      );
      if (applied) deltaApplied = true;
    }

    if (deltaApplied) {
      // Only write to DB for matched markets (those in market_mappings used by arb scanner)
      if (isMatchedMarket(marketId)) {
        // Get full accumulated book and write orderbook + band metrics
        const fullBook = orderBookManager.getOrderBook(assetId);
        if (fullBook) {
          const orderBook: OrderBook = {
            source_id: sourceId,
            exchange_id: exchangeId,
            market_id: marketId,
            outcome_side: outcomeSide,
            bids: fullBook.bids,
            asks: fullBook.asks,
            entry_time: now,
          };

          orderBookWriter.add(orderBook).catch((err) => {
            logger.error({ err }, 'Failed to add order book to batch (price_change)');
          });

          // Calculate band metrics from full book
          const metrics = calculateBandMetrics(fullBook.bids, fullBook.asks);

          const marketData: MarketLatestData = {
            source_id: sourceId,
            exchange_id: exchangeId,
            market_id: marketId,
            outcome_side: outcomeSide,
            reference_price: metrics.referencePrice ?? undefined,
            band_liquidity_qty_ask: metrics.bandLiquidityQtyAsk ?? undefined,
            band_liquidity_qty_bid: metrics.bandLiquidityQtyBid ?? undefined,
            band_vwap_ask: metrics.bandVwapAsk ?? undefined,
            band_vwap_bid: metrics.bandVwapBid ?? undefined,
            band_delta_used: metrics.bandDeltaUsed ?? undefined,
            entry_time: now,
          };

          marketDataWriter.add(marketData).catch((err) => {
            logger.error({ err }, 'Failed to add market data (band metrics from price_change) to batch');
          });
        }
      }
    } else {
      // No snapshot state - log delta drop (same as Kalshi)
      priceChangeDeltaDrops++;
      if (priceChangeDeltaDrops <= 10 || priceChangeDeltaDrops % 1000 === 0) {
        logger.warn(
          { assetId, drops: priceChangeDeltaDrops },
          'Delta dropped - no snapshot state for asset'
        );
      }
    }

    logger.debug({ assetId, marketId, count: changes.length, deltaApplied }, 'Processed price changes (new format)');
    return;
  }

  // Try old format (before Sept 15, 2025)
  const priceChanges = msg.price_changes as PriceChangeEntryOld[] | undefined;
  if (!priceChanges || !Array.isArray(priceChanges)) {
    logger.debug({ msgKeys: Object.keys(msg) }, 'price_change message with unrecognized format');
    return;
  }

  priceChangeOldFormat++;
  for (const pc of priceChanges) {
    const pcAssetId = pc.asset_id;
    if (!pcAssetId) continue;

    // Lookup outcome side from cache (keyed by clobTokenId)
    const pcOutcomeSide = getOutcomeSide(pcAssetId);

    // Skip if outcome_side not in cache - better to skip than write UNKNOWN
    if (!pcOutcomeSide) {
      logger.warn({ assetId: pcAssetId }, 'Cache miss for outcome_side in handlePriceChange (old format) - skipping record');
      continue;
    }

    // Resolve Gamma market ID from condition_id, fall back to assetId
    const marketId = (conditionId && getGammaMarketId(conditionId)) || pcAssetId;

    // Apply delta to OrderBookManager
    const applied = orderBookManager.applyDelta(
      pcAssetId,
      pc.side.toUpperCase() as 'BUY' | 'SELL',
      parseFloat(pc.price),
      parseFloat(pc.size)
    );

    if (applied) {
      // Only write to DB for matched markets (those in market_mappings used by arb scanner)
      if (isMatchedMarket(marketId)) {
        // Get full accumulated book and write orderbook + band metrics
        const fullBook = orderBookManager.getOrderBook(pcAssetId);
        if (fullBook) {
          const orderBook: OrderBook = {
            source_id: sourceId,
            exchange_id: exchangeId,
            market_id: marketId,
            outcome_side: pcOutcomeSide,
            bids: fullBook.bids,
            asks: fullBook.asks,
            entry_time: now,
          };

          orderBookWriter.add(orderBook).catch((err) => {
            logger.error({ err }, 'Failed to add order book to batch (price_change old format)');
          });

          const metrics = calculateBandMetrics(fullBook.bids, fullBook.asks);

          const marketData: MarketLatestData = {
            source_id: sourceId,
            exchange_id: exchangeId,
            market_id: marketId,
            outcome_side: pcOutcomeSide,
            reference_price: metrics.referencePrice ?? undefined,
            band_liquidity_qty_ask: metrics.bandLiquidityQtyAsk ?? undefined,
            band_liquidity_qty_bid: metrics.bandLiquidityQtyBid ?? undefined,
            band_vwap_ask: metrics.bandVwapAsk ?? undefined,
            band_vwap_bid: metrics.bandVwapBid ?? undefined,
            band_delta_used: metrics.bandDeltaUsed ?? undefined,
            entry_time: now,
          };

          marketDataWriter.add(marketData).catch((err) => {
            logger.error({ err }, 'Failed to add market data to batch');
          });
        }
      }
    } else {
      // No snapshot - write price_close only for matched markets (legacy behavior)
      if (isMatchedMarket(marketId)) {
        const marketData: MarketLatestData = {
          source_id: sourceId,
          exchange_id: exchangeId,
          market_id: marketId,
          outcome_side: pcOutcomeSide,
          price_close: parseFloat(pc.price),
          entry_time: now,
        };

        marketDataWriter.add(marketData).catch((err) => {
          logger.error({ err }, 'Failed to add market data to batch');
        });
      }
    }

    // Also create a quote from best_bid/best_ask if available (only if feature flag enabled)
    if (ENABLE_QUOTE_WRITES && (pc.best_bid || pc.best_ask)) {
      priceChangeOldWithQuotes++;
      const quote: Quote = {
        source_id: sourceId,
        exchange_id: exchangeId,
        market_id: marketId,
        outcome_side: pcOutcomeSide,
        bid: pc.best_bid ? parseFloat(pc.best_bid) : undefined,
        ask: pc.best_ask ? parseFloat(pc.best_ask) : undefined,
        entry_time: now,
      };

      quoteWriter.add(quote).catch((err) => {
        logger.error({ err }, 'Failed to add quote to batch');
      });
    }
  }

  // Log stats every 1000 old format messages
  if (priceChangeOldFormat % 1000 === 0) {
    logger.info({
      newFormat: priceChangeNewFormat,
      oldFormat: priceChangeOldFormat,
      oldWithQuotes: priceChangeOldWithQuotes
    }, 'Price change format stats');
  }

  logger.debug({ count: priceChanges.length }, 'Processed price changes (old format)');
}

function handleLastTradePrice(
  msg: Record<string, unknown>,
  sourceId: string,
  exchangeId: string
): void {
  const assetId = msg.asset_id as string;
  const conditionId = msg.market as string | undefined;
  const price = parseFloat(msg.price as string);
  const size = msg.size ? parseFloat(msg.size as string) : 1;
  const side = msg.side as string | undefined;
  // Use transaction_hash as trade_id for uniqueness
  const tradeId = msg.transaction_hash as string | undefined;
  // Use timestamp from message if available
  const timestamp = msg.timestamp ? new Date(parseInt(msg.timestamp as string)) : new Date();

  // Resolve Gamma market ID from condition_id, fall back to assetId
  const marketId = (conditionId && getGammaMarketId(conditionId)) || assetId;

  // Lookup outcome side (YES/NO) from cache keyed by clobTokenId
  const outcomeSide = getOutcomeSide(assetId);

  const trade: Trade = {
    source_id: sourceId,
    exchange_id: exchangeId,
    market_id: marketId,
    trade_id: tradeId,
    price,
    quantity: size,
    side: side?.toUpperCase() === 'BUY' ? 'Buy' : side?.toUpperCase() === 'SELL' ? 'Sell' : undefined,
    outcome: outcomeSide === 'YES' || outcomeSide === 'NO' ? outcomeSide : undefined,
    entry_time: timestamp,
  };

  tradeWriter.add(trade).catch((err) => {
    logger.error({ err }, 'Failed to add trade to batch');
  });

  logger.debug({ assetId, marketId, price, size }, 'Processed last trade price');
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
