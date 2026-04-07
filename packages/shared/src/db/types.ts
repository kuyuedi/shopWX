export type OutcomeType = 'Binary' | 'Scalar' | 'MultipleChoice';

export interface PredictionMarket {
  source_id: string;
  exchange_id: string;
  market_id: string;
  event_id?: string;
  series_id?: string;
  outcome_side: 'YES' | 'NO';
  outcome_name?: string;        // Human-readable: "Yes", "No", or specific outcome like "Chiefs"
  outcome_type?: OutcomeType;   // Market structure: Binary, Scalar, or MultipleChoice
  market_name: string;
  sub_title?: string;
  rules_primary?: string;
  rules_secondary?: string;
  category?: string;
  price?: number;
  end_date?: Date;
  status?: string;
  source_specific_data?: Record<string, unknown>;
  created_at?: Date;
  updated_at?: Date;
}

export interface MarketLatestData {
  source_id: string;
  exchange_id: string;
  market_id: string;
  outcome_side?: 'YES' | 'NO';
  price_open?: number;
  price_high?: number;
  price_low?: number;
  price_close?: number;
  volume_traded?: number;
  trades_count?: number;
  reference_price?: number;
  band_liquidity_qty_ask?: number;
  band_liquidity_qty_bid?: number;
  band_vwap_ask?: number;
  band_vwap_bid?: number;
  band_delta_used?: number;
  entry_time?: Date;
  updated_at?: Date;
}

export interface OrderBook {
  source_id: string;
  exchange_id: string;
  market_id: string;
  outcome_side?: 'YES' | 'NO';
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  entry_time: Date;
}

export interface OrderBookLevel {
  price: number;
  quantity: number;
}

export interface Quote {
  source_id: string;
  exchange_id: string;
  market_id: string;
  outcome_side?: 'YES' | 'NO';
  bid?: number;
  bid_size?: number;
  ask?: number;
  ask_size?: number;
  entry_time: Date;
}

export interface Trade {
  source_id: string;
  exchange_id: string;
  market_id: string;
  trade_id?: string;
  price: number;
  quantity: number;
  side?: 'Buy' | 'Sell';
  outcome?: 'YES' | 'NO';
  entry_time: Date;
}

export interface Exchange {
  exchange_id: string;
  name: string;
  type: string;
  is_active: boolean;
}

export interface MarketForMatching {
  source_id: string;
  exchange_id: string;
  market_id: string;
  outcome_side: 'YES' | 'NO';
  outcome_name: string | null;
  title: string;
  sub_title: string | null;
  rules_primary: string | null;
  category: string | null;
  price: number | null;
  expires_at: Date | null;
  status: string | null;
}

export interface MarketMapping {
  source_id: string;
  exchange_id: string;
  market_id: string;
  outcome_side: 'YES' | 'NO';
  canonical_market_id: string;
  confidence_score: number;
  matched_at: Date;
  model_id: string;
  match_version: number;
}

export interface MarketTitle {
  canonical_market_id: string;
  generated_title: string;
  kalshi_title: string | null;
  polymarket_title: string | null;
  model_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ExchangeEvent {
  source_id: string;
  exchange_id: string;
  event_id: string;
  title?: string;
  subtitle?: string;
  category?: string;
  series_id?: string;
  status?: string;
  end_date?: Date;
  image_url?: string;
  mutually_exclusive?: boolean;
  market_count?: number;
  source_specific_data?: Record<string, unknown>;
}

export interface EventMapping {
  source_id: string;
  exchange_id: string;
  event_id: string;
  canonical_event_id: string;
  confidence_score: number;
  matched_at: Date;
  model_id: string;
  match_version: number;
}

export interface EventForMatching {
  source_id: string;
  exchange_id: string;
  event_id: string;
  title: string;
  subtitle: string | null;
  category: string | null;
  end_date: Date | null;
  market_count: number | null;
  total_volume: number;
  total_trades: number;
  match_checked_at: Date | null;
}

export interface MatchedEventPair {
  source_event_id: string;
  source_source_id: string;
  source_exchange_id: string;
  target_event_id: string;
  target_source_id: string;
  target_exchange_id: string;
  canonical_event_id: string;
}

export interface ArbConfig {
  config_key: string;
  config_value: string;
  description: string | null;
  updated_at: Date;
}

export interface MarketLeg {
  canonical_market_id: string;
  canonical_event_id: string | null;
  exchange_id: string;
  source_id: string;
  market_id: string;
  outcome_side: 'YES' | 'NO';
  band_vwap_ask: number | null;
  band_vwap_bid: number | null;
  band_liquidity_qty_ask: number | null;
  band_liquidity_qty_bid: number | null;
  reference_price: number | null;
  confidence_score: number;
  market_title: string | null;
  category: string | null;
  expires_at: Date | null;
  data_updated_at: Date;
  token_id: string | null;
}

export type ArbSubtype = 'CROSS_PLATFORM' | 'TIME_DECAY' | 'LIQUIDITY_GAP';

export interface ArbOpportunity {
  arb_id: number;
  canonical_market_id: string;
  canonical_event_id: string | null;
  arb_type: 'DIRECT' | 'COMPLEMENT';
  arb_subtype: ArbSubtype | null;
  leg1_exchange_id: string;
  leg1_source_id: string;
  leg1_market_id: string;
  leg1_side: 'YES' | 'NO';
  leg1_action: string;
  leg1_vwap: number | null;
  leg1_liquidity_qty: number | null;
  leg2_exchange_id: string;
  leg2_source_id: string;
  leg2_market_id: string;
  leg2_side: 'YES' | 'NO';
  leg2_action: string;
  leg2_vwap: number | null;
  leg2_liquidity_qty: number | null;
  gross_spread: number;
  gross_spread_pct: number;
  executable_qty: number | null;
  gross_profit: number | null;
  prev_gross_spread_pct: number | null;
  market_title: string | null;
  category: string | null;
  expires_at: Date | null;
  mapping_confidence: number | null;
  status: 'ACTIVE' | 'EXPIRED' | 'EXECUTED' | 'DISMISSED';
  detected_at: Date;
  updated_at: Date;
  last_checked_at: Date;
  expired_at: Date | null;
  leg1_data_at: Date | null;
  leg2_data_at: Date | null;
}

export interface MarketScore {
  id: string;
  score: number;
  notional_24h: number;
  depth: number;
  trades_24h: number;
  n_norm: number;
  d_norm: number;
  v_norm: number;
  category: string | null;
  is_matched: boolean;
  canonical_market_id: string | null;
  exchange_id: string | null;
  source_id: string | null;
  market_id: string | null;
  event_id: string | null;
  outcome_side: string;
  title: string | null;
  thumb: string | null;
  end_date: Date | null;
  end_date_formatted: string | null;
  volume_formatted: string | null;
  status: string | null;
  updated_at: Date | null;
  computed_at: Date;
}
