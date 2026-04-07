import { createHash } from 'crypto';

/**
 * Generate a deterministic canonical ID from a set of exchange:id entries.
 * Sorts entries lexicographically before hashing to ensure the same ID
 * regardless of input order.
 *
 * For backward compatibility with existing Kalshi↔Polymarket IDs:
 * - generateCanonicalId('CE', [{exchangeId: 'KALSHI', id: 'X'}, {exchangeId: 'POLYMARKET', id: 'Y'}])
 *   produces the same hash as the old generateCanonicalEventId('X', 'Y')
 * - generateCanonicalId('CM', ...) produces the same as old generateCanonicalMarketId()
 */
export function generateCanonicalId(
  prefix: 'CE' | 'CM',
  entries: Array<{ exchangeId: string; id: string }>
): string {
  const keys = entries.map(e => `${e.exchangeId}:${e.id}`).sort();

  const hash = createHash('sha256')
    .update(keys.join('|'))
    .digest('hex')
    .substring(0, 16);

  return `${prefix}-${hash}`;
}
