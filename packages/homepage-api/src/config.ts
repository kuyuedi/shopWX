export interface HomepageApiConfig {
  port: number;
  host: string;
  scoreIntervalMs: number;
  defaultPageSize: number;
  maxPageSize: number;
  tickerSize: number;
  recentWindowMinutes: number;
  arbScanIntervalMs: number;
  kalshiApiKey: string;
  kalshiPrivateKeyPath: string;
  kalshiRestUrl: string;
  polymarketClobUrl: string;
  predictRestUrl: string;
  predictApiKey: string;
}

export function getConfig(): HomepageApiConfig {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  return {
    port: parseInt(process.env.PORT || '3100', 10),
    host: process.env.HOST || '0.0.0.0',
    scoreIntervalMs: parseInt(process.env.SCORE_INTERVAL_MS || '30000', 10),
    defaultPageSize: parseInt(process.env.DEFAULT_PAGE_SIZE || '30', 10),
    maxPageSize: parseInt(process.env.MAX_PAGE_SIZE || '100', 10),
    tickerSize: parseInt(process.env.TICKER_SIZE || '10', 10),
    recentWindowMinutes: parseInt(process.env.RECENT_WINDOW_MINUTES || '10', 10),
    arbScanIntervalMs: parseInt(process.env.ARB_SCAN_INTERVAL_MS || '10000', 10),
    kalshiApiKey: process.env.KALSHI_API_KEY || '',
    kalshiPrivateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH || '',
    kalshiRestUrl: process.env.KALSHI_REST_URL || 'https://api.elections.kalshi.com/trade-api/v2',
    polymarketClobUrl: process.env.POLYMARKET_CLOB_URL || 'https://clob.polymarket.com',
    predictRestUrl: process.env.PREDICT_REST_URL || 'https://api.predict.fun',
    predictApiKey: process.env.PREDICT_API_KEY || '',
  };
}
