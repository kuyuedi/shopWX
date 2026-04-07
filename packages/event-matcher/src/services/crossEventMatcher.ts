import {
  createLogger,
  fetchUnmatchedMarketsWithEvents,
  fetchMegaEvents,
  markPhase2Checked,
  searchMarketsByEntity,
  upsertMarketMappingsBatch,
  upsertMarketTitleWithExchanges,
  findExistingCanonicalMarketId,
  KALSHI_SOURCE_ID,
  KALSHI_EXCHANGE_ID,
  POLYMARKET_EXCHANGE_ID,
} from '@prediction-market/shared';
import type { MarketForMatching, MarketMapping } from '@prediction-market/shared';
import type { Config } from '../config.js';
import { generateCanonicalId } from '../utils/canonicalId.js';
import { extractEntity, stripAccents } from './preFilter.js';
import { verifyMarketMatch } from './aiComparer.js';

const logger = createLogger('cross-event-matcher');

/**
 * Phase 2 cross-event matching.
 *
 * Handles markets that couldn't be matched within their event pairs:
 * - Date variants: same question under different events on different exchanges
 * - Mega-events: one exchange groups many entities under one event, the other splits by entity
 *
 * Currently searches for unmatched source (Kalshi) markets and finds target (Polymarket) candidates.
 * Parameterized to support additional exchange pairs in future.
 */

/**
 * Normalize an entity name for comparison.
 */
function normalizeEntity(name: string): string {
  return stripAccents(name)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if an extracted entity is a real entity (person, team, company)
 * vs junk like "80% or more", "25+ wins", "Above 1500".
 */
function isValidEntity(raw: string, normalized: string): boolean {
  // Too short after normalization
  if (normalized.length < 3) return false;
  // Purely numeric (after stripping punctuation)
  if (/^\d[\d\s]*$/.test(normalized)) return false;
  // Starts with number (e.g., "25+ wins", "80% or more", "0-5%")
  if (/^\d/.test(normalized)) return false;
  // Threshold/range words (e.g., "Above 1500", "Below 50")
  if (/^(above|below|under|over|more|less|at least|at most|between|within)\b/i.test(normalized)) return false;
  // Contains percentage or plus sign in raw form
  if (/[%+]/.test(raw)) return false;
  // Range pattern in raw form (e.g., "0-5%", "1500-2000")
  if (/\d+\s*[-–—]\s*\d+/.test(raw)) return false;
  // Too many words (real entities are 1-4 words: "Gustavo Petro", "Oklahoma City Thunder")
  if (normalized.split(' ').length > 5) return false;
  return true;
}

/**
 * Run Phase 2: Cross-event matching for unmatched markets.
 *
 * Strategy:
 * 1. Fetch all unmatched source (Kalshi) YES markets with event info
 * 2. For each market, extract the entity name (text after "—" in title)
 * 3. Search target exchange (Polymarket) for markets containing that entity name
 * 4. Use AI verification to confirm matches
 * 5. Write market_mappings for confirmed matches
 */
export async function runCrossEventMatching(
  config: Config,
  sourceExchangeId: string = KALSHI_EXCHANGE_ID,
  targetExchangeId: string = POLYMARKET_EXCHANGE_ID
): Promise<number> {
  const startTime = Date.now();
  logger.info({ sourceExchangeId, targetExchangeId }, 'Starting Phase 2: cross-event matching');

  try {
    // Fetch unmatched source markets with event info
    const unmatchedSource = await fetchUnmatchedMarketsWithEvents(sourceExchangeId);

    if (unmatchedSource.length === 0) {
      logger.info({ sourceExchangeId }, 'No unmatched markets for cross-event matching');
      return 0;
    }

    logger.info({ count: unmatchedSource.length, sourceExchangeId }, 'Unmatched source markets found');

    // Group by entity name to avoid redundant searches
    const entityGroups = new Map<string, typeof unmatchedSource>();
    let totalExtracted = 0;

    for (const market of unmatchedSource) {
      const entity = extractEntity(market.title || '');
      if (!entity) continue;
      totalExtracted++;

      const normEntity = normalizeEntity(entity);
      if (!isValidEntity(entity, normEntity)) continue;

      if (!entityGroups.has(normEntity)) {
        entityGroups.set(normEntity, []);
      }
      entityGroups.get(normEntity)!.push(market);
    }

    logger.info({
      uniqueEntities: entityGroups.size,
      totalExtracted,
      filtered: totalExtracted - entityGroups.size,
    }, 'Extracted unique entities from unmatched markets');

    // Step A: Sequential DB lookups — build work queue
    const workQueue: Array<{ sourceMarket: MarketForMatching; targetCandidates: MarketForMatching[] }> = [];
    let entitiesWithCandidates = 0;
    let entityCount = 0;

    for (const [normEntity, sourceMarkets] of entityGroups) {
      entityCount++;
      const rawEntity = extractEntity(sourceMarkets[0]!.title || '') || normEntity;
      const targetCandidates = await searchMarketsByEntity(targetExchangeId, rawEntity);

      if (entityCount % 1000 === 0) {
        logger.info({ processed: entityCount, total: entityGroups.size }, 'Phase 2 entity search progress');
      }

      if (targetCandidates.length === 0) {
        logger.debug({ entity: rawEntity }, 'No target candidates found for entity');
        continue;
      }

      entitiesWithCandidates++;
      for (const market of sourceMarkets) {
        workQueue.push({ sourceMarket: market, targetCandidates });
      }
    }

    logger.info({
      entitiesWithCandidates,
      workQueueSize: workQueue.length,
    }, 'Phase 2 DB lookups complete, starting AI verification');

    // Step B: Concurrent AI verification
    const PHASE2_CONCURRENCY = parseInt(process.env.MATCHER_PHASE2_CONCURRENCY || '100', 10);
    let nextIdx = 0;
    let totalMatched = 0;
    const matchedTargetIds = new Set<string>();

    async function phase2Worker(): Promise<void> {
      while (nextIdx < workQueue.length) {
        const idx = nextIdx++;
        const item = workQueue[idx];
        if (!item) break;
        const { sourceMarket, targetCandidates } = item;

        const matched = await findBestTargetMatch(
          sourceMarket, targetCandidates, config, sourceExchangeId, targetExchangeId
        );
        if (matched && !matchedTargetIds.has(matched.targetMarket.market_id)) {
          matchedTargetIds.add(matched.targetMarket.market_id);
          await writeMarketMapping(
            sourceMarket, matched.targetMarket, matched.confidence, config,
            sourceExchangeId, targetExchangeId
          );
          totalMatched++;
        }

        // Mark immediately so restarts don't recheck
        await markPhase2Checked(sourceMarket.source_id, sourceExchangeId, [sourceMarket.market_id]);

        if (idx % 100 === 0 && idx > 0) {
          logger.info({ processed: idx, total: workQueue.length, matched: totalMatched }, 'Phase 2 progress');
        }
      }
    }

    const workers = Array.from({ length: PHASE2_CONCURRENCY }, () => phase2Worker());
    await Promise.all(workers);

    const durationMs = Date.now() - startTime;
    logger.info({
      durationMs,
      totalMatched,
      entitiesSearched: entityGroups.size,
      entitiesWithCandidates,
      workQueueSize: workQueue.length,
      sourceExchangeId,
      targetExchangeId,
    }, 'Phase 2 cross-event matching complete');

    return totalMatched;
  } catch (err) {
    logger.error({ err }, 'Phase 2 cross-event matching failed');
    return 0;
  }
}

/**
 * Run Phase 2b: Mega-event decomposition (logging only).
 * Actual matching is handled by runCrossEventMatching.
 */
export async function runMegaEventMatching(
  config: Config,
  exchangeId: string = KALSHI_EXCHANGE_ID
): Promise<number> {
  const startTime = Date.now();
  logger.info({ exchangeId }, 'Starting Phase 2b: mega-event decomposition');

  try {
    const megaEvents = await fetchMegaEvents(exchangeId);

    if (megaEvents.length === 0) {
      logger.info('No mega-events found');
      return 0;
    }

    logger.info({ count: megaEvents.length }, 'Mega-events found');

    // Log mega-events for visibility
    for (const evt of megaEvents) {
      logger.info({
        eventId: evt.event_id,
        title: evt.title,
        marketCount: evt.market_count,
        volume: evt.total_volume,
      }, 'Mega-event detected');
    }

    // The cross-event matcher already handles these — no separate logic needed
    return 0;
  } catch (err) {
    logger.error({ err }, 'Mega-event decomposition failed');
    return 0;
  }
}

/**
 * Find the best target match for a source market from a list of candidates.
 * Uses AI verification for confidence.
 */
async function findBestTargetMatch(
  sourceMarket: MarketForMatching,
  targetCandidates: MarketForMatching[],
  config: Config,
  sourceExchangeId: string,
  targetExchangeId: string
): Promise<{ targetMarket: MarketForMatching; confidence: number } | null> {
  const sourceEntity = extractEntity(sourceMarket.title || '');
  if (!sourceEntity) return null;

  const normSourceEntity = normalizeEntity(sourceEntity);

  // Filter candidates whose title contains the entity name
  const relevant = targetCandidates.filter(t => {
    const normTargetTitle = normalizeEntity(t.title || '');
    return normTargetTitle.includes(normSourceEntity);
  });

  if (relevant.length === 0) return null;

  // Cap candidates to avoid excessive AI calls
  const MAX_CANDIDATES = 5;
  const capped = relevant.slice(0, MAX_CANDIDATES);

  // Verify candidates concurrently and pick the best match
  const results = await Promise.all(
    capped.map(async (candidate) => {
      const result = await verifyMarketMatch(
        sourceMarket, candidate, 0.5, config, sourceExchangeId, targetExchangeId
      );
      return { candidate, result };
    })
  );

  let bestMatch: { targetMarket: MarketForMatching; confidence: number } | null = null;
  for (const { candidate, result } of results) {
    if (result.match && result.confidence >= 0.8) {
      if (!bestMatch || result.confidence > bestMatch.confidence) {
        bestMatch = { targetMarket: candidate, confidence: result.confidence };
      }
    }
  }

  return bestMatch;
}

/**
 * Write market mapping for a cross-event match.
 */
async function writeMarketMapping(
  sourceMarket: MarketForMatching,
  targetMarket: MarketForMatching,
  confidence: number,
  config: Config,
  sourceExchangeId: string,
  targetExchangeId: string
): Promise<void> {
  // Transitive grouping: check if either market already has a canonical ID
  const [existingSourceCanonical, existingTargetCanonical] = await Promise.all([
    findExistingCanonicalMarketId(sourceMarket.source_id, sourceExchangeId, sourceMarket.market_id),
    findExistingCanonicalMarketId(targetMarket.source_id, targetExchangeId, targetMarket.market_id),
  ]);

  const canonicalMarketId = existingSourceCanonical
    || existingTargetCanonical
    || generateCanonicalId('CM', [
      { exchangeId: sourceExchangeId, id: sourceMarket.market_id },
      { exchangeId: targetExchangeId, id: targetMarket.market_id },
    ]);

  const now = new Date();
  const modelId = 'cross-event-ai-v1';

  const mappings: MarketMapping[] = [
    {
      source_id: sourceMarket.source_id,
      exchange_id: sourceExchangeId,
      market_id: sourceMarket.market_id,
      outcome_side: 'YES',
      canonical_market_id: canonicalMarketId,
      confidence_score: confidence,
      matched_at: now,
      model_id: modelId,
      match_version: config.matchVersion,
    },
    {
      source_id: sourceMarket.source_id,
      exchange_id: sourceExchangeId,
      market_id: sourceMarket.market_id,
      outcome_side: 'NO',
      canonical_market_id: canonicalMarketId,
      confidence_score: confidence,
      matched_at: now,
      model_id: modelId,
      match_version: config.matchVersion,
    },
    {
      source_id: targetMarket.source_id,
      exchange_id: targetExchangeId,
      market_id: targetMarket.market_id,
      outcome_side: 'YES',
      canonical_market_id: canonicalMarketId,
      confidence_score: confidence,
      matched_at: now,
      model_id: modelId,
      match_version: config.matchVersion,
    },
    {
      source_id: targetMarket.source_id,
      exchange_id: targetExchangeId,
      market_id: targetMarket.market_id,
      outcome_side: 'NO',
      canonical_market_id: canonicalMarketId,
      confidence_score: confidence,
      matched_at: now,
      model_id: modelId,
      match_version: config.matchVersion,
    },
  ];

  await upsertMarketMappingsBatch(mappings);

  // Generate title from source market
  const title = sourceMarket.outcome_name &&
    sourceMarket.outcome_name.toLowerCase() !== 'yes' &&
    sourceMarket.outcome_name.toLowerCase() !== 'no'
    ? sourceMarket.outcome_name
    : sourceMarket.title || 'Unknown Market';

  const exchangeTitles: Record<string, string> = {
    [sourceExchangeId]: sourceMarket.title || '',
    [targetExchangeId]: targetMarket.title || '',
  };
  await upsertMarketTitleWithExchanges(canonicalMarketId, title, exchangeTitles, modelId);

  logger.info({
    sourceMarket: sourceMarket.market_id,
    targetMarket: targetMarket.market_id,
    sourceTitle: sourceMarket.title,
    targetTitle: targetMarket.title,
    confidence,
    canonicalMarketId,
  }, 'Cross-event market match written');
}
