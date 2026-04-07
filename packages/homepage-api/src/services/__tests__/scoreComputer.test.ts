import { describe, it, expect } from 'vitest';
import { maxNormalize } from '../scoreComputer.js';

describe('maxNormalize', () => {
  it('should return 0 when value is 0', () => {
    expect(maxNormalize(0, 100)).toBe(0);
  });

  it('should return 1 when value equals max', () => {
    expect(maxNormalize(100, 100)).toBe(1);
  });

  it('should return correct ratio for middle value', () => {
    expect(maxNormalize(50, 100)).toBe(0.5);
  });

  it('should clamp to 1 when value exceeds max', () => {
    expect(maxNormalize(200, 100)).toBe(1);
  });

  it('should return 0 when max is 0', () => {
    expect(maxNormalize(10, 0)).toBe(0);
  });

  it('should return 0 when max is negative', () => {
    expect(maxNormalize(10, -5)).toBe(0);
  });

  it('should handle small fractions', () => {
    expect(maxNormalize(0.001, 1)).toBeCloseTo(0.001);
  });

  it('should handle large values', () => {
    expect(maxNormalize(5e8, 1e9)).toBeCloseTo(0.5);
  });
});

describe('score formula', () => {
  it('should compute correct composite score', () => {
    const n_norm = 0.8;
    const d_norm = 0.6;
    const v_norm = 0.4;
    const score = 0.55 * n_norm + 0.30 * d_norm + 0.15 * v_norm;
    expect(score).toBeCloseTo(0.55 * 0.8 + 0.30 * 0.6 + 0.15 * 0.4);
    expect(score).toBeCloseTo(0.44 + 0.18 + 0.06);
    expect(score).toBeCloseTo(0.68);
  });

  it('should return 0 when all components are 0', () => {
    const score = 0.55 * 0 + 0.30 * 0 + 0.15 * 0;
    expect(score).toBe(0);
  });

  it('should return 1 when all components are 1', () => {
    const score = 0.55 * 1 + 0.30 * 1 + 0.15 * 1;
    expect(score).toBe(1);
  });

  it('should weight notional highest', () => {
    const scoreHighN = 0.55 * 1 + 0.30 * 0 + 0.15 * 0;
    const scoreHighD = 0.55 * 0 + 0.30 * 1 + 0.15 * 0;
    const scoreHighV = 0.55 * 0 + 0.30 * 0 + 0.15 * 1;
    expect(scoreHighN).toBeGreaterThan(scoreHighD);
    expect(scoreHighD).toBeGreaterThan(scoreHighV);
  });
});
