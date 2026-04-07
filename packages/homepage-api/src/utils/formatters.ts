export function formatVolume(notional: number): string {
  if (notional >= 1e9) return `$${(notional / 1e9).toFixed(1)}B`;
  if (notional >= 1e6) return `$${(notional / 1e6).toFixed(1)}M`;
  if (notional >= 1e3) return `$${(notional / 1e3).toFixed(1)}K`;
  return `$${Math.round(notional)}`;
}

export function formatDate(date: Date | null): string | null {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[d.getUTCMonth()];
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();
  return `${month} ${day}, ${year}`;
}

export function normalizePrice(price: number | null, _exchangeId: string): number | null {
  if (price == null) return null;
  // Both exchanges store decimal (0-1) in prediction_markets.price
  return Math.round(price * 100);
}
