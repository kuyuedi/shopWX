/**
 * One-time backfill script to populate event_id for historical/closed Polymarket markets.
 *
 * ~85k rows have NULL event_id because the Gamma API sync only fetches active markets.
 * This script fetches closed markets from the Gamma API page-by-page and upserts each
 * page immediately to keep memory usage low (streaming approach).
 *
 * Usage (from server with DB access):
 *   cd /opt/prediction-market-ingestion
 *   DATABASE_URL=... npx tsx scripts/backfill-polymarket-event-ids.ts
 */
import 'dotenv/config';
import {
  createLogger,
  closePool,
  upsertPredictionMarketsBatch,
  POLYMARKET_SOURCE_ID,
  POLYMARKET_EXCHANGE_ID,
  type PredictionMarket,
} from '@prediction-market/shared';
import { normalizeMarket, type PolymarketMarket } from '../packages/polymarket-listener/src/transformers/normalize.js';

const logger = createLogger('backfill-event-ids');

const GAMMA_URL = process.env.POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com';
const PAGE_LIMIT = 100;

async function main() {
  logger.info('Starting backfill of Polymarket event_id for closed markets (streaming)');

  let offset = 0;
  let hasMore = true;
  let totalFetched = 0;
  let totalUpserted = 0;

  while (hasMore) {
    // 1. Fetch one page of closed markets
    const url = new URL(`${GAMMA_URL}/markets`);
    url.searchParams.set('closed', 'true');
    url.searchParams.set('limit', PAGE_LIMIT.toString());
    url.searchParams.set('offset', offset.toString());

    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch closed markets: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as PolymarketMarket[];
    const markets: PolymarketMarket[] = Array.isArray(data) ? data : [];
    totalFetched += markets.length;

    // 2. Normalize and upsert this page immediately
    const dbMarkets: PredictionMarket[] = [];
    for (const market of markets) {
      const normalized = normalizeMarket(market);
      for (const nm of normalized) {
        dbMarkets.push({
          source_id: nm.sourceId,
          exchange_id: nm.exchangeId,
          market_id: nm.marketId,
          event_id: nm.eventId,
          outcome_side: nm.outcomeSide,
          market_name: nm.marketName,
          rules_primary: nm.rulesPrimary,
          category: nm.category,
          price: nm.price,
          end_date: nm.endDate,
          status: nm.status,
          source_specific_data: nm.sourceSpecificData,
        });
      }
    }

    if (dbMarkets.length > 0) {
      await upsertPredictionMarketsBatch(dbMarkets);
      totalUpserted += dbMarkets.length;
    }

    if (totalFetched % 5000 < PAGE_LIMIT) {
      logger.info({ page: offset / PAGE_LIMIT + 1, totalFetched, totalUpserted }, 'Progress');
    }

    // 3. Check if we've reached the end
    if (markets.length < PAGE_LIMIT) {
      hasMore = false;
    } else {
      offset += PAGE_LIMIT;
    }
  }

  logger.info({ totalFetched, totalUpserted }, 'Backfill complete');
  await closePool();
}

main().catch((err) => {
  logger.error({ err }, 'Backfill failed');
  process.exit(1);
});
