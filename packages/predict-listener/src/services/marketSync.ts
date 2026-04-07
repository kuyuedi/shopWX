import {
  createLogger,
  upsertPredictionMarketsBatch,
  upsertMarketLatestDataBatch,
  upsertEventsBatch,
  markStaleMarketsAsClosed,
  markStaleEventsAsClosed,
  backfillPredictPrices,
  upsertMarketMappingsBatch,
  fetchExistingMappedMarketIds,
  PREDICT_SOURCE_ID,
  PREDICT_EXCHANGE_ID,
  KALSHI_SOURCE_ID,
  KALSHI_EXCHANGE_ID,
  POLYMARKET_SOURCE_ID,
  POLYMARKET_EXCHANGE_ID,
  type MarketMapping,
  type MarketTitle,
} from '@prediction-market/shared';
import type { PredictConfig } from '../config.js';
import type {
  PredictMarket,
  PredictCategory,
  PredictPaginatedResponse,
} from '../types/api.js';
import { normalizeMarkets, normalizeEvents } from '../transformers/normalize.js';
import { syncCrossExchangeMappings } from './crossMapping.js';

const logger = createLogger('predict-market-sync');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface MarketSyncResult {
  marketIds: number[];
}

async function fetchAllCategories(restUrl: string, apiKey: string): Promise<PredictCategory[]> {
  const allCategories: PredictCategory[] = [];
  let cursor: string | null = null;

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }

  while (true) {
    let url = `${restUrl}/v1/categories?status=OPEN`;
    if (cursor) {
      url += `&after=${cursor}`;
    }

    logger.info({ cursor, total: allCategories.length }, 'Fetching categories page');

    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`Failed to fetch categories: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as PredictPaginatedResponse<PredictCategory>;

    if (!data.data || data.data.length === 0) break;
    allCategories.push(...data.data);

    logger.info({
      pageSize: data.data.length,
      total: allCategories.length,
      hasMore: !!data.cursor,
    }, 'Fetched categories page');

    if (!data.cursor) break;
    cursor = data.cursor;
    await sleep(250); // rate limit: 240 req/min
  }

  logger.info({ totalCategories: allCategories.length }, 'Fetched all categories');
  return allCategories;
}

export async function refreshMarkets(config: PredictConfig): Promise<MarketSyncResult> {
  const syncStartTime = new Date();

  // Fetch all OPEN categories (includes nested markets)
  const categories = await fetchAllCategories(config.restUrl, config.apiKey);

  // Extract open markets from categories
  const rawMarkets: PredictMarket[] = [];
  for (const cat of categories) {
    for (const m of cat.markets || []) {
      if (m.tradingStatus === 'OPEN' && m.status === 'REGISTERED') {
        rawMarkets.push(m);
      }
    }
  }
  logger.info({ totalMarkets: rawMarkets.length, fromCategories: categories.length }, 'Extracted markets from categories');

  // Normalize to DB format
  const dbMarkets = normalizeMarkets(rawMarkets);
  const events = normalizeEvents(categories);

  // Upsert markets in chunks
  const CHUNK_SIZE = 100;
  for (let i = 0; i < dbMarkets.length; i += CHUNK_SIZE) {
    const chunk = dbMarkets.slice(i, i + CHUNK_SIZE);
    await upsertPredictionMarketsBatch(chunk);
    logger.debug({ chunk: i / CHUNK_SIZE + 1, count: chunk.length }, 'Synced market chunk');
  }
  logger.info({ total: dbMarkets.length }, 'Synced all markets to database');

  // Backfill prediction_markets.price from market_latest_data (reference_price or band_vwap_bid)
  try {
    const priceUpdates = await backfillPredictPrices(PREDICT_SOURCE_ID, PREDICT_EXCHANGE_ID);
    if (priceUpdates > 0) {
      logger.info({ updated: priceUpdates }, 'Backfilled prediction_markets.price from market_latest_data');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to backfill prediction_markets.price');
  }

  // Mark stale markets as closed
  await markStaleMarketsAsClosed(PREDICT_SOURCE_ID, PREDICT_EXCHANGE_ID, syncStartTime);

  // Upsert events in chunks
  for (let i = 0; i < events.length; i += CHUNK_SIZE) {
    const chunk = events.slice(i, i + CHUNK_SIZE);
    await upsertEventsBatch(chunk);
  }
  logger.info({ totalEvents: events.length }, 'Synced all events to database');

  // Mark stale events as closed
  await markStaleEventsAsClosed(PREDICT_SOURCE_ID, PREDICT_EXCHANGE_ID, syncStartTime);

  // Cross-exchange mapping
  if (config.enableCrossMapping) {
    try {
      await syncCrossExchangeMappings(rawMarkets);
    } catch (err) {
      logger.error({ err }, 'Failed to sync cross-exchange mappings');
    }
  }

  // Collect market IDs for WS subscription
  const marketIds = rawMarkets.map(m => m.id);

  logger.info({
    markets: dbMarkets.length,
    events: events.length,
    wsMarkets: marketIds.length,
  }, 'Market refresh complete');

  return { marketIds };
}
