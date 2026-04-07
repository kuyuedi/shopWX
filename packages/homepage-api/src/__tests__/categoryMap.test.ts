import { describe, it, expect } from 'vitest';
import { mapCategory, VALID_CATEGORIES } from '../categoryMap.js';

describe('mapCategory', () => {
  it('should map Sports to sports', () => {
    expect(mapCategory('Sports')).toBe('sports');
  });

  it('should map Crypto to crypto', () => {
    expect(mapCategory('Crypto')).toBe('crypto');
  });

  it('should map Entertainment to entertainment', () => {
    expect(mapCategory('Entertainment')).toBe('entertainment');
  });

  it('should map Politics to politics', () => {
    expect(mapCategory('Politics')).toBe('politics');
  });

  it('should map Elections to politics', () => {
    expect(mapCategory('Elections')).toBe('politics');
  });

  it('should map Economics to economics', () => {
    expect(mapCategory('Economics')).toBe('economics');
  });

  it('should map Financials to economics', () => {
    expect(mapCategory('Financials')).toBe('economics');
  });

  it('should map Companies to economics', () => {
    expect(mapCategory('Companies')).toBe('economics');
  });

  // Unmapped categories should return null
  it('should return null for Climate and Weather', () => {
    expect(mapCategory('Climate and Weather')).toBeNull();
  });

  it('should return null for Mentions', () => {
    expect(mapCategory('Mentions')).toBeNull();
  });

  it('should return null for Science and Technology', () => {
    expect(mapCategory('Science and Technology')).toBeNull();
  });

  it('should return null for Social', () => {
    expect(mapCategory('Social')).toBeNull();
  });

  it('should return null for World', () => {
    expect(mapCategory('World')).toBeNull();
  });

  it('should return null for Health', () => {
    expect(mapCategory('Health')).toBeNull();
  });

  it('should return null for Transportation', () => {
    expect(mapCategory('Transportation')).toBeNull();
  });

  it('should return null for null input', () => {
    expect(mapCategory(null)).toBeNull();
  });

  it('should return null for unknown string', () => {
    expect(mapCategory('Unknown')).toBeNull();
    expect(mapCategory('')).toBeNull();
  });
});

describe('VALID_CATEGORIES', () => {
  it('should contain exactly 5 categories', () => {
    expect(VALID_CATEGORIES.length).toBe(5);
  });

  it('should contain all expected categories', () => {
    expect(VALID_CATEGORIES).toContain('politics');
    expect(VALID_CATEGORIES).toContain('economics');
    expect(VALID_CATEGORIES).toContain('crypto');
    expect(VALID_CATEGORIES).toContain('sports');
    expect(VALID_CATEGORIES).toContain('entertainment');
  });
});
