// GET /v1/markets response
export interface PredictMarket {
  id: number;
  title: string;           // Outcome name, e.g. "Oklahoma City Thunder"
  question: string;        // Full question, e.g. "Will the OKC Thunder win the 2026 NBA Finals?"
  status: string;          // REGISTERED, RESOLVED
  tradingStatus: string;   // OPEN, CLOSED, CANCEL_ONLY, MATCHING_NOT_ENABLED
  categorySlug: string;    // Links market to category/event
  outcomes: PredictOutcome[];
  feeRateBps: number;      // e.g. 200 = 2%
  decimalPrecision: number; // 2 or 3 decimal places
  kalshiMarketTicker: string | null;
  polymarketConditionIds: string[];
  isNegRisk: boolean;
  imageUrl: string | null;
  createdAt: string;       // ISO date
  marketVariant: string;   // DEFAULT, SPORTS_MATCH, etc.
}

export interface PredictOutcome {
  indexSet: number;        // 1 = Yes, 2 = No
  name: string;            // "Yes", "No", or specific outcome
  onChainId: string;
  status: string | null;   // null = active, "WON"/"LOST" = resolved
}

// GET /v1/categories response
export interface PredictCategory {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  status: string;          // OPEN, RESOLVED
  startsAt: string | null;
  endsAt: string | null;
  imageUrl: string | null;
  markets: PredictMarket[];
  tags: PredictTag[];
  marketVariant: string;
}

export interface PredictTag {
  id: number;
  name: string;
  level: number;           // 1 = top-level, 2 = subcategory
}

// Paginated response wrapper
export interface PredictPaginatedResponse<T> {
  data: T[];
  cursor: string | null;   // null when no more pages
}

// GET /v1/markets/{id}/orderbook
export interface PredictOrderbookData {
  marketId: number;
  updateTimestampMs: number;
  asks: [number, number][];  // [price, quantity]
  bids: [number, number][];  // [price, quantity]
  lastOrderSettled: PredictLastOrder | null;
}

export interface PredictLastOrder {
  id: string;
  kind: string;            // LIMIT, MARKET
  marketId: number;
  outcome: string;         // "Yes", "No"
  price: string;           // decimal string
  side: string;            // "Bid", "Ask"
}

// WebSocket messages
export interface PredictWsMessage {
  type: string;            // "M" = push, "R" = response
  topic?: string;          // e.g. "predictOrderbook/393", "heartbeat"
  requestId?: number;
  success?: boolean;
  data?: unknown;
}

export interface PredictWsOrderbookPush {
  type: 'M';
  topic: string;           // "predictOrderbook/{marketId}"
  data: PredictOrderbookData;
}
