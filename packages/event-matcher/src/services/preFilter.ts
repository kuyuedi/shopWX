import type { EventForMatching } from '@prediction-market/shared';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'as', 'be', 'was', 'are',
  'will', 'would', 'could', 'should', 'may', 'might', 'can', 'has',
  'have', 'had', 'do', 'does', 'did', 'not', 'no', 'yes', 'if', 'than',
  'then', 'that', 'this', 'what', 'which', 'who', 'whom', 'how', 'when',
  'where', 'why', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
  'other', 'some', 'such', 'only', 'own', 'same', 'so', 'too', 'very',
  'just', 'because', 'about', 'up', 'out', 'over', 'under', 'between',
  'before', 'after', 'above', 'below', 'any', 'its', 'their', 'his',
  'her', 'they', 'them', 'he', 'she', 'we', 'us', 'our', 'my', 'your',
  'been', 'being', 'were', 'market', 'markets', 'price',
]);

// Fix 3b: Synonym normalization map — normalize common financial/political synonyms
// before keyword comparison so "cut" matches "decrease", etc.
const SYNONYMS: Record<string, string> = {
  'cut': 'decrease',
  'hike': 'increase',
  'raise': 'increase',
  'lower': 'decrease',
  'slash': 'decrease',
  'reduction': 'decrease',
  'boost': 'increase',
  'buy': 'acquire',
  'purchase': 'acquire',
  'obtain': 'acquire',
  'win': 'victory',
  'beat': 'victory',
  'defeat': 'victory',
  'maintain': 'nochange',
  'maintained': 'nochange',
  'maintains': 'nochange',
  'unchanged': 'nochange',
  'steady': 'nochange',
  'leave': 'depart',
  'resign': 'depart',
  'quit': 'depart',
  'step down': 'depart',
  'above': 'exceed',
  'exceed': 'exceed',
  'exceeds': 'exceed',
  'none': 'no',
  'before': 'by',
};

/**
 * Fix 3c: Strip accented characters (Unicode normalization).
 * "São Paulo" → "Sao Paulo", "González" → "Gonzalez"
 */
export function stripAccents(str: string): string {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Fix 3b: Apply synonym normalization to a string.
 * Replaces known synonym words with their canonical form.
 */
export function normalizeSynonyms(text: string): string {
  let normalized = text.toLowerCase();
  for (const [key, value] of Object.entries(SYNONYMS)) {
    // Use word boundary matching to avoid partial replacements
    normalized = normalized.replace(new RegExp(`\\b${key}\\b`, 'gi'), value);
  }
  return normalized;
}

/**
 * Fix 3a: Extract entity name from Kalshi subtitle pattern.
 * "Who will win Los Angeles Mayoral Election? — Adam Miller" → "Adam Miller"
 */
export function extractEntity(title: string): string | null {
  const dashMatch = title.match(/\s*[—–-]\s*(.+)$/);
  if (dashMatch) return dashMatch[1]!.trim();
  return null;
}

/**
 * After stripping -ing/-ed, restore trailing 'e' when the stem
 * doesn't end in a doubled consonant (trade→trading, rate→rated).
 */
function restoreE(stemmed: string): string {
  if (
    stemmed.length >= 2 &&
    stemmed[stemmed.length - 1] !== stemmed[stemmed.length - 2]
  ) {
    return stemmed + 'e';
  }
  return stemmed;
}

/**
 * Apply one pass of suffix stripping.
 */
function stemOnce(word: string): string {
  // Long suffixes first
  if (word.length > 5 && word.endsWith('iness')) return word.slice(0, -5) + 'y';
  if (word.length > 5 && word.endsWith('ation')) return word.slice(0, -5);
  if (word.length > 5 && word.endsWith('ement')) return word.slice(0, -4);
  if (word.length > 4 && word.endsWith('ship')) return word.slice(0, -4);
  if (word.length > 4 && word.endsWith('ment')) return word.slice(0, -4);
  if (word.length > 4 && word.endsWith('ness')) return word.slice(0, -4);
  if (word.length > 4 && word.endsWith('able')) return word.slice(0, -4);
  if (word.length > 4 && word.endsWith('ible')) return word.slice(0, -4);
  if (word.length > 4 && word.endsWith('ious')) return word.slice(0, -4);
  if (word.length > 4 && word.endsWith('ical')) return word.slice(0, -4);
  if (word.length > 4 && word.endsWith('ally')) return word.slice(0, -4);
  if (word.length > 4 && word.endsWith('ing')) return restoreE(word.slice(0, -3));
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 4 && word.endsWith('ion')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ers')) return word.slice(0, -3);
  if (word.length > 3 && word.endsWith('ed')) return restoreE(word.slice(0, -2));
  if (word.length > 3 && word.endsWith('er')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('ly')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('al')) return word.slice(0, -2);
  // Sibilant plurals: -ses, -xes, -zes, -ches, -shes
  if (word.length > 3 && /(?:s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  // Regular plurals
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * Simple recursive suffix-stripping stemmer.
 * Reduces words to a common root so "championship"/"champion",
 * "elections"/"election", "trading"/"trade" match each other.
 */
export function stem(word: string): string {
  let result = word;
  for (let i = 0; i < 3; i++) {
    const next = stemOnce(result);
    if (next === result) break;
    result = next;
  }
  return result;
}

/**
 * Extract meaningful keywords from an event title.
 * Removes stop words, numbers, and short tokens. Applies stemming.
 * Fix 3b/3c: Now applies accent stripping and synonym normalization.
 */
export function extractKeywords(title: string): Set<string> {
  const normalized = normalizeSynonyms(stripAccents(title));
  const words = normalized
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));

  return new Set(words.map(stem));
}

/**
 * Normalize a category string for comparison.
 */
function normalizeCategory(cat: string): string {
  return cat.toLowerCase().replace(/[^a-z]/g, '');
}

interface CandidateResult {
  event: EventForMatching;
  overlapScore: number;
}

/**
 * Find the top N Polymarket candidates for a given Kalshi event
 * by keyword overlap scoring, with stemming, category boost,
 * entity extraction (Fix 3a), synonym normalization (Fix 3b),
 * and accent stripping (Fix 3c).
 */
export function findCandidates(
  kalshiEvent: EventForMatching,
  polymarketEvents: EventForMatching[],
  maxCandidates: number
): CandidateResult[] {
  const kalshiKeywords = extractKeywords(kalshiEvent.title || '');
  if (kalshiKeywords.size === 0) return [];

  const kalshiCategory = kalshiEvent.category
    ? normalizeCategory(kalshiEvent.category)
    : null;

  // Also extract from subtitle for bonus matching
  const kalshiSubtitleKeywords = kalshiEvent.subtitle
    ? extractKeywords(kalshiEvent.subtitle)
    : new Set<string>();

  // Fix 3a: Extract entity name from Kalshi dash pattern
  const kalshiEntity = extractEntity(kalshiEvent.title || '');
  const kalshiEntityNorm = kalshiEntity
    ? stripAccents(kalshiEntity).toLowerCase()
    : null;

  const scored: CandidateResult[] = [];

  for (const polyEvent of polymarketEvents) {
    const polyKeywords = extractKeywords(polyEvent.title || '');
    if (polyKeywords.size === 0) continue;

    // Count title keyword overlap (on stemmed tokens)
    let overlap = 0;
    for (const keyword of kalshiKeywords) {
      if (polyKeywords.has(keyword)) overlap++;
    }

    // Bonus for subtitle keyword overlap
    if (kalshiSubtitleKeywords.size > 0) {
      for (const keyword of kalshiSubtitleKeywords) {
        if (polyKeywords.has(keyword)) overlap += 0.5;
      }
    }

    // Fix 3a: Entity name bonus — if the Kalshi entity name appears
    // in the Polymarket title, boost significantly to force GPT evaluation
    if (kalshiEntityNorm) {
      const polyTitleNorm = stripAccents(polyEvent.title || '').toLowerCase();
      if (polyTitleNorm.includes(kalshiEntityNorm)) {
        overlap += 3; // Strong boost — entity match is highly indicative
      }
    }

    // Category boost: +1 overlap point when categories match
    if (kalshiCategory && polyEvent.category) {
      const polyCategory = normalizeCategory(polyEvent.category);
      if (kalshiCategory === polyCategory) {
        overlap += 1;
      }
    }

    if (overlap < 1) continue; // Need at least 1 keyword match (or category match)

    // Jaccard-like score: overlap / union
    const union = new Set([...kalshiKeywords, ...polyKeywords]).size;
    const overlapScore = overlap / union;

    scored.push({ event: polyEvent, overlapScore });
  }

  // Sort by overlap score DESC, then by volume DESC
  scored.sort((a, b) => {
    const scoreDiff = b.overlapScore - a.overlapScore;
    if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
    return b.event.total_volume - a.event.total_volume;
  });

  return scored.slice(0, maxCandidates);
}
