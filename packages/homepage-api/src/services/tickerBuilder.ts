import type pg from 'pg';
import { query, queryWithPool } from '@prediction-market/shared';
import type { TickerItem } from '../types.js';
import { normalizePrice } from '../utils/formatters.js';

function getTickerTag(category: string | null): string {
  switch (category) {
    case 'crypto': return '₿ CRYPTO';
    case 'politics': return '🗳️ ELECTION';
    case 'sports': return '🏀 SPORTS';
    case 'economics': return '📊 DATA';
    case 'entertainment': return '🎬 ENTERTAINMENT';
    default: return '🔴 LIVE';
  }
}

function exchangeShort(exchangeId: string): string {
  switch (exchangeId) {
    case 'KALSHI': return 'KAL';
    case 'POLYMARKET': return 'POLY';
    default: return exchangeId.substring(0, 3).toUpperCase();
  }
}

interface TickerMarketRow {
  id: string;
  title: string | null;
  category: string | null;
  is_matched: boolean;
  canonical_market_id: string | null;
  exchange_id: string | null;
  source_id: string | null;
  market_id: string | null;
  volume_formatted: string | null;
}

export async function buildTickerItems(limit: number, pool?: pg.Pool): Promise<TickerItem[]> {
  const q = pool
    ? <T extends pg.QueryResultRow>(text: string, params?: unknown[]) => queryWithPool<T>(pool, text, params)
    : query;

  // Fetch top markets by score
  const topMarkets = await q<TickerMarketRow>(
    `SELECT id, title, category, is_matched, canonical_market_id,
            exchange_id, source_id, market_id, volume_formatted
     FROM market_scores
     ORDER BY score DESC
     LIMIT $1`,
    [limit]
  );

  const items: TickerItem[] = [];

  for (const market of topMarkets.rows) {
    const tag = getTickerTag(market.category);
    let text = market.title ?? 'Market';

    if (market.is_matched && market.canonical_market_id) {
      // Fetch prices from both exchanges
      const pricesResult = await q<{
        exchange_id: string;
        price: number | null;
      }>(
        `SELECT mm.exchange_id, COALESCE(pm.price, mld.reference_price, mld.band_vwap_bid) AS price
         FROM market_mappings mm
         JOIN prediction_markets pm
           ON mm.source_id = pm.source_id AND mm.exchange_id = pm.exchange_id
           AND mm.market_id = pm.market_id AND mm.outcome_side = pm.outcome_side
         LEFT JOIN market_latest_data mld
           ON pm.source_id = mld.source_id AND pm.exchange_id = mld.exchange_id
           AND pm.market_id = mld.market_id AND pm.outcome_side = mld.outcome_side
         WHERE mm.canonical_market_id = $1 AND mm.outcome_side = 'YES'`,
        [market.canonical_market_id]
      );

      const priceParts = pricesResult.rows
        .map(r => {
          const price = normalizePrice(r.price, r.exchange_id);
          return price != null ? `${exchangeShort(r.exchange_id)} ${price}%` : null;
        })
        .filter(Boolean);

      if (priceParts.length > 0) {
        text = `${market.title}: ${priceParts.join(' / ')}`;
      }
    } else if (market.volume_formatted) {
      text = `${market.title} crosses ${market.volume_formatted} volume`;
    }

    items.push({ tag, text });
  }

  return items;
}
