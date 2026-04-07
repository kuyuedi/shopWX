import {
  OPINION_SOURCE_ID,
  OPINION_EXCHANGE_ID,
  type PredictionMarket,
  type ExchangeEvent,
} from '@prediction-market/shared';
import type { OpinionMarketData } from '../types/api.js';

function mapStatus(statusEnum: string): string {
  switch (statusEnum) {
    case 'Activated': return 'Open';
    case 'Created': return 'Open';
    case 'Resolving': return 'Open';
    case 'Resolved': return 'Closed';
    case 'Failed': return 'Closed';
    case 'Deleted': return 'Closed';
    default: return 'Open';
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max - 3) + '...' : s;
}

export function normalizeMarkets(markets: OpinionMarketData[]): PredictionMarket[] {
  const results: PredictionMarket[] = [];

  for (const m of markets) {
    if (m.marketType === 0) {
      // Binary market → 2 records (YES + NO)
      results.push(...normalizeBinaryMarket(m));
    } else if (m.marketType === 1 && m.childMarkets?.length) {
      // Categorical market → 2 records per child
      results.push(...normalizeCategoricalMarket(m));
    }
  }

  return results;
}

function normalizeBinaryMarket(m: OpinionMarketData): PredictionMarket[] {
  const marketId = truncate(String(m.marketId), 255);
  const title = truncate(m.marketTitle, 512);
  const eventId = marketId; // binary: market IS the event
  const endDate = m.cutoffAt ? new Date(m.cutoffAt) : undefined;
  const status = mapStatus(m.statusEnum);

  return [
    {
      source_id: OPINION_SOURCE_ID,
      exchange_id: OPINION_EXCHANGE_ID,
      market_id: marketId,
      event_id: eventId,
      outcome_side: 'YES',
      outcome_name: m.yesLabel || 'Yes',
      market_name: title,
      rules_primary: m.rules || undefined,
      category: m.collection?.title || undefined,
      price: undefined, // filled by WS
      end_date: endDate,
      status,
      source_specific_data: {
        tokenId: m.yesTokenId,
        conditionId: m.conditionId,
        chainId: m.chainId,
        volume: m.volume,
        volume24h: m.volume24h,
      },
    },
    {
      source_id: OPINION_SOURCE_ID,
      exchange_id: OPINION_EXCHANGE_ID,
      market_id: marketId,
      event_id: eventId,
      outcome_side: 'NO',
      outcome_name: m.noLabel || 'No',
      market_name: title,
      rules_primary: m.rules || undefined,
      category: m.collection?.title || undefined,
      price: undefined,
      end_date: endDate,
      status,
      source_specific_data: {
        tokenId: m.noTokenId,
        conditionId: m.conditionId,
        chainId: m.chainId,
      },
    },
  ];
}

function normalizeCategoricalMarket(m: OpinionMarketData): PredictionMarket[] {
  const results: PredictionMarket[] = [];
  const rootEventId = truncate(String(m.marketId), 255);

  for (const child of m.childMarkets ?? []) {
    const childId = truncate(String(child.marketId), 255);
    const title = truncate(`${m.marketTitle} — ${child.marketTitle}`, 512);
    const endDate = child.cutoffAt ? new Date(child.cutoffAt) : undefined;
    const status = mapStatus(child.statusEnum);

    results.push(
      {
        source_id: OPINION_SOURCE_ID,
        exchange_id: OPINION_EXCHANGE_ID,
        market_id: childId,
        event_id: rootEventId,
        outcome_side: 'YES',
        outcome_name: child.yesLabel || 'Yes',
        market_name: title,
        category: m.collection?.title || undefined,
        price: undefined,
        end_date: endDate,
        status,
        source_specific_data: {
          tokenId: child.yesTokenId,
          conditionId: child.conditionId,
        },
      },
      {
        source_id: OPINION_SOURCE_ID,
        exchange_id: OPINION_EXCHANGE_ID,
        market_id: childId,
        event_id: rootEventId,
        outcome_side: 'NO',
        outcome_name: child.noLabel || 'No',
        market_name: title,
        category: m.collection?.title || undefined,
        price: undefined,
        end_date: endDate,
        status,
        source_specific_data: {
          tokenId: child.noTokenId,
          conditionId: child.conditionId,
        },
      },
    );
  }

  return results;
}

export function normalizeEvents(markets: OpinionMarketData[]): ExchangeEvent[] {
  const events: ExchangeEvent[] = [];

  for (const m of markets) {
    if (m.marketType === 0) {
      // Binary: market = event
      events.push({
        source_id: OPINION_SOURCE_ID,
        exchange_id: OPINION_EXCHANGE_ID,
        event_id: String(m.marketId),
        title: m.marketTitle,
        category: m.collection?.title || undefined,
        status: mapStatus(m.statusEnum),
        end_date: m.cutoffAt ? new Date(m.cutoffAt) : undefined,
        market_count: 1,
        mutually_exclusive: true,
      });
    } else if (m.marketType === 1) {
      // Categorical: root = event, children = markets
      events.push({
        source_id: OPINION_SOURCE_ID,
        exchange_id: OPINION_EXCHANGE_ID,
        event_id: String(m.marketId),
        title: m.marketTitle,
        category: m.collection?.title || undefined,
        status: mapStatus(m.statusEnum),
        end_date: m.cutoffAt ? new Date(m.cutoffAt) : undefined,
        market_count: m.childMarkets?.length || 0,
        mutually_exclusive: true,
      });
    }
  }

  return events;
}

/** Build token → market lookup for WS handlers */
export interface TokenInfo {
  marketId: string;
  outcomeSide: 'YES' | 'NO';
}

export function buildTokenCache(markets: OpinionMarketData[]): Map<string, TokenInfo> {
  const cache = new Map<string, TokenInfo>();

  for (const m of markets) {
    const id = String(m.marketId);
    cache.set(m.yesTokenId, { marketId: id, outcomeSide: 'YES' });
    cache.set(m.noTokenId, { marketId: id, outcomeSide: 'NO' });

    for (const child of m.childMarkets ?? []) {
      const childId = String(child.marketId);
      cache.set(child.yesTokenId, { marketId: childId, outcomeSide: 'YES' });
      cache.set(child.noTokenId, { marketId: childId, outcomeSide: 'NO' });
    }
  }

  return cache;
}
