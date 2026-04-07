export interface ScoreCursor {
  s: number;   // score
  t: string;   // updated_at ISO 8601
  i: string;   // market id (canonical_market_id or composite)
}

export interface ClosesSoonCursor {
  d: string;   // end_date ISO 8601
  t: string;   // updated_at ISO 8601
  i: string;   // market id
}

export interface EventCursor {
  p: number;   // page number (0-based)
}

export type CursorData = ScoreCursor | ClosesSoonCursor | EventCursor;

export function encodeCursor(data: CursorData): string {
  return Buffer.from(JSON.stringify(data)).toString('base64');
}

export function decodeCursor(cursor: string): CursorData | null {
  try {
    const json = Buffer.from(cursor, 'base64').toString('utf-8');
    const data = JSON.parse(json) as CursorData;
    if (!data || typeof data !== 'object' || !('i' in data)) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}
