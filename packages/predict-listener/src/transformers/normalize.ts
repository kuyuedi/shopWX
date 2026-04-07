import {
  PREDICT_SOURCE_ID,
  PREDICT_EXCHANGE_ID,
  type PredictionMarket,
  type ExchangeEvent,
} from '@prediction-market/shared';
import type { PredictMarket, PredictCategory } from '../types/api.js';

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max - 3) + '...' : s;
}

function mapStatus(market: PredictMarket): string {
  if (market.tradingStatus === 'OPEN' && market.status === 'REGISTERED') return 'Open';
  return 'Closed';
}

/**
 * Normalize Predict.fun markets to DB format.
 * Each market produces 2 records (YES + NO).
 */
export function normalizeMarkets(markets: PredictMarket[]): PredictionMarket[] {
  const results: PredictionMarket[] = [];

  for (const m of markets) {
    const marketId = truncate(String(m.id), 255);
    const title = truncate(m.question || m.title, 512);
    const outcomeName = m.title; // e.g. "Oklahoma City Thunder"
    const eventId = truncate(m.categorySlug || String(m.id), 255);
    const createdAt = m.createdAt ? new Date(m.createdAt) : undefined;
    const status = mapStatus(m);

    const yesOutcome = m.outcomes.find(o => o.indexSet === 1);
    const noOutcome = m.outcomes.find(o => o.indexSet === 2);

    results.push(
      {
        source_id: PREDICT_SOURCE_ID,
        exchange_id: PREDICT_EXCHANGE_ID,
        market_id: marketId,
        event_id: eventId,
        outcome_side: 'YES',
        outcome_name: yesOutcome?.name || outcomeName || 'Yes',
        market_name: title,
        category: undefined, // filled from categories
        price: undefined,    // filled by WS
        status,
        created_at: createdAt,
        source_specific_data: {
          kalshiMarketTicker: m.kalshiMarketTicker,
          polymarketConditionIds: m.polymarketConditionIds,
          feeRateBps: m.feeRateBps,
          isNegRisk: m.isNegRisk,
          decimalPrecision: m.decimalPrecision,
          marketVariant: m.marketVariant,
          onChainId: yesOutcome?.onChainId,
        },
      },
      {
        source_id: PREDICT_SOURCE_ID,
        exchange_id: PREDICT_EXCHANGE_ID,
        market_id: marketId,
        event_id: eventId,
        outcome_side: 'NO',
        outcome_name: noOutcome?.name || 'No',
        market_name: title,
        category: undefined,
        price: undefined,
        status,
        created_at: createdAt,
        source_specific_data: {
          kalshiMarketTicker: m.kalshiMarketTicker,
          polymarketConditionIds: m.polymarketConditionIds,
          feeRateBps: m.feeRateBps,
          isNegRisk: m.isNegRisk,
          decimalPrecision: m.decimalPrecision,
          marketVariant: m.marketVariant,
          onChainId: noOutcome?.onChainId,
        },
      },
    );
  }

  return results;
}

/**
 * Normalize Predict.fun categories to events.
 */
export function normalizeEvents(categories: PredictCategory[]): ExchangeEvent[] {
  return categories.map(cat => ({
    source_id: PREDICT_SOURCE_ID,
    exchange_id: PREDICT_EXCHANGE_ID,
    event_id: truncate(cat.slug || String(cat.id), 255),
    title: cat.title,
    subtitle: cat.description || undefined,
    category: cat.tags.find(t => t.level === 1)?.name || undefined,
    status: cat.status === 'OPEN' ? 'Open' : 'Closed',
    end_date: cat.endsAt ? new Date(cat.endsAt) : undefined,
    image_url: cat.imageUrl || undefined,
    market_count: cat.markets?.length || 0,
    mutually_exclusive: true,
  }));
}
