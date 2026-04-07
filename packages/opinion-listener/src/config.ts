import { OPINION_SOURCE_ID, OPINION_EXCHANGE_ID } from '@prediction-market/shared';

export interface OpinionConfig {
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
}

export function loadConfig(): OpinionConfig {
  return {
    restUrl: process.env.OPINION_REST_URL || 'https://openapi.opinion.trade/openapi',
    wsUrl: process.env.OPINION_WS_URL || 'wss://ws.opinion.trade',
    apiKey: process.env.OPINION_API_KEY || '',
    sourceId: OPINION_SOURCE_ID,
    exchangeId: OPINION_EXCHANGE_ID,
    marketRefreshIntervalMs: parseInt(process.env.MARKET_REFRESH_INTERVAL_MS || '300000', 10),
    marketsPerSocket: parseInt(process.env.OPINION_MARKETS_PER_SOCKET || '200', 10),
    batchSize: parseInt(process.env.BATCH_SIZE || '100', 10),
    batchIntervalMs: parseInt(process.env.BATCH_INTERVAL_MS || '1000', 10),
    cleanupIntervalMs: parseInt(process.env.CLEANUP_INTERVAL_MS || '3600000', 10),
    cleanupRetentionMs: parseInt(process.env.CLEANUP_RETENTION_MS || '86400000', 10),
  };
}
