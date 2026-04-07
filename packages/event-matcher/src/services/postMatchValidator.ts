import { createLogger } from '@prediction-market/shared';

const logger = createLogger('post-match-validator');

export interface ValidationResult {
  valid: boolean;
  check?: string;
  reason?: string;
}

// ─────────────────────────────────────────────────────
// Year / date extraction
// ─────────────────────────────────────────────────────

function extractYears(text: string): number[] {
  return [...text.matchAll(/\b(20\d{2})\b/g)].map(m => parseInt(m[1]!));
}

// ─────────────────────────────────────────────────────
// Superlative / ordinal extraction
// ─────────────────────────────────────────────────────

const SUPERLATIVES = [
  'first', 'second', 'third', 'fourth', 'fifth',
  '1st', '2nd', '3rd', '4th', '5th',
  'hottest', 'coldest', 'warmest', 'coolest',
  'most', 'least', 'highest', 'lowest',
  'best', 'worst', 'top', 'bottom',
];

function extractSuperlatives(text: string): string[] {
  const lower = text.toLowerCase();
  return SUPERLATIVES.filter(s => {
    // Word-boundary check to avoid matching "first" inside "thirst", etc.
    const re = new RegExp(`\\b${s}\\b`);
    return re.test(lower);
  });
}

// ─────────────────────────────────────────────────────
// Entity inversion detection
// ─────────────────────────────────────────────────────

const OPPOSING_PAIRS: [RegExp, RegExp][] = [
  [/\bdemocrat(?:ic|s)?\b/i, /\brepublican(?:s)?\b/i],
  [/\bdem(?:s)?\b/i, /\brep(?:s)?\b/i],
  [/\bgop\b/i, /\bdem(?:ocrat(?:ic|s)?)?\b/i],
  [/\bleft\b/i, /\bright\b/i],
  [/\bbull(?:ish)?\b/i, /\bbear(?:ish)?\b/i],
];

function hasEntityInversion(a: string, b: string): boolean {
  for (const [pat1, pat2] of OPPOSING_PAIRS) {
    const aHas1 = pat1.test(a), aHas2 = pat2.test(a);
    const bHas1 = pat1.test(b), bHas2 = pat2.test(b);
    // Inversion: A has entity1 but not entity2, B has entity2 but not entity1
    if (aHas1 && !aHas2 && bHas2 && !bHas1) return true;
    if (aHas2 && !aHas1 && bHas1 && !bHas2) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────
// Numeric threshold extraction
// ─────────────────────────────────────────────────────

interface Threshold {
  value: number;
  context: string;
}

function extractThresholds(text: string): Threshold[] {
  const results: Threshold[] = [];
  const patterns = [
    /(\d+(?:\.\d+)?)\s*%/g,
    /(\d+(?:\.\d+)?)\s+seats/gi,
    /above\s+(\d+(?:\.\d+)?)/gi,
    /below\s+(\d+(?:\.\d+)?)/gi,
    /over\s+(\d+(?:\.\d+)?)/gi,
    /under\s+(\d+(?:\.\d+)?)/gi,
    /at least\s+(\d+(?:\.\d+)?)/gi,
    /at most\s+(\d+(?:\.\d+)?)/gi,
    /more than\s+(\d+(?:\.\d+)?)/gi,
    /fewer than\s+(\d+(?:\.\d+)?)/gi,
    /less than\s+(\d+(?:\.\d+)?)/gi,
  ];
  for (const pat of patterns) {
    for (const m of text.matchAll(pat)) {
      results.push({ value: parseFloat(m[1]!), context: m[0] });
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────
// Main validation entry point
// ─────────────────────────────────────────────────────

const MAX_EXPIRY_DIVERGENCE_DAYS = 30;

/**
 * Validate a match between two titles using deterministic checks.
 * Runs after AI verification says "match" but before DB write.
 * Returns { valid: true } if the match passes all checks.
 *
 * Optional end_date params enable expiry date divergence check for event-level matches.
 */
export function validateMatch(
  sourceTitle: string,
  targetTitle: string,
  sourceEndDate?: Date | null,
  targetEndDate?: Date | null,
): ValidationResult {
  // 1. Year mismatch: both titles contain years but none overlap
  const sourceYears = extractYears(sourceTitle);
  const targetYears = extractYears(targetTitle);
  if (sourceYears.length > 0 && targetYears.length > 0) {
    const sourceSet = new Set(sourceYears);
    const hasOverlap = targetYears.some(y => sourceSet.has(y));
    if (!hasOverlap) {
      return {
        valid: false,
        check: 'YEAR_MISMATCH',
        reason: `Years differ: source=[${[...new Set(sourceYears)]}] target=[${[...new Set(targetYears)]}]`,
      };
    }
  }

  // 2. Entity inversion: opposing political/financial entities
  if (hasEntityInversion(sourceTitle, targetTitle)) {
    return {
      valid: false,
      check: 'ENTITY_INVERSION',
      reason: 'Opposing entities detected between titles',
    };
  }

  // 3. Superlative mismatch: "hottest" vs "third-hottest"
  const sourceSup = extractSuperlatives(sourceTitle);
  const targetSup = extractSuperlatives(targetTitle);
  if (sourceSup.length > 0 && targetSup.length > 0) {
    const sourceKey = sourceSup.sort().join(',');
    const targetKey = targetSup.sort().join(',');
    if (sourceKey !== targetKey) {
      return {
        valid: false,
        check: 'SUPERLATIVE_MISMATCH',
        reason: `Superlatives differ: source=[${sourceSup}] target=[${targetSup}]`,
      };
    }
  }

  // 4. Threshold mismatch: "51 seats" vs "52 seats", "above 3%" vs "above 4%"
  const sourceThresh = extractThresholds(sourceTitle);
  const targetThresh = extractThresholds(targetTitle);
  if (sourceThresh.length === 1 && targetThresh.length === 1) {
    const st = sourceThresh[0]!;
    const tt = targetThresh[0]!;
    if (st.value !== tt.value) {
      return {
        valid: false,
        check: 'THRESHOLD_MISMATCH',
        reason: `Thresholds differ: "${st.context}" vs "${tt.context}"`,
      };
    }
  }

  // 5. Expiry date divergence: reject if end dates differ by > 30 days
  if (sourceEndDate && targetEndDate) {
    const diffMs = Math.abs(sourceEndDate.getTime() - targetEndDate.getTime());
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    if (diffDays > MAX_EXPIRY_DIVERGENCE_DAYS) {
      return {
        valid: false,
        check: 'EXPIRY_DIVERGENCE',
        reason: `End dates differ by ${Math.round(diffDays)} days (max ${MAX_EXPIRY_DIVERGENCE_DAYS})`,
      };
    }
  }

  return { valid: true };
}
