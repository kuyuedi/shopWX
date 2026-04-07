import {
  createLogger,
  upsertPredictionMarketsBatch,
  upsertMarketLatestDataBatch,
  upsertEventsBatch,
  getTradeCounts24h,
  markStaleMarketsAsClosed,
  markStaleEventsAsClosed,
  type PredictionMarket,
  type MarketLatestData,
  type ExchangeEvent,
  KALSHI_SOURCE_ID,
  KALSHI_EXCHANGE_ID,
} from '@prediction-market/shared';
import { normalizeMarket, type KalshiMarket } from '../transformers/normalize.js';

const logger = createLogger('kalshi-market-sync');

export interface KalshiMarketsResponse {
  markets: KalshiMarket[];
  cursor?: string;
}

interface KalshiEvent {
  event_ticker: string;
  series_ticker?: string;
  category: string;
  title: string;
  sub_title?: string;
  strike_date?: string;
  mutually_exclusive?: boolean;
  strike_period?: string;
  collateral_return_type?: string;
  markets?: KalshiMarket[];
}

export interface FetchActiveMarketsResult {
  markets: KalshiMarket[];
  events: ExchangeEvent[];
}

interface KalshiEventsResponse {
  events: KalshiEvent[];
  cursor?: string;
}

// Candlestick types for OHLC data
interface PriceOHLC {
  open: number;
  high: number;
  low: number;
  close: number;
}

interface KalshiCandlestick {
  end_period_ts: number;
  volume: number;
  open_interest: number;
  price?: PriceOHLC;
  yes_bid?: PriceOHLC;
  yes_ask?: PriceOHLC;
}

interface MarketCandlesticksResponse {
  market_ticker: string;
  candlesticks: KalshiCandlestick[];
}

interface BatchCandlesticksResponse {
  markets: MarketCandlesticksResponse[];
}

// Prefixes of dynamically generated sports betting combo markets to exclude
const EXCLUDED_MARKET_PREFIXES = [
  'KXMVESPORTSMULTIGAMEEXTENDED',  // Multi-game sports combos
  'KXMVESPORTSMULTIGAME',          // Multi-game sports combos
];

function isExcludedMarket(ticker: string): boolean {
  return EXCLUDED_MARKET_PREFIXES.some(prefix => ticker.startsWith(prefix));
}

export async function fetchActiveMarkets(
  restUrl: string,
  apiKey?: string,
  maxPages?: number
): Promise<FetchActiveMarketsResult> {
  const configMaxPages = parseInt(process.env.KALSHI_MAX_PAGES || '0', 10);
  const MAX_PAGES = maxPages ?? (configMaxPages > 0 ? configMaxPages : Infinity); // 0 = no limit
  const allMarkets: KalshiMarket[] = [];
  const allEvents: ExchangeEvent[] = [];
  let cursor: string | undefined;
  let pageCount = 0;

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // Fetch events with nested markets to get actual prediction markets
  // This avoids the 200k+ dynamically generated sports betting combo markets
  do {
    const url = new URL(`${restUrl}/events`);
    url.searchParams.set('with_nested_markets', 'true');
    url.searchParams.set('status', 'open');
    url.searchParams.set('limit', '100');
    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    logger.info({ page: pageCount + 1, maxPages: MAX_PAGES === Infinity ? 'unlimited' : MAX_PAGES }, 'Fetching events page');

    let response = await fetch(url.toString(), { headers });

    // Retry with exponential backoff on 429
    if (response.status === 429) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const delaySec = attempt * 10; // 10s, 20s, 30s
        logger.warn({ page: pageCount + 1, attempt, delaySec }, 'Rate limited (429), backing off before retry');
        await new Promise(r => setTimeout(r, delaySec * 1000));
        response = await fetch(url.toString(), { headers });
        if (response.status !== 429) break;
      }
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch events: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as KalshiEventsResponse;

    // Extract markets from each event, filtering out excluded sports markets
    // Thread event_ticker into each market for event grouping
    let pageMarketCount = 0;
    for (const event of data.events) {
      // Extract event-level data
      allEvents.push({
        source_id: KALSHI_SOURCE_ID,
        exchange_id: KALSHI_EXCHANGE_ID,
        event_id: event.event_ticker,
        title: event.title,
        subtitle: event.sub_title,
        category: event.category,
        series_id: event.series_ticker,
        status: 'Open',
        end_date: event.strike_date ? new Date(event.strike_date) : undefined,
        mutually_exclusive: event.mutually_exclusive,
        market_count: event.markets?.length,
        source_specific_data: {
          ...(event.strike_period ? { strike_period: event.strike_period } : {}),
          ...(event.collateral_return_type ? { collateral_return_type: event.collateral_return_type } : {}),
        },
      });

      if (event.markets) {
        for (const market of event.markets) {
          if (!isExcludedMarket(market.ticker)) {
            allMarkets.push({
              ...market,
              event_ticker: event.event_ticker,
              series_ticker: event.series_ticker,
              category: market.category || event.category,
            });
            pageMarketCount++;
          }
        }
      }
    }

    cursor = data.cursor;
    pageCount++;

    logger.info({
      events: data.events.length,
      markets: pageMarketCount,
      total: allMarkets.length,
      hasMore: !!cursor
    }, 'Fetched events page');
  } while (cursor && pageCount < MAX_PAGES);

  logger.info({ totalMarkets: allMarkets.length, totalEvents: allEvents.length, limitReached: pageCount >= MAX_PAGES }, 'Fetched active markets and events');
  return { markets: allMarkets, events: allEvents };
}

export async function syncMarkets(markets: KalshiMarket[]): Promise<void> {
  const syncStartTime = new Date();
  const dbMarkets: PredictionMarket[] = [];

  for (const market of markets) {
    const normalized = normalizeMarket(market);

    for (const nm of normalized) {
      dbMarkets.push({
        source_id: nm.sourceId,
        exchange_id: nm.exchangeId,
        market_id: nm.marketId,
        event_id: nm.eventId,
        series_id: nm.seriesId,
        outcome_side: nm.outcomeSide,
        market_name: nm.marketName,
        sub_title: nm.subTitle,
        rules_primary: nm.rulesPrimary,
        rules_secondary: nm.rulesSecondary,
        category: nm.category,
        price: nm.price,
        end_date: nm.endDate,
        status: nm.status,
        source_specific_data: nm.sourceSpecificData,
      });
    }
  }

  // Batch insert in chunks of 100
  const CHUNK_SIZE = 100;
  for (let i = 0; i < dbMarkets.length; i += CHUNK_SIZE) {
    const chunk = dbMarkets.slice(i, i + CHUNK_SIZE);
    await upsertPredictionMarketsBatch(chunk);
    logger.debug({ chunk: i / CHUNK_SIZE + 1, count: chunk.length }, 'Synced market chunk');
  }

  logger.info({ total: dbMarkets.length }, 'Synced all markets to database');

  // Mark stale markets as closed: any "Open" market not refreshed during this sync
  await markStaleMarketsAsClosed(KALSHI_SOURCE_ID, KALSHI_EXCHANGE_ID, syncStartTime);
}

export async function getMarketTickers(restUrl: string, apiKey?: string): Promise<string[]> {
  const { markets } = await fetchActiveMarkets(restUrl, apiKey);
  return markets.map((m) => m.ticker);
}

// Helper to sleep for a given number of milliseconds
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fetch candlestick OHLC data for multiple markets
 * API limit: max 100 tickers per request
 * Rate limited to ~10 requests per second to avoid 429 errors
 */
export async function fetchCandlesticks(
  restUrl: string,
  tickers: string[],
  apiKey?: string
): Promise<Map<string, KalshiCandlestick>> {
  const result = new Map<string, KalshiCandlestick>();

  if (tickers.length === 0) return result;

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // Use 1-day candlesticks for the last 24 hours
  const now = Math.floor(Date.now() / 1000);
  const oneDayAgo = now - 86400;
  const periodInterval = 1440; // 1 day in minutes

  // Batch requests (max 100 tickers per request)
  const BATCH_SIZE = 100;
  const DELAY_MS = 100; // 100ms between requests = ~10 requests/second
  const totalBatches = Math.ceil(tickers.length / BATCH_SIZE);

  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    const url = new URL(`${restUrl}/markets/candlesticks`);
    url.searchParams.set('market_tickers', batch.join(','));
    url.searchParams.set('start_ts', oneDayAgo.toString());
    url.searchParams.set('end_ts', now.toString());
    url.searchParams.set('period_interval', periodInterval.toString());

    try {
      const response = await fetch(url.toString(), { headers });

      if (response.status === 429) {
        // Rate limited - wait longer and retry once
        logger.warn({ batch: batchNum }, 'Rate limited, waiting 2s before retry');
        await sleep(2000);
        const retryResponse = await fetch(url.toString(), { headers });
        if (!retryResponse.ok) {
          logger.warn({ status: retryResponse.status, batch: batchNum }, 'Retry failed');
          continue;
        }
        const data = await retryResponse.json() as BatchCandlesticksResponse;
        for (const market of data.markets || []) {
          if (market.candlesticks && market.candlesticks.length > 0) {
            const latest = market.candlesticks[market.candlesticks.length - 1];
            if (latest) {
              result.set(market.market_ticker, latest);
            }
          }
        }
      } else if (!response.ok) {
        logger.warn({ status: response.status, batch: batchNum }, 'Failed to fetch candlesticks batch');
        continue;
      } else {
        const data = await response.json() as BatchCandlesticksResponse;

        // Extract the latest candlestick for each market
        for (const market of data.markets || []) {
          if (market.candlesticks && market.candlesticks.length > 0) {
            // Get the most recent candlestick
            const latest = market.candlesticks[market.candlesticks.length - 1];
            if (latest) {
              result.set(market.market_ticker, latest);
            }
          }
        }
      }

      // Log progress every 50 batches
      if (batchNum % 50 === 0) {
        logger.info({ batch: batchNum, totalBatches, received: result.size }, 'Candlestick fetch progress');
      }
    } catch (err) {
      logger.warn({ err, batch: batchNum }, 'Error fetching candlesticks batch');
    }

    // Rate limiting delay between requests
    if (i + BATCH_SIZE < tickers.length) {
      await sleep(DELAY_MS);
    }
  }

  logger.info({ total: result.size, requested: tickers.length }, 'Fetched candlesticks');
  return result;
}

/**
 * Sync market OHLC data to market_latest_data table
 */
export async function syncMarketOHLC(
  restUrl: string,
  markets: KalshiMarket[],
  apiKey?: string
): Promise<void> {
  const tickers = markets.map(m => m.ticker);
  const candlesticks = await fetchCandlesticks(restUrl, tickers, apiKey);

  if (candlesticks.size === 0) {
    logger.info('No candlestick data to sync');
    return;
  }

  // Fetch 24h trade counts from the trades table
  const tradeCounts = await getTradeCounts24h(KALSHI_SOURCE_ID, KALSHI_EXCHANGE_ID);
  logger.info({ marketsWithTrades: tradeCounts.size }, 'Fetched trade counts for OHLC sync');

  const marketLatestDataList: MarketLatestData[] = [];
  const now = new Date();

  for (const market of markets) {
    const candle = candlesticks.get(market.ticker);
    if (!candle) continue;

    // Get OHLC from price field (trade prices) - values are in cents, convert to decimal (0-1)
    const priceOHLC = candle.price;

    // Get trade count for this market
    const tradeCount = tradeCounts.get(market.ticker);

    // Create entries for both YES and NO outcomes
    // YES side uses the raw prices
    marketLatestDataList.push({
      source_id: KALSHI_SOURCE_ID,
      exchange_id: KALSHI_EXCHANGE_ID,
      market_id: market.ticker,
      outcome_side: 'YES',
      price_open: priceOHLC ? priceOHLC.open / 100 : undefined,
      price_high: priceOHLC ? priceOHLC.high / 100 : undefined,
      price_low: priceOHLC ? priceOHLC.low / 100 : undefined,
      price_close: priceOHLC ? priceOHLC.close / 100 : undefined,
      volume_traded: candle.volume,
      trades_count: tradeCount,
      entry_time: now,
    });

    // NO side uses inverted prices (1 - price)
    // Note: high/low are swapped for NO side since high YES = low NO
    marketLatestDataList.push({
      source_id: KALSHI_SOURCE_ID,
      exchange_id: KALSHI_EXCHANGE_ID,
      market_id: market.ticker,
      outcome_side: 'NO',
      price_open: priceOHLC ? 1 - priceOHLC.open / 100 : undefined,
      price_high: priceOHLC ? 1 - priceOHLC.low / 100 : undefined,  // Inverted: YES low = NO high
      price_low: priceOHLC ? 1 - priceOHLC.high / 100 : undefined,  // Inverted: YES high = NO low
      price_close: priceOHLC ? 1 - priceOHLC.close / 100 : undefined,
      volume_traded: candle.volume,
      trades_count: tradeCount,
      entry_time: now,
    });
  }

  // Batch upsert
  const CHUNK_SIZE = 100;
  for (let i = 0; i < marketLatestDataList.length; i += CHUNK_SIZE) {
    const chunk = marketLatestDataList.slice(i, i + CHUNK_SIZE);
    await upsertMarketLatestDataBatch(chunk);
    logger.debug({ chunk: i / CHUNK_SIZE + 1, count: chunk.length }, 'Synced OHLC chunk');
  }

  logger.info({ total: marketLatestDataList.length }, 'Synced all market OHLC data');
}
