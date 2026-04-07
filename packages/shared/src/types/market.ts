export type OutcomeSide = 'YES' | 'NO';
export type TradeSide = 'Buy' | 'Sell';

export interface NormalizedMarket {
  sourceId: string;
  exchangeId: string;
  marketId: string;
  eventId?: string;
  seriesId?: string;
  outcomeSide: OutcomeSide;
  marketName: string;
  subTitle?: string;
  rulesPrimary?: string;
  rulesSecondary?: string;
  category?: string;
  price?: number;
  endDate?: Date;
  status?: string;
  sourceSpecificData?: Record<string, unknown>;
}

export interface NormalizedTicker {
  sourceId: string;
  exchangeId: string;
  marketId: string;
  price?: number;
  volume24h?: number;
  openInterest?: number;
  bid?: number;
  bidSize?: number;
  ask?: number;
  askSize?: number;
  timestamp: Date;
}

export interface NormalizedOrderBook {
  sourceId: string;
  exchangeId: string;
  marketId: string;
  bids: Array<{ price: number; quantity: number }>;
  asks: Array<{ price: number; quantity: number }>;
  timestamp: Date;
}

export interface NormalizedTrade {
  sourceId: string;
  exchangeId: string;
  marketId: string;
  tradeId?: string;
  price: number;
  quantity: number;
  side?: TradeSide;
  timestamp: Date;
}

export interface MarketSubscription {
  marketId: string;
  ticker: string;
  channels: string[];
}

export const KALSHI_SOURCE_ID = 'KALSHI_DIRECT';
export const KALSHI_EXCHANGE_ID = 'KALSHI';

export const POLYMARKET_SOURCE_ID = 'POLYMARKET_DIRECT';
export const POLYMARKET_EXCHANGE_ID = 'POLYMARKET';

export const OPINION_SOURCE_ID = 'OPINION_DIRECT';
export const OPINION_EXCHANGE_ID = 'OPINIONTRADE';

export const PREDICT_SOURCE_ID = 'PREDICT_DIRECT';
export const PREDICT_EXCHANGE_ID = 'PREDICT';
