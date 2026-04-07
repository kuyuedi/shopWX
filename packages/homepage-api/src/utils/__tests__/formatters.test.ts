import { describe, it, expect } from 'vitest';
import { formatVolume, formatDate, normalizePrice } from '../formatters.js';

describe('formatVolume', () => {
  it('should format billions', () => {
    expect(formatVolume(1200000000)).toBe('$1.2B');
    expect(formatVolume(2500000000)).toBe('$2.5B');
  });

  it('should format millions', () => {
    expect(formatVolume(21300000)).toBe('$21.3M');
    expect(formatVolume(1000000)).toBe('$1.0M');
    expect(formatVolume(14700000)).toBe('$14.7M');
  });

  it('should format thousands', () => {
    expect(formatVolume(4900)).toBe('$4.9K');
    expect(formatVolume(1000)).toBe('$1.0K');
    expect(formatVolume(999999)).toBe('$1000.0K');
  });

  it('should format small values', () => {
    expect(formatVolume(500)).toBe('$500');
    expect(formatVolume(0)).toBe('$0');
    expect(formatVolume(1)).toBe('$1');
  });
});

describe('formatDate', () => {
  it('should format a valid date', () => {
    expect(formatDate(new Date('2026-12-31T00:00:00Z'))).toBe('Dec 31, 2026');
    expect(formatDate(new Date('2026-03-19T00:00:00Z'))).toBe('Mar 19, 2026');
    expect(formatDate(new Date('2028-08-01T00:00:00Z'))).toBe('Aug 1, 2028');
  });

  it('should return null for null', () => {
    expect(formatDate(null)).toBeNull();
  });

  it('should return null for invalid date', () => {
    expect(formatDate(new Date('invalid'))).toBeNull();
  });
});

describe('normalizePrice', () => {
  it('should convert decimal prices to cents for all exchanges', () => {
    expect(normalizePrice(0.95, 'KALSHI')).toBe(95);
    expect(normalizePrice(0.05, 'KALSHI')).toBe(5);
    expect(normalizePrice(0, 'KALSHI')).toBe(0);
    expect(normalizePrice(1, 'KALSHI')).toBe(100);
    expect(normalizePrice(0.95, 'POLYMARKET')).toBe(95);
    expect(normalizePrice(0.05, 'POLYMARKET')).toBe(5);
    expect(normalizePrice(0, 'POLYMARKET')).toBe(0);
    expect(normalizePrice(1, 'POLYMARKET')).toBe(100);
    expect(normalizePrice(0.67, 'POLYMARKET')).toBe(67);
  });

  it('should return null for null price', () => {
    expect(normalizePrice(null, 'KALSHI')).toBeNull();
    expect(normalizePrice(null, 'POLYMARKET')).toBeNull();
  });
});
