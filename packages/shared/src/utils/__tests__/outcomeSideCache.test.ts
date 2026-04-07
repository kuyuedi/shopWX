import { describe, it, expect, beforeEach } from 'vitest';
import {
  getOutcomeSide,
  bulkSetOutcomeSide,
  getOutcomeSideCacheSize,
  clearOutcomeSideCache,
} from '../outcomeSideCache.js';

beforeEach(() => {
  clearOutcomeSideCache();
});

describe('outcomeSideCache', () => {
  it('returns undefined for unknown key', () => {
    expect(getOutcomeSide('nonexistent')).toBeUndefined();
  });

  it('bulkSetOutcomeSide populates entries', () => {
    const entries = new Map<string, 'YES' | 'NO'>([
      ['token-1', 'YES'],
      ['token-2', 'NO'],
    ]);
    bulkSetOutcomeSide(entries);
    expect(getOutcomeSide('token-1')).toBe('YES');
    expect(getOutcomeSide('token-2')).toBe('NO');
  });

  it('bulkSetOutcomeSide overwrites existing entries', () => {
    const initial = new Map<string, 'YES' | 'NO'>([['token-1', 'YES']]);
    bulkSetOutcomeSide(initial);
    expect(getOutcomeSide('token-1')).toBe('YES');

    const update = new Map<string, 'YES' | 'NO'>([['token-1', 'NO']]);
    bulkSetOutcomeSide(update);
    expect(getOutcomeSide('token-1')).toBe('NO');
  });

  it('getOutcomeSideCacheSize returns correct count', () => {
    expect(getOutcomeSideCacheSize()).toBe(0);
    const entries = new Map<string, 'YES' | 'NO'>([
      ['a', 'YES'],
      ['b', 'NO'],
      ['c', 'YES'],
    ]);
    bulkSetOutcomeSide(entries);
    expect(getOutcomeSideCacheSize()).toBe(3);
  });

  it('clearOutcomeSideCache empties cache', () => {
    const entries = new Map<string, 'YES' | 'NO'>([['token-1', 'YES']]);
    bulkSetOutcomeSide(entries);
    expect(getOutcomeSideCacheSize()).toBe(1);
    clearOutcomeSideCache();
    expect(getOutcomeSideCacheSize()).toBe(0);
    expect(getOutcomeSide('token-1')).toBeUndefined();
  });

  it('handles empty map gracefully', () => {
    bulkSetOutcomeSide(new Map());
    expect(getOutcomeSideCacheSize()).toBe(0);
  });

  it('handles many entries', () => {
    const entries = new Map<string, 'YES' | 'NO'>();
    for (let i = 0; i < 1000; i++) {
      entries.set(`token-${i}`, i % 2 === 0 ? 'YES' : 'NO');
    }
    bulkSetOutcomeSide(entries);
    expect(getOutcomeSideCacheSize()).toBe(1000);
    expect(getOutcomeSide('token-0')).toBe('YES');
    expect(getOutcomeSide('token-1')).toBe('NO');
    expect(getOutcomeSide('token-999')).toBe('NO');
  });

  it('isolation: beforeEach clears state between tests', () => {
    // This test runs after others, cache should be empty due to beforeEach
    expect(getOutcomeSideCacheSize()).toBe(0);
  });
});
