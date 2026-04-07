import { createLogger } from '@prediction-market/shared';
import { KalshiWebSocketClient, KalshiWebSocketConfig } from './client.js';

const logger = createLogger('kalshi-ws-pool');
const DEFAULT_MARKETS_PER_SOCKET = 2000;

export class KalshiWebSocketPool {
  private clients: KalshiWebSocketClient[] = [];
  private marketsPerSocket: number;
  private statsInterval: ReturnType<typeof setInterval> | null = null;
  /** Track which tickers are subscribed on each client */
  private clientTickers: Map<KalshiWebSocketClient, Set<string>> = new Map();

  constructor(
    private readonly config: KalshiWebSocketConfig,
    marketsPerSocket: number = DEFAULT_MARKETS_PER_SOCKET
  ) {
    this.marketsPerSocket = marketsPerSocket;
  }

  async subscribeToMarkets(tickers: string[]): Promise<void> {
    // First call — do full pool build
    if (this.clients.length === 0) {
      await this.buildPool(tickers);
      return;
    }

    const newTickerSet = new Set(tickers);

    // Build current subscribed set
    const currentTickers = new Set<string>();
    for (const t of this.clientTickers.values()) {
      for (const ticker of t) currentTickers.add(ticker);
    }

    // Find genuinely new tickers
    const added = tickers.filter(t => !currentTickers.has(t));

    if (added.length === 0) {
      logger.info({ markets: tickers.length }, 'No new markets to subscribe, skipping pool update');
      return;
    }

    logger.info({
      total: tickers.length,
      newMarkets: added.length,
      socketsBefore: this.clients.length,
    }, 'Incremental pool update — subscribing new markets only');

    let remaining = [...added];

    // Find sockets with closed/inactive tickers and replace them with new ones
    for (const [client, tickerSet] of this.clientTickers) {
      if (remaining.length === 0) break;

      const closedOnSocket = [...tickerSet].filter(t => !newTickerSet.has(t));
      if (closedOnSocket.length > 0) {
        const batch = remaining.splice(0, closedOnSocket.length);

        // Unsubscribe closed tickers via Kalshi's native protocol
        await client.unsubscribeFromMarkets(closedOnSocket);
        for (const t of closedOnSocket) tickerSet.delete(t);

        // Subscribe new ones
        await client.subscribeToMarkets(batch);
        for (const t of batch) tickerSet.add(t);

        logger.info({
          replaced: batch.length,
          removedClosed: closedOnSocket.length,
        }, 'Replaced closed markets with new ones on existing socket');
      }
    }

    // Fill sockets that have spare capacity
    for (const [client, tickerSet] of this.clientTickers) {
      if (remaining.length === 0) break;
      const room = this.marketsPerSocket - tickerSet.size;
      if (room > 0) {
        const batch = remaining.splice(0, room);
        await client.subscribeToMarkets(batch);
        for (const t of batch) tickerSet.add(t);
      }
    }

    // Create new sockets for anything that still didn't fit
    if (remaining.length > 0) {
      const chunks: string[][] = [];
      for (let i = 0; i < remaining.length; i += this.marketsPerSocket) {
        chunks.push(remaining.slice(i, i + this.marketsPerSocket));
      }

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (!chunk) continue;
        const socketIndex = this.clients.length;
        const client = new KalshiWebSocketClient(this.config, socketIndex);
        this.clients.push(client);
        this.clientTickers.set(client, new Set(chunk));

        try {
          await client.connect();
          await client.subscribeToMarkets(chunk);
          logger.info({ socketIndex, markets: chunk.length }, 'Added new socket for new markets');

          if (i < chunks.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } catch (err) {
          logger.error({ err, socketIndex }, 'Failed to connect new socket');
        }
      }
    }

    logger.info({
      socketsAfter: this.clients.length,
    }, 'Incremental pool update complete');
  }

  private async buildPool(tickers: string[]): Promise<void> {
    const chunks: string[][] = [];
    for (let i = 0; i < tickers.length; i += this.marketsPerSocket) {
      chunks.push(tickers.slice(i, i + this.marketsPerSocket));
    }

    logger.info({
      totalMarkets: tickers.length,
      sockets: chunks.length,
      marketsPerSocket: this.marketsPerSocket,
    }, 'Creating WebSocket pool');

    for (let i = 0; i < chunks.length; i++) {
      const client = new KalshiWebSocketClient(this.config, i);
      this.clients.push(client);
      this.clientTickers.set(client, new Set(chunks[i] ?? []));
    }

    for (let i = 0; i < this.clients.length; i++) {
      const client = this.clients[i];
      const chunk = chunks[i];
      if (!client || !chunk) continue;

      try {
        await client.connect();
        await client.subscribeToMarkets(chunk);
        logger.info({ socketIndex: i, markets: chunk.length }, 'Socket connected and subscribed');

        if (i < this.clients.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (err) {
        logger.error({ err, socketIndex: i }, 'Failed to connect socket');
      }
    }

    this.startStatsInterval();
    logger.info({ connectedSockets: this.clients.length }, 'WebSocket pool ready');
  }

  private startStatsInterval(): void {
    this.stopStatsInterval();
    this.statsInterval = setInterval(() => {
      let totalMessages = 0;
      let connectedCount = 0;

      for (const client of this.clients) {
        const state = client.getConnectionState();
        if (state === 'OPEN') {
          connectedCount++;
        }
        totalMessages += client.getMessageCount();
      }

      logger.info({
        totalSockets: this.clients.length,
        connectedSockets: connectedCount,
        totalMessages,
      }, 'Pool stats');
    }, 30000);
  }

  private stopStatsInterval(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  async closeAll(): Promise<void> {
    this.stopStatsInterval();

    const closePromises = this.clients.map((client) => client.close());
    await Promise.all(closePromises);

    this.clients = [];
    this.clientTickers = new Map();
    logger.info('All WebSocket connections closed');
  }

  getStats(): { totalSockets: number; connectedSockets: number } {
    let connectedCount = 0;
    for (const client of this.clients) {
      if (client.getConnectionState() === 'OPEN') {
        connectedCount++;
      }
    }
    return {
      totalSockets: this.clients.length,
      connectedSockets: connectedCount,
    };
  }
}
