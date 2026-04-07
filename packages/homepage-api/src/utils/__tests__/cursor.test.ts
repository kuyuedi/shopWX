import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../cursor.js';
import type { ScoreCursor, ClosesSoonCursor } from '../cursor.js';

describe('cursor', () => {
  describe('encodeCursor / decodeCursor round-trip', () => {
    it('should round-trip a score cursor', () => {
      const cursor: ScoreCursor = { s: 0.85, t: '2026-03-02T14:30:00Z', i: 'CM-abc1234567890def' };
      const encoded = encodeCursor(cursor);
      const decoded = decodeCursor(encoded);
      expect(decoded).toEqual(cursor);
    });

    it('should round-trip a closes_soon cursor', () => {
      const cursor: ClosesSoonCursor = { d: '2026-03-19T00:00:00Z', t: '2026-03-02T14:30:00Z', i: 'K:FED-26MAR' };
      const encoded = encodeCursor(cursor);
      const decoded = decodeCursor(encoded);
      expect(decoded).toEqual(cursor);
    });

    it('should handle special characters in market IDs', () => {
      const cursor: ScoreCursor = { s: 0.5, t: '2026-03-02T00:00:00Z', i: 'P:0x1234abcd/special+chars=test' };
      const encoded = encodeCursor(cursor);
      const decoded = decodeCursor(encoded);
      expect(decoded).toEqual(cursor);
    });

    it('should handle zero values', () => {
      const cursor: ScoreCursor = { s: 0, t: '', i: 'K:test' };
      const encoded = encodeCursor(cursor);
      const decoded = decodeCursor(encoded);
      expect(decoded).toEqual(cursor);
    });
  });

  describe('decodeCursor invalid input', () => {
    it('should return null for invalid base64', () => {
      expect(decodeCursor('not_valid_base64!!!')).toBeNull();
    });

    it('should return null for valid base64 but invalid JSON', () => {
      const encoded = Buffer.from('not json').toString('base64');
      expect(decodeCursor(encoded)).toBeNull();
    });

    it('should return null for valid JSON but missing i field', () => {
      const encoded = Buffer.from(JSON.stringify({ s: 0.5 })).toString('base64');
      expect(decodeCursor(encoded)).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(decodeCursor('')).toBeNull();
    });
  });
});
