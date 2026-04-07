import {
  KALSHI_SOURCE_ID,
  KALSHI_EXCHANGE_ID,
  POLYMARKET_SOURCE_ID,
  POLYMARKET_EXCHANGE_ID,
  OPINION_SOURCE_ID,
  OPINION_EXCHANGE_ID,
  PREDICT_SOURCE_ID,
  PREDICT_EXCHANGE_ID,
} from '@prediction-market/shared';

export interface ExchangePairConfig {
  source: { sourceId: string; exchangeId: string };
  target: { sourceId: string; exchangeId: string };
  strategy: 'ai' | 'derived';
  enabled: boolean;
}

/**
 * Exchange pairs to match. Order matters:
 * - K↔P runs first (existing behavior, unchanged)
 * - Predict pairs use 'derived' strategy (infer from existing market_mappings)
 * - Opinion pairs use 'ai' strategy
 *
 * Controlled by environment variables for each pair.
 */
export function getExchangePairs(): ExchangePairConfig[] {
  return [
    // Core pair — always enabled, existing behavior
    {
      source: { sourceId: KALSHI_SOURCE_ID, exchangeId: KALSHI_EXCHANGE_ID },
      target: { sourceId: POLYMARKET_SOURCE_ID, exchangeId: POLYMARKET_EXCHANGE_ID },
      strategy: 'ai',
      enabled: true,
    },
    // Predict pairs — derived from API-provided links (no AI calls)
    {
      source: { sourceId: KALSHI_SOURCE_ID, exchangeId: KALSHI_EXCHANGE_ID },
      target: { sourceId: PREDICT_SOURCE_ID, exchangeId: PREDICT_EXCHANGE_ID },
      strategy: 'derived',
      enabled: process.env.ENABLE_PREDICT_MATCHING !== 'false',
    },
    {
      source: { sourceId: POLYMARKET_SOURCE_ID, exchangeId: POLYMARKET_EXCHANGE_ID },
      target: { sourceId: PREDICT_SOURCE_ID, exchangeId: PREDICT_EXCHANGE_ID },
      strategy: 'derived',
      enabled: process.env.ENABLE_PREDICT_MATCHING !== 'false',
    },
    // Predict AI pairs — for markets without API-provided links.
    // Order matters: P↔PREDICT runs first so Predict events get matched to Polymarket,
    // then K↔PREDICT runs and transitive grouping merges into 3-way groups via
    // existing K↔P canonical IDs.
    {
      source: { sourceId: PREDICT_SOURCE_ID, exchangeId: PREDICT_EXCHANGE_ID },
      target: { sourceId: POLYMARKET_SOURCE_ID, exchangeId: POLYMARKET_EXCHANGE_ID },
      strategy: 'ai',
      enabled: process.env.ENABLE_PREDICT_AI_MATCHING === 'true',
    },
    {
      source: { sourceId: PREDICT_SOURCE_ID, exchangeId: PREDICT_EXCHANGE_ID },
      target: { sourceId: KALSHI_SOURCE_ID, exchangeId: KALSHI_EXCHANGE_ID },
      strategy: 'ai',
      enabled: process.env.ENABLE_PREDICT_AI_MATCHING === 'true',
    },
    // Opinion pairs — AI matching
    {
      source: { sourceId: KALSHI_SOURCE_ID, exchangeId: KALSHI_EXCHANGE_ID },
      target: { sourceId: OPINION_SOURCE_ID, exchangeId: OPINION_EXCHANGE_ID },
      strategy: 'ai',
      enabled: process.env.ENABLE_OPINION_MATCHING === 'true',
    },
    {
      source: { sourceId: POLYMARKET_SOURCE_ID, exchangeId: POLYMARKET_EXCHANGE_ID },
      target: { sourceId: OPINION_SOURCE_ID, exchangeId: OPINION_EXCHANGE_ID },
      strategy: 'ai',
      enabled: process.env.ENABLE_OPINION_MATCHING === 'true',
    },
    {
      source: { sourceId: PREDICT_SOURCE_ID, exchangeId: PREDICT_EXCHANGE_ID },
      target: { sourceId: OPINION_SOURCE_ID, exchangeId: OPINION_EXCHANGE_ID },
      strategy: 'ai',
      enabled: process.env.ENABLE_OPINION_MATCHING === 'true',
    },
  ];
}

export function getConfig() {
  return {
    model: process.env.OPENAI_MODEL || 'gpt-5-nano',
    apiKey: process.env.OPENAI_API_KEY,
    intervalMs: parseInt(process.env.MATCHER_INTERVAL_MS || '300000'),
    confidenceThreshold: parseFloat(process.env.MATCHER_CONFIDENCE_THRESHOLD || '0.85'),
    candidatesPerBatch: parseInt(process.env.MATCHER_CANDIDATES_PER_BATCH || '10'),
    matchVersion: parseInt(process.env.MATCHER_MATCH_VERSION || '1'),
    minEventVolume: parseFloat(process.env.MATCHER_MIN_EVENT_VOLUME || '0'),
    marketMatchThreshold: parseFloat(process.env.MARKET_MATCH_THRESHOLD || '0.85'),
    marketMatchAiThreshold: parseFloat(process.env.MARKET_MATCH_AI_THRESHOLD || '0.3'),
    recheckIntervalMs: parseInt(process.env.MATCHER_RECHECK_INTERVAL_MS || '86400000'), // 24 hours
  };
}

export type Config = ReturnType<typeof getConfig>;
