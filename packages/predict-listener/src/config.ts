import { PREDICT_SOURCE_ID, PREDICT_EXCHANGE_ID } from '@prediction-market/shared';

export interface PredictConfig {
  restUrl: string;
  wsUrl: string;
  apiKey: string;
  sourceId: string;
  exchangeId: string;
  marketRefreshIntervalMs: number;
  marketsPerSocket: number;
  batchSize: number;
  batchIntervalMs: number;
  cleanupIntervalMs: number;
  cleanupRetentionMs: number;
  enableCrossMapping: boolean;
}

export function loadConfig(): PredictConfig {
  return {
    restUrl: process.env.PREDICT_REST_URL || 'https://api.predict.fun',
    wsUrl: process.env.PREDICT_WS_URL || 'wss://ws.predict.fun/ws',
    apiKey: process.env.PREDICT_API_KEY || '',
    sourceId: PREDICT_SOURCE_ID,
    exchangeId: PREDICT_EXCHANGE_ID,
    marketRefreshIntervalMs: parseInt(process.env.MARKET_REFRESH_INTERVAL_MS || '300000', 10),
    marketsPerSocket: parseInt(process.env.PREDICT_MARKETS_PER_SOCKET || '500', 10),
    batchSize: parseInt(process.env.BATCH_SIZE || '100', 10),
    batchIntervalMs: parseInt(process.env.BATCH_INTERVAL_MS || '1000', 10),
    cleanupIntervalMs: parseInt(process.env.CLEANUP_INTERVAL_MS || '3600000', 10),
    cleanupRetentionMs: parseInt(process.env.CLEANUP_RETENTION_MS || '86400000', 10),
    enableCrossMapping: process.env.ENABLE_CROSS_MAPPING !== 'false',
  };
}
