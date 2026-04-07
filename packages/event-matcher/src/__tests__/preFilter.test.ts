import { describe, it, expect } from 'vitest';
import { extractKeywords, findCandidates, stem } from '../services/preFilter.js';
import type { EventForMatching } from '@prediction-market/shared';

function makeEvent(overrides: Partial<EventForMatching> = {}): EventForMatching {
  return {
    source_id: 'DIRECT',
    exchange_id: 'KALSHI',
    event_id: 'test-1',
    title: 'Test Event',
    subtitle: null,
    category: null,
    end_date: null,
    market_count: 1,
    total_volume: 0,
    total_trades: 0,
    ...overrides,
  };
}

describe('stem', () => {
  it('reduces plurals to same root', () => {
    expect(stem('elections')).toBe(stem('election'));
    expect(stem('rates')).toBe(stem('rate'));
  });

  it('reduces -ing with e-restoration', () => {
    expect(stem('trading')).toBe(stem('trade'));
    expect(stem('voting')).toBe(stem('vote'));
    expect(stem('rating')).toBe(stem('rate'));
  });

  it('reduces -ing without e-restoration for doubled consonants', () => {
    // "cutting" -> "cutt" (doubled t, no e added)
    expect(stem('cutting')).toBe('cutt');
  });

  it('reduces -ship via recursive stemming', () => {
    expect(stem('championship')).toBe(stem('champion'));
  });

  it('reduces -ies to -y', () => {
    expect(stem('economies')).toBe(stem('economy'));
  });

  it('reduces -ed with e-restoration', () => {
    expect(stem('traded')).toBe(stem('trade'));
    expect(stem('rated')).toBe(stem('rate'));
  });

  it('does not over-stem short words', () => {
    expect(stem('fed')).toBe('fed');
    expect(stem('win')).toBe('win');
    expect(stem('nba')).toBe('nba');
  });
});

describe('extractKeywords', () => {
  it('extracts meaningful words from a title', () => {
    const keywords = extractKeywords('Will Bitcoin reach $100,000 by end of 2026?');
    expect(keywords.has(stem('bitcoin'))).toBe(true);
    expect(keywords.has(stem('reach'))).toBe(true);
  });

  it('removes stop words', () => {
    const keywords = extractKeywords('Will the Federal Reserve cut interest rates?');
    expect(keywords.has('the')).toBe(false);
    expect(keywords.has('will')).toBe(false);
    expect(keywords.has(stem('federal'))).toBe(true);
    expect(keywords.has(stem('reserve'))).toBe(true);
    expect(keywords.has(stem('interest'))).toBe(true);
    expect(keywords.has(stem('rates'))).toBe(true);
  });

  it('keeps "win" and "winner" (not stop words)', () => {
    const keywords = extractKeywords('Who will win the championship?');
    // "win" → synonym "victory" (Fix 3b)
    expect(keywords.has(stem('victory'))).toBe(true);
    const keywords2 = extractKeywords('Super Bowl winner 2026');
    // "winner" doesn't match \bwin\b, so stays as "winner" → stems to "winn"
    expect(keywords2.has(stem('winner'))).toBe(true);
  });

  it('stems words so singular/plural match', () => {
    const kw1 = extractKeywords('Presidential Election');
    const kw2 = extractKeywords('Presidential Elections');
    expect([...kw1]).toEqual([...kw2]);
  });

  it('removes pure numbers', () => {
    const keywords = extractKeywords('2026 Presidential Election');
    expect(keywords.has('2026')).toBe(false);
    expect(keywords.has(stem('presidential'))).toBe(true);
  });

  it('returns empty set for empty string', () => {
    expect(extractKeywords('').size).toBe(0);
  });
});

describe('findCandidates', () => {
  it('returns candidates with keyword overlap', () => {
    const kalshi = makeEvent({
      title: 'Federal Reserve Interest Rate Decision March 2026',
    });

    const polyEvents = [
      makeEvent({
        exchange_id: 'POLYMARKET',
        event_id: 'poly-1',
        title: 'Fed Interest Rate Cut in March',
        total_volume: 1000,
      }),
      makeEvent({
        exchange_id: 'POLYMARKET',
        event_id: 'poly-2',
        title: 'Bitcoin Price Above 100k',
        total_volume: 500,
      }),
      makeEvent({
        exchange_id: 'POLYMARKET',
        event_id: 'poly-3',
        title: 'Federal Reserve Rate Decision',
        total_volume: 2000,
      }),
    ];

    const candidates = findCandidates(kalshi, polyEvents, 10);
    expect(candidates.length).toBeGreaterThan(0);
    const matchedIds = candidates.map(c => c.event.event_id);
    expect(matchedIds).not.toContain('poly-2');
  });

  it('matches stemmed variants (championship vs champion)', () => {
    const kalshi = makeEvent({
      title: 'NBA Championship 2026',
    });

    const polyEvents = [
      makeEvent({
        exchange_id: 'POLYMARKET',
        event_id: 'poly-1',
        title: 'NBA Champion 2026',
        total_volume: 1000,
      }),
    ];

    const candidates = findCandidates(kalshi, polyEvents, 10);
    expect(candidates.length).toBe(1);
  });

  it('matches with at least 1 keyword overlap', () => {
    const kalshi = makeEvent({
      title: 'Super Bowl Champion 2026',
    });

    const polyEvents = [
      makeEvent({
        exchange_id: 'POLYMARKET',
        event_id: 'poly-1',
        title: 'NBA Champion 2026',
        total_volume: 1000,
      }),
    ];

    const candidates = findCandidates(kalshi, polyEvents, 10);
    expect(candidates.length).toBe(1);
  });

  it('boosts score for matching categories', () => {
    const kalshi = makeEvent({
      title: 'Rate Decision',
      category: 'Economics',
    });

    const polyEvents = [
      makeEvent({
        exchange_id: 'POLYMARKET',
        event_id: 'poly-1',
        title: 'Interest Rate Outlook',
        category: 'Economics',
        total_volume: 500,
      }),
      makeEvent({
        exchange_id: 'POLYMARKET',
        event_id: 'poly-2',
        title: 'Interest Rate Outlook',
        category: 'Sports',
        total_volume: 500,
      }),
    ];

    const candidates = findCandidates(kalshi, polyEvents, 10);
    expect(candidates.length).toBe(2);
    // Same-category candidate should rank higher
    expect(candidates[0]!.event.event_id).toBe('poly-1');
    expect(candidates[0]!.overlapScore).toBeGreaterThan(candidates[1]!.overlapScore);
  });

  it('category match alone surfaces candidate', () => {
    const kalshi = makeEvent({
      title: 'March Madness Final',
      category: 'Sports',
    });

    const polyEvents = [
      makeEvent({
        exchange_id: 'POLYMARKET',
        event_id: 'poly-1',
        title: 'NCAA Tournament Championship',
        category: 'Sports',
        total_volume: 1000,
      }),
    ];

    const candidates = findCandidates(kalshi, polyEvents, 10);
    expect(candidates.length).toBe(1);
  });

  it('limits results to maxCandidates', () => {
    const kalshi = makeEvent({
      title: 'Presidential Election Winner United States',
    });

    const polyEvents = Array.from({ length: 20 }, (_, i) =>
      makeEvent({
        exchange_id: 'POLYMARKET',
        event_id: `poly-${i}`,
        title: `United States Presidential Election Result ${i}`,
        total_volume: i * 100,
      })
    );

    const candidates = findCandidates(kalshi, polyEvents, 5);
    expect(candidates.length).toBeLessThanOrEqual(5);
  });
});
