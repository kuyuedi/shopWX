import type { CursorData, ScoreCursor, ClosesSoonCursor } from './cursor.js';

export interface PaginationQuery {
  whereClause: string;
  params: unknown[];
  paramOffset: number;
}

/**
 * Build keyset pagination WHERE clause from a decoded cursor.
 * Returns the clause fragment and params to append.
 */
export function buildPaginationQuery(
  cursor: CursorData,
  sort: 'score' | 'closes_soon',
  paramStartIndex: number
): PaginationQuery {
  if (sort === 'score') {
    const c = cursor as ScoreCursor;
    // ORDER BY score DESC, updated_at DESC, id ASC
    // Seek: (score < $X) OR (score = $X AND updated_at < $Y) OR (score = $X AND updated_at = $Y AND id > $Z)
    const whereClause = `(
      ms.score < $${paramStartIndex}
      OR (ms.score = $${paramStartIndex} AND ms.updated_at < $${paramStartIndex + 1})
      OR (ms.score = $${paramStartIndex} AND ms.updated_at = $${paramStartIndex + 1} AND ms.id > $${paramStartIndex + 2})
    )`;
    return {
      whereClause,
      params: [c.s, c.t, c.i],
      paramOffset: paramStartIndex + 3,
    };
  }

  // closes_soon: ORDER BY end_date ASC NULLS LAST, updated_at DESC, id ASC
  const c = cursor as ClosesSoonCursor;
  const whereClause = `(
    (ms.end_date IS NOT NULL AND ms.end_date > $${paramStartIndex})
    OR (ms.end_date IS NOT NULL AND ms.end_date = $${paramStartIndex} AND ms.updated_at < $${paramStartIndex + 1})
    OR (ms.end_date IS NOT NULL AND ms.end_date = $${paramStartIndex} AND ms.updated_at = $${paramStartIndex + 1} AND ms.id > $${paramStartIndex + 2})
    OR (ms.end_date IS NULL AND $${paramStartIndex} IS NOT NULL)
    OR (ms.end_date IS NULL AND $${paramStartIndex} IS NULL AND ms.updated_at < $${paramStartIndex + 1})
    OR (ms.end_date IS NULL AND $${paramStartIndex} IS NULL AND ms.updated_at = $${paramStartIndex + 1} AND ms.id > $${paramStartIndex + 2})
  )`;
  return {
    whereClause,
    params: [c.d || null, c.t, c.i],
    paramOffset: paramStartIndex + 3,
  };
}
