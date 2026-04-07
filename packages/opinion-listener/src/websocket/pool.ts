import { createLogger } from '@prediction-market/shared';
import { OpinionWebSocketClient } from './client.js';

const logger = createLogger('opinion-ws-pool');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class OpinionWebSocketPool {
  private clients: OpinionWebSocketClient[] = [];
  private statsInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly wsUrl: string,
    private readonly apiKey: string,
    private readonly marketsPerSocket: number,
    private readonly onMessage: (msg: Record<string, unknown>) => void,
  ) {}

  async subscribeToMarkets(
    marketIds: number[],
    rootMarketIds: number[],
  ): Promise<void> {
    // Close existing clients
    await this.closeAll();

    // Chunk binary market IDs across sockets
    const chunks: number[][] = [];
    for (let i = 0; i < marketIds.length; i += this.marketsPerSocket) {
      chunks.push(marketIds.slice(i, i + this.marketsPerSocket));
    }

    // Ensure at least one socket if we only have categorical markets
    if (chunks.length === 0 && rootMarketIds.length > 0) {
      chunks.push([]);
    }

    logger.info({
      totalBinaryMarkets: marketIds.length,
      totalCategoricalRoots: rootMarketIds.length,
      sockets: chunks.length,
      marketsPerSocket: this.marketsPerSocket,
    }, 'Creating WebSocket pool');

    // Create and connect clients
    for (let i = 0; i < chunks.length; i++) {
      const client = new OpinionWebSocketClient(
        this.wsUrl,
        this.apiKey,
        this.onMessage,
        i,
      );

      try {
        await client.connect();
        // Distribute rootMarketIds to first socket only
        const rootChunk = i === 0 ? rootMarketIds : [];
        const chunk = chunks[i];
        if (chunk) {
          client.subscribe(chunk, rootChunk);
        }
        this.clients.push(client);
        logger.info({ socketIndex: i, markets: chunk?.length ?? 0, roots: rootChunk.length }, 'Socket connected');

        // Stagger connections
        if (i < chunks.length - 1) {
          await sleep(500);
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
        if (client.getConnectionState() === 'OPEN') {
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
