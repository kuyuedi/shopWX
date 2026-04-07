import 'dotenv/config';
import {
  createLogger, query, healthCheck, closePool,
  KALSHI_SOURCE_ID, KALSHI_EXCHANGE_ID,
  POLYMARKET_SOURCE_ID, POLYMARKET_EXCHANGE_ID,
  PREDICT_SOURCE_ID, PREDICT_EXCHANGE_ID,
} from '@prediction-market/shared';
import { getConfig } from '../config.js';
import { matchMarketsForSinglePair } from '../services/marketMatcher.js';

const logger = createLogger('backfill-3way-markets');

const SOURCE_ID_MAP: Record<string, string> = {
  KALSHI: KALSHI_SOURCE_ID,
  POLYMARKET: POLYMARKET_SOURCE_ID,
  PREDICT: PREDICT_SOURCE_ID,
};

interface EventInGroup {
  exchange_id: string;
  source_id: string;
  event_id: string;
}

async function main() {
  logger.info('Starting 3-way market backfill');

  const config = getConfig();

  const dbHealthy = await healthCheck();
  if (!dbHealthy) {
    logger.error('Database health check failed, exiting');
    process.exit(1);
  }
  logger.info('Database connected');

  // Find all canonical event groups with 3+ exchanges
  const groupsSql = `
    SELECT canonical_event_id, array_agg(DISTINCT exchange_id) as exchanges
    FROM direct_exchanges_data.event_mappings
    WHERE is_active = TRUE
    GROUP BY canonical_event_id
    HAVING COUNT(DISTINCT exchange_id) >= 3
  `;
  const groupsResult = await query<{ canonical_event_id: string; exchanges: string[] }>(groupsSql);
  logger.info({ groups: groupsResult.rows.length }, 'Found 3+ exchange event groups');

  // For each group, get all events
  let totalPairsProcessed = 0;
  let totalMarketsMatched = 0;

  for (const group of groupsResult.rows) {
    const eventsSql = `
      SELECT exchange_id, source_id, event_id
      FROM direct_exchanges_data.event_mappings
      WHERE canonical_event_id = $1 AND is_active = TRUE
    `;
    const eventsResult = await query<EventInGroup>(eventsSql, [group.canonical_event_id]);
    const events = eventsResult.rows;

    // Run matchMarketsForSinglePair for every pair combination
    for (let i = 0; i < events.length; i++) {
      for (let j = i + 1; j < events.length; j++) {
        const source = events[i]!;
        const target = events[j]!;

        try {
          const matched = await matchMarketsForSinglePair(
            source.source_id,
            source.exchange_id,
            source.event_id,
            target.source_id,
            target.exchange_id,
            target.event_id,
            config
          );

          totalPairsProcessed++;
          totalMarketsMatched += matched;

          if (matched > 0) {
            logger.info({
              canonicalEventId: group.canonical_event_id,
              source: `${source.exchange_id}:${source.event_id}`,
              target: `${target.exchange_id}:${target.event_id}`,
              matched,
            }, 'Matched markets for event pair');
          }
        } catch (err) {
          logger.error({
            err,
            source: `${source.exchange_id}:${source.event_id}`,
            target: `${target.exchange_id}:${target.event_id}`,
          }, 'Failed to match markets for pair');
        }
      }
    }
  }

  logger.info({
    groups: groupsResult.rows.length,
    totalPairsProcessed,
    totalMarketsMatched,
  }, '3-way market backfill complete');

  await closePool();
  process.exit(0);
}

main().catch(async (err) => {
  logger.error({ err }, 'Backfill failed');
  await closePool();
  process.exit(1);
});
