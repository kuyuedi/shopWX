import type pg from 'pg';
import { createLogger, query, queryWithPool } from '@prediction-market/shared';
import type { MarketOutcome, MarketResponse } from '../types.js';
import { normalizePrice } from '../utils/formatters.js';

const logger = createLogger('outcome-assembler');

interface ScoreRow {
  id: string;
  title: string | null;
  thumb: string | null;
  category: string | null;
  end_date_formatted: string | null;
  volume_formatted: string | null;
  is_matched: boolean;
  canonical_market_id: string | null;
  exchange_id: string | null;
  source_id: string | null;
  market_id: string | null;
  event_id: string | null;
  updated_at: Date | null;
}

function exchangeKey(exchangeId: string): string {
  switch (exchangeId) {
    case 'KALSHI': return 'kal';
    case 'POLYMARKET': return 'poly';
    default: return exchangeId.toLowerCase().substring(0, 3);
  }
}

/**
 * Extract outcome name from market title.
 * Kalshi: "Question? — OutcomeName" → OutcomeName
 * Predict: "Will X win the Y?" → X
 */
function extractOutcomeFromTitle(title: string): string | null {
  // Kalshi em-dash format
  const dashIdx = title.lastIndexOf('—');
  if (dashIdx >= 0) {
    const name = title.substring(dashIdx + 1).trim();
    if (name.length > 0) return name;
  }
  // Predict-style: "Will X win/be/become..." → extract X
  const willMatch = title.match(/^Will\s+(.+?)\s+(?:win|be|become|qualify|advance|hit|reach|exceed|dip|launch|make)\b/i);
  if (willMatch && willMatch[1]) {
    const subject = willMatch[1]!.replace(/^(?:the|a|an)\s+/i, '').trim();
    if (subject.length > 0 && subject.length < 50) return subject;
  }
  // Colon-separated: "Event Title: Outcome Name" → extract after last colon
  const colonIdx = title.lastIndexOf(':');
  if (colonIdx >= 0 && colonIdx < title.length - 1) {
    const afterColon = title.substring(colonIdx + 1).trim();
    if (afterColon.length > 0 && afterColon.length < 50) return afterColon;
  }
  return null;
}

/**
 * Assemble outcomes with per-exchange prices for a batch of market score rows.
 */
export async function assembleOutcomes(scoreRows: ScoreRow[], pool?: pg.Pool): Promise<MarketResponse[]> {
  if (scoreRows.length === 0) return [];

  const q = pool
    ? <T extends pg.QueryResultRow>(text: string, params?: unknown[]) => queryWithPool<T>(pool, text, params)
    : query;

  // Separate matched and unmatched
  const matchedRows = scoreRows.filter(r => r.is_matched && r.canonical_market_id);
  const unmatchedRows = scoreRows.filter(r => !r.is_matched);

  const results: Map<string, MarketResponse> = new Map();

  // Process matched markets
  if (matchedRows.length > 0) {
    const canonicalIds = matchedRows.map(r => r.canonical_market_id!);

    // Fetch generated titles
    const titlesResult = await q<{
      canonical_market_id: string;
      generated_title: string;
    }>(
      `SELECT canonical_market_id, generated_title
       FROM market_titles
       WHERE canonical_market_id = ANY($1)`,
      [canonicalIds]
    );
    const titleMap = new Map(titlesResult.rows.map(r => [r.canonical_market_id, r.generated_title]));

    // Fetch all outcomes for matched markets
    const outcomesResult = await q<{
      canonical_market_id: string;
      exchange_id: string;
      market_id: string;
      outcome_name: string | null;
      title: string;
      price: number | null;
      outcome_side: string;
    }>(
      `SELECT mm.canonical_market_id, mm.exchange_id,
              pm.market_id, pm.outcome_name, pm.title,
              COALESCE(pm.price, mld.reference_price, mld.band_vwap_bid) AS price,
              pm.outcome_side
       FROM market_mappings mm
       JOIN prediction_markets pm
         ON mm.source_id = pm.source_id AND mm.exchange_id = pm.exchange_id
         AND mm.market_id = pm.market_id AND mm.outcome_side = pm.outcome_side
       LEFT JOIN market_latest_data mld
         ON pm.source_id = mld.source_id AND pm.exchange_id = mld.exchange_id
         AND pm.market_id = mld.market_id AND pm.outcome_side = mld.outcome_side
       WHERE mm.canonical_market_id = ANY($1)
         AND mm.outcome_side = 'YES'`,
      [canonicalIds]
    );

    for (const row of matchedRows) {
      const cid = row.canonical_market_id!;
      const marketOutcomes = outcomesResult.rows.filter(o => o.canonical_market_id === cid);

      // Build outcome label and per-exchange prices
      const exchangeSet = new Set<string>();
      const outcomeMap = new Map<string, Record<string, number>>();

      // Determine outcome label once (consistent across exchanges for merging)
      // Prefer Kalshi (has short em-dash names) over Polymarket (has full question titles)
      let outcomeLabel = 'Yes';
      const kalshiOutcomes = marketOutcomes.filter(o => o.exchange_id === 'KALSHI');
      const otherOutcomes = marketOutcomes.filter(o => o.exchange_id !== 'KALSHI');
      const orderedOutcomes = [...kalshiOutcomes, ...otherOutcomes];
      for (const o of orderedOutcomes) {
        if (o.outcome_name && o.outcome_name !== 'Yes' && o.outcome_name !== 'No') {
          outcomeLabel = o.outcome_name;
          break;
        }
        const extracted = extractOutcomeFromTitle(o.title);
        if (extracted) {
          outcomeLabel = extracted;
          break;
        }
      }

      for (const o of marketOutcomes) {
        const exKey = exchangeKey(o.exchange_id);
        exchangeSet.add(exKey);

        if (!outcomeMap.has(outcomeLabel)) {
          outcomeMap.set(outcomeLabel, {});
        }
        const prices = outcomeMap.get(outcomeLabel)!;
        const normalizedPrice = normalizePrice(o.price, o.exchange_id);
        if (normalizedPrice != null) {
          prices[exKey] = normalizedPrice;
        }
      }

      // If binary (generic "Yes" label), add a "No" outcome with inverted prices
      if (outcomeMap.size === 1 && outcomeLabel === 'Yes') {
        const yesPrices = outcomeMap.get('Yes')!;
        const noPrices: Record<string, number> = {};
        for (const [ex, price] of Object.entries(yesPrices)) {
          noPrices[ex] = 100 - price;
        }
        outcomeMap.set('No', noPrices);
      }

      const outcomes: MarketOutcome[] = Array.from(outcomeMap.entries())
        .map(([label, prices]) => ({ label, prices }))
        .sort((a, b) => {
          const aMax = Math.max(...Object.values(a.prices), 0);
          const bMax = Math.max(...Object.values(b.prices), 0);
          return bMax - aMax;
        });

      const displayTitle = titleMap.get(cid) ?? row.title ?? 'Untitled Market';

      results.set(row.id, {
        id: row.id,
        title: displayTitle,
        thumb: row.thumb,
        category: row.category,
        end_date: row.end_date_formatted,
        volume: row.volume_formatted,
        exchanges: Array.from(exchangeSet).sort(),
        outcomes,
        updated_at: row.updated_at?.toISOString() ?? null,
      });
    }
  }

  // Process unmatched markets
  if (unmatchedRows.length > 0) {
    // Group by event_id for multi-outcome events
    const eventGroups = new Map<string, ScoreRow[]>();
    const standaloneRows: ScoreRow[] = [];

    for (const row of unmatchedRows) {
      if (row.event_id && row.exchange_id) {
        const groupKey = `${row.exchange_id}:${row.event_id}`;
        if (!eventGroups.has(groupKey)) {
          eventGroups.set(groupKey, []);
        }
        eventGroups.get(groupKey)!.push(row);
      } else {
        standaloneRows.push(row);
      }
    }

    // Fetch multi-outcome events
    for (const [_groupKey, groupRows] of eventGroups) {
      if (groupRows.length <= 1) {
        // Not actually multi-outcome, treat as standalone
        standaloneRows.push(...groupRows);
        continue;
      }

      // Use the first row as the representative
      const rep = groupRows[0]!;
      const exKey = exchangeKey(rep.exchange_id!);

      // Fetch all outcomes for this event
      const eventResult = await q<{
        market_id: string;
        outcome_name: string | null;
        title: string;
        price: number | null;
      }>(
        `SELECT market_id, outcome_name, title, price
         FROM prediction_markets
         WHERE exchange_id = $1 AND event_id = $2
           AND outcome_side = 'YES' AND status = 'Open'
         ORDER BY price DESC NULLS LAST`,
        [rep.exchange_id, rep.event_id]
      );

      const outcomes: MarketOutcome[] = eventResult.rows.map(o => {
        const label = o.outcome_name && o.outcome_name !== 'Yes' && o.outcome_name !== 'No'
          ? o.outcome_name
          : extractOutcomeFromTitle(o.title) ?? o.title;
        const normalizedPrice = normalizePrice(o.price, rep.exchange_id!);
        const prices: Record<string, number> = {};
        if (normalizedPrice != null) {
          prices[exKey] = normalizedPrice;
        }
        return { label, prices };
      });

      // Use the first row's ID as the event ID
      results.set(rep.id, {
        id: rep.id,
        title: rep.title ?? 'Untitled Market',
        thumb: rep.thumb,
        category: rep.category,
        end_date: rep.end_date_formatted,
        volume: rep.volume_formatted,
        exchanges: [exKey],
        outcomes: outcomes.slice(0, 10), // Limit to 10 outcomes
        updated_at: rep.updated_at?.toISOString() ?? null,
      });
    }

    // Process standalone unmatched
    for (const row of standaloneRows) {
      if (!row.exchange_id || !row.market_id) continue;
      const exKey = exchangeKey(row.exchange_id);

      // Fetch this market's price for Yes/No outcomes
      const priceResult = await q<{
        outcome_name: string | null;
        price: number | null;
        outcome_side: string;
      }>(
        `SELECT outcome_name, price, outcome_side
         FROM prediction_markets
         WHERE source_id = $1 AND exchange_id = $2 AND market_id = $3
           AND status = 'Open'`,
        [row.source_id, row.exchange_id, row.market_id]
      );

      const outcomes: MarketOutcome[] = [];
      const yesRow = priceResult.rows.find(r => r.outcome_side === 'YES');
      const noRow = priceResult.rows.find(r => r.outcome_side === 'NO');

      if (yesRow) {
        const yesLabel = yesRow.outcome_name && yesRow.outcome_name !== 'Yes' && yesRow.outcome_name !== 'No'
          ? yesRow.outcome_name
          : 'Yes';
        const yesPrice = normalizePrice(yesRow.price, row.exchange_id);
        const yesPrices: Record<string, number> = {};
        if (yesPrice != null) yesPrices[exKey] = yesPrice;
        outcomes.push({ label: yesLabel, prices: yesPrices });

        // Add No outcome
        const noLabel = yesLabel === 'Yes' ? 'No' : `Not ${yesLabel}`;
        const noPrices: Record<string, number> = {};
        if (noRow) {
          const noPrice = normalizePrice(noRow.price, row.exchange_id);
          if (noPrice != null) noPrices[exKey] = noPrice;
        } else if (yesPrice != null) {
          noPrices[exKey] = 100 - yesPrice;
        }
        outcomes.push({ label: noLabel, prices: noPrices });
      }

      results.set(row.id, {
        id: row.id,
        title: row.title ?? 'Untitled Market',
        thumb: row.thumb,
        category: row.category,
        end_date: row.end_date_formatted,
        volume: row.volume_formatted,
        exchanges: [exKey],
        outcomes,
        updated_at: row.updated_at?.toISOString() ?? null,
      });
    }
  }

  // Return in same order as input, filtering out events with no outcomes
  return scoreRows
    .map(r => results.get(r.id))
    .filter((r): r is MarketResponse => r !== undefined && r.outcomes.length > 0);
}
