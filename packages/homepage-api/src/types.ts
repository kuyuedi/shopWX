export interface MarketOutcome {
  label: string;
  prices: Record<string, number>;
}

export interface MarketResponse {
  id: string;
  title: string;
  thumb: string | null;
  category: string | null;
  end_date: string | null;
  volume: string | null;
  exchanges: string[];
  outcomes: MarketOutcome[];
  updated_at: string | null;
}

export interface MarketsListResponse {
  markets: MarketResponse[];
  next_cursor: string | null;
  has_more: boolean;
  total: number;
}

export interface TickerItem {
  tag: string;
  text: string;
}

export interface TickerResponse {
  items: TickerItem[];
}

export interface CategoryItem {
  slug: string;
  label: string;
  count: number;
}

export interface CategoriesResponse {
  categories: CategoryItem[];
}

export interface StatsResponse {
  total_markets: number;
  volume_24h: string;
  exchange_count: number;
  exchanges: string[];
  last_updated: string | null;
}

export interface HealthResponse {
  status: string;
  uptime_seconds: number;
  db_connected: boolean;
  last_score_computation: string | null;
}

export interface EventMarket {
  id: string;
  title: string;
  prices: Record<string, number>;
}

export interface EventResponse {
  id: string;
  title: string;
  subtitle: string | null;
  category: string | null;
  end_date: string | null;
  image_url: string | null;
  is_matched: boolean;
  exchanges: string[];
  total_volume: string;
  market_count: number;
  markets: EventMarket[];
  updated_at: string | null;
}

export interface EventsListResponse {
  events: EventResponse[];
  next_cursor: string | null;
  has_more: boolean;
  total: number;
  matched_total: number;
}

// ── Arb API v7 Types ──────────────────────────────────────────────────

export interface ArbV7Leg {
  exchange: string;
  exchange_short: string;
  action: string;
  side: 'YES' | 'NO';
  price_cents: number;
  price_decimal: number;
  depth_qty: number | null;
  depth_usd: number | null;
  low_liquidity: boolean;
  trade_url: string | null;
}

export interface ArbV7 {
  arb_id: number;
  market_title: string | null;
  category: string | null;
  arb_type: 'DIRECT' | 'COMPLEMENT';
  arb_subtype: string;
  gross_spread_pct: number;
  gross_spread: number;
  gross_profit: number | null;
  executable_qty: number | null;
  apy: number | null;
  days_to_expiry: number | null;
  expires_at: string | null;
  spread_direction: 'up' | 'down' | 'flat';
  updated_at: string;
  detected_at: string;
  mapping_confidence: number | null;
  subtype_note: string | null;
  legs: ArbV7Leg[];
}

export interface ArbV7Response {
  arbs: ArbV7[];
  next_cursor: string | null;
  has_more: boolean;
  total: number;
  counts: {
    all: number;
    cross_platform: number;
    time_decay: number;
    liquidity_gap: number;
  };
  meta: {
    last_scan_at: string | null;
    total_markets_streaming: number;
    volume_24h: number;
    exchange_count: number;
  };
}

export interface RawMarketData {
  id: string;
  notional_recent: number;
  depth: number;
  volume_24h: number;
  category: string | null;
  is_matched: boolean;
  canonical_market_id: string | null;
  exchange_id: string | null;
  source_id: string | null;
  market_id: string | null;
  event_id: string | null;
  outcome_side: string;
  title: string | null;
  end_date: Date | null;
  updated_at: Date | null;
  status: string | null;
}
