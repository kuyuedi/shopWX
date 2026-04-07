/**
 * Backfill script: re-run market matching for all matched event pairs.
 *
 * Finds event pairs (from event_mappings) that have unmatched markets
 * and runs matchMarketsForSinglePair for each.
 *
 * Usage (from server):
 *   cd /opt/prediction-market-ingestion
 *   npx tsx scripts/backfill-market-matching.ts
 */
import 'dotenv/config';
import {
  createLogger,
  closePool,
  fetchMatchedEventPairsForMarketMatching,
} from '@prediction-market/shared';
import { matchMarketsForSinglePair } from '../packages/event-matcher/src/services/marketMatcher.js';
import { getConfig } from '../packages/event-matcher/src/config.js';

const logger = createLogger('backfill-market-matching');

async function main() {
  const config = getConfig();
  const pairs = await fetchMatchedEventPairsForMarketMatching();
  logger.info({ totalPairs: pairs.length }, 'Fetched matched event pairs');

  let totalMatched = 0;
  let pairsWithNewMatches = 0;

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]!;
    const matched = await matchMarketsForSinglePair(
      pair.kalshi_source_id,
      pair.kalshi_event_id,
      pair.poly_source_id,
      pair.poly_event_id,
      config
    );

    if (matched > 0) {
      totalMatched += matched;
      pairsWithNewMatches++;
      logger.info({
        progress: `${i + 1}/${pairs.length}`,
        kalshiEvent: pair.kalshi_event_id,
        polyEvent: pair.poly_event_id,
        matched,
      }, 'New market matches found');
    }

    if ((i + 1) % 50 === 0) {
      logger.info({
        progress: `${i + 1}/${pairs.length}`,
        totalMatched,
        pairsWithNewMatches,
      }, 'Progress');
    }
  }

  logger.info({
    totalPairs: pairs.length,
    pairsWithNewMatches,
    totalMatched,
  }, 'Backfill complete');

  await closePool();
}

main().catch((err) => {
  logger.error({ err }, 'Backfill failed');
  process.exit(1);
});
