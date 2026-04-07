// GET /market response
export interface OpinionMarketData {
  marketId: number;
  marketTitle: string;
  status: number;          // 1=Created, 2=Activated, 3=Resolving, 4=Resolved, 5=Failed, 6=Deleted
  statusEnum: string;
  marketType: number;      // 0=Binary, 1=Categorical
  childMarkets?: OpinionChildMarketData[];
  yesLabel: string;
  noLabel: string;
  rules: string;
  yesTokenId: string;
  noTokenId: string;
  conditionId: string;
  resultTokenId: string;
  volume: string;
  volume24h: string;
  volume7d: string;
  quoteToken: string;
  chainId: string;
  questionId: string;
  collection?: OpinionCollectionData | null;
  createdAt: number;       // ms timestamp
  cutoffAt: number;        // ms timestamp
  resolvedAt: number;      // ms timestamp
}

export interface OpinionChildMarketData {
  marketId: number;
  marketTitle: string;
  status: number;
  statusEnum: string;
  yesLabel: string;
  noLabel: string;
  yesTokenId: string;
  noTokenId: string;
  conditionId: string;
  volume: string;
  quoteToken: string;
  chainId: string;
  createdAt: number;
  cutoffAt: number;
  resolvedAt: number;
}

export interface OpinionCollectionData {
  title: string;
  symbol: string;
  frequency: string;
}

// GET /token/orderbook response
export interface OpinionOrderbookResponse {
  market: string;          // conditionId
  tokenId: string;
  timestamp: number;       // ms
  bids: OpinionOrderbookLevel[];
  asks: OpinionOrderbookLevel[];
}

export interface OpinionOrderbookLevel {
  price: string;
  size: string;
}

// GET /token/latest-price response
export interface OpinionLatestPriceResponse {
  tokenId: string;
  price: string;
  side: string;            // BUY/SELL
  size: string;
  timestamp: number;       // ms
}

// API wrapper
export interface OpinionApiResponse<T> {
  code: number;
  msg: string;
  result: T;
}

export interface OpinionMarketListResult {
  total: number;
  list: OpinionMarketData[];
}

// WebSocket messages
export interface OpinionWsDepthDiff {
  marketId: number;
  rootMarketId?: number;
  tokenId: string;
  outcomeSide: number;     // 1=YES, 2=NO
  side: string;            // "bids" or "asks"
  price: string;
  size: string;
  msgType: 'market.depth.diff';
}

export interface OpinionWsLastPrice {
  marketId: number;
  rootMarketId?: number;
  tokenId: string;
  price: string;
  outcomeSide: number;
  msgType: 'market.last.price';
}

export interface OpinionWsLastTrade {
  marketId: number;
  rootMarketId?: number;
  tokenId: string;
  side: string;            // "Buy", "Sell", "Split", "Merge"
  outcomeSide: number;
  price: string;
  shares: string;
  amount: string;
  msgType: 'market.last.trade';
}
