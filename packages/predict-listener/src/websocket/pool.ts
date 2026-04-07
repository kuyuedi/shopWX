import { createLogger } from '@prediction-market/shared';
import { PredictWebSocketClient } from './client.js';

const logger = createLogger('predict-ws-pool');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class PredictWebSocketPool {
  private clients: PredictWebSocketClient[] = [];
  private statsInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly wsUrl: string,
    private readonly apiKey: string,
    private readonly marketsPerSocket: number,
    private readonly onMessage: (msg: Record<string, unknown>) => void,
  ) {}

  async subscribeToMarkets(marketIds: number[]): Promise<void> {
    // Close existing clients
    await this.closeAll();

    // Chunk market IDs across sockets
    const chunks: number[][] = [];
    for (let i = 0; i < marketIds.length; i += this.marketsPerSocket) {
      chunks.push(marketIds.slice(i, i + this.marketsPerSocket));
    }

    if (chunks.length === 0) {
      logger.info('No markets to subscribe to');
      return;
    }

    logger.info({
      totalMarkets: marketIds.length,
      sockets: chunks.length,
      marketsPerSocket: this.marketsPerSocket,
    }, 'Creating WebSocket pool');

    // Create and connect clients
    for (let i = 0; i < chunks.length; i++) {
      const client = new PredictWebSocketClient(
        this.wsUrl,
        this.apiKey,
        this.onMessage,
        i,
      );

      try {
        await client.connect();
        const chunk = chunks[i]!;
        client.subscribe(chunk);
        this.clients.push(client);
        logger.info({ socketIndex: i, markets: chunk.length }, 'Socket connected');

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
