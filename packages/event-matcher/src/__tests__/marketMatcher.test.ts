import { describe, it, expect, vi } from 'vitest';
import {
  classifyMarketType,
  areMarketTypesCompatible,
  substringMatch,
  checkModifierConflict,
} from '../services/marketMatcher.js';
import type { MarketStructuralType } from '../services/marketMatcher.js';

// Mock aiComparer to avoid real OpenAI calls in tests
vi.mock('../services/aiComparer.js', () => ({
  verifyModifierConflict: vi.fn().mockResolvedValue('DIFFERENT'),
  verifyMarketMatch: vi.fn().mockResolvedValue({ match: false, confidence: 0, reasoning: 'mocked' }),
}));

const mockConfig = {
  model: 'gpt-5-nano',
  apiKey: 'test-key',
  intervalMs: 300000,
  confidenceThreshold: 0.85,
  candidatesPerBatch: 10,
  matchVersion: 1,
  minEventVolume: 0,
  marketMatchThreshold: 0.85,
  marketMatchAiThreshold: 0.3,
  recheckIntervalMs: 86400000,
};

describe('classifyMarketType', () => {
  it('should classify spread markets', () => {
    expect(classifyMarketType('Team A -1.5')).toBe('SPREAD');
    expect(classifyMarketType('Lakers +3.5 spread')).toBe('SPREAD');
    expect(classifyMarketType('handicap match')).toBe('SPREAD');
  });

  it('should classify BTTS markets', () => {
    expect(classifyMarketType('Both Teams to Score')).toBe('BTTS');
    expect(classifyMarketType('BTTS - Yes')).toBe('BTTS');
    expect(classifyMarketType('Will Chelsea keep a clean sheet?')).toBe('BTTS');
  });

  it('should classify win method markets', () => {
    expect(classifyMarketType('Fighter wins by KO')).toBe('WIN_METHOD');
    expect(classifyMarketType('Victory by submission')).toBe('WIN_METHOD');
    expect(classifyMarketType('Win by decision')).toBe('WIN_METHOD');
    expect(classifyMarketType('by split decision')).toBe('WIN_METHOD');
  });

  it('should classify over/under markets', () => {
    expect(classifyMarketType('Over 2.5 goals in match')).toBe('OVER_UNDER');
    expect(classifyMarketType('Under 3 goals scored')).toBe('OVER_UNDER');
    expect(classifyMarketType('Total goals in match')).toBe('OVER_UNDER');
    expect(classifyMarketType('Total points scored')).toBe('OVER_UNDER');
  });

  it('should classify correct score markets', () => {
    expect(classifyMarketType('Correct Score: 2-1')).toBe('CORRECT_SCORE');
  });

  it('should classify first half markets', () => {
    expect(classifyMarketType('First half result')).toBe('FIRST_HALF');
    expect(classifyMarketType('Leading at half')).toBe('FIRST_HALF');
    expect(classifyMarketType('Halftime score')).toBe('FIRST_HALF');
  });

  it('should classify draw/tie markets', () => {
    expect(classifyMarketType('Match ends in a draw')).toBe('DRAW');
    expect(classifyMarketType('Will the game tie?')).toBe('DRAW');
  });

  it('should classify round markets', () => {
    expect(classifyMarketType('Fight ends in round 3')).toBe('ROUND');
    expect(classifyMarketType('Will it go the distance?')).toBe('ROUND');
  });

  it('should classify win markets', () => {
    expect(classifyMarketType('Will Lakers win?')).toBe('WIN');
    expect(classifyMarketType('Who is the winner?')).toBe('WIN');
  });

  it('should classify margin markets', () => {
    expect(classifyMarketType('Win by 6 points')).toBe('MARGIN');
    expect(classifyMarketType('Margin of victory')).toBe('MARGIN');
  });

  it('should return UNKNOWN for non-sports binary', () => {
    expect(classifyMarketType('Will Bitcoin hit $150k?')).toBe('UNKNOWN');
    expect(classifyMarketType('Fed rate cut in June?')).toBe('UNKNOWN');
    expect(classifyMarketType('Will TikTok be banned?')).toBe('UNKNOWN');
  });
});

describe('areMarketTypesCompatible', () => {
  it('should reject different specific types', () => {
    const incompatible: [MarketStructuralType, MarketStructuralType][] = [
      ['WIN', 'BTTS'],
      ['WIN', 'DRAW'],
      ['WIN', 'SPREAD'],
      ['WIN', 'OVER_UNDER'],
      ['BTTS', 'OVER_UNDER'],
      ['SPREAD', 'CORRECT_SCORE'],
      ['WIN_METHOD', 'ROUND'],
    ];
    for (const [a, b] of incompatible) {
      expect(areMarketTypesCompatible(a, b)).toBe(false);
    }
  });

  it('should allow same type', () => {
    const types: MarketStructuralType[] = ['WIN', 'DRAW', 'BTTS', 'SPREAD', 'OVER_UNDER'];
    for (const t of types) {
      expect(areMarketTypesCompatible(t, t)).toBe(true);
    }
  });

  it('should allow UNKNOWN with anything', () => {
    const types: MarketStructuralType[] = ['WIN', 'DRAW', 'BTTS', 'SPREAD', 'OVER_UNDER', 'UNKNOWN'];
    for (const t of types) {
      expect(areMarketTypesCompatible('UNKNOWN', t)).toBe(true);
      expect(areMarketTypesCompatible(t, 'UNKNOWN')).toBe(true);
    }
  });

  it('should allow BINARY with anything', () => {
    const types: MarketStructuralType[] = ['WIN', 'DRAW', 'BTTS', 'BINARY'];
    for (const t of types) {
      expect(areMarketTypesCompatible('BINARY', t)).toBe(true);
      expect(areMarketTypesCompatible(t, 'BINARY')).toBe(true);
    }
  });
});

describe('substringMatch', () => {
  it('should match forward: Kalshi name in Polymarket title', () => {
    expect(substringMatch('Oklahoma City', 'Will Oklahoma City win the finals?')).toBe(true);
  });

  it('should match bidirectionally: Poly entity in Kalshi name', () => {
    expect(substringMatch('Andrea Kimi Antonelli', 'Kimi Antonelli')).toBe(true);
  });

  it('should handle tie/draw synonyms', () => {
    expect(substringMatch('Tie', 'Will the match end in a draw?')).toBe(true);
    expect(substringMatch('Draw', 'Will the match tie?')).toBe(true);
  });

  it('should match abbreviations via expansion', () => {
    expect(substringMatch('Man City', 'Will Manchester City win?')).toBe(true);
    expect(substringMatch('PSG', 'Paris Saint Germain wins')).toBe(true);
  });

  it('should use word boundaries for short names', () => {
    expect(substringMatch('Tie', 'parties together')).toBe(false);
  });

  it('should not match unrelated strings', () => {
    expect(substringMatch('Lakers', 'Will Celtics win?')).toBe(false);
  });
});

describe('checkModifierConflict', () => {
  it('should auto-reject WIN_METHOD mismatch', async () => {
    const result = await checkModifierConflict(
      'Will Axel Sola win the fight?',
      'Will Axel Sola win by KO?',
      mockConfig
    );
    expect(result.reject).toBe(true);
    expect(result.reason).toContain('WIN_METHOD');
  });

  it('should auto-reject BTTS mismatch', async () => {
    const result = await checkModifierConflict(
      'Will Wolfsburg win?',
      'Both Teams to Score in Wolfsburg match',
      mockConfig
    );
    expect(result.reject).toBe(true);
    expect(result.reason).toContain('MARKET_TYPE_SPORTS');
  });

  it('should auto-reject when only one side has halftime qualifier', async () => {
    const result = await checkModifierConflict(
      'Will Real Madrid win?',
      'Real Madrid leading at half',
      mockConfig
    );
    expect(result.reject).toBe(true);
  });

  it('should pass when no modifier conflict', async () => {
    const result = await checkModifierConflict(
      'Will Bitcoin hit $150k?',
      'Bitcoin to reach $150,000?',
      mockConfig
    );
    expect(result.reject).toBe(false);
  });

  it('should pass when both sides have same modifier', async () => {
    const result = await checkModifierConflict(
      'Fighter wins by KO',
      'Fighter wins by KO or TKO',
      mockConfig
    );
    // Both have WIN_METHOD patterns, so kHas === pHas → no conflict
    expect(result.reject).toBe(false);
  });

  it('should AI-verify RANGE_QUALIFIER mismatch (mocked as DIFFERENT)', async () => {
    const result = await checkModifierConflict(
      'Republicans win 47 Senate seats',
      'Republicans win 47 or fewer Senate seats',
      mockConfig
    );
    expect(result.reject).toBe(true);
    expect(result.reason).toContain('RANGE_QUALIFIER');
  });

  it('should AI-verify TIME_SCOPE mismatch (mocked as DIFFERENT)', async () => {
    const result = await checkModifierConflict(
      'Starmer out as PM',
      'Starmer out as PM before 2027',
      mockConfig
    );
    expect(result.reject).toBe(true);
    expect(result.reason).toContain('TIME_SCOPE');
  });
});
