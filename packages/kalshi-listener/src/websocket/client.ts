import WebSocket from 'ws';
import {
  createLogger,
  ExponentialBackoff,
  KALSHI_SOURCE_ID,
  KALSHI_EXCHANGE_ID,
} from '@prediction-market/shared';
import { handleMessage } from './handlers.js';
import { getBatchSubscriptionMessage, getBatchUnsubscriptionMessage, getSubscriptionMessage, type KalshiChannel, type KalshiSubscription } from './subscriptions.js';
import { generateWsAuthHeaders } from '../utils/auth.js';
import { orderBookManager } from '../state/orderBookManager.js';

const logger = createLogger('kalshi-ws');

export interface KalshiWebSocketConfig {
  url: string;
  apiKey?: string;
  privateKeyPath?: string;
}

export class KalshiWebSocketClient {
  private ws: WebSocket | null = null;
  private backoff = new ExponentialBackoff();
  private subscriptions: KalshiSubscription[] = [];
  private subscribedTickers: string[] = [];
  private readonly SUBSCRIBE_CHANNELS: KalshiChannel[] = ['ticker', 'orderbook_delta', 'trade'];
  private isConnected = false;
  private shouldReconnect = true;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private statsInterval: ReturnType<typeof setInterval> | null = null;
  private messageId = 1;
  private messageCount = 0;
  private totalMessageCount = 0;
  private messagesByType: Record<string, number> = {};
  private lastStatsTime = Date.now();
  private socketIndex: number;

  constructor(
    private readonly config: KalshiWebSocketConfig,
    socketIndex: number = 0
  ) {
    this.socketIndex = socketIndex;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        logger.info({ socketIndex: this.socketIndex, url: this.config.url }, 'Connecting to Kalshi WebSocket');

        // Generate authentication headers if credentials provided
        const options: WebSocket.ClientOptions = {};
        if (this.config.apiKey && this.config.privateKeyPath) {
          const authHeaders = generateWsAuthHeaders(
            this.config.apiKey,
            this.config.privateKeyPath
          );
          options.headers = authHeaders as unknown as Record<string, string>;
          logger.info('Using authenticated WebSocket connection');
        }

        this.ws = new WebSocket(this.config.url, options);

        this.ws.on('open', () => {
          logger.info({ socketIndex: this.socketIndex }, 'Connected to Kalshi WebSocket');
          this.isConnected = true;
          this.backoff.reset();
          this.startPingInterval();
          this.startStatsInterval();
          this.resubscribe();
          resolve();
        });

        this.ws.on('message', (data) => {
          this.messageCount++;
          this.totalMessageCount++;
          try {
            const message = JSON.parse(data.toString());
            this.handleIncomingMessage(message);
          } catch (err) {
            logger.error({ err, data: data.toString().substring(0, 200) }, 'Failed to parse message');
          }
        });

        this.ws.on('close', (code, reason) => {
          logger.warn({ code, reason: reason.toString() }, 'WebSocket closed');
          this.handleDisconnect();
        });

        this.ws.on('error', (err) => {
          logger.error({ err }, 'WebSocket error');
          if (!this.isConnected) {
            reject(err);
          }
        });

        this.ws.on('ping', () => {
          this.ws?.pong();
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private handleIncomingMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      return;
    }

    const msg = message as Record<string, unknown>;
    const msgType = (msg.type as string) || 'unknown';
    this.messagesByType[msgType] = (this.messagesByType[msgType] || 0) + 1;

    // Handle subscription confirmations
    if (msg.type === 'subscribed' || msg.type === 'ok') {
      const innerMsg = msg.msg as Record<string, unknown> | undefined;
      logger.debug({ type: msg.type, channel: innerMsg?.channel }, 'Subscription confirmed');
      return;
    }

    // Handle errors
    if (msg.type === 'error') {
      logger.error({ error: msg }, 'Received error from Kalshi');
      return;
    }

    // Handle data messages
    handleMessage(msg, KALSHI_SOURCE_ID, KALSHI_EXCHANGE_ID);
  }

  private startPingInterval(): void {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private startStatsInterval(): void {
    this.stopStatsInterval();
    this.messageCount = 0;
    this.messagesByType = {};
    this.lastStatsTime = Date.now();
    this.statsInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = (now - this.lastStatsTime) / 1000;
      const rate = Math.round(this.messageCount / elapsed);
      logger.info({
        total: this.messageCount,
        rate,
        byType: this.messagesByType
      }, 'WebSocket stats (msg/sec)');
      this.messageCount = 0;
      this.messagesByType = {};
      this.lastStatsTime = now;
    }, 10000); // Log every 10 seconds
  }

  private stopStatsInterval(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  private async handleDisconnect(): Promise<void> {
    this.isConnected = false;
    this.stopPingInterval();
    this.stopStatsInterval();

    // Clear orderbook state for this socket's markets only (not all sockets)
    for (const ticker of this.subscribedTickers) {
      orderBookManager.clearMarket(ticker);
    }
    logger.info({ cleared: this.subscribedTickers.length, socketIndex: this.socketIndex }, 'Cleared orderbook state for disconnected socket');

    if (!this.shouldReconnect) {
      return;
    }

    await this.backoff.wait();
    logger.info('Attempting to reconnect');

    try {
      await this.connect();
    } catch (err) {
      logger.error({ err }, 'Reconnection failed');
      this.handleDisconnect();
    }
  }

  subscribe(subscription: KalshiSubscription): void {
    this.subscriptions.push(subscription);

    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscription(subscription);
    }
  }

  private sendSubscription(subscription: KalshiSubscription): void {
    const message = getSubscriptionMessage(subscription, this.messageId++);
    logger.debug({ subscription, message }, 'Sending subscription');
    this.ws?.send(JSON.stringify(message));
  }

  private resubscribe(): void {
    // Prefer bulk resubscription if we have stored tickers
    if (this.subscribedTickers.length > 0) {
      this.sendBulkSubscriptions(this.subscribedTickers);
      return;
    }
    for (const subscription of this.subscriptions) {
      this.sendSubscription(subscription);
    }
  }

  private sendBulkSubscriptions(tickers: string[]): void {
    const BATCH_SIZE = parseInt(process.env.WS_SUBSCRIPTION_BATCH_SIZE || '250', 10);

    for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
      const batch = tickers.slice(i, i + BATCH_SIZE);
      const message = getBatchSubscriptionMessage(batch, this.SUBSCRIBE_CHANNELS, this.messageId++);
      this.ws?.send(JSON.stringify(message));
    }
  }

  async subscribeToMarkets(tickers: string[]): Promise<void> {
    const BATCH_SIZE = parseInt(process.env.WS_SUBSCRIPTION_BATCH_SIZE || '250', 10);
    const BATCH_DELAY_MS = parseInt(process.env.WS_SUBSCRIPTION_DELAY_MS || '100', 10);
    const MAX_SUBSCRIPTIONS = parseInt(process.env.MAX_WS_SUBSCRIPTIONS || '5000', 10);
    const tickersToSubscribe = tickers.slice(0, MAX_SUBSCRIPTIONS);

    // Store tickers for resubscription on reconnect
    this.subscribedTickers = tickersToSubscribe;

    const totalBatches = Math.ceil(tickersToSubscribe.length / BATCH_SIZE);
    logger.info({
      total: tickers.length,
      subscribing: tickersToSubscribe.length,
      batchSize: BATCH_SIZE,
      delayMs: BATCH_DELAY_MS,
      totalBatches,
      channels: this.SUBSCRIBE_CHANNELS,
    }, 'Starting bulk market subscriptions');

    for (let i = 0; i < tickersToSubscribe.length; i += BATCH_SIZE) {
      const batch = tickersToSubscribe.slice(i, i + BATCH_SIZE);
      const message = getBatchSubscriptionMessage(batch, this.SUBSCRIBE_CHANNELS, this.messageId++);
      this.ws?.send(JSON.stringify(message));

      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      logger.info({ batch: batchNum, totalBatches, tickers: batch.length }, 'Sent subscription batch');

      if (i + BATCH_SIZE < tickersToSubscribe.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    logger.info({ total: tickersToSubscribe.length }, 'Completed market subscriptions');
  }

  async unsubscribeFromMarkets(tickers: string[]): Promise<void> {
    if (tickers.length === 0) return;

    const BATCH_SIZE = parseInt(process.env.WS_SUBSCRIPTION_BATCH_SIZE || '250', 10);
    const BATCH_DELAY_MS = parseInt(process.env.WS_SUBSCRIPTION_DELAY_MS || '100', 10);

    // Remove from stored tickers
    const tickerSet = new Set(tickers);
    this.subscribedTickers = this.subscribedTickers.filter(t => !tickerSet.has(t));

    const totalBatches = Math.ceil(tickers.length / BATCH_SIZE);
    logger.info({
      total: tickers.length,
      batchSize: BATCH_SIZE,
      totalBatches,
      channels: this.SUBSCRIBE_CHANNELS,
    }, 'Starting bulk market unsubscriptions');

    for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
      const batch = tickers.slice(i, i + BATCH_SIZE);
      const message = getBatchUnsubscriptionMessage(batch, this.SUBSCRIBE_CHANNELS, this.messageId++);
      this.ws?.send(JSON.stringify(message));

      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      logger.info({ batch: batchNum, totalBatches, tickers: batch.length }, 'Sent unsubscription batch');

      if (i + BATCH_SIZE < tickers.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    logger.info({ total: tickers.length }, 'Completed market unsubscriptions');
  }

  async close(): Promise<void> {
    this.shouldReconnect = false;
    this.stopPingInterval();
    this.stopStatsInterval();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
    logger.info({ socketIndex: this.socketIndex }, 'WebSocket connection closed');
  }

  getMessageCount(): number {
    return this.totalMessageCount;
  }

  resetMessageCount(): void {
    this.totalMessageCount = 0;
  }

  getConnectionState(): string {
    if (!this.ws) return 'DISCONNECTED';
    switch (this.ws.readyState) {
      case WebSocket.CONNECTING:
        return 'CONNECTING';
      case WebSocket.OPEN:
        return 'OPEN';
      case WebSocket.CLOSING:
        return 'CLOSING';
      case WebSocket.CLOSED:
        return 'CLOSED';
      default:
        return 'UNKNOWN';
    }
  }
}
