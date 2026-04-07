import {
  createLogger,
  fetchOpenEventsForMatching,
  fetchExistingMappedEventIds,
  fetchMappedEventIdsForPair,
  upsertEventMappingsBatch,
  updateEventMatchCheckedAt,
  findExistingCanonicalEventId,
} from '@prediction-market/shared';
import type { EventMapping, EventForMatching } from '@prediction-market/shared';
import type { Config, ExchangePairConfig } from '../config.js';
import { getExchangePairs } from '../config.js';
import { generateCanonicalId } from '../utils/canonicalId.js';
import { findCandidates } from './preFilter.js';
import { compareEvents } from './aiComparer.js';
import { validateMatch } from './postMatchValidator.js';
import { matchMarketsForSinglePair } from './marketMatcher.js';
import { runCrossEventMatching, runMegaEventMatching } from './crossEventMatcher.js';
import { runDerivedPairMatching } from './derivedMatcher.js';

const logger = createLogger('matching-cycle');

const CONCURRENCY = parseInt(process.env.MATCHER_CONCURRENCY || '20');

export async function runMatchingCycle(config: Config): Promise<void> {
  const cycleStart = Date.now();
  logger.info('Starting matching cycle');

  try {
    const pairs = getExchangePairs().filter(p => p.enabled);
    logger.info({ enabledPairs: pairs.length }, 'Exchange pairs configured');

    let totalMatchesFound = 0;
    let totalMarketsMatched = 0;

    for (const pair of pairs) {
      try {
        if (pair.strategy === 'ai') {
          const result = await runAIPairMatching(pair, config);
          totalMatchesFound += result.matchesFound;
          totalMarketsMatched += result.marketsMatched;
        } else {
          const result = await runDerivedPairMatching(pair, config);
          totalMatchesFound += result.eventMatchesCreated;
          totalMarketsMatched += result.marketsMatched;
        }
      } catch (err) {
        logger.error({
          err,
          source: pair.source.exchangeId,
          target: pair.target.exchangeId,
        }, 'Pair matching failed, continuing with next pair');
      }
    }

    // Phase 2: Cross-event matching (runs after all pairs)
    let crossEventMatched = 0;
    const enablePhase2 = process.env.ENABLE_PHASE2 !== 'false';
    if (enablePhase2) {
      try {
        crossEventMatched = await runCrossEventMatching(config);
        await runMegaEventMatching(config);
      } catch (err) {
        logger.error({ err }, 'Phase 2 cross-event matching encountered an error');
      }
    } else {
      logger.info('Phase 2 cross-event matching disabled (ENABLE_PHASE2=false)');
    }

    const durationMs = Date.now() - cycleStart;
    logger.info({
      durationMs,
      totalMatchesFound,
      totalMarketsMatched,
      crossEventMatched,
    }, 'Matching cycle complete');
  } catch (err) {
    logger.error({ err }, 'Matching cycle failed');
  }
}

/**
 * Run AI-based event matching for a single exchange pair.
 * This is the existing Phase 1 logic, parameterized for any exchange pair.
 */
async function runAIPairMatching(
  pair: ExchangePairConfig,
  config: Config
): Promise<{ matchesFound: number; marketsMatched: number }> {
  const sourceLabel = pair.source.exchangeId;
  const targetLabel = pair.target.exchangeId;
  logger.info({ source: sourceLabel, target: targetLabel }, 'Starting AI pair matching');

  // 1. Fetch open events from both exchanges (sorted by volume DESC)
  const [sourceEvents, targetEvents] = await Promise.all([
    fetchOpenEventsForMatching(pair.source.exchangeId, pair.source.sourceId),
    fetchOpenEventsForMatching(pair.target.exchangeId, pair.target.sourceId),
  ]);

  // Filter out target events with 0 binary markets (non-binary markets are skipped)
  const filteredTargetEvents = targetEvents.filter(e => e.market_count == null || e.market_count > 0);

  logger.info({
    sourceEvents: sourceEvents.length,
    targetEvents: targetEvents.length,
    targetEventsSkippedNoBinaryMarkets: targetEvents.length - filteredTargetEvents.length,
    source: sourceLabel,
    target: targetLabel,
  }, 'Fetched open events');

  if (sourceEvents.length === 0 || filteredTargetEvents.length === 0) {
    logger.warn({ source: sourceLabel, target: targetLabel }, 'No events from one or both exchanges, skipping pair');
    return { matchesFound: 0, marketsMatched: 0 };
  }

  // 2. Fetch already-matched event IDs (pair-aware: only skip events matched to this specific counterpart)
  const { sourceIds: mappedSourceIds, targetIds: mappedTargetIds } =
    await fetchMappedEventIdsForPair(pair.source.exchangeId, pair.target.exchangeId);
  logger.info({
    alreadyMappedSource: mappedSourceIds.size,
    alreadyMappedTarget: mappedTargetIds.size,
  }, 'Fetched existing pair mappings');

  // 3. Filter out events already matched between THIS pair
  const unmatchedSource = sourceEvents.filter(
    e => !mappedSourceIds.has(`${pair.source.exchangeId}:${e.event_id}`)
  );

  const unmatchedTarget = filteredTargetEvents.filter(
    e => !mappedTargetIds.has(`${pair.target.exchangeId}:${e.event_id}`)
  );

  // Apply volume filter
  const volumeFiltered = config.minEventVolume > 0
    ? unmatchedSource.filter(e => e.total_volume >= config.minEventVolume)
    : unmatchedSource;

  // Skip events recently checked with no match (recheck after configured interval)
  const recheckCutoff = new Date(Date.now() - config.recheckIntervalMs);
  const eligibleSource = volumeFiltered.filter(
    e => !e.match_checked_at || e.match_checked_at < recheckCutoff
  );
  const skippedRecentlyChecked = volumeFiltered.length - eligibleSource.length;

  logger.info({
    unmatchedSource: unmatchedSource.length,
    unmatchedTarget: unmatchedTarget.length,
    eligibleSource: eligibleSource.length,
    skippedRecentlyChecked,
    concurrency: CONCURRENCY,
    source: sourceLabel,
    target: targetLabel,
  }, 'Filtered events for matching');

  // 4. Process events with concurrent worker pool
  let matchesFound = 0;
  let aiCallsMade = 0;
  let skippedNoCandidates = 0;
  let totalMarketsMatched = 0;
  const matchedTargetIds = new Set<string>();

  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < eligibleSource.length) {
      const idx = nextIndex++;
      const sourceEvent = eligibleSource[idx]!;

      // Find candidates for this single event (fast, CPU-only)
      const rawCandidates = findCandidates(
        sourceEvent,
        unmatchedTarget,
        config.candidatesPerBatch
      );

      if (rawCandidates.length === 0) {
        skippedNoCandidates++;
        continue;
      }

      // Filter out target events already matched by another worker
      const candidates = rawCandidates
        .map(c => c.event)
        .filter(c => !matchedTargetIds.has(c.event_id));
      if (candidates.length === 0) continue;

      aiCallsMade++;
      const matchResult = await compareEvents(
        sourceEvent,
        candidates,
        config,
        sourceLabel,
        targetLabel
      );

      if (!matchResult) {
        // No match found — mark as checked so we don't retry until recheck interval
        await updateEventMatchCheckedAt(
          sourceEvent.source_id,
          sourceEvent.exchange_id,
          sourceEvent.event_id
        );
        continue;
      }

      // Post-match validation: deterministic checks for false positive patterns
      const validation = validateMatch(
        sourceEvent.title, matchResult.targetEvent.title,
        sourceEvent.end_date, matchResult.targetEvent.end_date,
      );
      if (!validation.valid) {
        logger.info({
          sourceEvent: sourceEvent.event_id,
          targetEvent: matchResult.targetEvent.event_id,
          check: validation.check,
          reason: validation.reason,
          sourceTitle: sourceEvent.title,
          targetTitle: matchResult.targetEvent.title,
        }, 'Event match rejected by post-match validator');
        await updateEventMatchCheckedAt(
          sourceEvent.source_id,
          sourceEvent.exchange_id,
          sourceEvent.event_id
        );
        continue;
      }

      // Check if this target event was already claimed by another concurrent worker
      if (matchedTargetIds.has(matchResult.targetEvent.event_id)) {
        logger.debug({
          sourceEvent: sourceEvent.event_id,
          targetEvent: matchResult.targetEvent.event_id,
        }, 'Target event already matched by another worker, skipping');
        continue;
      }

      matchedTargetIds.add(matchResult.targetEvent.event_id);

      // Transitive grouping: check if either event already belongs to a canonical group
      const [existingSourceCanonical, existingTargetCanonical] = await Promise.all([
        findExistingCanonicalEventId(
          sourceEvent.source_id, sourceEvent.exchange_id, sourceEvent.event_id
        ),
        findExistingCanonicalEventId(
          matchResult.targetEvent.source_id, matchResult.targetEvent.exchange_id, matchResult.targetEvent.event_id
        ),
      ]);

      const canonicalEventId = existingSourceCanonical
        || existingTargetCanonical
        || generateCanonicalId('CE', [
          { exchangeId: pair.source.exchangeId, id: sourceEvent.event_id },
          { exchangeId: pair.target.exchangeId, id: matchResult.targetEvent.event_id },
        ]);

      const now = new Date();
      const mappings: EventMapping[] = [
        {
          source_id: pair.source.sourceId,
          exchange_id: pair.source.exchangeId,
          event_id: sourceEvent.event_id,
          canonical_event_id: canonicalEventId,
          confidence_score: matchResult.result.confidence,
          matched_at: now,
          model_id: config.model,
          match_version: config.matchVersion,
        },
        {
          source_id: pair.target.sourceId,
          exchange_id: pair.target.exchangeId,
          event_id: matchResult.targetEvent.event_id,
          canonical_event_id: canonicalEventId,
          confidence_score: matchResult.result.confidence,
          matched_at: now,
          model_id: config.model,
          match_version: config.matchVersion,
        },
      ];

      await upsertEventMappingsBatch(mappings);
      matchesFound++;

      // Match markets within this event pair immediately
      const marketsMatched = await matchMarketsForSinglePair(
        pair.source.sourceId,
        pair.source.exchangeId,
        sourceEvent.event_id,
        pair.target.sourceId,
        pair.target.exchangeId,
        matchResult.targetEvent.event_id,
        config
      );
      totalMarketsMatched += marketsMatched;
    }
  }

  // Launch workers
  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  logger.info({
    matchesFound,
    aiCallsMade,
    skippedNoCandidates,
    totalSource: sourceEvents.length,
    totalTarget: filteredTargetEvents.length,
    eligibleSource: eligibleSource.length,
    marketsMatched: totalMarketsMatched,
    source: sourceLabel,
    target: targetLabel,
  }, 'AI pair matching complete');

  return { matchesFound, marketsMatched: totalMarketsMatched };
}
