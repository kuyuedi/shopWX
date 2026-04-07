import type pg from 'pg';
import { query, queryWithPool, transaction, getPool } from './client.js';
import type {
  PredictionMarket,
  MarketLatestData,
  OrderBook,
  Quote,
  Trade,
  MarketForMatching,
  MarketMapping,
  MarketTitle,
  ExchangeEvent,
  EventForMatching,
  EventMapping,
  MatchedEventPair,
  ArbConfig,
  MarketLeg,
  ArbOpportunity,
} from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('db-queries');

export async function upsertPredictionMarket(market: PredictionMarket): Promise<void> {
  const sql = `
    INSERT INTO prediction_markets (
      source_id, exchange_id, market_id, event_id, series_id, outcome_side, outcome_name, outcome_type,
      title, sub_title, rules_primary, rules_secondary, category, price, expires_at, status,
      source_specific_data, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), NOW())
    ON CONFLICT (source_id, exchange_id, market_id, outcome_side)
    DO UPDATE SET
      event_id = EXCLUDED.event_id,
      series_id = EXCLUDED.series_id,
      outcome_name = EXCLUDED.outcome_name,
      outcome_type = EXCLUDED.outcome_type,
      title = EXCLUDED.title,
      sub_title = EXCLUDED.sub_title,
      rules_primary = EXCLUDED.rules_primary,
      rules_secondary = EXCLUDED.rules_secondary,
      category = EXCLUDED.category,
      price = EXCLUDED.price,
      expires_at = EXCLUDED.expires_at,
      status = EXCLUDED.status,
      source_specific_data = EXCLUDED.source_specific_data,
      updated_at = NOW()
  `;

  await query(sql, [
    market.source_id,
    market.exchange_id,
    market.market_id,
    market.event_id || null,
    market.series_id || null,
    market.outcome_side,
    market.outcome_name || (market.outcome_side === 'YES' ? 'Yes' : 'No'),
    market.outcome_type || 'Binary',
    market.market_name,
    market.sub_title || null,
    market.rules_primary || null,
    market.rules_secondary || null,
    market.category || null,
    market.price || null,
    market.end_date || null,
    market.status || null,
    market.source_specific_data ? JSON.stringify(market.source_specific_data) : null,
  ]);
}

export async function upsertPredictionMarketsBatch(markets: PredictionMarket[]): Promise<void> {
  if (markets.length === 0) return;

  // Deduplicate: keep only the latest entry for each unique key (source_id, exchange_id, market_id, outcome_side)
  const uniqueMap = new Map<string, PredictionMarket>();
  for (const market of markets) {
    const key = `${market.source_id}|${market.exchange_id}|${market.market_id}|${market.outcome_side}`;
    uniqueMap.set(key, market); // Later entries overwrite earlier ones
  }
  const deduplicated = Array.from(uniqueMap.values());

  // Sort by (market_id, outcome_side) to ensure consistent lock ordering and prevent deadlocks
  const sorted = deduplicated.sort((a, b) =>
    a.market_id.localeCompare(b.market_id) || (a.outcome_side || '').localeCompare(b.outcome_side || '')
  );

  // Build bulk INSERT with multiple VALUES rows
  const values: unknown[] = [];
  const valuePlaceholders: string[] = [];

  sorted.forEach((market, i) => {
    const offset = i * 17;

    valuePlaceholders.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15}, $${offset + 16}, $${offset + 17}, NOW(), NOW())`
    );

    values.push(
      market.source_id,
      market.exchange_id,
      market.market_id,
      market.event_id || null,
      market.series_id || null,
      market.outcome_side,
      market.outcome_name || (market.outcome_side === 'YES' ? 'Yes' : 'No'),
      market.outcome_type || 'Binary',
      market.market_name,
      market.sub_title || null,
      market.rules_primary || null,
      market.rules_secondary || null,
      market.category || null,
      market.price || null,
      market.end_date || null,
      market.status || null,
      market.source_specific_data ? JSON.stringify(market.source_specific_data) : null,
    );
  });

  const sql = `
    INSERT INTO prediction_markets (
      source_id, exchange_id, market_id, event_id, series_id, outcome_side, outcome_name, outcome_type,
      title, sub_title, rules_primary, rules_secondary, category, price, expires_at, status,
      source_specific_data, created_at, updated_at
    ) VALUES ${valuePlaceholders.join(', ')}
    ON CONFLICT (source_id, exchange_id, market_id, outcome_side)
    DO UPDATE SET
      event_id = EXCLUDED.event_id,
      series_id = EXCLUDED.series_id,
      outcome_name = EXCLUDED.outcome_name,
      outcome_type = EXCLUDED.outcome_type,
      title = EXCLUDED.title,
      sub_title = EXCLUDED.sub_title,
      rules_primary = EXCLUDED.rules_primary,
      rules_secondary = EXCLUDED.rules_secondary,
      category = EXCLUDED.category,
      price = EXCLUDED.price,
      expires_at = EXCLUDED.expires_at,
      status = EXCLUDED.status,
      source_specific_data = EXCLUDED.source_specific_data,
      updated_at = NOW()
  `;

  await query(sql, values);
  logger.debug({ count: markets.length }, 'Batch upserted prediction markets');
}

export async function upsertMarketLatestData(data: MarketLatestData): Promise<void> {
  const now = new Date();
  const sql = `
    INSERT INTO market_latest_data (
      source_id, exchange_id, market_id, outcome_side,
      time_period_start, time_period_end, time_open, time_close,
      price_open, price_high, price_low, price_close,
      volume_traded, trades_count,
      reference_price, band_liquidity_qty_ask, band_liquidity_qty_bid,
      band_vwap_ask, band_vwap_bid, band_delta_used,
      created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $21)
    ON CONFLICT (source_id, exchange_id, market_id, outcome_side)
    DO UPDATE SET
      price_open = CASE WHEN EXCLUDED.price_open = 0 THEN market_latest_data.price_open ELSE EXCLUDED.price_open END,
      price_high = GREATEST(EXCLUDED.price_high, market_latest_data.price_high),
      price_low = LEAST(EXCLUDED.price_low, market_latest_data.price_low),
      price_close = CASE WHEN EXCLUDED.price_close = 0 THEN market_latest_data.price_close ELSE EXCLUDED.price_close END,
      volume_traded = CASE WHEN EXCLUDED.volume_traded = 0 THEN market_latest_data.volume_traded ELSE EXCLUDED.volume_traded END,
      trades_count = CASE WHEN EXCLUDED.trades_count = 0 THEN market_latest_data.trades_count ELSE EXCLUDED.trades_count END,
      reference_price = CASE WHEN EXCLUDED.band_delta_used IS NOT NULL THEN EXCLUDED.reference_price ELSE market_latest_data.reference_price END,
      band_liquidity_qty_ask = CASE WHEN EXCLUDED.band_delta_used IS NOT NULL THEN EXCLUDED.band_liquidity_qty_ask ELSE market_latest_data.band_liquidity_qty_ask END,
      band_liquidity_qty_bid = CASE WHEN EXCLUDED.band_delta_used IS NOT NULL THEN EXCLUDED.band_liquidity_qty_bid ELSE market_latest_data.band_liquidity_qty_bid END,
      band_vwap_ask = CASE WHEN EXCLUDED.band_delta_used IS NOT NULL THEN EXCLUDED.band_vwap_ask ELSE market_latest_data.band_vwap_ask END,
      band_vwap_bid = CASE WHEN EXCLUDED.band_delta_used IS NOT NULL THEN EXCLUDED.band_vwap_bid ELSE market_latest_data.band_vwap_bid END,
      band_delta_used = CASE WHEN EXCLUDED.band_delta_used IS NOT NULL THEN EXCLUDED.band_delta_used ELSE market_latest_data.band_delta_used END,
      time_close = EXCLUDED.time_close,
      updated_at = CASE WHEN EXCLUDED.band_delta_used IS NOT NULL THEN EXCLUDED.updated_at ELSE market_latest_data.updated_at END
  `;

  const entryTime = data.entry_time || now;
  await query(sql, [
    data.source_id,
    data.exchange_id,
    data.market_id,
    data.outcome_side || 'UNKNOWN',
    entryTime, // time_period_start
    entryTime, // time_period_end
    entryTime, // time_open
    entryTime, // time_close
    data.price_close ?? 0, // price_open (use close as fallback), default to 0
    data.price_high ?? data.price_close ?? 0,
    data.price_low ?? data.price_close ?? 0,
    data.price_close ?? 0,
    data.volume_traded ?? 0,  // volume_traded has NOT NULL constraint, default to 0
    data.trades_count ?? 0,  // trades_count has NOT NULL constraint, default to 0
    data.reference_price ?? null,
    data.band_liquidity_qty_ask ?? null,
    data.band_liquidity_qty_bid ?? null,
    data.band_vwap_ask ?? null,
    data.band_vwap_bid ?? null,
    data.band_delta_used ?? null,
    entryTime, // created_at and updated_at
  ]);
}

export async function upsertMarketLatestDataBatch(dataList: MarketLatestData[]): Promise<void> {
  if (dataList.length === 0) return;

  const now = new Date();

  // Deduplicate: keep only the latest entry for each unique key (source_id, exchange_id, market_id, outcome_side)
  const uniqueMap = new Map<string, MarketLatestData>();
  for (const data of dataList) {
    const key = `${data.source_id}|${data.exchange_id}|${data.market_id}|${data.outcome_side || 'UNKNOWN'}`;
    const existing = uniqueMap.get(key);
    if (existing) {
      if (data.band_delta_used != null) {
        // New record has band metrics — it wins entirely
        uniqueMap.set(key, data);
      } else if (existing.band_delta_used != null) {
        // New record lacks band metrics but existing has them.
        // Keep band fields from existing, take price from new.
        uniqueMap.set(key, {
          ...existing,
          price_close: data.price_close ?? existing.price_close,
          entry_time: data.entry_time ?? existing.entry_time,
        });
      } else {
        // Neither has band metrics — last write wins
        uniqueMap.set(key, data);
      }
    } else {
      uniqueMap.set(key, data);
    }
  }
  const deduplicated = Array.from(uniqueMap.values());

  // Sort by (market_id, outcome_side) to ensure consistent lock ordering and prevent deadlocks
  const sorted = deduplicated.sort((a, b) =>
    a.market_id.localeCompare(b.market_id) || (a.outcome_side || '').localeCompare(b.outcome_side || '')
  );

  // Build bulk INSERT with multiple VALUES rows
  const values: unknown[] = [];
  const valuePlaceholders: string[] = [];

  sorted.forEach((data, i) => {
    const entryTime = data.entry_time || now;
    const offset = i * 21;

    valuePlaceholders.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15}, $${offset + 16}, $${offset + 17}, $${offset + 18}, $${offset + 19}, $${offset + 20}, $${offset + 21}, $${offset + 21})`
    );

    values.push(
      data.source_id,
      data.exchange_id,
      data.market_id,
      data.outcome_side || 'UNKNOWN',
      entryTime,
      entryTime,
      entryTime,
      entryTime,
      data.price_close ?? 0,
      data.price_high ?? data.price_close ?? 0,
      data.price_low ?? data.price_close ?? 0,
      data.price_close ?? 0,
      data.volume_traded ?? 0,  // volume_traded has NOT NULL constraint, default to 0
      data.trades_count ?? 0,  // trades_count has NOT NULL constraint, default to 0
      data.reference_price ?? null,
      data.band_liquidity_qty_ask ?? null,
      data.band_liquidity_qty_bid ?? null,
      data.band_vwap_ask ?? null,
      data.band_vwap_bid ?? null,
      data.band_delta_used ?? null,
      entryTime, // created_at and updated_at
    );
  });

  const sql = `
    INSERT INTO market_latest_data (
      source_id, exchange_id, market_id, outcome_side,
      time_period_start, time_period_end, time_open, time_close,
      price_open, price_high, price_low, price_close,
      volume_traded, trades_count,
      reference_price, band_liquidity_qty_ask, band_liquidity_qty_bid,
      band_vwap_ask, band_vwap_bid, band_delta_used,
      created_at, updated_at
    ) VALUES ${valuePlaceholders.join(', ')}
    ON CONFLICT (source_id, exchange_id, market_id, outcome_side)
    DO UPDATE SET
      price_open = CASE WHEN EXCLUDED.price_open = 0 THEN market_latest_data.price_open ELSE EXCLUDED.price_open END,
      price_high = GREATEST(EXCLUDED.price_high, market_latest_data.price_high),
      price_low = LEAST(EXCLUDED.price_low, market_latest_data.price_low),
      price_close = CASE WHEN EXCLUDED.price_close = 0 THEN market_latest_data.price_close ELSE EXCLUDED.price_close END,
      volume_traded = CASE WHEN EXCLUDED.volume_traded = 0 THEN market_latest_data.volume_traded ELSE EXCLUDED.volume_traded END,
      trades_count = CASE WHEN EXCLUDED.trades_count = 0 THEN market_latest_data.trades_count ELSE EXCLUDED.trades_count END,
      reference_price = CASE WHEN EXCLUDED.band_delta_used IS NOT NULL THEN EXCLUDED.reference_price ELSE market_latest_data.reference_price END,
      band_liquidity_qty_ask = CASE WHEN EXCLUDED.band_delta_used IS NOT NULL THEN EXCLUDED.band_liquidity_qty_ask ELSE market_latest_data.band_liquidity_qty_ask END,
      band_liquidity_qty_bid = CASE WHEN EXCLUDED.band_delta_used IS NOT NULL THEN EXCLUDED.band_liquidity_qty_bid ELSE market_latest_data.band_liquidity_qty_bid END,
      band_vwap_ask = CASE WHEN EXCLUDED.band_delta_used IS NOT NULL THEN EXCLUDED.band_vwap_ask ELSE market_latest_data.band_vwap_ask END,
      band_vwap_bid = CASE WHEN EXCLUDED.band_delta_used IS NOT NULL THEN EXCLUDED.band_vwap_bid ELSE market_latest_data.band_vwap_bid END,
      band_delta_used = CASE WHEN EXCLUDED.band_delta_used IS NOT NULL THEN EXCLUDED.band_delta_used ELSE market_latest_data.band_delta_used END,
      time_close = EXCLUDED.time_close,
      updated_at = CASE WHEN EXCLUDED.band_delta_used IS NOT NULL THEN EXCLUDED.updated_at ELSE market_latest_data.updated_at END
  `;

  await query(sql, values);
  logger.debug({ count: dataList.length }, 'Batch upserted market latest data');
}

export async function insertOrderBook(orderBook: OrderBook): Promise<void> {
  const now = new Date();
  const sql = `
    INSERT INTO order_books (
      source_id, exchange_id, market_id, outcome_side, bids, asks,
      time_exchange, time_coinapi, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
    ON CONFLICT (source_id, exchange_id, market_id, outcome_side, time_exchange) DO NOTHING
  `;

  await query(sql, [
    orderBook.source_id,
    orderBook.exchange_id,
    orderBook.market_id,
    orderBook.outcome_side || 'UNKNOWN',
    JSON.stringify(orderBook.bids),
    JSON.stringify(orderBook.asks),
    orderBook.entry_time,
    now,
  ]);
}

export async function insertOrderBooksBatch(orderBooks: OrderBook[]): Promise<void> {
  if (orderBooks.length === 0) return;

  // Sort by market_id to ensure consistent lock ordering and prevent deadlocks
  const sorted = [...orderBooks].sort((a, b) => a.market_id.localeCompare(b.market_id));

  const now = new Date();
  const values: unknown[] = [];
  const placeholders: string[] = [];

  sorted.forEach((ob, i) => {
    const offset = i * 8;
    placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, NOW(), NOW())`);
    values.push(
      ob.source_id,
      ob.exchange_id,
      ob.market_id,
      ob.outcome_side || 'UNKNOWN',
      JSON.stringify(ob.bids),
      JSON.stringify(ob.asks),
      ob.entry_time,
      now
    );
  });

  const sql = `
    INSERT INTO order_books (source_id, exchange_id, market_id, outcome_side, bids, asks, time_exchange, time_coinapi, created_at, updated_at)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (source_id, exchange_id, market_id, outcome_side, time_exchange) DO NOTHING
  `;

  await query(sql, values);
  logger.debug({ count: orderBooks.length }, 'Batch inserted order books');
}

export async function insertQuote(quote: Quote): Promise<void> {
  const now = new Date();
  const sql = `
    INSERT INTO quotes (
      source_id, exchange_id, market_id, outcome_side, bid, bid_volume, ask, ask_volume,
      entry_time, recv_time, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
    ON CONFLICT (source_id, exchange_id, market_id, entry_time) DO NOTHING
  `;

  await query(sql, [
    quote.source_id,
    quote.exchange_id,
    quote.market_id,
    quote.outcome_side || 'UNKNOWN',
    quote.bid || 0,
    quote.bid_size || 0,
    quote.ask || 0,
    quote.ask_size || 0,
    quote.entry_time,
    now,
  ]);
}

export async function insertQuotesBatch(quotes: Quote[]): Promise<void> {
  if (quotes.length === 0) return;

  // Sort by market_id to ensure consistent lock ordering and prevent deadlocks
  const sorted = [...quotes].sort((a, b) => a.market_id.localeCompare(b.market_id));

  const now = new Date();
  const values: unknown[] = [];
  const placeholders: string[] = [];

  sorted.forEach((q, i) => {
    const offset = i * 10;
    placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, NOW(), NOW())`);
    values.push(
      q.source_id,
      q.exchange_id,
      q.market_id,
      q.outcome_side || 'UNKNOWN',
      q.bid || 0,
      q.bid_size || 0,
      q.ask || 0,
      q.ask_size || 0,
      q.entry_time,
      now
    );
  });

  const sql = `
    INSERT INTO quotes (source_id, exchange_id, market_id, outcome_side, bid, bid_volume, ask, ask_volume, entry_time, recv_time, created_at, updated_at)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (source_id, exchange_id, market_id, entry_time) DO NOTHING
  `;

  await query(sql, values);
  logger.debug({ count: quotes.length }, 'Batch inserted quotes');
}

export async function insertTrade(trade: Trade): Promise<void> {
  const sql = `
    INSERT INTO trades (
      source_id, exchange_id, market_id, trade_id, price, quantity, side, outcome, timestamp, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
    ON CONFLICT (source_id, exchange_id, trade_id, timestamp) DO NOTHING
  `;

  await query(sql, [
    trade.source_id,
    trade.exchange_id,
    trade.market_id,
    trade.trade_id || '',
    trade.price,
    trade.quantity,
    trade.side || null,
    trade.outcome || null,
    trade.entry_time,
  ]);
}

export async function insertTradesBatch(trades: Trade[]): Promise<void> {
  if (trades.length === 0) return;

  // Sort by market_id to ensure consistent lock ordering and prevent deadlocks
  const sorted = [...trades].sort((a, b) => a.market_id.localeCompare(b.market_id));

  const values: unknown[] = [];
  const placeholders: string[] = [];

  sorted.forEach((t, i) => {
    const offset = i * 9;
    placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, NOW(), NOW())`);
    values.push(
      t.source_id,
      t.exchange_id,
      t.market_id,
      t.trade_id || '',
      t.price,
      t.quantity,
      t.side || null,
      t.outcome || null,
      t.entry_time
    );
  });

  const sql = `
    INSERT INTO trades (source_id, exchange_id, market_id, trade_id, price, quantity, side, outcome, timestamp, created_at, updated_at)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (source_id, exchange_id, trade_id, timestamp) DO NOTHING
  `;

  await query(sql, values);
  logger.debug({ count: trades.length }, 'Batch inserted trades');
}

/**
 * Get trade counts for the last 24 hours grouped by market
 * Returns a Map of market_id -> trade_count
 */
export async function getTradeCounts24h(
  sourceId: string,
  exchangeId: string
): Promise<Map<string, number>> {
  const sql = `
    SELECT market_id, COUNT(*)::int as trade_count
    FROM trades
    WHERE source_id = $1
      AND exchange_id = $2
      AND timestamp > NOW() - INTERVAL '24 hours'
    GROUP BY market_id
  `;

  const result = await query(sql, [sourceId, exchangeId]);
  const tradeCounts = new Map<string, number>();

  for (const row of result.rows) {
    tradeCounts.set(row.market_id, row.trade_count);
  }

  logger.debug({
    sourceId,
    exchangeId,
    marketsWithTrades: tradeCounts.size
  }, 'Fetched 24h trade counts');

  return tradeCounts;
}

/**
 * Mark stale "Open" markets as "Closed".
 * Any market with status='Open' whose updated_at is before syncStartTime
 * was not refreshed during the latest sync — meaning it's no longer in the active API response.
 * Returns the number of rows updated.
 */
export async function markStaleMarketsAsClosed(
  sourceId: string,
  exchangeId: string,
  syncStartTime: Date
): Promise<number> {
  const sql = `
    UPDATE prediction_markets
    SET status = 'Closed', updated_at = NOW()
    WHERE source_id = $1
      AND exchange_id = $2
      AND status = 'Open'
      AND updated_at < $3
  `;

  const result = await query(sql, [sourceId, exchangeId, syncStartTime]);
  const count = result.rowCount ?? 0;

  if (count > 0) {
    logger.info({ sourceId, exchangeId, markedClosed: count }, 'Marked stale markets as closed');
  } else {
    logger.debug({ sourceId, exchangeId }, 'No stale markets to mark as closed');
  }

  return count;
}

/**
 * Backfill prediction_markets.price for Predict markets using market_latest_data.
 * Uses reference_price (orderbook midpoint), falling back to band_vwap_bid.
 * Only updates rows where the price has actually changed.
 */
export async function backfillPredictPrices(
  sourceId: string,
  exchangeId: string
): Promise<number> {
  const sql = `
    UPDATE direct_exchanges_data.prediction_markets pm
    SET price = COALESCE(mld.reference_price, mld.band_vwap_bid),
        updated_at = NOW()
    FROM direct_exchanges_data.market_latest_data mld
    WHERE pm.source_id = mld.source_id
      AND pm.exchange_id = mld.exchange_id
      AND pm.market_id = mld.market_id
      AND pm.outcome_side = mld.outcome_side
      AND pm.source_id = $1
      AND pm.exchange_id = $2
      AND pm.price IS DISTINCT FROM COALESCE(mld.reference_price, mld.band_vwap_bid)
      AND COALESCE(mld.reference_price, mld.band_vwap_bid) IS NOT NULL
  `;

  const result = await query(sql, [sourceId, exchangeId]);
  return result.rowCount ?? 0;
}

/**
 * Delete closed/resolved/cancelled markets older than the retention period.
 * Deletes market_latest_data first (same composite key), then prediction_markets.
 * Uses batched deletes (default 1000 rows) to avoid lock contention.
 */
export async function deleteClosedMarkets(
  sourceId: string,
  exchangeId: string,
  retentionMs: number,
  batchSize: number = 1000
): Promise<{ marketsDeleted: number; latestDataDeleted: number }> {
  const cutoffDate = new Date(Date.now() - retentionMs);
  let marketsDeleted = 0;
  let latestDataDeleted = 0;

  // Phase 1: Delete market_latest_data rows for closed markets
  let deletedInBatch: number;
  do {
    const latestDataSql = `
      DELETE FROM market_latest_data
      WHERE ctid IN (
        SELECT mld.ctid
        FROM market_latest_data mld
        INNER JOIN prediction_markets pm
          ON mld.source_id = pm.source_id
          AND mld.exchange_id = pm.exchange_id
          AND mld.market_id = pm.market_id
          AND mld.outcome_side = pm.outcome_side
        WHERE pm.source_id = $1
          AND pm.exchange_id = $2
          AND pm.status IN ('Closed', 'Resolved', 'Cancelled')
          AND pm.updated_at < $3
        LIMIT $4
      )
    `;

    const result = await query(latestDataSql, [sourceId, exchangeId, cutoffDate, batchSize]);
    deletedInBatch = result.rowCount ?? 0;
    latestDataDeleted += deletedInBatch;
  } while (deletedInBatch >= batchSize);

  // Phase 2: Delete prediction_markets rows
  do {
    const marketsSql = `
      DELETE FROM prediction_markets
      WHERE ctid IN (
        SELECT ctid
        FROM prediction_markets
        WHERE source_id = $1
          AND exchange_id = $2
          AND status IN ('Closed', 'Resolved', 'Cancelled')
          AND updated_at < $3
        LIMIT $4
      )
    `;

    const result = await query(marketsSql, [sourceId, exchangeId, cutoffDate, batchSize]);
    deletedInBatch = result.rowCount ?? 0;
    marketsDeleted += deletedInBatch;
  } while (deletedInBatch >= batchSize);

  if (marketsDeleted > 0 || latestDataDeleted > 0) {
    logger.info({
      sourceId,
      exchangeId,
      marketsDeleted,
      latestDataDeleted,
      retentionMs,
    }, 'Closed market cleanup completed');
  } else {
    logger.debug({ sourceId, exchangeId }, 'No closed markets to clean up');
  }

  return { marketsDeleted, latestDataDeleted };
}

/**
 * Delete closed events older than the retention period.
 * Uses batched deletes to avoid lock contention.
 */
export async function deleteClosedEvents(
  sourceId: string,
  exchangeId: string,
  retentionMs: number,
  batchSize: number = 1000
): Promise<number> {
  const cutoffDate = new Date(Date.now() - retentionMs);
  let eventsDeleted = 0;

  let deletedInBatch: number;
  do {
    const sql = `
      DELETE FROM events
      WHERE ctid IN (
        SELECT ctid
        FROM events
        WHERE source_id = $1
          AND exchange_id = $2
          AND status = 'Closed'
          AND updated_at < $3
        LIMIT $4
      )
    `;

    const result = await query(sql, [sourceId, exchangeId, cutoffDate, batchSize]);
    deletedInBatch = result.rowCount ?? 0;
    eventsDeleted += deletedInBatch;
  } while (deletedInBatch >= batchSize);

  if (eventsDeleted > 0) {
    logger.info({
      sourceId,
      exchangeId,
      eventsDeleted,
      retentionMs,
    }, 'Closed event cleanup completed');
  } else {
    logger.debug({ sourceId, exchangeId }, 'No closed events to clean up');
  }

  return eventsDeleted;
}

/**
 * Fetch open markets for matching by exchange, source, category, and outcome side.
 */
export async function fetchMarketsForMatching(
  exchangeId: string,
  sourceId: string,
  category: string,
  outcomeSide: 'YES' | 'NO'
): Promise<MarketForMatching[]> {
  const sql = `
    SELECT source_id, exchange_id, market_id, outcome_side, outcome_name,
           title, sub_title, rules_primary, category, price, expires_at, status
    FROM prediction_markets
    WHERE exchange_id = $1
      AND source_id = $2
      AND category = $3
      AND outcome_side = $4
      AND status = 'Open'
  `;

  const result = await query<MarketForMatching>(sql, [exchangeId, sourceId, category, outcomeSide]);
  logger.debug({ exchangeId, category, outcomeSide, count: result.rows.length }, 'Fetched markets for matching');
  return result.rows;
}

/**
 * Fetch all open markets for matching by exchange, source, and outcome side (no category filter).
 */
export async function fetchAllMarketsForMatching(
  exchangeId: string,
  sourceId: string,
  outcomeSide: 'YES' | 'NO'
): Promise<MarketForMatching[]> {
  const sql = `
    SELECT source_id, exchange_id, market_id, outcome_side, outcome_name,
           title, sub_title, rules_primary, category, price, expires_at, status
    FROM prediction_markets
    WHERE exchange_id = $1
      AND source_id = $2
      AND outcome_side = $3
      AND status = 'Open'
  `;

  const result = await query<MarketForMatching>(sql, [exchangeId, sourceId, outcomeSide]);
  logger.debug({ exchangeId, outcomeSide, count: result.rows.length }, 'Fetched all markets for matching');
  return result.rows;
}

/**
 * Fetch existing mapped market IDs.
 * Returns a Set for O(1) lookup. No side filter — a match covers both YES and NO.
 */
export async function fetchExistingMappedMarketIds(): Promise<Set<string>> {
  const sql = `
    SELECT DISTINCT market_id
    FROM market_mappings
  `;

  const result = await query<{ market_id: string }>(sql);
  const ids = new Set<string>();
  for (const row of result.rows) {
    ids.add(row.market_id);
  }
  logger.debug({ count: ids.size }, 'Fetched existing mapped market IDs');
  return ids;
}

/**
 * Fetch market IDs that are already matched between a specific pair of exchanges.
 * Returns two sets: source market IDs matched to the target, and target market IDs matched to the source.
 * A market matched to a different exchange is NOT excluded.
 */
export async function fetchMappedMarketIdsForPair(
  sourceExchangeId: string,
  targetExchangeId: string
): Promise<{ sourceIds: Set<string>; targetIds: Set<string> }> {
  const sql = `
    SELECT DISTINCT a.market_id as source_market, b.market_id as target_market
    FROM market_mappings a
    JOIN market_mappings b ON a.canonical_market_id = b.canonical_market_id
    WHERE a.exchange_id = $1 AND b.exchange_id = $2
      AND a.outcome_side = 'YES' AND b.outcome_side = 'YES'
  `;
  const result = await query<{ source_market: string; target_market: string }>(
    sql, [sourceExchangeId, targetExchangeId]
  );

  const sourceIds = new Set<string>();
  const targetIds = new Set<string>();
  for (const row of result.rows) {
    sourceIds.add(row.source_market);
    targetIds.add(row.target_market);
  }
  return { sourceIds, targetIds };
}

/**
 * Batch upsert market mappings.
 * Follows existing dedup -> sort -> multi-row pattern.
 */
export async function upsertMarketMappingsBatch(mappings: MarketMapping[]): Promise<void> {
  if (mappings.length === 0) return;

  // Deduplicate: keep latest entry per unique key
  const uniqueMap = new Map<string, MarketMapping>();
  for (const mapping of mappings) {
    const key = `${mapping.source_id}|${mapping.exchange_id}|${mapping.market_id}|${mapping.outcome_side}`;
    uniqueMap.set(key, mapping);
  }
  const deduplicated = Array.from(uniqueMap.values());

  // Sort by market_id to prevent deadlocks
  const sorted = deduplicated.sort((a, b) =>
    a.market_id.localeCompare(b.market_id) || a.outcome_side.localeCompare(b.outcome_side)
  );

  const values: unknown[] = [];
  const valuePlaceholders: string[] = [];

  sorted.forEach((m, i) => {
    const offset = i * 9;
    valuePlaceholders.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`
    );
    values.push(
      m.source_id,
      m.exchange_id,
      m.market_id,
      m.outcome_side,
      m.canonical_market_id,
      m.confidence_score,
      m.matched_at,
      m.model_id,
      m.match_version
    );
  });

  const sql = `
    INSERT INTO market_mappings (
      source_id, exchange_id, market_id, outcome_side, canonical_market_id,
      confidence_score, matched_at, model_id, match_version
    ) VALUES ${valuePlaceholders.join(', ')}
    ON CONFLICT (source_id, exchange_id, market_id, outcome_side)
    DO UPDATE SET
      canonical_market_id = EXCLUDED.canonical_market_id,
      confidence_score = EXCLUDED.confidence_score,
      matched_at = EXCLUDED.matched_at,
      model_id = EXCLUDED.model_id,
      match_version = EXCLUDED.match_version,
      updated_at = NOW()
  `;

  await query(sql, values);
  logger.debug({ count: mappings.length }, 'Batch upserted market mappings');
}

/**
 * Insert a canonical_markets row (required as FK parent for market_mappings).
 * Uses ON CONFLICT DO NOTHING since the ID is deterministic.
 */
export async function upsertCanonicalMarket(canonicalMarketId: string): Promise<void> {
  const sql = `
    INSERT INTO canonical_markets (
      canonical_market_id, canonical_event_id, predicate, expiry_time, resolution_source
    ) VALUES ($1, $1, 'auto-matched', NOW() + INTERVAL '1 year', 'market-matcher')
    ON CONFLICT (canonical_market_id) DO NOTHING
  `;
  await query(sql, [canonicalMarketId]);
}

/**
 * Upsert a generated title for a matched market pair.
 */
export async function upsertMarketTitle(
  canonicalMarketId: string,
  generatedTitle: string,
  kalshiTitle: string,
  polymarketTitle: string,
  modelId: string
): Promise<void> {
  const sql = `
    INSERT INTO market_titles
      (canonical_market_id, generated_title, kalshi_title, polymarket_title, model_id, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (canonical_market_id) DO UPDATE SET
      generated_title = EXCLUDED.generated_title,
      kalshi_title = EXCLUDED.kalshi_title,
      polymarket_title = EXCLUDED.polymarket_title,
      model_id = EXCLUDED.model_id,
      updated_at = NOW()
  `;
  await query(sql, [canonicalMarketId, generatedTitle, kalshiTitle, polymarketTitle, modelId]);
}

/**
 * Check if a title already exists for a canonical market ID.
 */
export async function checkExistingTitle(canonicalMarketId: string): Promise<boolean> {
  const sql = `
    SELECT 1 FROM market_titles WHERE canonical_market_id = $1 LIMIT 1
  `;
  const result = await query(sql, [canonicalMarketId]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Fetch matched markets with combined metrics for score computation.
 * @param recentWindowMinutes - Window for recent trades (default 10 minutes per Spec V1)
 */
export async function fetchMatchedMarketsRawData(recentWindowMinutes: number = 10): Promise<pg.QueryResult> {
  const sql = `
    WITH matched_pairs AS (
      SELECT
        mm.canonical_market_id,
        COALESCE(
          MAX(CASE WHEN mm.exchange_id = 'KALSHI' THEN pm.title END),
          MAX(pm.title)
        ) AS kalshi_title,
        MAX(CASE WHEN mm.exchange_id = 'KALSHI' THEN pm.category END) AS category,
        MAX(pm.event_id) AS event_id,
        MIN(pm.expires_at) AS end_date,
        MAX(pm.updated_at) AS updated_at,
        MAX(pm.status) AS status
      FROM market_mappings mm
      JOIN prediction_markets pm
        ON mm.source_id = pm.source_id
        AND mm.exchange_id = pm.exchange_id
        AND mm.market_id = pm.market_id
        AND mm.outcome_side = pm.outcome_side
      WHERE mm.outcome_side = 'YES'
        AND pm.status = 'Open'
      GROUP BY mm.canonical_market_id
    ),
    matched_depth AS (
      SELECT
        mm.canonical_market_id,
        MAX((COALESCE(mld.band_liquidity_qty_bid, 0) + COALESCE(mld.band_liquidity_qty_ask, 0)) / 2.0) AS avg_band_liquidity
      FROM market_mappings mm
      JOIN market_latest_data mld
        ON mm.source_id = mld.source_id
        AND mm.exchange_id = mld.exchange_id
        AND mm.market_id = mld.market_id
        AND mm.outcome_side = mld.outcome_side
      WHERE mm.outcome_side = 'YES'
      GROUP BY mm.canonical_market_id
    ),
    matched_volume AS (
      SELECT
        mm.canonical_market_id,
        SUM(COALESCE(mld.volume_traded, 0))::double precision AS volume_24h
      FROM market_mappings mm
      JOIN market_latest_data mld
        ON mm.source_id = mld.source_id
        AND mm.exchange_id = mld.exchange_id
        AND mm.market_id = mld.market_id
        AND mm.outcome_side = mld.outcome_side
      WHERE mm.outcome_side = 'YES'
      GROUP BY mm.canonical_market_id
    ),
    matched_trades AS (
      SELECT
        mm.canonical_market_id,
        SUM(t.price * t.quantity) AS notional_recent
      FROM market_mappings mm
      JOIN trades t
        ON mm.source_id = t.source_id
        AND mm.exchange_id = t.exchange_id
        AND mm.market_id = t.market_id
      WHERE mm.outcome_side = 'YES'
        AND t.timestamp > NOW() - INTERVAL '1 minute' * $1
      GROUP BY mm.canonical_market_id
    )
    SELECT
      mp.canonical_market_id AS id,
      COALESCE(mt.notional_recent, 0)::double precision AS notional_recent,
      COALESCE(md.avg_band_liquidity, 0)::double precision AS depth,
      COALESCE(mv.volume_24h, 0)::double precision AS volume_24h,
      mp.category,
      true AS is_matched,
      mp.canonical_market_id,
      NULL::varchar AS exchange_id,
      NULL::varchar AS source_id,
      NULL::varchar AS market_id,
      mp.event_id,
      'YES' AS outcome_side,
      mp.kalshi_title AS title,
      mp.end_date,
      mp.updated_at,
      mp.status
    FROM matched_pairs mp
    LEFT JOIN matched_depth md ON mp.canonical_market_id = md.canonical_market_id
    LEFT JOIN matched_volume mv ON mp.canonical_market_id = mv.canonical_market_id
    LEFT JOIN matched_trades mt ON mp.canonical_market_id = mt.canonical_market_id
  `;

  return query(sql, [recentWindowMinutes]);
}

/**
 * Fetch unmatched markets with metrics for score computation.
 * @param recentWindowMinutes - Window for recent trades (default 10 minutes per Spec V1)
 */
export async function fetchUnmatchedMarketsRawData(recentWindowMinutes: number = 10): Promise<pg.QueryResult> {
  const sql = `
    WITH mapped_ids AS (
      SELECT DISTINCT source_id, exchange_id, market_id, outcome_side
      FROM market_mappings
    )
    SELECT
      LEFT(pm.exchange_id, 2) || ':' || pm.market_id AS id,
      COALESCE(ut.notional_recent, 0)::double precision AS notional_recent,
      ((COALESCE(mld.band_liquidity_qty_bid, 0) + COALESCE(mld.band_liquidity_qty_ask, 0)) / 2.0)::double precision AS depth,
      COALESCE(mld.volume_traded, 0)::double precision AS volume_24h,
      pm.category,
      false AS is_matched,
      NULL::varchar AS canonical_market_id,
      pm.exchange_id,
      pm.source_id,
      pm.market_id,
      pm.event_id,
      pm.outcome_side::varchar,
      pm.title,
      pm.expires_at AS end_date,
      pm.updated_at,
      pm.status
    FROM prediction_markets pm
    LEFT JOIN mapped_ids mi
      ON pm.source_id = mi.source_id
      AND pm.exchange_id = mi.exchange_id
      AND pm.market_id = mi.market_id
      AND pm.outcome_side = mi.outcome_side
    LEFT JOIN market_latest_data mld
      ON pm.source_id = mld.source_id
      AND pm.exchange_id = mld.exchange_id
      AND pm.market_id = mld.market_id
      AND pm.outcome_side = mld.outcome_side
    LEFT JOIN (
      SELECT source_id, exchange_id, market_id,
             SUM(price * quantity)::double precision AS notional_recent
      FROM trades
      WHERE timestamp > NOW() - INTERVAL '1 minute' * $1
      GROUP BY source_id, exchange_id, market_id
    ) ut ON pm.source_id = ut.source_id
      AND pm.exchange_id = ut.exchange_id
      AND pm.market_id = ut.market_id
    WHERE mi.source_id IS NULL
      AND pm.outcome_side = 'YES'
      AND pm.status = 'Open'
  `;

  return query(sql, [recentWindowMinutes]);
}

/**
 * Batch upsert events.
 * Follows existing dedup -> sort -> multi-row pattern.
 */
export async function upsertEventsBatch(events: ExchangeEvent[]): Promise<void> {
  if (events.length === 0) return;

  // Deduplicate: keep latest entry per unique key (source_id, exchange_id, event_id)
  const uniqueMap = new Map<string, ExchangeEvent>();
  for (const event of events) {
    const key = `${event.source_id}|${event.exchange_id}|${event.event_id}`;
    uniqueMap.set(key, event);
  }
  const deduplicated = Array.from(uniqueMap.values());

  // Sort by event_id to ensure consistent lock ordering and prevent deadlocks
  const sorted = deduplicated.sort((a, b) => a.event_id.localeCompare(b.event_id));

  const values: unknown[] = [];
  const valuePlaceholders: string[] = [];

  sorted.forEach((event, i) => {
    const offset = i * 13;
    valuePlaceholders.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, NOW(), NOW())`
    );
    values.push(
      event.source_id,
      event.exchange_id,
      event.event_id,
      event.title || null,
      event.subtitle || null,
      event.category || null,
      event.series_id || null,
      event.status || 'Open',
      event.end_date || null,
      event.image_url || null,
      event.mutually_exclusive ?? null,
      event.market_count ?? null,
      event.source_specific_data ? JSON.stringify(event.source_specific_data) : null,
    );
  });

  const sql = `
    INSERT INTO events (
      source_id, exchange_id, event_id, title, subtitle, category, series_id,
      status, end_date, image_url, mutually_exclusive, market_count,
      source_specific_data, created_at, updated_at
    ) VALUES ${valuePlaceholders.join(', ')}
    ON CONFLICT (source_id, exchange_id, event_id)
    DO UPDATE SET
      title = EXCLUDED.title,
      subtitle = EXCLUDED.subtitle,
      category = EXCLUDED.category,
      series_id = EXCLUDED.series_id,
      status = EXCLUDED.status,
      end_date = EXCLUDED.end_date,
      image_url = EXCLUDED.image_url,
      mutually_exclusive = EXCLUDED.mutually_exclusive,
      market_count = EXCLUDED.market_count,
      source_specific_data = EXCLUDED.source_specific_data,
      updated_at = NOW()
  `;

  await query(sql, values);
  logger.debug({ count: events.length }, 'Batch upserted events');
}

/**
 * Mark stale "Open" events as "Closed".
 * Any event with status='Open' whose updated_at is before syncStartTime
 * was not refreshed during the latest sync — meaning it's no longer in the active API response.
 * Returns the number of rows updated.
 */
export async function markStaleEventsAsClosed(
  sourceId: string,
  exchangeId: string,
  syncStartTime: Date
): Promise<number> {
  const sql = `
    UPDATE events
    SET status = 'Closed', updated_at = NOW()
    WHERE source_id = $1
      AND exchange_id = $2
      AND status = 'Open'
      AND updated_at < $3
  `;

  const result = await query(sql, [sourceId, exchangeId, syncStartTime]);
  const count = result.rowCount ?? 0;

  if (count > 0) {
    logger.info({ sourceId, exchangeId, markedClosed: count }, 'Marked stale events as closed');
  } else {
    logger.debug({ sourceId, exchangeId }, 'No stale events to mark as closed');
  }

  return count;
}

/**
 * Fetch open events for matching, with aggregated market liquidity data.
 * Results are sorted by total_volume DESC so the most liquid events are matched first.
 */
export async function fetchOpenEventsForMatching(
  exchangeId: string,
  sourceId: string
): Promise<EventForMatching[]> {
  const sql = `
    SELECT
      e.source_id,
      e.exchange_id,
      e.event_id,
      e.title,
      e.subtitle,
      e.category,
      e.end_date,
      e.market_count,
      e.match_checked_at,
      COALESCE(SUM(mld.volume_traded), 0)::double precision AS total_volume,
      COALESCE(SUM(mld.trades_count), 0)::double precision AS total_trades
    FROM events e
    LEFT JOIN prediction_markets pm
      ON e.source_id = pm.source_id
      AND e.exchange_id = pm.exchange_id
      AND e.event_id = pm.event_id
      AND pm.outcome_side = 'YES'
      AND pm.status = 'Open'
    LEFT JOIN market_latest_data mld
      ON pm.source_id = mld.source_id
      AND pm.exchange_id = mld.exchange_id
      AND pm.market_id = mld.market_id
      AND pm.outcome_side = mld.outcome_side
    WHERE e.exchange_id = $1
      AND e.source_id = $2
      AND e.status = 'Open'
    GROUP BY e.source_id, e.exchange_id, e.event_id, e.title, e.subtitle,
             e.category, e.end_date, e.market_count, e.match_checked_at
    ORDER BY total_volume DESC
  `;

  const result = await query<EventForMatching>(sql, [exchangeId, sourceId]);
  logger.debug({ exchangeId, count: result.rows.length }, 'Fetched open events for matching');
  return result.rows;
}

/**
 * Fetch existing mapped event IDs.
 * Returns a Set of composite keys "exchange_id:event_id" for O(1) lookup.
 */
export async function fetchExistingMappedEventIds(): Promise<Set<string>> {
  const sql = `
    SELECT DISTINCT exchange_id, event_id
    FROM event_mappings
    WHERE is_active = TRUE
  `;

  const result = await query<{ exchange_id: string; event_id: string }>(sql);
  const ids = new Set<string>();
  for (const row of result.rows) {
    ids.add(`${row.exchange_id}:${row.event_id}`);
  }
  logger.debug({ count: ids.size }, 'Fetched existing mapped event IDs');
  return ids;
}

/**
 * Fetch event IDs that are already matched between a specific pair of exchanges.
 * Returns two sets: source event IDs matched to the target, and target event IDs matched to the source.
 * This is pair-aware — an event matched to a different exchange is NOT excluded.
 */
export async function fetchMappedEventIdsForPair(
  sourceExchangeId: string,
  targetExchangeId: string
): Promise<{ sourceIds: Set<string>; targetIds: Set<string> }> {
  const sql = `
    SELECT DISTINCT a.exchange_id as source_exchange, a.event_id as source_event,
           b.exchange_id as target_exchange, b.event_id as target_event
    FROM event_mappings a
    JOIN event_mappings b ON a.canonical_event_id = b.canonical_event_id
    WHERE a.exchange_id = $1 AND b.exchange_id = $2
      AND a.is_active = TRUE AND b.is_active = TRUE
  `;
  const result = await query<{
    source_exchange: string; source_event: string;
    target_exchange: string; target_event: string;
  }>(sql, [sourceExchangeId, targetExchangeId]);

  const sourceIds = new Set<string>();
  const targetIds = new Set<string>();
  for (const row of result.rows) {
    sourceIds.add(`${row.source_exchange}:${row.source_event}`);
    targetIds.add(`${row.target_exchange}:${row.target_event}`);
  }
  logger.debug({ sourceIds: sourceIds.size, targetIds: targetIds.size, sourceExchangeId, targetExchangeId }, 'Fetched mapped event IDs for pair');
  return { sourceIds, targetIds };
}

/**
 * Find the canonical_event_id for an event that already belongs to a canonical group.
 * Used for transitive grouping: if event A is already in a group, reuse that group ID.
 */
export async function findExistingCanonicalEventId(
  sourceId: string,
  exchangeId: string,
  eventId: string
): Promise<string | null> {
  const sql = `
    SELECT canonical_event_id FROM event_mappings
    WHERE source_id = $1 AND exchange_id = $2 AND event_id = $3 AND is_active = TRUE
    LIMIT 1
  `;
  const result = await query<{ canonical_event_id: string }>(sql, [sourceId, exchangeId, eventId]);
  return result.rows[0]?.canonical_event_id ?? null;
}

/**
 * Find the canonical_market_id for a market that already belongs to a canonical group.
 * Used for transitive grouping across exchange pairs.
 */
export async function findExistingCanonicalMarketId(
  sourceId: string,
  exchangeId: string,
  marketId: string,
  outcomeSide: 'YES' | 'NO' = 'YES'
): Promise<string | null> {
  const sql = `
    SELECT canonical_market_id FROM market_mappings
    WHERE source_id = $1 AND exchange_id = $2 AND market_id = $3 AND outcome_side = $4
    LIMIT 1
  `;
  const result = await query<{ canonical_market_id: string }>(sql, [sourceId, exchangeId, marketId, outcomeSide]);
  return result.rows[0]?.canonical_market_id ?? null;
}

/**
 * Upsert a market title with per-exchange title storage via exchange_titles JSONB.
 * Also populates legacy kalshi_title/polymarket_title columns for backward compat.
 */
export async function upsertMarketTitleWithExchanges(
  canonicalMarketId: string,
  generatedTitle: string,
  exchangeTitles: Record<string, string>,
  modelId: string
): Promise<void> {
  const kalshiTitle = exchangeTitles['KALSHI'] || null;
  const polymarketTitle = exchangeTitles['POLYMARKET'] || null;

  const sql = `
    INSERT INTO market_titles
      (canonical_market_id, generated_title, kalshi_title, polymarket_title, exchange_titles, model_id, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (canonical_market_id) DO UPDATE SET
      generated_title = EXCLUDED.generated_title,
      kalshi_title = COALESCE(EXCLUDED.kalshi_title, market_titles.kalshi_title),
      polymarket_title = COALESCE(EXCLUDED.polymarket_title, market_titles.polymarket_title),
      exchange_titles = market_titles.exchange_titles || EXCLUDED.exchange_titles,
      model_id = EXCLUDED.model_id,
      updated_at = NOW()
  `;
  await query(sql, [canonicalMarketId, generatedTitle, kalshiTitle, polymarketTitle, JSON.stringify(exchangeTitles), modelId]);
}

/**
 * Mark an event as checked for matching (no match found).
 * Used to avoid re-checking the same event every cycle.
 */
export async function updateEventMatchCheckedAt(
  sourceId: string,
  exchangeId: string,
  eventId: string
): Promise<void> {
  const sql = `
    UPDATE events
    SET match_checked_at = NOW()
    WHERE source_id = $1 AND exchange_id = $2 AND event_id = $3
  `;
  await query(sql, [sourceId, exchangeId, eventId]);
}

/**
 * Batch upsert event mappings.
 * Follows existing dedup -> sort -> multi-row pattern.
 */
export async function upsertEventMappingsBatch(mappings: EventMapping[]): Promise<void> {
  if (mappings.length === 0) return;

  // Deduplicate: keep latest entry per unique key
  const uniqueMap = new Map<string, EventMapping>();
  for (const mapping of mappings) {
    const key = `${mapping.source_id}|${mapping.exchange_id}|${mapping.event_id}`;
    uniqueMap.set(key, mapping);
  }
  const deduplicated = Array.from(uniqueMap.values());

  // Sort by event_id to prevent deadlocks
  const sorted = deduplicated.sort((a, b) => a.event_id.localeCompare(b.event_id));

  const values: unknown[] = [];
  const valuePlaceholders: string[] = [];

  sorted.forEach((m, i) => {
    const offset = i * 9;
    valuePlaceholders.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`
    );
    values.push(
      m.source_id,
      m.exchange_id,
      m.event_id,
      m.canonical_event_id,
      m.confidence_score,
      m.matched_at,
      m.model_id,
      m.match_version,
      true
    );
  });

  const sql = `
    INSERT INTO event_mappings (
      source_id, exchange_id, event_id, canonical_event_id,
      confidence_score, matched_at, model_id, match_version, is_active
    ) VALUES ${valuePlaceholders.join(', ')}
    ON CONFLICT (source_id, exchange_id, event_id)
    DO UPDATE SET
      canonical_event_id = EXCLUDED.canonical_event_id,
      confidence_score = EXCLUDED.confidence_score,
      matched_at = EXCLUDED.matched_at,
      model_id = EXCLUDED.model_id,
      match_version = EXCLUDED.match_version,
      is_active = TRUE,
      updated_at = NOW()
  `;

  await query(sql, values);
  logger.debug({ count: mappings.length }, 'Batch upserted event mappings');
}

/**
 * Fetch all active matched event pairs for market-level matching.
 * Returns one row per source–target pair, linked by canonical_event_id.
 */
export async function fetchMatchedEventPairsForMarketMatching(
  sourceExchangeId: string,
  targetExchangeId: string
): Promise<MatchedEventPair[]> {
  const sql = `
    SELECT
      s.event_id AS source_event_id, s.source_id AS source_source_id, s.exchange_id AS source_exchange_id,
      t.event_id AS target_event_id, t.source_id AS target_source_id, t.exchange_id AS target_exchange_id,
      s.canonical_event_id
    FROM event_mappings s
    JOIN event_mappings t
      ON s.canonical_event_id = t.canonical_event_id
      AND t.exchange_id = $2 AND t.is_active = TRUE
    WHERE s.exchange_id = $1 AND s.is_active = TRUE
  `;

  const result = await query<MatchedEventPair>(sql, [sourceExchangeId, targetExchangeId]);
  logger.debug({ count: result.rows.length, sourceExchangeId, targetExchangeId }, 'Fetched matched event pairs for market matching');
  return result.rows;
}

/**
 * Fetch open markets for a specific event, filtered by source_id, exchange_id, and outcome_side.
 */
export async function fetchMarketsForEvent(
  sourceId: string,
  exchangeId: string,
  eventId: string,
  outcomeSide: 'YES' | 'NO'
): Promise<MarketForMatching[]> {
  const sql = `
    SELECT source_id, exchange_id, market_id, outcome_side, outcome_name,
           title, sub_title, rules_primary, category, price, expires_at, status
    FROM prediction_markets
    WHERE source_id = $1 AND exchange_id = $2 AND event_id = $3
      AND outcome_side = $4 AND status = 'Open'
  `;

  const result = await query<MarketForMatching>(sql, [sourceId, exchangeId, eventId, outcomeSide]);
  logger.debug({ exchangeId, eventId, outcomeSide, count: result.rows.length }, 'Fetched markets for event');
  return result.rows;
}

// ── Arb Scanner Queries ─────────────────────────────────────────────────

export async function fetchArbConfig(): Promise<Map<string, string>> {
  const sql = `SELECT config_key, config_value FROM arb_config`;
  const result = await query<ArbConfig>(sql);
  const map = new Map<string, string>();
  for (const row of result.rows) {
    map.set(row.config_key, row.config_value);
  }
  return map;
}

export async function fetchMatchedMarketLegs(maxStalenessSeconds: number | null, minConfidence: number): Promise<MarketLeg[]> {
  const stalenessClause = maxStalenessSeconds !== null
    ? `AND mld.updated_at > NOW() - INTERVAL '1 second' * $1`
    : '';
  const confidenceParam = maxStalenessSeconds !== null ? '$2' : '$1';

  const sql = `
    WITH multi_exchange AS (
      SELECT canonical_market_id
      FROM market_mappings
      GROUP BY canonical_market_id
      HAVING COUNT(DISTINCT exchange_id) >= 2
    )
    SELECT
      mm.canonical_market_id,
      em.canonical_event_id,
      mm.exchange_id,
      mm.source_id,
      mm.market_id,
      mm.outcome_side,
      mld.band_vwap_ask,
      mld.band_vwap_bid,
      mld.band_liquidity_qty_ask,
      mld.band_liquidity_qty_bid,
      mld.reference_price,
      mm.confidence_score,
      COALESCE(mt.generated_title, pm.title) AS market_title,
      pm.category,
      pm.expires_at,
      mld.updated_at AS data_updated_at,
      pm.source_specific_data::jsonb->>'token_id' AS token_id
    FROM market_mappings mm
    JOIN multi_exchange me ON me.canonical_market_id = mm.canonical_market_id
    JOIN market_latest_data mld
      ON mm.source_id = mld.source_id
     AND mm.exchange_id = mld.exchange_id
     AND mm.market_id = mld.market_id
     AND mm.outcome_side = mld.outcome_side
    JOIN prediction_markets pm
      ON mm.source_id = pm.source_id
     AND mm.exchange_id = pm.exchange_id
     AND mm.market_id = pm.market_id
     AND mm.outcome_side = pm.outcome_side
    LEFT JOIN market_titles mt
      ON mm.canonical_market_id = mt.canonical_market_id
    LEFT JOIN event_mappings em
      ON mm.source_id = em.source_id
     AND mm.exchange_id = em.exchange_id
     AND pm.event_id = em.event_id
    WHERE mld.reference_price IS NOT NULL
      ${stalenessClause}
      AND mm.confidence_score >= ${confidenceParam}
      AND pm.status = 'Open'
    ORDER BY mm.canonical_market_id, mm.exchange_id
  `;
  const params = maxStalenessSeconds !== null
    ? [maxStalenessSeconds, minConfidence]
    : [minConfidence];
  const result = await query<MarketLeg>(sql, params);
  return result.rows;
}

export async function upsertArbOpportunities(opps: Omit<ArbOpportunity, 'arb_id' | 'detected_at' | 'updated_at' | 'last_checked_at' | 'expired_at' | 'prev_gross_spread_pct'>[]): Promise<void> {
  if (opps.length === 0) return;

  const values: unknown[] = [];
  const placeholders: string[] = [];

  const cols = 28;
  opps.forEach((opp, i) => {
    const o = i * cols;
    const p = Array.from({ length: cols }, (_, j) => `$${o + j + 1}`).join(', ');
    placeholders.push(`(${p})`);
    values.push(
      opp.canonical_market_id, opp.canonical_event_id, opp.arb_type, opp.arb_subtype,
      opp.leg1_exchange_id, opp.leg1_source_id, opp.leg1_market_id, opp.leg1_side, opp.leg1_action,
      opp.leg1_vwap, opp.leg1_liquidity_qty,
      opp.leg2_exchange_id, opp.leg2_source_id, opp.leg2_market_id, opp.leg2_side, opp.leg2_action,
      opp.leg2_vwap, opp.leg2_liquidity_qty,
      opp.gross_spread, opp.gross_spread_pct, opp.executable_qty, opp.gross_profit,
      opp.market_title, opp.category, opp.expires_at, opp.mapping_confidence,
      opp.leg1_data_at, opp.leg2_data_at,
    );
  });

  const sql = `
    INSERT INTO arb_opportunities (
      canonical_market_id, canonical_event_id, arb_type, arb_subtype,
      leg1_exchange_id, leg1_source_id, leg1_market_id, leg1_side, leg1_action,
      leg1_vwap, leg1_liquidity_qty,
      leg2_exchange_id, leg2_source_id, leg2_market_id, leg2_side, leg2_action,
      leg2_vwap, leg2_liquidity_qty,
      gross_spread, gross_spread_pct, executable_qty, gross_profit,
      market_title, category, expires_at, mapping_confidence,
      leg1_data_at, leg2_data_at
    ) VALUES ${placeholders.join(', ')}
    ON CONFLICT (canonical_market_id, arb_type, leg1_exchange_id, leg2_exchange_id)
    DO UPDATE SET
      arb_subtype = EXCLUDED.arb_subtype,
      leg1_source_id = EXCLUDED.leg1_source_id,
      leg1_market_id = EXCLUDED.leg1_market_id,
      leg1_side = EXCLUDED.leg1_side,
      leg1_action = EXCLUDED.leg1_action,
      leg1_vwap = EXCLUDED.leg1_vwap,
      leg1_liquidity_qty = EXCLUDED.leg1_liquidity_qty,
      leg2_source_id = EXCLUDED.leg2_source_id,
      leg2_market_id = EXCLUDED.leg2_market_id,
      leg2_side = EXCLUDED.leg2_side,
      leg2_action = EXCLUDED.leg2_action,
      leg2_vwap = EXCLUDED.leg2_vwap,
      leg2_liquidity_qty = EXCLUDED.leg2_liquidity_qty,
      gross_spread = EXCLUDED.gross_spread,
      prev_gross_spread_pct = arb_opportunities.gross_spread_pct,
      gross_spread_pct = EXCLUDED.gross_spread_pct,
      executable_qty = EXCLUDED.executable_qty,
      gross_profit = EXCLUDED.gross_profit,
      market_title = EXCLUDED.market_title,
      category = EXCLUDED.category,
      expires_at = EXCLUDED.expires_at,
      mapping_confidence = EXCLUDED.mapping_confidence,
      leg1_data_at = EXCLUDED.leg1_data_at,
      leg2_data_at = EXCLUDED.leg2_data_at,
      status = CASE
        WHEN arb_opportunities.status = 'ACTIVE' THEN 'ACTIVE'
        WHEN arb_opportunities.expired_at < NOW() - INTERVAL '5 minutes' THEN 'ACTIVE'
        ELSE arb_opportunities.status
      END,
      expired_at = CASE
        WHEN arb_opportunities.status = 'ACTIVE' THEN NULL
        WHEN arb_opportunities.expired_at < NOW() - INTERVAL '5 minutes' THEN NULL
        ELSE arb_opportunities.expired_at
      END,
      last_checked_at = CASE
        WHEN arb_opportunities.status = 'ACTIVE' THEN NOW()
        WHEN arb_opportunities.expired_at < NOW() - INTERVAL '5 minutes' THEN NOW()
        ELSE arb_opportunities.last_checked_at
      END,
      updated_at = CASE
        WHEN arb_opportunities.gross_spread_pct IS DISTINCT FROM EXCLUDED.gross_spread_pct
          OR arb_opportunities.executable_qty IS DISTINCT FROM EXCLUDED.executable_qty
        THEN NOW()
        ELSE arb_opportunities.updated_at
      END
  `;

  await query(sql, values);
}

export async function expireEvaluatedArbs(
  evaluatedCanonicalIds: string[],
  shortGraceSec: number,
  longGraceSec: number,
): Promise<number> {
  const sql = `
    UPDATE arb_opportunities
    SET status = 'EXPIRED', expired_at = NOW()
    WHERE status = 'ACTIVE'
      AND (
        (canonical_market_id = ANY($1) AND last_checked_at < NOW() - INTERVAL '1 second' * $2)
        OR
        (NOT (canonical_market_id = ANY($1)) AND last_checked_at < NOW() - INTERVAL '1 second' * $3)
      )
  `;
  const result = await query(sql, [evaluatedCanonicalIds, shortGraceSec, longGraceSec]);
  return result.rowCount ?? 0;
}

// ── Arb API v7 Queries ────────────────────────────────────────────────

export interface ArbV7Row {
  arb_id: number;
  canonical_market_id: string;
  canonical_event_id: string | null;
  arb_type: 'DIRECT' | 'COMPLEMENT';
  arb_subtype: string | null;
  gross_spread: number;
  gross_spread_pct: number;
  executable_qty: number | null;
  gross_profit: number | null;
  prev_gross_spread_pct: number | null;
  market_title: string | null;
  category: string | null;
  expires_at: Date | null;
  mapping_confidence: number | null;
  detected_at: Date;
  updated_at: Date;
  leg1_exchange_id: string;
  leg1_source_id: string;
  leg1_market_id: string;
  leg1_side: 'YES' | 'NO';
  leg1_action: string;
  leg1_vwap: number | null;
  leg1_liquidity_qty: number | null;
  leg2_exchange_id: string;
  leg2_source_id: string;
  leg2_market_id: string;
  leg2_side: 'YES' | 'NO';
  leg2_action: string;
  leg2_vwap: number | null;
  leg2_liquidity_qty: number | null;
  // Depth from market_latest_data JOINs
  leg1_depth_qty: number | null;
  leg1_depth_usd: number | null;
  leg2_depth_qty: number | null;
  leg2_depth_usd: number | null;
  // Trade URL fields
  leg1_trade_url_market_id: string | null;
  leg2_trade_url_market_id: string | null;
  leg1_event_id: string | null;
  leg2_event_id: string | null;
  // Computed APY
  days_to_expiry: number | null;
  apy: number | null;
}

export interface ArbV7Counts {
  all: number;
  cross_platform: number;
  time_decay: number;
  liquidity_gap: number;
}

export interface ArbV7Meta {
  last_scan_at: Date | null;
  total_markets_streaming: number;
  volume_24h: number;
  exchange_count: number;
}

export interface FetchArbsV7Options {
  sort: 'spread' | 'profit' | 'detected' | 'apy';
  category?: string;
  arb_type?: string;
  subtype?: string;
  limit: number;
  cursor?: number;
}

export async function fetchArbsV7(opts: FetchArbsV7Options, pool?: pg.Pool): Promise<{ rows: ArbV7Row[]; total: number; counts: ArbV7Counts; meta: ArbV7Meta }> {
  const q = pool
    ? <T extends pg.QueryResultRow>(text: string, params?: unknown[]) => queryWithPool<T>(pool, text, params)
    : query;
  const whereClauses: string[] = [
    'ao.status = \'ACTIVE\'',
    '(ao.expires_at IS NULL OR ao.expires_at > NOW())',
  ];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (opts.category) {
    whereClauses.push(`ao.category = $${paramIdx}`);
    params.push(opts.category);
    paramIdx++;
  }
  if (opts.arb_type) {
    whereClauses.push(`ao.arb_type = $${paramIdx}`);
    params.push(opts.arb_type);
    paramIdx++;
  }
  if (opts.subtype) {
    whereClauses.push(`ao.arb_subtype = $${paramIdx}`);
    params.push(opts.subtype);
    paramIdx++;
  }
  if (opts.cursor) {
    whereClauses.push(`ao.arb_id < $${paramIdx}`);
    params.push(opts.cursor);
    paramIdx++;
  }

  let orderBy: string;
  switch (opts.sort) {
    case 'profit':
      orderBy = 'ORDER BY ao.gross_profit DESC NULLS LAST, ao.arb_id DESC';
      break;
    case 'detected':
      orderBy = 'ORDER BY ao.detected_at DESC, ao.arb_id DESC';
      break;
    case 'apy':
      orderBy = 'ORDER BY apy DESC NULLS LAST, ao.arb_id DESC';
      break;
    default:
      orderBy = 'ORDER BY ao.gross_spread_pct DESC, ao.arb_id DESC';
  }

  const whereStr = whereClauses.join(' AND ');
  const limitParam = `$${paramIdx}`;
  params.push(opts.limit + 1);

  const dataSql = `
    SELECT
      ao.arb_id, ao.canonical_market_id, ao.canonical_event_id,
      ao.arb_type, ao.arb_subtype,
      ao.gross_spread, ao.gross_spread_pct, ao.executable_qty, ao.gross_profit,
      ao.prev_gross_spread_pct,
      ao.market_title, ao.category, ao.expires_at, ao.mapping_confidence,
      ao.detected_at, ao.updated_at,
      ao.leg1_exchange_id, ao.leg1_source_id, ao.leg1_market_id, ao.leg1_side, ao.leg1_action,
      ao.leg1_vwap, ao.leg1_liquidity_qty,
      ao.leg2_exchange_id, ao.leg2_source_id, ao.leg2_market_id, ao.leg2_side, ao.leg2_action,
      ao.leg2_vwap, ao.leg2_liquidity_qty,
      -- Leg 1 depth: pick ask or bid qty depending on action
      CASE WHEN ao.leg1_action = 'BUY' THEN mld1.band_liquidity_qty_ask
           ELSE mld1.band_liquidity_qty_bid END AS leg1_depth_qty,
      CASE WHEN ao.leg1_action = 'BUY'
           THEN mld1.band_liquidity_qty_ask * ao.leg1_vwap
           ELSE mld1.band_liquidity_qty_bid * ao.leg1_vwap END AS leg1_depth_usd,
      -- Leg 2 depth
      CASE WHEN ao.leg2_action = 'BUY' THEN mld2.band_liquidity_qty_ask
           ELSE mld2.band_liquidity_qty_bid END AS leg2_depth_qty,
      CASE WHEN ao.leg2_action = 'BUY'
           THEN mld2.band_liquidity_qty_ask * ao.leg2_vwap
           ELSE mld2.band_liquidity_qty_bid * ao.leg2_vwap END AS leg2_depth_usd,
      -- Trade URL building blocks
      ao.leg1_market_id AS leg1_trade_url_market_id,
      ao.leg2_market_id AS leg2_trade_url_market_id,
      -- Per-leg event IDs for trade URL building
      e1.event_id AS leg1_event_id,
      e2.event_id AS leg2_event_id,
      -- APY computation
      CASE
        WHEN ao.expires_at IS NULL OR ao.expires_at <= NOW() THEN NULL
        ELSE GREATEST(EXTRACT(EPOCH FROM (ao.expires_at - NOW())) / 86400.0, 1)
      END AS days_to_expiry,
      CASE
        WHEN ao.expires_at IS NULL OR ao.expires_at <= NOW() THEN NULL
        WHEN EXTRACT(EPOCH FROM (ao.expires_at - NOW())) / 86400.0 < 14 THEN NULL
        ELSE ao.gross_spread_pct * 365.0 / GREATEST(EXTRACT(EPOCH FROM (ao.expires_at - NOW())) / 86400.0, 1)
      END AS apy
    FROM arb_opportunities ao
    -- Leg 1 live depth
    LEFT JOIN market_latest_data mld1
      ON ao.leg1_source_id = mld1.source_id
     AND ao.leg1_exchange_id = mld1.exchange_id
     AND ao.leg1_market_id = mld1.market_id
     AND ao.leg1_side = mld1.outcome_side
    -- Leg 2 live depth
    LEFT JOIN market_latest_data mld2
      ON ao.leg2_source_id = mld2.source_id
     AND ao.leg2_exchange_id = mld2.exchange_id
     AND ao.leg2_market_id = mld2.market_id
     AND ao.leg2_side = mld2.outcome_side
    -- Leg 1 event ID (for trade URLs)
    LEFT JOIN prediction_markets pm1
      ON ao.leg1_source_id = pm1.source_id
     AND ao.leg1_exchange_id = pm1.exchange_id
     AND ao.leg1_market_id = pm1.market_id
     AND ao.leg1_side = pm1.outcome_side
    LEFT JOIN events e1
      ON pm1.source_id = e1.source_id
     AND pm1.exchange_id = e1.exchange_id
     AND pm1.event_id = e1.event_id
    -- Leg 2 event ID (for trade URLs)
    LEFT JOIN prediction_markets pm2
      ON ao.leg2_source_id = pm2.source_id
     AND ao.leg2_exchange_id = pm2.exchange_id
     AND ao.leg2_market_id = pm2.market_id
     AND ao.leg2_side = pm2.outcome_side
    LEFT JOIN events e2
      ON pm2.source_id = e2.source_id
     AND pm2.exchange_id = e2.exchange_id
     AND pm2.event_id = e2.event_id
    WHERE ${whereStr}
    ${orderBy}
    LIMIT ${limitParam}
  `;

  // Count query (no cursor filter) — reuse same filters except cursor
  const countWhereClauses: string[] = [
    'ao.status = \'ACTIVE\'',
    '(ao.expires_at IS NULL OR ao.expires_at > NOW())',
  ];
  const countParams: unknown[] = [];
  let countParamIdx = 1;

  if (opts.category) {
    countWhereClauses.push(`ao.category = $${countParamIdx}`);
    countParams.push(opts.category);
    countParamIdx++;
  }
  if (opts.arb_type) {
    countWhereClauses.push(`ao.arb_type = $${countParamIdx}`);
    countParams.push(opts.arb_type);
    countParamIdx++;
  }
  if (opts.subtype) {
    countWhereClauses.push(`ao.arb_subtype = $${countParamIdx}`);
    countParams.push(opts.subtype);
    countParamIdx++;
  }

  const countWhereStr = countWhereClauses.join(' AND ');

  const countSql = `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE ao.arb_subtype = 'CROSS_PLATFORM')::int AS cross_platform,
      COUNT(*) FILTER (WHERE ao.arb_subtype = 'TIME_DECAY')::int AS time_decay,
      COUNT(*) FILTER (WHERE ao.arb_subtype = 'LIQUIDITY_GAP')::int AS liquidity_gap
    FROM arb_opportunities ao
    WHERE ${countWhereStr}
  `;

  // Meta query
  const metaSql = `
    SELECT
      (SELECT MAX(last_checked_at) FROM arb_opportunities WHERE status = 'ACTIVE') AS last_scan_at,
      (SELECT COUNT(DISTINCT market_id)::int FROM market_latest_data WHERE updated_at > NOW() - INTERVAL '60 seconds') AS total_markets_streaming,
      (SELECT COALESCE(SUM(volume_traded), 0)::numeric FROM market_latest_data WHERE updated_at > NOW() - INTERVAL '24 hours') AS volume_24h,
      (SELECT COUNT(DISTINCT exchange_id)::int FROM market_latest_data WHERE updated_at > NOW() - INTERVAL '60 seconds') AS exchange_count
  `;

  const [dataResult, countResult, metaResult] = await Promise.all([
    q<ArbV7Row>(dataSql, params),
    q<{ total: number; cross_platform: number; time_decay: number; liquidity_gap: number }>(countSql, countParams),
    q<{ last_scan_at: Date | null; total_markets_streaming: number; volume_24h: number; exchange_count: number }>(metaSql),
  ]);

  const countRow = countResult.rows[0]!;
  const metaRow = metaResult.rows[0]!;

  // For the total when filtered by subtype, use the filtered count
  // The counts object always shows unfiltered counts per subtype
  const total = opts.subtype ? countRow.total : countRow.total;

  return {
    rows: dataResult.rows,
    total,
    counts: {
      all: countRow.total,
      cross_platform: countRow.cross_platform,
      time_decay: countRow.time_decay,
      liquidity_gap: countRow.liquidity_gap,
    },
    meta: {
      last_scan_at: metaRow.last_scan_at,
      total_markets_streaming: metaRow.total_markets_streaming,
      volume_24h: Number(metaRow.volume_24h),
      exchange_count: metaRow.exchange_count,
    },
  };
}

export async function fetchMatchedMarketIds(exchangeId: string): Promise<Set<string>> {
  const sql = `
    SELECT DISTINCT market_id
    FROM direct_exchanges_data.market_mappings
    WHERE exchange_id = $1 AND is_active = true
  `;
  const result = await query(sql, [exchangeId]);
  return new Set(result.rows.map((r) => r.market_id as string));
}

/**
 * Fix 6: Fetch unmatched YES markets with their event info.
 * Returns markets that have no entry in market_mappings,
 * joined with their event data for cross-event matching.
 */
export async function fetchUnmatchedMarketsWithEvents(
  exchangeId: string
): Promise<Array<MarketForMatching & { event_title: string; event_category: string | null; event_end_date: Date | null }>> {
  const sql = `
    SELECT pm.source_id, pm.exchange_id, pm.market_id, pm.outcome_side,
           pm.outcome_name, pm.title, pm.sub_title, pm.rules_primary,
           pm.category, pm.price, pm.expires_at, pm.status,
           e.title as event_title, e.category as event_category, e.end_date as event_end_date
    FROM direct_exchanges_data.prediction_markets pm
    JOIN direct_exchanges_data.events e
      ON pm.source_id = e.source_id AND pm.exchange_id = e.exchange_id AND pm.event_id = e.event_id
    LEFT JOIN direct_exchanges_data.market_mappings mm
      ON pm.source_id = mm.source_id AND pm.exchange_id = mm.exchange_id
         AND pm.market_id = mm.market_id AND pm.outcome_side = mm.outcome_side
    WHERE pm.exchange_id = $1
      AND pm.outcome_side = 'YES'
      AND pm.status = 'Open'
      AND mm.market_id IS NULL
      AND (pm.phase2_checked_at IS NULL OR pm.phase2_checked_at < NOW() - INTERVAL '24 hours')
    ORDER BY pm.price DESC
  `;
  const result = await query(sql, [exchangeId]);
  return result.rows as Array<MarketForMatching & { event_title: string; event_category: string | null; event_end_date: Date | null }>;
}

/**
 * Mark markets as checked by Phase 2 cross-event matching.
 * Prevents re-checking the same markets every cycle (24h cooldown).
 */
export async function markPhase2Checked(
  sourceId: string,
  exchangeId: string,
  marketIds: string[]
): Promise<void> {
  if (marketIds.length === 0) return;
  const placeholders = marketIds.map((_, i) => `$${i + 3}`).join(', ');
  const sql = `
    UPDATE direct_exchanges_data.prediction_markets
    SET phase2_checked_at = NOW()
    WHERE source_id = $1 AND exchange_id = $2
      AND market_id IN (${placeholders})
      AND outcome_side = 'YES'
  `;
  await query(sql, [sourceId, exchangeId, ...marketIds]);
}

/**
 * Fetch mega-events — events with 20+ markets on a given exchange.
 * These are events that group many entity-specific markets under one event
 * (e.g., "Who will win the NBA Championship?" with 30 team markets).
 */
export async function fetchMegaEvents(exchangeId: string = 'KALSHI'): Promise<Array<EventForMatching>> {
  const sql = `
    SELECT e.source_id, e.exchange_id, e.event_id, e.title,
           e.subtitle, e.category, e.end_date, e.market_count,
           COALESCE(SUM(mld.volume_traded), 0)::numeric as total_volume,
           0 as total_trades,
           e.match_checked_at
    FROM direct_exchanges_data.events e
    LEFT JOIN direct_exchanges_data.prediction_markets pm
      ON e.source_id = pm.source_id AND e.exchange_id = pm.exchange_id AND e.event_id = pm.event_id
    LEFT JOIN direct_exchanges_data.market_latest_data mld
      ON pm.source_id = mld.source_id AND pm.exchange_id = mld.exchange_id
         AND pm.market_id = mld.market_id AND pm.outcome_side = mld.outcome_side
    WHERE e.exchange_id = $1
      AND e.status = 'Open'
      AND e.market_count >= 20
    GROUP BY e.source_id, e.exchange_id, e.event_id, e.title,
             e.subtitle, e.category, e.end_date, e.market_count, e.match_checked_at
    ORDER BY total_volume DESC
  `;
  const result = await query(sql, [exchangeId]);
  return result.rows.map(r => ({
    source_id: r.source_id as string,
    exchange_id: r.exchange_id as string,
    event_id: r.event_id as string,
    title: r.title as string,
    subtitle: (r.subtitle as string) || null,
    category: (r.category as string) || null,
    end_date: r.end_date ? new Date(r.end_date as string) : null,
    market_count: r.market_count as number,
    total_volume: Number(r.total_volume),
    total_trades: Number(r.total_trades),
    match_checked_at: r.match_checked_at ? new Date(r.match_checked_at as string) : null,
  }));
}

/**
 * Search markets by entity name (substring match on title).
 * Used for cross-event matching to find per-entity markets on a target exchange.
 */
export async function searchMarketsByEntity(
  exchangeId: string,
  entityName: string
): Promise<MarketForMatching[]> {
  const sql = `
    SELECT pm.source_id, pm.exchange_id, pm.market_id, pm.outcome_side,
           pm.outcome_name, pm.title, pm.sub_title, pm.rules_primary,
           pm.category, pm.price, pm.expires_at, pm.status
    FROM direct_exchanges_data.prediction_markets pm
    WHERE pm.exchange_id = $1
      AND pm.outcome_side = 'YES'
      AND pm.status = 'Open'
      AND LOWER(pm.title) LIKE '%' || LOWER($2) || '%'
    ORDER BY pm.price DESC
    LIMIT 20
  `;
  const result = await query(sql, [exchangeId, entityName]);
  return result.rows as MarketForMatching[];
}

/**
 * @deprecated Use searchMarketsByEntity instead. Kept for backward compatibility.
 */
export async function searchPolymarketMarketsByEntity(
  entityName: string
): Promise<MarketForMatching[]> {
  return searchMarketsByEntity('POLYMARKET', entityName);
}
