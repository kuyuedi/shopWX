import WebSocket from 'ws';
import { createLogger, ExponentialBackoff } from '@prediction-market/shared';
import { orderBookManager } from '../state/orderBookManager.js';

const logger = createLogger('predict-ws');

const HEARTBEAT_WATCHDOG_MS = 30_000; // 30s (server sends heartbeat every 15s)

export class PredictWebSocketClient {
  private ws: WebSocket | null = null;
  private backoff = new ExponentialBackoff();
  private heartbeatWatchdog: ReturnType<typeof setTimeout> | null = null;
  private statsInterval: ReturnType<typeof setInterval> | null = null;
  private isConnected = false;
  private shouldReconnect = true;
  private messageCount = 0;
  private totalMessageCount = 0;
  private lastStatsTime = Date.now();
  private marketIds: number[] = [];
  private requestId = 0;

  constructor(
    private readonly wsUrl: string,
    private readonly apiKey: string,
    private readonly onMessage: (msg: Record<string, unknown>) => void,
    private readonly socketIndex: number = 0,
  ) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const headers: Record<string, string> = {};
        if (this.apiKey) {
          headers['x-api-key'] = this.apiKey;
        }

        logger.info({ socketIndex: this.socketIndex }, 'Connecting to Predict.fun WebSocket');

        this.ws = new WebSocket(this.wsUrl, { headers });

        this.ws.on('open', () => {
          logger.info({ socketIndex: this.socketIndex }, 'Connected to Predict.fun WebSocket');
          this.isConnected = true;
          this.backoff.reset();
          this.resetHeartbeatWatchdog();
          this.startStatsInterval();
          this.subscribeAll();
          resolve();
        });

        this.ws.on('message', (data) => {
          this.messageCount++;
          this.totalMessageCount++;
          try {
            const message = JSON.parse(data.toString()) as Record<string, unknown>;
            this.handleRawMessage(message);
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

  subscribe(marketIds: number[]): void {
    this.marketIds = marketIds;
    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      this.subscribeAll();
    }
  }

  private subscribeAll(): void {
    for (const marketId of this.marketIds) {
      this.send({
        method: 'subscribe',
        requestId: ++this.requestId,
        params: [`predictOrderbook/${marketId}`],
      });
    }

    logger.info({
      socketIndex: this.socketIndex,
      markets: this.marketIds.length,
    }, 'Sent all subscriptions');
  }

  private handleRawMessage(message: Record<string, unknown>): void {
    const type = message.type as string;
    const topic = message.topic as string | undefined;

    // Handle heartbeat: echo timestamp back
    if (type === 'M' && topic === 'heartbeat') {
      this.send({ method: 'heartbeat', data: message.data });
      this.resetHeartbeatWatchdog();
      return;
    }

    // Handle subscription acknowledgment
    if (type === 'R') {
      if (message.success === false) {
        logger.warn({ requestId: message.requestId, data: message.data }, 'Subscription failed');
      }
      return;
    }

    // Handle orderbook push
    if (type === 'M' && topic && (topic as string).startsWith('predictOrderbook/')) {
      this.resetHeartbeatWatchdog();
      this.onMessage(message);
      return;
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private resetHeartbeatWatchdog(): void {
    if (this.heartbeatWatchdog) {
      clearTimeout(this.heartbeatWatchdog);
    }
    this.heartbeatWatchdog = setTimeout(() => {
      logger.warn({ socketIndex: this.socketIndex }, 'Heartbeat watchdog timeout — reconnecting');
      this.ws?.terminate();
    }, HEARTBEAT_WATCHDOG_MS);
  }

  private stopHeartbeatWatchdog(): void {
    if (this.heartbeatWatchdog) {
      clearTimeout(this.heartbeatWatchdog);
      this.heartbeatWatchdog = null;
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
    this.stopHeartbeatWatchdog();
    this.stopStatsInterval();

    // Clear orderbook state to prevent stale data
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
    this.stopHeartbeatWatchdog();
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
