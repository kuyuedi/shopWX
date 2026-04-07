import {
  KALSHI_SOURCE_ID,
  KALSHI_EXCHANGE_ID,
  type NormalizedMarket,
  type NormalizedTicker,
  type NormalizedOrderBook,
  type NormalizedTrade,
} from '@prediction-market/shared';

export interface KalshiMarket {
  ticker: string;
  event_ticker?: string;
  series_ticker?: string;
  title: string;
  subtitle?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  rules_primary?: string;
  rules_secondary?: string;
  category?: string;
  status: string;
  // Legacy fields (cents 0-100)
  yes_bid?: number;
  yes_ask?: number;
  last_price?: number;
  volume?: number;
  volume_24h?: number;
  open_interest?: number;
  // New fields (dollars 0-1, 2026-03 API change)
  yes_bid_dollars?: number;
  yes_ask_dollars?: number;
  no_bid_dollars?: number;
  no_ask_dollars?: number;
  last_price_dollars?: number;
  volume_fp?: number;
  volume_24h_fp?: number;
  open_interest_fp?: number;
  close_time?: string;
  expiration_time?: string;
}

function mapStatus(status: string): string {
  const statusLower = status.toLowerCase();
  if (statusLower === 'open' || statusLower === 'active') return 'Open';
  if (statusLower === 'closed') return 'Closed';
  if (statusLower === 'resolved' || statusLower === 'finalized') return 'Resolved';
  if (statusLower === 'cancelled' || statusLower === 'canceled') return 'Cancelled';
  return 'Open'; // Default to Open
}

export function normalizeMarket(market: KalshiMarket): NormalizedMarket[] {
  // Truncate market_id to 255 chars to fit DB constraint
  const marketId = market.ticker.length > 255 ? market.ticker.substring(0, 255) : market.ticker;

  // Combine title + yes_sub_title for a unique market name
  // Kalshi title is the event-level question (e.g., "SOL price on Feb 1, 2026?")
  // yes_sub_title is the market-specific differentiator (e.g., "101 or above", "Atlanta")
  const subTitle = market.yes_sub_title || market.subtitle;
  const fullTitle = subTitle ? `${market.title} — ${subTitle}` : market.title;
  // Truncate to 512 chars to fit DB constraint
  const title = fullTitle.length > 512 ? fullTitle.substring(0, 509) + '...' : fullTitle;

  // Truncate event_id to 255 chars to fit DB constraint
  const eventId = market.event_ticker
    ? (market.event_ticker.length > 255 ? market.event_ticker.substring(0, 255) : market.event_ticker)
    : undefined;

  // Truncate series_id to 255 chars to fit DB constraint
  const seriesId = market.series_ticker
    ? (market.series_ticker.length > 255 ? market.series_ticker.substring(0, 255) : market.series_ticker)
    : undefined;

  const base = {
    sourceId: KALSHI_SOURCE_ID,
    exchangeId: KALSHI_EXCHANGE_ID,
    marketId,
    eventId,
    seriesId,
    marketName: title,
    rulesPrimary: market.rules_primary,
    rulesSecondary: market.rules_secondary,
    category: market.category,
    status: mapStatus(market.status),
    endDate: market.expiration_time
      ? new Date(market.expiration_time)
      : market.close_time
        ? new Date(market.close_time)
        : undefined,
    sourceSpecificData: {
      open_interest: market.open_interest_fp ?? market.open_interest,
      volume_24h: market.volume_24h_fp ?? market.volume_24h,
    },
  };

  // Helper to clamp price between 0 and 1
  const clampPrice = (p: number | undefined): number | undefined => {
    if (p === undefined || p === null) return undefined;
    if (p < 0) return 0;
    if (p > 1) return 1;
    return p;
  };

  // Kalshi prices: new API uses dollars (0-1), legacy used cents (0-100)
  // Prefer new dollar fields, fall back to legacy cents fields
  const lastPrice = market.last_price_dollars ?? (market.last_price !== undefined ? market.last_price / 100 : undefined);
  const yesBid = market.yes_bid_dollars ?? (market.yes_bid !== undefined ? market.yes_bid / 100 : undefined);
  const yesAsk = market.yes_ask_dollars ?? (market.yes_ask !== undefined ? market.yes_ask / 100 : undefined);

  // Return both YES and NO sides
  return [
    {
      ...base,
      outcomeSide: 'YES' as const,
      subTitle: market.yes_sub_title,
      price: clampPrice(lastPrice ?? yesBid),
    },
    {
      ...base,
      outcomeSide: 'NO' as const,
      subTitle: market.no_sub_title || market.yes_sub_title,
      price: clampPrice(lastPrice !== undefined ? 1 - lastPrice : (yesAsk !== undefined ? 1 - yesAsk : undefined)),
    },
  ];
}

export function normalizeTicker(
  ticker: string,
  data: {
    yes_bid?: number;
    yes_ask?: number;
    last_price?: number;
    volume_24h?: number;
    open_interest?: number;
  }
): NormalizedTicker {
  return {
    sourceId: KALSHI_SOURCE_ID,
    exchangeId: KALSHI_EXCHANGE_ID,
    marketId: ticker,
    price: data.last_price,
    volume24h: data.volume_24h,
    openInterest: data.open_interest,
    bid: data.yes_bid,
    ask: data.yes_ask,
    timestamp: new Date(),
  };
}

export function normalizeOrderBook(
  ticker: string,
  bids: Array<[number, number]>,
  asks: Array<[number, number]>
): NormalizedOrderBook {
  return {
    sourceId: KALSHI_SOURCE_ID,
    exchangeId: KALSHI_EXCHANGE_ID,
    marketId: ticker,
    bids: bids.map(([price, quantity]) => ({ price, quantity })),
    asks: asks.map(([price, quantity]) => ({ price, quantity })),
    timestamp: new Date(),
  };
}

export function normalizeTrade(
  ticker: string,
  data: {
    trade_id?: string;
    price: number;
    count: number;
    taker_side?: string;
    created_time?: string;
  }
): NormalizedTrade {
  return {
    sourceId: KALSHI_SOURCE_ID,
    exchangeId: KALSHI_EXCHANGE_ID,
    marketId: ticker,
    tradeId: data.trade_id,
    price: data.price,
    quantity: data.count,
    side: data.taker_side === 'yes' ? 'Buy' : data.taker_side === 'no' ? 'Sell' : undefined,
    timestamp: data.created_time ? new Date(data.created_time) : new Date(),
  };
}
