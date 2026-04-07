import {
  createLogger,
  upsertPredictionMarketsBatch,
  upsertMarketLatestDataBatch,
  upsertEventsBatch,
  getTradeCounts24h,
  bulkSetOutcomeSide,
  bulkSetGammaMarketId,
  markStaleMarketsAsClosed,
  markStaleEventsAsClosed,
  type PredictionMarket,
  type MarketLatestData,
  type ExchangeEvent,
  POLYMARKET_SOURCE_ID,
  POLYMARKET_EXCHANGE_ID,
} from '@prediction-market/shared';
import { normalizeMarket, type PolymarketMarket } from '../transformers/normalize.js';

const logger = createLogger('polymarket-gamma-api');

export interface GammaMarketsResponse {
  markets: PolymarketMarket[];
  next_cursor?: string;
}

export interface EventMappingResult {
  eventIdMap: Map<string, string>;    // clobTokenId → event.id
  seriesIdMap: Map<string, string>;   // clobTokenId → series ticker
  categoryMap: Map<string, string>;   // clobTokenId → first tag label from event
}

export async function fetchActiveMarkets(gammaUrl: string, maxMarkets?: number): Promise<PolymarketMarket[]> {
  const allMarkets: PolymarketMarket[] = [];
  const LIMIT = 100;
  const configMax = parseInt(process.env.POLYMARKET_MAX_MARKETS || '0', 10);
  const MAX_MARKETS = maxMarkets || (configMax > 0 ? configMax : Infinity); // 0 means no limit
  let offset = 0;
  let hasMore = true;

  while (hasMore && allMarkets.length < MAX_MARKETS) {
    const url = new URL(`${gammaUrl}/markets`);
    url.searchParams.set('active', 'true');
    url.searchParams.set('closed', 'false');
    url.searchParams.set('limit', LIMIT.toString());
    url.searchParams.set('offset', offset.toString());

    logger.debug({ url: url.toString(), offset }, 'Fetching markets page');

    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch markets: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as PolymarketMarket[];
    const markets: PolymarketMarket[] = Array.isArray(data) ? data : [];

    allMarkets.push(...markets);
    logger.info({ page: offset / LIMIT + 1, count: markets.length, total: allMarkets.length }, 'Fetched markets page');

    // If we got fewer than LIMIT, we've reached the end
    if (markets.length < LIMIT) {
      hasMore = false;
    } else {
      offset += LIMIT;
    }
  }

  if (allMarkets.length >= MAX_MARKETS) {
    logger.warn({ total: allMarkets.length, maxMarkets: MAX_MARKETS }, 'Reached max markets limit');
  }

  logger.info({ total: allMarkets.length }, 'Fetched all active markets');
  return allMarkets;
}

export async function fetchClosedMarkets(gammaUrl: string): Promise<PolymarketMarket[]> {
  const allMarkets: PolymarketMarket[] = [];
  const LIMIT = 100;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const url = new URL(`${gammaUrl}/markets`);
    url.searchParams.set('closed', 'true');
    url.searchParams.set('limit', LIMIT.toString());
    url.searchParams.set('offset', offset.toString());

    logger.debug({ url: url.toString(), offset }, 'Fetching closed markets page');

    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch closed markets: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as PolymarketMarket[];
    const markets: PolymarketMarket[] = Array.isArray(data) ? data : [];

    allMarkets.push(...markets);
    logger.info({ page: offset / LIMIT + 1, count: markets.length, total: allMarkets.length }, 'Fetched closed markets page');

    if (markets.length < LIMIT) {
      hasMore = false;
    } else {
      offset += LIMIT;
    }
  }

  logger.info({ total: allMarkets.length }, 'Fetched all closed markets');
  return allMarkets;
}

interface GammaEventMarket {
  id?: string;
  question?: string;
  description?: string;
  category?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  endDateIso?: string;
  endDate?: string;
  clobTokenIds?: string;
  outcomes?: string;
  outcomePrices?: string;
  volume?: string;
  volumeNum?: number;
  volume24hr?: number;
  liquidity?: string;
  liquidityNum?: number;
  conditionId?: string;
  groupItemTitle?: string;
}

interface GammaEventSeries {
  ticker?: string;
}

interface GammaEventTag {
  label?: string;
}

interface GammaEventCategory {
  label?: string;
}

interface GammaEvent {
  id: string;
  title?: string;
  subtitle?: string;
  endDate?: string;
  image?: string;
  slug?: string;
  negRisk?: boolean;
  enableNegRisk?: boolean;
  volume?: number;
  liquidity?: number;
  volume24hr?: number;
  markets?: GammaEventMarket[];
  series?: GammaEventSeries[];
  tags?: GammaEventTag[];
  categories?: GammaEventCategory[];
}

export interface FetchEventsWithMarketsResult {
  events: ExchangeEvent[];
  markets: PolymarketMarket[];
  eventMapping: EventMappingResult;
}

export async function fetchEventMapping(gammaUrl: string): Promise<EventMappingResult> {
  const eventIdMap = new Map<string, string>();
  const seriesIdMap = new Map<string, string>();
  const categoryMap = new Map<string, string>();

  try {
    const LIMIT = 100;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const url = new URL(`${gammaUrl}/events`);
      url.searchParams.set('active', 'true');
      url.searchParams.set('closed', 'false');
      url.searchParams.set('limit', LIMIT.toString());
      url.searchParams.set('offset', offset.toString());

      const response = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, 'Failed to fetch events for mapping');
        break;
      }

      const events = await response.json() as GammaEvent[];
      const eventList: GammaEvent[] = Array.isArray(events) ? events : [];

      for (const event of eventList) {
        const eventId = String(event.id);
        const seriesTicker = event.series?.[0]?.ticker;
        const category = event.tags?.[0]?.label;

        if (event.markets) {
          for (const market of event.markets) {
            if (market.clobTokenIds) {
              try {
                const tokenIds = JSON.parse(market.clobTokenIds) as string[];
                for (const tokenId of tokenIds) {
                  if (tokenId) {
                    eventIdMap.set(tokenId, eventId);
                    if (seriesTicker) {
                      seriesIdMap.set(tokenId, seriesTicker);
                    }
                    if (category) {
                      categoryMap.set(tokenId, category);
                    }
                  }
                }
              } catch {
                // Skip markets with invalid clobTokenIds JSON
              }
            }
          }
        }
      }

      logger.debug({ page: offset / LIMIT + 1, events: eventList.length, mappings: eventIdMap.size }, 'Fetched events page for mapping');

      if (eventList.length < LIMIT) {
        hasMore = false;
      } else {
        offset += LIMIT;
      }
    }

    logger.info({ eventMappings: eventIdMap.size, seriesMappings: seriesIdMap.size, categoryMappings: categoryMap.size }, 'Fetched event mapping');
  } catch (err) {
    logger.error({ err }, 'Failed to fetch event mapping, falling back to market.id');
  }

  return { eventIdMap, seriesIdMap, categoryMap };
}

/**
 * Unified fetch: get events with nested markets from Gamma API.
 * Extracts event data, market data, and event-to-token mappings from a single endpoint.
 * This replaces separate fetchActiveMarkets() + fetchEventMapping() calls.
 */
export async function fetchEventsWithMarkets(gammaUrl: string): Promise<FetchEventsWithMarketsResult> {
  const allEvents: ExchangeEvent[] = [];
  const allMarkets: PolymarketMarket[] = [];
  const eventIdMap = new Map<string, string>();
  const seriesIdMap = new Map<string, string>();
  const categoryMap = new Map<string, string>();

  const LIMIT = 100;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const url = new URL(`${gammaUrl}/events`);
    url.searchParams.set('active', 'true');
    url.searchParams.set('closed', 'false');
    url.searchParams.set('limit', LIMIT.toString());
    url.searchParams.set('offset', offset.toString());

    logger.debug({ url: url.toString(), offset }, 'Fetching events page');

    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch events: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as GammaEvent[];
    const eventList: GammaEvent[] = Array.isArray(data) ? data : [];

    for (const event of eventList) {
      const eventId = String(event.id);
      const seriesTicker = event.series?.[0]?.ticker;
      const category = event.tags?.[0]?.label || event.categories?.[0]?.label;

      // Count only binary markets (outcomes include both "Yes" and "No")
      const binaryMarketCount = event.markets?.filter(m => {
        try {
          const outcomes = m.outcomes ? JSON.parse(m.outcomes) as string[] : [];
          return outcomes.some(o => o?.toUpperCase() === 'YES')
            && outcomes.some(o => o?.toUpperCase() === 'NO');
        } catch {
          return false;
        }
      }).length ?? 0;

      // Extract event-level data
      allEvents.push({
        source_id: POLYMARKET_SOURCE_ID,
        exchange_id: POLYMARKET_EXCHANGE_ID,
        event_id: eventId,
        title: event.title,
        subtitle: event.subtitle,
        category,
        series_id: seriesTicker,
        status: 'Open',
        end_date: event.endDate ? new Date(event.endDate) : undefined,
        image_url: event.image,
        mutually_exclusive: event.enableNegRisk,
        market_count: binaryMarketCount,
        source_specific_data: {
          ...(event.slug ? { slug: event.slug } : {}),
          ...(event.negRisk != null ? { negRisk: event.negRisk } : {}),
          ...(event.volume != null ? { volume: event.volume } : {}),
          ...(event.liquidity != null ? { liquidity: event.liquidity } : {}),
          ...(event.volume24hr != null ? { volume24hr: event.volume24hr } : {}),
        },
      });

      // Extract nested markets and build event mappings
      if (event.markets) {
        for (const market of event.markets) {
          // Convert GammaEventMarket to PolymarketMarket
          if (market.id) {
            allMarkets.push({
              id: market.id,
              question: market.question || event.title || '',
              description: market.description,
              category: market.category || category,
              active: market.active ?? true,
              closed: market.closed ?? false,
              archived: market.archived,
              endDateIso: market.endDateIso,
              endDate: market.endDate || event.endDate,
              clobTokenIds: market.clobTokenIds,
              outcomes: market.outcomes,
              outcomePrices: market.outcomePrices,
              volume: market.volume,
              volumeNum: market.volumeNum,
              volume24hr: market.volume24hr,
              liquidity: market.liquidity,
              liquidityNum: market.liquidityNum,
              conditionId: market.conditionId,
              groupItemTitle: market.groupItemTitle,
            });
          }

          // Build event-to-token mappings (same logic as fetchEventMapping)
          if (market.clobTokenIds) {
            try {
              const tokenIds = JSON.parse(market.clobTokenIds) as string[];
              for (const tokenId of tokenIds) {
                if (tokenId) {
                  eventIdMap.set(tokenId, eventId);
                  if (seriesTicker) {
                    seriesIdMap.set(tokenId, seriesTicker);
                  }
                  if (category) {
                    categoryMap.set(tokenId, category);
                  }
                }
              }
            } catch {
              // Skip markets with invalid clobTokenIds JSON
            }
          }
        }
      }
    }

    logger.info({
      page: offset / LIMIT + 1,
      events: eventList.length,
      marketsThisPage: eventList.reduce((sum, e) => sum + (e.markets?.length || 0), 0),
      totalMarkets: allMarkets.length,
      totalEvents: allEvents.length,
    }, 'Fetched events page');

    if (eventList.length < LIMIT) {
      hasMore = false;
    } else {
      offset += LIMIT;
    }
  }

  logger.info({
    totalEvents: allEvents.length,
    totalMarkets: allMarkets.length,
    eventMappings: eventIdMap.size,
    seriesMappings: seriesIdMap.size,
    categoryMappings: categoryMap.size,
  }, 'Fetched all events with markets');

  return {
    events: allEvents,
    markets: allMarkets,
    eventMapping: { eventIdMap, seriesIdMap, categoryMap },
  };
}

export async function syncMarkets(markets: PolymarketMarket[], eventMapping?: EventMappingResult): Promise<void> {
  const syncStartTime = new Date();
  const dbMarkets: PredictionMarket[] = [];
  const marketLatestDataList: MarketLatestData[] = [];
  const outcomeSideMap = new Map<string, 'YES' | 'NO'>();
  const now = new Date();
  let marketsWithVolume = 0;

  // Fetch 24h trade counts from the trades table
  const tradeCounts = await getTradeCounts24h(POLYMARKET_SOURCE_ID, POLYMARKET_EXCHANGE_ID);
  logger.info({ marketsWithTrades: tradeCounts.size }, 'Fetched trade counts for sync');

  // Build conditionId → Gamma market ID cache for WebSocket handlers
  const conditionIdMap = new Map<string, string>();
  for (const market of markets) {
    if (market.conditionId) {
      conditionIdMap.set(market.conditionId, market.id);
    }
  }

  for (const market of markets) {
    const normalized = normalizeMarket(market);

    // Get 24hr volume for this market (shared across all tokens/outcomes)
    // Convert to integer since volume_traded is bigint in database
    // Note: volume24hr can be null or undefined, so we check for both
    const volume = market.volume24hr != null && market.volume24hr > 0
      ? Math.floor(market.volume24hr)
      : undefined;

    if (volume !== undefined && volume > 0) {
      marketsWithVolume++;
    }

    for (const nm of normalized) {
      // Build outcome side cache: clobTokenId -> outcome_side
      outcomeSideMap.set(nm.marketId, nm.outcomeSide);

      dbMarkets.push({
        source_id: nm.sourceId,
        exchange_id: nm.exchangeId,
        market_id: market.id,
        event_id: eventMapping?.eventIdMap.get(nm.marketId) || nm.eventId,
        series_id: eventMapping?.seriesIdMap.get(nm.marketId),
        outcome_side: nm.outcomeSide,
        market_name: nm.marketName,
        sub_title: nm.subTitle,
        rules_primary: nm.rulesPrimary,
        category: eventMapping?.categoryMap.get(nm.marketId) || nm.category,
        price: nm.price,
        end_date: nm.endDate,
        status: nm.status,
        source_specific_data: {
          ...nm.sourceSpecificData,
          token_id: nm.marketId,
        },
      });

      // Get trade count (may be 0 during transition from clobTokenId to Gamma ID)
      const tradeCount = tradeCounts.get(market.id);

      // Also prepare market_latest_data with volume, price, and trade count
      marketLatestDataList.push({
        source_id: nm.sourceId,
        exchange_id: nm.exchangeId,
        market_id: market.id,
        outcome_side: nm.outcomeSide,
        price_close: nm.price,
        volume_traded: volume,
        trades_count: tradeCount,
        entry_time: now,
      });
    }
  }

  // Populate the outcome side cache for WebSocket handlers
  bulkSetOutcomeSide(outcomeSideMap);
  logger.info({ cacheSize: outcomeSideMap.size }, 'Updated outcome side cache');

  // Populate the conditionId → Gamma market ID cache for WebSocket handlers
  bulkSetGammaMarketId(conditionIdMap);
  logger.info({ cacheSize: conditionIdMap.size }, 'Updated conditionId → Gamma market ID cache');

  // Batch insert prediction_markets in chunks of 100
  const CHUNK_SIZE = 100;
  for (let i = 0; i < dbMarkets.length; i += CHUNK_SIZE) {
    const chunk = dbMarkets.slice(i, i + CHUNK_SIZE);
    await upsertPredictionMarketsBatch(chunk);
    logger.debug({ chunk: i / CHUNK_SIZE + 1, count: chunk.length }, 'Synced market chunk');
  }

  logger.info({ total: dbMarkets.length }, 'Synced all markets to database');

  // Batch upsert market_latest_data with volume in chunks of 100
  for (let i = 0; i < marketLatestDataList.length; i += CHUNK_SIZE) {
    const chunk = marketLatestDataList.slice(i, i + CHUNK_SIZE);
    await upsertMarketLatestDataBatch(chunk);
    logger.debug({ chunk: i / CHUNK_SIZE + 1, count: chunk.length }, 'Synced market latest data chunk');
  }

  logger.info({
    total: marketLatestDataList.length,
    marketsWithVolume,
    percentWithVolume: ((marketsWithVolume / markets.length) * 100).toFixed(1)
  }, 'Synced all market latest data with volume');

  // Mark stale markets as closed: any "Open" market not refreshed during this sync
  await markStaleMarketsAsClosed(POLYMARKET_SOURCE_ID, POLYMARKET_EXCHANGE_ID, syncStartTime);
}

export async function getAssetIds(gammaUrl: string): Promise<string[]> {
  const markets = await fetchActiveMarkets(gammaUrl);
  const assetIds: string[] = [];

  for (const market of markets) {
    if (market.clobTokenIds) {
      try {
        const tokenIds = JSON.parse(market.clobTokenIds) as string[];
        for (const tokenId of tokenIds) {
          if (tokenId) {
            assetIds.push(tokenId);
          }
        }
      } catch {
        // Skip markets with invalid clobTokenIds
      }
    }
  }

  return assetIds;
}

export async function fetchMarketById(
  gammaUrl: string,
  conditionId: string
): Promise<PolymarketMarket | null> {
  try {
    const url = `${gammaUrl}/markets/${conditionId}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch market: ${response.status} ${response.statusText}`);
    }

    return await response.json() as PolymarketMarket;
  } catch (err) {
    logger.error({ err, conditionId }, 'Failed to fetch market by ID');
    return null;
  }
}
