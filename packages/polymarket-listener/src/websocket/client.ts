import WebSocket from 'ws';
import {
  createLogger,
  ExponentialBackoff,
  POLYMARKET_SOURCE_ID,
  POLYMARKET_EXCHANGE_ID,
} from '@prediction-market/shared';
import { handleMessage } from './handlers.js';
import type { PolymarketSubscription } from './subscriptions.js';

const logger = createLogger('polymarket-ws');

export interface PolymarketWebSocketConfig {
  url: string;
}

export class PolymarketWebSocketClient {
  private ws: WebSocket | null = null;
  private backoff = new ExponentialBackoff();
  private subscriptions: PolymarketSubscription[] = [];
  private isConnected = false;
  private shouldReconnect = true;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private statsInterval: ReturnType<typeof setInterval> | null = null;
  private messageCount = 0;
  private totalMessageCount = 0;
  private messagesByType: Record<string, number> = {};
  private lastStatsTime = Date.now();
  private socketIndex: number;

  constructor(private readonly config: PolymarketWebSocketConfig, socketIndex: number = 0) {
    this.socketIndex = socketIndex;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        logger.info({ url: this.config.url }, 'Connecting to Polymarket WebSocket');

        this.ws = new WebSocket(this.config.url);

        this.ws.on('open', () => {
          logger.info('Connected to Polymarket WebSocket');
          this.isConnected = true;
          this.backoff.reset();
          this.startPingInterval();
          this.startStatsInterval();
          this.resubscribe();
          resolve();
        });

        this.ws.on('message', (data) => {
          this.messageCount++;
          const rawData = data.toString();

          // Handle plain text error responses from Polymarket
          if (rawData === 'INVALID OPERATION' || rawData.startsWith('ERROR')) {
            logger.warn({ response: rawData }, 'Received error response from Polymarket');
            return;
          }

          try {
            const messages = JSON.parse(rawData);
            // Polymarket sends arrays of messages
            if (Array.isArray(messages)) {
              for (const message of messages) {
                this.handleIncomingMessage(message);
              }
            } else {
              this.handleIncomingMessage(messages);
            }
          } catch (err) {
            logger.error({ err, data: rawData.substring(0, 200) }, 'Failed to parse message');
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
    this.totalMessageCount++;

    if (typeof message !== 'object' || message === null) {
      return;
    }

    const msg = message as Record<string, unknown>;
    const msgType = (msg.event_type as string) || (msg.type as string) || 'unknown';
    this.messagesByType[msgType] = (this.messagesByType[msgType] || 0) + 1;

    // Handle subscription confirmations
    if (msg.type === 'subscribed' || msg.event_type === 'subscribed') {
      logger.debug({ message: msg }, 'Subscription confirmed');
      return;
    }

    // Handle pong responses (keepalive acknowledgment)
    if (msg.type === 'pong' || msg.event_type === 'pong') {
      return; // Silently acknowledge pongs
    }

    // Handle errors
    if (msg.type === 'error' || msg.event_type === 'error') {
      logger.error({ error: msg }, 'Received error from Polymarket');
      return;
    }

    // Handle data messages
    handleMessage(msg, POLYMARKET_SOURCE_ID, POLYMARKET_EXCHANGE_ID);
  }

  private startPingInterval(): void {
    this.stopPingInterval();
    // Use WebSocket protocol ping frames for keepalive
    // Polymarket rejects JSON ping messages with "INVALID OPERATION"
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 25000); // Ping every 25 seconds
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

  subscribe(subscription: PolymarketSubscription): void {
    this.subscriptions.push(subscription);

    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscription(subscription);
    }
  }

  private sendSubscription(subscription: PolymarketSubscription): void {
    const message = {
      type: subscription.type,
      assets_ids: subscription.assetIds,
    };

    logger.debug({ subscription, message }, 'Sending subscription');
    this.ws?.send(JSON.stringify(message));
  }

  private resubscribe(): void {
    for (const subscription of this.subscriptions) {
      this.sendSubscription(subscription);
    }
  }

  subscribeToMarkets(assetIds: string[]): void {
    // Clear existing subscriptions to avoid accumulation on refresh
    this.subscriptions = [];

    // Polymarket uses a single subscription with all asset IDs
    // Subscribe to market channel which includes all events
    this.subscribe({
      type: 'market',
      assetIds,
    });
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
    logger.info('WebSocket connection closed');
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

  getMessageCount(): number {
    return this.totalMessageCount;
  }

  resetMessageCount(): void {
    this.totalMessageCount = 0;
  }
}
