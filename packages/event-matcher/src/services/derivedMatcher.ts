import {
  createLogger,
  findExistingCanonicalEventId,
  upsertEventMappingsBatch,
  query,
} from '@prediction-market/shared';
import type { EventMapping } from '@prediction-market/shared';
import type { Config, ExchangePairConfig } from '../config.js';
import { generateCanonicalId } from '../utils/canonicalId.js';

const logger = createLogger('derived-matcher');

interface DerivedEventLink {
  source_event_id: string;
  source_source_id: string;
  target_event_id: string;
  target_source_id: string;
}

/**
 * Derived event matching: infer event_mappings from existing market_mappings.
 *
 * For exchange pairs like Kalshi↔Predict where one exchange provides API links
 * to the other's markets, we can derive event-level mappings by:
 * 1. Finding market_mappings that link markets across the two exchanges
 * 2. Looking up each market's event_id from prediction_markets
 * 3. Creating event_mappings for the event pairs (with transitive canonical grouping)
 *
 * This avoids duplicate AI calls for exchanges that already have reliable links.
 */
export async function runDerivedPairMatching(
  pair: ExchangePairConfig,
  config: Config
): Promise<{ eventMatchesCreated: number; marketsMatched: number }> {
  const sourceLabel = pair.source.exchangeId;
  const targetLabel = pair.target.exchangeId;
  logger.info({ source: sourceLabel, target: targetLabel }, 'Starting derived pair matching');

  try {
    // Find event pairs linked by existing market_mappings across the two exchanges
    const sql = `
      SELECT DISTINCT
        sp.event_id AS source_event_id, sp.source_id AS source_source_id,
        tp.event_id AS target_event_id, tp.source_id AS target_source_id
      FROM direct_exchanges_data.market_mappings sm
      JOIN direct_exchanges_data.market_mappings tm
        ON sm.canonical_market_id = tm.canonical_market_id
        AND tm.exchange_id = $2 AND tm.outcome_side = 'YES'
      JOIN direct_exchanges_data.prediction_markets sp
        ON sm.source_id = sp.source_id AND sm.exchange_id = sp.exchange_id
        AND sm.market_id = sp.market_id AND sm.outcome_side = sp.outcome_side
      JOIN direct_exchanges_data.prediction_markets tp
        ON tm.source_id = tp.source_id AND tm.exchange_id = tp.exchange_id
        AND tm.market_id = tp.market_id AND tm.outcome_side = tp.outcome_side
      LEFT JOIN direct_exchanges_data.event_mappings em_s
        ON sp.source_id = em_s.source_id AND sp.exchange_id = em_s.exchange_id AND sp.event_id = em_s.event_id
        AND em_s.is_active = TRUE
        AND em_s.canonical_event_id IN (
          SELECT canonical_event_id FROM direct_exchanges_data.event_mappings
          WHERE exchange_id = $2 AND is_active = TRUE
        )
      WHERE sm.exchange_id = $1 AND sm.outcome_side = 'YES'
        AND sp.event_id IS NOT NULL AND tp.event_id IS NOT NULL
        AND em_s.event_id IS NULL
    `;

    const result = await query<DerivedEventLink>(sql, [sourceLabel, targetLabel]);
    const eventLinks = result.rows;

    if (eventLinks.length === 0) {
      logger.info({ source: sourceLabel, target: targetLabel }, 'No new event pairs to derive');
      return { eventMatchesCreated: 0, marketsMatched: 0 };
    }

    logger.info({
      eventPairs: eventLinks.length,
      source: sourceLabel,
      target: targetLabel,
    }, 'Found event pairs to derive from market_mappings');

    // Deduplicate by source_event_id + target_event_id
    const seen = new Set<string>();
    const uniqueLinks: DerivedEventLink[] = [];
    for (const link of eventLinks) {
      const key = `${link.source_event_id}:${link.target_event_id}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueLinks.push(link);
      }
    }

    let eventMatchesCreated = 0;

    for (const link of uniqueLinks) {
      // Transitive grouping: check if either event already has a canonical group
      const [existingSourceCanonical, existingTargetCanonical] = await Promise.all([
        findExistingCanonicalEventId(link.source_source_id, sourceLabel, link.source_event_id),
        findExistingCanonicalEventId(link.target_source_id, targetLabel, link.target_event_id),
      ]);

      const canonicalEventId = existingSourceCanonical
        || existingTargetCanonical
        || generateCanonicalId('CE', [
          { exchangeId: sourceLabel, id: link.source_event_id },
          { exchangeId: targetLabel, id: link.target_event_id },
        ]);

      const now = new Date();
      const mappings: EventMapping[] = [
        {
          source_id: link.source_source_id,
          exchange_id: sourceLabel,
          event_id: link.source_event_id,
          canonical_event_id: canonicalEventId,
          confidence_score: 1.0,
          matched_at: now,
          model_id: 'derived-from-market-mappings-v1',
          match_version: config.matchVersion,
        },
        {
          source_id: link.target_source_id,
          exchange_id: targetLabel,
          event_id: link.target_event_id,
          canonical_event_id: canonicalEventId,
          confidence_score: 1.0,
          matched_at: now,
          model_id: 'derived-from-market-mappings-v1',
          match_version: config.matchVersion,
        },
      ];

      await upsertEventMappingsBatch(mappings);
      eventMatchesCreated++;
    }

    logger.info({
      eventMatchesCreated,
      source: sourceLabel,
      target: targetLabel,
    }, 'Derived pair matching complete');

    // No inline market matching for derived pairs — markets are already mapped
    return { eventMatchesCreated, marketsMatched: 0 };
  } catch (err) {
    logger.error({ err, source: sourceLabel, target: targetLabel }, 'Derived pair matching failed');
    return { eventMatchesCreated: 0, marketsMatched: 0 };
  }
}
