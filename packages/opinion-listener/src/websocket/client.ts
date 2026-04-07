import WebSocket from 'ws';
import { createLogger, ExponentialBackoff } from '@prediction-market/shared';
import { orderBookManager } from '../state/orderBookManager.js';

const logger = createLogger('opinion-ws');

const CHANNELS = ['market.depth.diff', 'market.last.price', 'market.last.trade'];
const HEARTBEAT_INTERVAL_MS = 25_000; // 25s (server timeout is 30s)

export class OpinionWebSocketClient {
  private ws: WebSocket | null = null;
  private backoff = new ExponentialBackoff();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private statsInterval: ReturnType<typeof setInterval> | null = null;
  private isConnected = false;
  private shouldReconnect = true;
  private messageCount = 0;
  private totalMessageCount = 0;
  private lastStatsTime = Date.now();
  private marketIds: number[] = [];
  private rootMarketIds: number[] = [];

  constructor(
    private readonly wsUrl: string,
    private readonly apiKey: string,
    private readonly onMessage: (msg: Record<string, unknown>) => void,
    private readonly socketIndex: number = 0,
  ) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const url = `${this.wsUrl}?apikey=${this.apiKey}`;
        logger.info({ socketIndex: this.socketIndex }, 'Connecting to Opinion WebSocket');

        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
          logger.info({ socketIndex: this.socketIndex }, 'Connected to Opinion WebSocket');
          this.isConnected = true;
          this.backoff.reset();
          this.startHeartbeat();
          this.startStatsInterval();
          this.subscribeAll();
          resolve();
        });

        this.ws.on('message', (data) => {
          this.messageCount++;
          this.totalMessageCount++;
          try {
            const message = JSON.parse(data.toString()) as Record<string, unknown>;
            this.onMessage(message);
          } catch (err) {
            logger.error({ err, data: data.toString().substring(0, 200) }, 'Failed to parse message');
          }
        });

        this.ws.on('close', (code, reason) => {
          logger.warn({ code, reason: reason.toString(), socketIndex: this.socketIndex }, 'WebSocket closed');
          this.handleDisconnect();
        });

        this.ws.on('error', (err) => {
          logger.error({ err, socketIndex: this.socketIndex }, 'WebSocket error');
          if (!this.isConnected) {
            reject(err);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  subscribe(marketIds: number[], rootMarketIds: number[]): void {
    this.marketIds = marketIds;
    this.rootMarketIds = rootMarketIds;
    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      this.subscribeAll();
    }
  }

  private subscribeAll(): void {
    for (const channel of CHANNELS) {
      for (const marketId of this.marketIds) {
        this.send({ action: 'SUBSCRIBE', channel, marketId });
      }
      for (const rootMarketId of this.rootMarketIds) {
        this.send({ action: 'SUBSCRIBE', channel, rootMarketId });
      }
    }

    logger.info({
      socketIndex: this.socketIndex,
      binaryMarkets: this.marketIds.length,
      categoricalRoots: this.rootMarketIds.length,
      channels: CHANNELS.length,
    }, 'Sent all subscriptions');
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      this.send({ action: 'HEARTBEAT' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private startStatsInterval(): void {
    this.stopStatsInterval();
    this.messageCount = 0;
    this.lastStatsTime = Date.now();
    this.statsInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = (now - this.lastStatsTime) / 1000;
      const rate = Math.round(this.messageCount / elapsed);
      logger.info({
        socketIndex: this.socketIndex,
        messages: this.messageCount,
        rate,
      }, 'WebSocket stats (msg/sec)');
      this.messageCount = 0;
      this.lastStatsTime = now;
    }, 10000);
  }

  private stopStatsInterval(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  private async handleDisconnect(): Promise<void> {
    this.isConnected = false;
    this.stopHeartbeat();
    this.stopStatsInterval();

    // Clear orderbook state so stale deltas don't apply on top of pre-disconnect data
    orderBookManager.clearAll();

    if (!this.shouldReconnect) {
      return;
    }

    await this.backoff.wait();
    logger.info({ socketIndex: this.socketIndex }, 'Attempting to reconnect');

    try {
      await this.connect();
    } catch (err) {
      logger.error({ err, socketIndex: this.socketIndex }, 'Reconnection failed');
      this.handleDisconnect();
    }
  }

  async close(): Promise<void> {
    this.shouldReconnect = false;
    this.stopHeartbeat();
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

  getConnectionState(): string {
    if (!this.ws) return 'DISCONNECTED';
    switch (this.ws.readyState) {
      case WebSocket.CONNECTING: return 'CONNECTING';
      case WebSocket.OPEN: return 'OPEN';
      case WebSocket.CLOSING: return 'CLOSING';
      case WebSocket.CLOSED: return 'CLOSED';
      default: return 'UNKNOWN';
    }
  }
}
