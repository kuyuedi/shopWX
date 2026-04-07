const KALSHI_CATEGORY_MAP: Record<string, string> = {
  'Sports': 'sports',
  'Crypto': 'crypto',
  'Entertainment': 'entertainment',
  'Politics': 'politics',
  'Elections': 'politics',
  'Economics': 'economics',
  'Financials': 'economics',
  'Companies': 'economics',
};

export const VALID_CATEGORIES = ['politics', 'economics', 'crypto', 'sports', 'entertainment'] as const;

export const CATEGORY_LABELS: Record<string, string> = {
  politics: 'Politics',
  economics: 'Economics',
  crypto: 'Crypto',
  sports: 'Sports',
  entertainment: 'Entertainment',
};

export function mapCategory(kalshiCategory: string | null): string | null {
  if (!kalshiCategory) return null;
  return KALSHI_CATEGORY_MAP[kalshiCategory] ?? null;
}
