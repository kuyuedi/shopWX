import {
  createLogger,
  fetchMatchedMarketsRawData,
  fetchUnmatchedMarketsRawData,
  transaction,
} from '@prediction-market/shared';
import type { RawMarketData } from '../types.js';
import { mapCategory } from '../categoryMap.js';
import { formatVolume, formatDate } from '../utils/formatters.js';
import { getConfig } from '../config.js';

const logger = createLogger('score-computer');

let lastComputedAt: Date | null = null;
let computeInProgress = false;

export function getLastComputedAt(): Date | null {
  return lastComputedAt;
}

/**
 * Max-based normalization per Spec V1: n = value / max_value, clamped to [0, 1].
 */
export function maxNormalize(value: number, maxValue: number): number {
  if (maxValue <= 0) return 0;
  return Math.min(value / maxValue, 1);
}

function getCategoryEmoji(category: string | null): string {
  switch (category) {
    case 'politics': return '🗳️';
    case 'economics': return '📊';
    case 'crypto': return '₿';
    case 'sports': return '🏀';
    case 'entertainment': return '🎬';
    default: return '📈';
  }
}

export async function computeScores(): Promise<number> {
  if (computeInProgress) {
    logger.debug('Score computation already in progress, skipping');
    return 0;
  }
  computeInProgress = true;
  try {
    return await _computeScoresInner();
  } finally {
    computeInProgress = false;
  }
}

async function _computeScoresInner(): Promise<number> {
  const startTime = Date.now();
  const config = getConfig();
  logger.info({ recentWindowMinutes: config.recentWindowMinutes }, 'Score computation started');

  try {
    // Fetch raw data from both matched and unmatched markets
    const [matchedResult, unmatchedResult] = await Promise.all([
      fetchMatchedMarketsRawData(config.recentWindowMinutes),
      fetchUnmatchedMarketsRawData(config.recentWindowMinutes),
    ]);

    const allMarkets: RawMarketData[] = [
      ...matchedResult.rows as RawMarketData[],
      ...unmatchedResult.rows as RawMarketData[],
    ];

    if (allMarkets.length === 0) {
      logger.warn('No markets found for score computation');
      lastComputedAt = new Date();
      return 0;
    }

    // Compute max values for max-based normalization (Spec V1)
    const nMax = Math.max(...allMarkets.map(m => m.notional_recent), 0);
    const dMax = Math.max(...allMarkets.map(m => m.depth), 0);
    const vMax = Math.max(...allMarkets.map(m => m.volume_24h), 0);

    logger.info({ nMax, dMax, vMax }, 'Max-based normalization bounds');

    const scoredMarkets = allMarkets.map(m => {
      const category = mapCategory(m.category);
      const n_norm = maxNormalize(m.notional_recent, nMax);
      const d_norm = maxNormalize(m.depth, dMax);
      const v_norm = maxNormalize(m.volume_24h, vMax);
      const score = 0.55 * n_norm + 0.30 * d_norm + 0.15 * v_norm;

      return {
        ...m,
        score,
        n_norm,
        d_norm,
        v_norm,
        category,
        thumb: getCategoryEmoji(category),
        volume_formatted: formatVolume(m.volume_24h),
        end_date_formatted: formatDate(m.end_date),
      };
    });

    // Atomic TRUNCATE + INSERT via transaction
    await transaction(async (client) => {
      await client.query('TRUNCATE market_scores');

      // Batch insert in chunks of 100
      const CHUNK_SIZE = 100;
      for (let i = 0; i < scoredMarkets.length; i += CHUNK_SIZE) {
        const chunk = scoredMarkets.slice(i, i + CHUNK_SIZE);

        const values: unknown[] = [];
        const placeholders: string[] = [];

        chunk.forEach((m, idx) => {
          const offset = idx * 23;
          placeholders.push(
            `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15}, $${offset + 16}, $${offset + 17}, $${offset + 18}, $${offset + 19}, $${offset + 20}, $${offset + 21}, $${offset + 22}, $${offset + 23}, NOW())`
          );
          values.push(
            m.id?.substring(0, 255),
            m.score,
            m.notional_recent,
            m.depth,
            m.volume_24h,
            m.n_norm,
            m.d_norm,
            m.v_norm,
            m.category?.substring(0, 50) ?? null,
            m.is_matched,
            m.canonical_market_id?.substring(0, 50) ?? null,
            m.exchange_id?.substring(0, 255) ?? null,
            m.source_id?.substring(0, 255) ?? null,
            m.market_id?.substring(0, 255) ?? null,
            m.event_id?.substring(0, 255) ?? null,
            m.outcome_side,
            m.title?.substring(0, 500) ?? null,
            m.thumb?.substring(0, 50) ?? null,
            m.end_date,
            m.end_date_formatted?.substring(0, 50) ?? null,
            m.volume_formatted?.substring(0, 20) ?? null,
            m.status?.substring(0, 50) ?? null,
            m.updated_at,
          );
        });

        const sql = `
          INSERT INTO market_scores (
            id, score, notional_24h, depth, trades_24h,
            n_norm, d_norm, v_norm,
            category, is_matched, canonical_market_id,
            exchange_id, source_id, market_id, event_id, outcome_side,
            title, thumb, end_date, end_date_formatted, volume_formatted,
            status, updated_at, computed_at
          ) VALUES ${placeholders.join(', ')}
        `;

        await client.query(sql, values);
      }
    });

    lastComputedAt = new Date();
    const durationMs = Date.now() - startTime;
    logger.info({
      marketCount: scoredMarkets.length,
      matched: matchedResult.rowCount,
      unmatched: unmatchedResult.rowCount,
      durationMs,
    }, 'Score computation completed');

    return scoredMarkets.length;
  } catch (err) {
    logger.error({ err }, 'Score computation failed');
    throw err;
  }
}
