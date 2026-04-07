import {
  createLogger,
  upsertPredictionMarketsBatch,
  upsertMarketLatestDataBatch,
  upsertEventsBatch,
  markStaleMarketsAsClosed,
  markStaleEventsAsClosed,
  OPINION_SOURCE_ID,
  OPINION_EXCHANGE_ID,
} from '@prediction-market/shared';
import type { OpinionConfig } from '../config.js';
import type {
  OpinionMarketData,
  OpinionApiResponse,
  OpinionMarketListResult,
} from '../types/api.js';
import { normalizeMarkets, normalizeEvents, buildTokenCache, type TokenInfo } from '../transformers/normalize.js';

const logger = createLogger('opinion-market-sync');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface MarketSyncResult {
  marketIds: number[];
  rootMarketIds: number[];
  tokenCache: Map<string, TokenInfo>;
  rawMarkets: OpinionMarketData[];
}

async function fetchAllActiveMarkets(restUrl: string, apiKey: string): Promise<OpinionMarketData[]> {
  const allMarkets: OpinionMarketData[] = [];
  let page = 1;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    apikey: apiKey,
  };

  while (true) {
    const url = `${restUrl}/market?status=activated&marketType=2&limit=20&page=${page}`;

    logger.info({ page, total: allMarkets.length }, 'Fetching markets page');

    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`Failed to fetch markets: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as OpinionApiResponse<OpinionMarketListResult>;

    if (data.code !== 0) {
      throw new Error(`Opinion API error: code=${data.code} msg=${data.msg}`);
    }

    if (data.result.list.length === 0) break;
    allMarkets.push(...data.result.list);

    logger.info({
      page,
      pageSize: data.result.list.length,
      total: allMarkets.length,
      apiTotal: data.result.total,
    }, 'Fetched markets page');

    if (allMarkets.length >= data.result.total) break;
    page++;
    await sleep(100); // rate limit: 15 req/s
  }

  logger.info({ totalMarkets: allMarkets.length }, 'Fetched all active markets');
  return allMarkets;
}

function collectSubscriptionIds(markets: OpinionMarketData[]): {
  marketIds: number[];
  rootMarketIds: number[];
} {
  const marketIds: number[] = [];
  const rootMarketIds: number[] = [];

  for (const m of markets) {
    if (m.marketType === 0) {
      marketIds.push(m.marketId);
    } else if (m.marketType === 1 && m.childMarkets?.length) {
      rootMarketIds.push(m.marketId); // categorical root for WS subscription
    }
  }

  return { marketIds, rootMarketIds };
}

export async function refreshMarkets(config: OpinionConfig): Promise<MarketSyncResult> {
  const syncStartTime = new Date();

  // Fetch all active markets from REST API
  const rawMarkets = await fetchAllActiveMarkets(config.restUrl, config.apiKey);

  // Normalize to DB format
  const dbMarkets = normalizeMarkets(rawMarkets);
  const events = normalizeEvents(rawMarkets);

  // Upsert markets in chunks
  const CHUNK_SIZE = 100;
  for (let i = 0; i < dbMarkets.length; i += CHUNK_SIZE) {
    const chunk = dbMarkets.slice(i, i + CHUNK_SIZE);
    await upsertPredictionMarketsBatch(chunk);
    logger.debug({ chunk: i / CHUNK_SIZE + 1, count: chunk.length }, 'Synced market chunk');
  }
  logger.info({ total: dbMarkets.length }, 'Synced all markets to database');

  // Mark stale markets as closed
  await markStaleMarketsAsClosed(OPINION_SOURCE_ID, OPINION_EXCHANGE_ID, syncStartTime);

  // Upsert events in chunks
  for (let i = 0; i < events.length; i += CHUNK_SIZE) {
    const chunk = events.slice(i, i + CHUNK_SIZE);
    await upsertEventsBatch(chunk);
  }
  logger.info({ totalEvents: events.length }, 'Synced all events to database');

  // Mark stale events as closed
  await markStaleEventsAsClosed(OPINION_SOURCE_ID, OPINION_EXCHANGE_ID, syncStartTime);

  // Build token cache for WS handlers
  const tokenCache = buildTokenCache(rawMarkets);

  // Collect subscription IDs for WS
  const { marketIds, rootMarketIds } = collectSubscriptionIds(rawMarkets);

  logger.info({
    markets: dbMarkets.length,
    events: events.length,
    binaryMarkets: marketIds.length,
    categoricalRoots: rootMarketIds.length,
    tokenCacheSize: tokenCache.size,
  }, 'Market refresh complete');

  return { marketIds, rootMarketIds, tokenCache, rawMarkets };
}
