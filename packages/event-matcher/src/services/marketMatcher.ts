import {
  createLogger,
  fetchMarketsForEvent,
  fetchMappedMarketIdsForPair,
  upsertMarketMappingsBatch,
  upsertMarketTitleWithExchanges,
  findExistingCanonicalMarketId,
} from '@prediction-market/shared';
import type { MarketForMatching, MarketMapping } from '@prediction-market/shared';
import type { Config } from '../config.js';
import { generateCanonicalId } from '../utils/canonicalId.js';
import { verifyMarketMatch, verifyModifierConflict } from './aiComparer.js';
import { validateMatch } from './postMatchValidator.js';
import { stripAccents, normalizeSynonyms } from './preFilter.js';

const logger = createLogger('market-matcher');

interface MarketPair {
  source: MarketForMatching;
  target: MarketForMatching;
  similarity: number;
}

// ── Abbreviation expansion ──

const ABBREVIATION_MAP: Record<string, string> = {
  'man city': 'manchester city',
  'man utd': 'manchester united',
  'man united': 'manchester united',
  'spurs': 'tottenham hotspur',
  'wolves': 'wolverhampton wanderers',
  'barca': 'barcelona',
  'atleti': 'atletico madrid',
  'inter': 'inter milan',
  'bayern': 'bayern munich',
  'psg': 'paris saint germain',
  'rb leipzig': 'rasenballsport leipzig',
  'dortmund': 'borussia dortmund',
  'lakers': 'los angeles lakers',
  'celtics': 'boston celtics',
  'niners': 'san francisco 49ers',
  'bucs': 'tampa bay buccaneers',
  'pats': 'new england patriots',
};

function expandAbbreviations(text: string): string {
  let result = text.toLowerCase();
  for (const [abbr, full] of Object.entries(ABBREVIATION_MAP)) {
    const re = new RegExp('\\b' + abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
    result = result.replace(re, full);
  }
  return result;
}

const FILLER_WORDS = new Set(['exactly', 'least', 'most', 'approximately', 'about', 'around']);

// ── Market structural type classification (Fix A) ──

export type MarketStructuralType =
  | 'BINARY'
  | 'WIN'
  | 'DRAW'
  | 'SPREAD'
  | 'OVER_UNDER'
  | 'BTTS'
  | 'CORRECT_SCORE'
  | 'FIRST_HALF'
  | 'WIN_METHOD'
  | 'ROUND'
  | 'RANGE_BUCKET'
  | 'MARGIN'
  | 'META'
  | 'UNKNOWN';

export function classifyMarketType(title: string): MarketStructuralType {
  const lower = title.toLowerCase();

  if (/\b(spread|handicap)\b/.test(lower) || /[+-]\d+\.5/.test(lower)) return 'SPREAD';
  if (/\b(over|under)\s+\d+\.?\d*\s*(goals?|points?|runs?|total)/i.test(lower)) return 'OVER_UNDER';
  if (/\btotal\s+(goals?|points?|runs?)\b/i.test(lower)) return 'OVER_UNDER';
  if (/\bboth teams to score\b/i.test(lower) || /\bBTTS\b/.test(title)) return 'BTTS';
  if (/\bcorrect score\b/i.test(lower)) return 'CORRECT_SCORE';
  if (/\b(halftime|half-time|first half|leading at half)\b/i.test(lower)) return 'FIRST_HALF';
  if (/\bNRFI\b/i.test(title) || /\bno run first inning\b/i.test(lower)) return 'FIRST_HALF';
  if (/\bclean sheet\b/i.test(lower)) return 'BTTS';
  if (/\b(draw|tie|tied)\b/.test(lower)) return 'DRAW';
  if (/\bby (KO|TKO|knockout|submission|decision|stoppage|split decision|unanimous|majority)\b/i.test(lower)) return 'WIN_METHOD';
  if (/\b(round \d|go the distance|ends in round)\b/i.test(lower)) return 'ROUND';
  if (/\d+[\s-]+\d+/.test(title) && /\b(above|below|between|range|bucket)\b/i.test(lower)) return 'RANGE_BUCKET';
  if (/\b(margin|win by \d)/i.test(lower)) return 'MARGIN';
  // META: markets about whether the event happens, not about the outcome
  if (/\b(completed match|match completed|game completed|will .+ be completed)\b/i.test(lower)) return 'META';
  if (/\b(postponed|cancelled|canceled|rained out|rain delay)\b/i.test(lower)) return 'META';
  if (/\b(win|winner|wins)\b/i.test(lower)) return 'WIN';
  // Bare "{Team} vs. {Team}" or "{Team} vs {Team}" without any other qualifier is a moneyline/winner market
  // (e.g., Predict titles: "Boston Red Sox vs. Houston Astros")
  if (/^[A-Z][\w\s.''()-]+\bvs\.?\s+[A-Z][\w\s.''()-]+$/i.test(title.trim()) && !/\b(NRFI|total|spread|over|under|score|half|quarter)\b/i.test(lower)) return 'WIN';

  return 'UNKNOWN';
}

export function areMarketTypesCompatible(type1: MarketStructuralType, type2: MarketStructuralType): boolean {
  if (type1 === 'UNKNOWN' || type2 === 'UNKNOWN') return true;
  if (type1 === 'BINARY' || type2 === 'BINARY') return true;
  return type1 === type2;
}

// ── Modifier guard (Fix B5) ──

type ModifierTier = 'AUTO_REJECT' | 'AI_VERIFY';

interface ModifierRule {
  category: string;
  tier: ModifierTier;
  patterns: RegExp[];
}

const MODIFIER_RULES: ModifierRule[] = [
  // TIER 1: Auto-reject
  {
    category: 'WIN_METHOD',
    tier: 'AUTO_REJECT',
    patterns: [
      /\bby KO\b/i, /\bby TKO\b/i, /\bby knockout\b/i,
      /\bby submission\b/i, /\bby decision\b/i, /\bby stoppage\b/i,
      /\bby split decision\b/i, /\bby unanimous\b/i, /\bby majority\b/i,
    ],
  },
  {
    category: 'MARKET_TYPE_SPORTS',
    tier: 'AUTO_REJECT',
    patterns: [
      /\bboth teams to score\b/i, /\bBTTS\b/,
      /\btotal goals\b/i, /\bover \d+\.?\d* goals\b/i, /\bunder \d+\.?\d* goals\b/i,
      /\bhalftime\b/i, /\bhalf-time\b/i, /\bleading at half\b/i,
      /\bclean sheet\b/i,
    ],
  },
  {
    category: 'SCOPE_QUALIFIER',
    tier: 'AUTO_REJECT',
    patterns: [
      /\bor any of its\b/i, /\baffiliates?\b/i, /\bsubsidiaries?\b/i,
    ],
  },
  // TIER 2: AI-verify
  {
    category: 'RANGE_QUALIFIER',
    tier: 'AI_VERIFY',
    patterns: [
      /\bor fewer\b/i, /\bor more\b/i, /\bor less\b/i, /\bor above\b/i,
      /\bat least\b/i, /\bat most\b/i,
      /\bfewer than\b/i, /\bmore than\b/i, /\bgreater than\b/i,
      /\bno more than\b/i, /\bno fewer than\b/i,
    ],
  },
  {
    category: 'TIME_SCOPE',
    tier: 'AI_VERIFY',
    patterns: [
      /\bby (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*/i,
      /\bbefore (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*/i,
      /\bin (Q[1-4])\b/i, /\bbefore (Q[1-4])\b/i,
      /\bin 202[4-9]\b/i, /\bin 203\d\b/i,
      /\bbefore 202[4-9]\b/i, /\bbefore 203\d\b/i,
      /\bby 202[4-9]\b/i, /\bby 203\d\b/i,
    ],
  },
];

export async function checkModifierConflict(
  sourceTitle: string,
  targetTitle: string,
  config: Config
): Promise<{ reject: boolean; reason?: string }> {
  for (const rule of MODIFIER_RULES) {
    const sHas = rule.patterns.some(p => p.test(sourceTitle));
    const tHas = rule.patterns.some(p => p.test(targetTitle));

    if (sHas === tHas) continue;

    if (rule.tier === 'AUTO_REJECT') {
      logger.debug({
        category: rule.category,
        sourceTitle,
        targetTitle,
      }, 'Modifier guard: auto-reject');
      return { reject: true, reason: `${rule.category}: auto-reject` };
    }

    if (rule.tier === 'AI_VERIFY') {
      const aiResult = await verifyModifierConflict(sourceTitle, targetTitle, config);
      if (aiResult === 'DIFFERENT') {
        logger.debug({
          category: rule.category,
          sourceTitle,
          targetTitle,
        }, 'Modifier guard: AI-rejected');
        return { reject: true, reason: `${rule.category}: AI-rejected` };
      }
      logger.debug({
        category: rule.category,
        sourceTitle,
        targetTitle,
      }, 'Modifier guard: AI-approved');
    }
  }
  return { reject: false };
}

// ── Substring matching (primary strategy) ──

/**
 * Extract outcome name from a market title by splitting on " — " (em-dash).
 * e.g. "Will OKC win the 2026 Pro Basketball Finals? — Oklahoma City" → "Oklahoma City"
 * Works for Kalshi-style titles. Other exchanges may use the full title.
 * Returns null if no em-dash found.
 */
function extractOutcomeName(title: string): string | null {
  const dashIndex = title.indexOf(' — ');
  if (dashIndex === -1) return null;
  const name = title.substring(dashIndex + 3).trim();
  return name.length > 0 ? name : null;
}

/**
 * Check if a source outcome name is a substring of a target title.
 * Handles special case: "Tie" matches "draw".
 */
export function substringMatch(sourceName: string, targetTitle: string): boolean {
  const normName = normalizeOutcomeName(sourceName);
  const normTarget = normalizeOutcomeName(targetTitle);

  // Forward: source name found in target title
  if (normName.length <= 4) {
    const escaped = normName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('\\b' + escaped + '\\b', 'i');
    if (re.test(normTarget)) return true;
  } else {
    if (normTarget.includes(normName)) return true;
  }

  // Reverse: target entity found in source name
  if (normTarget.length <= 4) {
    const escaped = normTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('\\b' + escaped + '\\b', 'i');
    if (re.test(normName)) return true;
  } else {
    if (normName.includes(normTarget)) return true;
  }

  // Special case: tie ↔ draw
  if (normName === 'tie' && /\bdraw\b/.test(normTarget)) return true;
  if (normName === 'draw' && /\btie\b/.test(normTarget)) return true;

  return false;
}

/**
 * Greedy substring matching: for each source market, extract the outcome name
 * after "—" and find target markets containing that name as a substring.
 * Returns matched pairs and the IDs of markets that were matched.
 */
function greedySubstringMatch(
  sourceMarkets: MarketForMatching[],
  targetMarkets: MarketForMatching[]
): MarketPair[] {
  const usedTargetIds = new Set<string>();
  const matches: MarketPair[] = [];

  for (const source of sourceMarkets) {
    const outcomeName = extractOutcomeName(source.title || '');
    if (!outcomeName) continue;

    // Find all target candidates that contain this outcome name
    const candidates = targetMarkets.filter(
      t => !usedTargetIds.has(t.market_id) && substringMatch(outcomeName, t.title || '')
    );

    if (candidates.length === 0) continue;

    let bestTarget: MarketForMatching;
    if (candidates.length === 1) {
      // Single candidate — verify outcome types are compatible
      const sourceType = classifyOutcome(source.title || '', outcomeName);
      const targetType = classifyOutcome(candidates[0]!.title || '', outcomeName);
      if (sourceType !== 'UNKNOWN' && targetType !== 'UNKNOWN' && sourceType !== targetType) {
        continue; // Outcome type mismatch (e.g., Win↔Draw) — skip to Jaccard/AI
      }
      bestTarget = candidates[0]!;
    } else {
      // Multiple matches — disambiguate by outcome type
      const sourceType = classifyOutcome(source.title || '', outcomeName);

      if (sourceType !== 'UNKNOWN') {
        const best = candidates.find(c =>
          classifyOutcome(c.title || '', outcomeName) === sourceType
        );
        if (best) {
          bestTarget = best;
        } else {
          continue; // No outcome-type match — fall through to Jaccard/AI
        }
      } else {
        // Non-sports ambiguous case — fall back to price tiebreaker
        const sourcePrice = source.price ?? 0.5;
        bestTarget = candidates.reduce((best, c) => {
          const bestDiff = Math.abs((best.price ?? 0.5) - sourcePrice);
          const cDiff = Math.abs((c.price ?? 0.5) - sourcePrice);
          return cDiff < bestDiff ? c : best;
        });
      }
    }

    // Check structural type compatibility (Fix A)
    const sStructType = classifyMarketType(source.title || '');
    const tStructType = classifyMarketType(bestTarget.title || '');
    if (!areMarketTypesCompatible(sStructType, tStructType)) {
      continue;
    }

    matches.push({ source, target: bestTarget, similarity: 1.0 });
    usedTargetIds.add(bestTarget.market_id);
  }

  return matches;
}

/**
 * Normalize an outcome name for comparison:
 * Fix 3c: strip accents, lowercase, strip punctuation, collapse whitespace, trim.
 */
function normalizeOutcomeName(name: string): string {
  let result = stripAccents(name)
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  result = expandAbbreviations(result);
  result = normalizeSynonyms(result);

  // Strip numeric-only tokens and filler words
  result = result.split(' ')
    .filter(token => {
      if (/^\d+$/.test(token)) return false;
      if (FILLER_WORDS.has(token)) return false;
      return true;
    })
    .join(' ');

  return result;
}

/**
 * Classify a market's outcome type for disambiguation in multi-outcome events.
 * Used when substring matching finds multiple target candidates for a single
 * source market (e.g., Win vs Draw in 3-way sports events).
 */
function classifyOutcome(title: string, entity: string): 'WIN' | 'DRAW' | 'OTHER_WIN' | 'UNKNOWN' {
  const lower = title.toLowerCase();
  const entityLower = entity.toLowerCase();

  // Title contains draw/tie keywords
  if (/\b(draw|tie|tied)\b/.test(lower)) return 'DRAW';

  // Entity is the subject of "will X win" → WIN
  if (lower.includes(entityLower) && /\b(win|winner)\b/.test(lower))
    return 'WIN';

  // Kalshi pattern: entity after dash = that team wins
  const dashMatch = title.match(/\u2014\s*(.+)$/);
  if (dashMatch && normalizeOutcomeName(dashMatch[1]!.trim()) === normalizeOutcomeName(entity))
    return 'WIN';

  // Another team is the subject of "win" → OTHER_WIN
  if (!lower.includes(entityLower) && /\b(win|winner)\b/.test(lower))
    return 'OTHER_WIN';

  return 'UNKNOWN';
}

/**
 * Extract the differentiating part of a market for matching.
 * Prefers outcome_name (if descriptive), falls back to title.
 */
function extractDifferentiator(market: MarketForMatching): string {
  if (
    market.outcome_name &&
    market.outcome_name.toLowerCase() !== 'yes' &&
    market.outcome_name.toLowerCase() !== 'no'
  ) {
    return market.outcome_name;
  }
  return market.title || '';
}

/**
 * Compute Jaccard token similarity between two strings (0-1).
 */
function computeSimilarity(a: string, b: string): number {
  const tokensA = new Set(normalizeOutcomeName(a).split(' ').filter(Boolean));
  const tokensB = new Set(normalizeOutcomeName(b).split(' ').filter(Boolean));

  if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
  if (tokensA.size === 0 || tokensB.size === 0) return 0.0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }

  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Generate a title for the matched market pair.
 * Uses outcome_name from source if descriptive, falls back to source title.
 */
function generateTitle(source: MarketForMatching): string {
  if (
    source.outcome_name &&
    source.outcome_name.toLowerCase() !== 'yes' &&
    source.outcome_name.toLowerCase() !== 'no'
  ) {
    return source.outcome_name;
  }
  return source.title || 'Unknown Market';
}

/**
 * Match markets within a single matched event pair.
 * Called immediately after an event match is found.
 * Parameterized for any exchange pair — uses source/target instead of kalshi/poly.
 */
export async function matchMarketsForSinglePair(
  sourceSourceId: string,
  sourceExchangeId: string,
  sourceEventId: string,
  targetSourceId: string,
  targetExchangeId: string,
  targetEventId: string,
  config: Config
): Promise<number> {
  try {
    // Fetch YES-side open markets from both exchanges
    const [sourceMarkets, targetMarkets] = await Promise.all([
      fetchMarketsForEvent(sourceSourceId, sourceExchangeId, sourceEventId, 'YES'),
      fetchMarketsForEvent(targetSourceId, targetExchangeId, targetEventId, 'YES'),
    ]);

    if (sourceMarkets.length === 0 || targetMarkets.length === 0) {
      logger.debug({
        sourceEventId,
        targetEventId,
        sourceMarkets: sourceMarkets.length,
        targetMarkets: targetMarkets.length,
      }, 'No markets on one or both sides, skipping');
      return 0;
    }

    // Fetch market IDs already matched between THIS specific exchange pair
    const { sourceIds: mappedSourceIds, targetIds: mappedTargetIds } =
      await fetchMappedMarketIdsForPair(sourceExchangeId, targetExchangeId);
    const unmappedSource = sourceMarkets.filter(m => !mappedSourceIds.has(m.market_id));
    const unmappedTarget = targetMarkets.filter(m => !mappedTargetIds.has(m.market_id));

    if (unmappedSource.length === 0 || unmappedTarget.length === 0) {
      return 0;
    }

    // Match markets using multi-tier approach:
    // 0. Binary (1:1): auto-match at confidence 1.0
    // 1. Substring matching (primary): extract outcome name after "—" from source titles
    // 2. Jaccard >= marketMatchThreshold (0.5): auto-accept (fallback)
    // 3. Jaccard >= marketMatchAiThreshold (0.3): AI verification (fallback)
    interface VerifiedPair extends MarketPair {
      modelId: string;
    }

    const verified: VerifiedPair[] = [];

    if (unmappedSource.length === 1 && unmappedTarget.length === 1) {
      // Binary (1:1) auto-match — but guard against outcome-type mismatches
      const s = unmappedSource[0]!;
      const t = unmappedTarget[0]!;
      const entity = extractOutcomeName(s.title || '');
      let compatible = true;
      if (entity) {
        const sType = classifyOutcome(s.title || '', entity);
        const tType = classifyOutcome(t.title || '', entity);
        if (sType !== 'UNKNOWN' && tType !== 'UNKNOWN' && sType !== tType) {
          compatible = false;
        }
      }
      // Fix A: structural type compatibility check
      if (compatible) {
        const sStructType = classifyMarketType(s.title || '');
        const tStructType = classifyMarketType(t.title || '');
        if (!areMarketTypesCompatible(sStructType, tStructType)) {
          compatible = false;
          logger.debug({ sStructType, tStructType, sTitle: s.title, tTitle: t.title },
            'Binary match rejected: incompatible market types');
        }
      }
      if (compatible) {
        verified.push({
          source: s,
          target: t,
          similarity: 1.0,
          modelId: 'algorithmic-v1',
        });
      }
    } else {
      // Tier 1: Substring matching (primary strategy)
      const substringMatched = greedySubstringMatch(unmappedSource, unmappedTarget);
      for (const m of substringMatched) {
        verified.push({ ...m, modelId: 'substring-v1' });
        logger.debug({
          sourceMarket: m.source.market_id,
          targetMarket: m.target.market_id,
          sourceTitle: m.source.title,
          targetTitle: m.target.title,
        }, 'Market matched via substring');
      }

      // Collect remaining unmatched markets for Jaccard fallback
      const usedSourceIds = new Set(substringMatched.map(m => m.source.market_id));
      const usedTargetIds = new Set(substringMatched.map(m => m.target.market_id));
      let remainingSource = unmappedSource.filter(m => !usedSourceIds.has(m.market_id));
      let remainingTarget = unmappedTarget.filter(m => !usedTargetIds.has(m.market_id));

      // Tier 2: Jaccard auto-accept (fallback for markets without "—" pattern)
      if (remainingSource.length > 0 && remainingTarget.length > 0) {
        const autoAccepted = greedyMatch(remainingSource, remainingTarget, config.marketMatchThreshold);
        for (const m of autoAccepted) {
          verified.push({ ...m, modelId: 'algorithmic-v1' });
        }

        const usedSource2 = new Set(autoAccepted.map(m => m.source.market_id));
        const usedTarget2 = new Set(autoAccepted.map(m => m.target.market_id));
        remainingSource = remainingSource.filter(m => !usedSource2.has(m.market_id));
        remainingTarget = remainingTarget.filter(m => !usedTarget2.has(m.market_id));
      }

      // Tier 3: AI-verify borderline Jaccard matches
      if (remainingSource.length > 0 && remainingTarget.length > 0) {
        const borderline = greedyMatch(remainingSource, remainingTarget, config.marketMatchAiThreshold);

        for (const pair of borderline) {
          // Fix A: skip incompatible structural types before AI call
          const sStructType = classifyMarketType(pair.source.title || '');
          const tStructType = classifyMarketType(pair.target.title || '');
          if (!areMarketTypesCompatible(sStructType, tStructType)) {
            continue;
          }
          const result = await verifyMarketMatch(
            pair.source, pair.target, pair.similarity, config,
            sourceExchangeId, targetExchangeId
          );
          if (result.match && result.confidence >= 0.8) {
            verified.push({ ...pair, similarity: result.confidence, modelId: 'ai-verified-v1' });
            logger.info({
              sourceMarket: pair.source.market_id,
              targetMarket: pair.target.market_id,
              jaccardScore: pair.similarity,
              aiConfidence: result.confidence,
              reasoning: result.reasoning,
            }, 'Borderline market match verified by AI');
          } else {
            logger.debug({
              sourceMarket: pair.source.market_id,
              targetMarket: pair.target.market_id,
              jaccardScore: pair.similarity,
              aiMatch: result.match,
              aiConfidence: result.confidence,
            }, 'Borderline market match rejected by AI');
          }
        }
      }
    }

    // Write results — apply modifier guard before DB write
    let marketsMatched = 0;
    for (const match of verified) {
      // Fix B5: modifier guard check
      const modifierCheck = await checkModifierConflict(
        match.source.title || '',
        match.target.title || '',
        config
      );
      if (modifierCheck.reject) {
        logger.info({
          sourceMarket: match.source.market_id,
          targetMarket: match.target.market_id,
          reason: modifierCheck.reason,
          sourceTitle: match.source.title,
          targetTitle: match.target.title,
        }, 'Match rejected by modifier guard');
        continue;
      }

      // Post-match validation: deterministic checks for false positive patterns
      // Pass expires_at so EXPIRY_DIVERGENCE check runs at market level (Fix #7)
      const validation = validateMatch(
        match.source.title || '', match.target.title || '',
        match.source.expires_at, match.target.expires_at
      );
      if (!validation.valid) {
        logger.info({
          sourceMarket: match.source.market_id,
          targetMarket: match.target.market_id,
          check: validation.check,
          reason: validation.reason,
          sourceTitle: match.source.title,
          targetTitle: match.target.title,
        }, 'Match rejected by post-match validator');
        continue;
      }

      // Transitive grouping: check if either market already has a canonical ID
      const [existingSourceCanonical, existingTargetCanonical] = await Promise.all([
        findExistingCanonicalMarketId(match.source.source_id, match.source.exchange_id, match.source.market_id),
        findExistingCanonicalMarketId(match.target.source_id, match.target.exchange_id, match.target.market_id),
      ]);

      const canonicalMarketId = existingSourceCanonical
        || existingTargetCanonical
        || generateCanonicalId('CM', [
          { exchangeId: sourceExchangeId, id: match.source.market_id },
          { exchangeId: targetExchangeId, id: match.target.market_id },
        ]);

      const now = new Date();
      const mappings: MarketMapping[] = [
        {
          source_id: match.source.source_id,
          exchange_id: sourceExchangeId,
          market_id: match.source.market_id,
          outcome_side: 'YES',
          canonical_market_id: canonicalMarketId,
          confidence_score: match.similarity,
          matched_at: now,
          model_id: match.modelId,
          match_version: config.matchVersion,
        },
        {
          source_id: match.source.source_id,
          exchange_id: sourceExchangeId,
          market_id: match.source.market_id,
          outcome_side: 'NO',
          canonical_market_id: canonicalMarketId,
          confidence_score: match.similarity,
          matched_at: now,
          model_id: match.modelId,
          match_version: config.matchVersion,
        },
        {
          source_id: match.target.source_id,
          exchange_id: targetExchangeId,
          market_id: match.target.market_id,
          outcome_side: 'YES',
          canonical_market_id: canonicalMarketId,
          confidence_score: match.similarity,
          matched_at: now,
          model_id: match.modelId,
          match_version: config.matchVersion,
        },
        {
          source_id: match.target.source_id,
          exchange_id: targetExchangeId,
          market_id: match.target.market_id,
          outcome_side: 'NO',
          canonical_market_id: canonicalMarketId,
          confidence_score: match.similarity,
          matched_at: now,
          model_id: match.modelId,
          match_version: config.matchVersion,
        },
      ];

      await upsertMarketMappingsBatch(mappings);

      const title = generateTitle(match.source);
      const exchangeTitles: Record<string, string> = {
        [sourceExchangeId]: match.source.title || '',
        [targetExchangeId]: match.target.title || '',
      };
      await upsertMarketTitleWithExchanges(canonicalMarketId, title, exchangeTitles, match.modelId);

      marketsMatched++;
    }

    if (marketsMatched > 0) {
      logger.info({
        sourceEventId,
        targetEventId,
        sourceExchangeId,
        targetExchangeId,
        marketsMatched,
        sourceTotal: sourceMarkets.length,
        targetTotal: targetMarkets.length,
      }, 'Market-level matching complete for event pair');
    }

    return marketsMatched;
  } catch (err) {
    logger.error({ err, sourceEventId, targetEventId }, 'Market-level matching failed for event pair');
    return 0;
  }
}

/**
 * Greedy matching: build all pairwise similarity scores, sort DESC,
 * assign greedily avoiding re-use. Only include pairs above threshold.
 */
function greedyMatch(
  sourceMarkets: MarketForMatching[],
  targetMarkets: MarketForMatching[],
  threshold: number
): MarketPair[] {
  // Build all pairwise scores
  const candidates: MarketPair[] = [];

  for (const source of sourceMarkets) {
    const sourceDiff = extractDifferentiator(source);
    for (const target of targetMarkets) {
      const targetDiff = extractDifferentiator(target);
      const similarity = computeSimilarity(sourceDiff, targetDiff);

      if (similarity >= threshold) {
        // Reject outcome-type mismatches (e.g., Win↔Draw in sports)
        const sourceEntity = extractOutcomeName(source.title || '');
        if (sourceEntity) {
          const sType = classifyOutcome(source.title || '', sourceEntity);
          const tType = classifyOutcome(target.title || '', sourceEntity);
          if (sType !== 'UNKNOWN' && tType !== 'UNKNOWN' && sType !== tType) {
            continue;
          }
        }
        // Fix A: structural type compatibility check
        const sStructType = classifyMarketType(source.title || '');
        const tStructType = classifyMarketType(target.title || '');
        if (!areMarketTypesCompatible(sStructType, tStructType)) {
          continue;
        }
        candidates.push({ source, target, similarity });
      }
    }
  }

  // Sort by similarity DESC
  candidates.sort((a, b) => b.similarity - a.similarity);

  // Greedy assignment: avoid re-using any market
  const usedSource = new Set<string>();
  const usedTarget = new Set<string>();
  const matches: MarketPair[] = [];

  for (const candidate of candidates) {
    if (usedSource.has(candidate.source.market_id) || usedTarget.has(candidate.target.market_id)) {
      continue;
    }
    matches.push(candidate);
    usedSource.add(candidate.source.market_id);
    usedTarget.add(candidate.target.market_id);
  }

  return matches;
}
