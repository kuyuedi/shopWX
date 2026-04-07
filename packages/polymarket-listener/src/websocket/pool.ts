import { createLogger } from '@prediction-market/shared';
import { PolymarketWebSocketClient, PolymarketWebSocketConfig } from './client.js';

const logger = createLogger('polymarket-ws-pool');

// Polymarket's undocumented limit: max 500 instruments per WebSocket connection
const DEFAULT_MARKETS_PER_SOCKET = 500;

export class PolymarketWebSocketPool {
  private clients: PolymarketWebSocketClient[] = [];
  private marketsPerSocket: number;
  private statsInterval: ReturnType<typeof setInterval> | null = null;
  /** Track which asset IDs are subscribed on each client */
  private clientAssets: Map<PolymarketWebSocketClient, Set<string>> = new Map();

  constructor(
    private readonly config: PolymarketWebSocketConfig,
    marketsPerSocket: number = DEFAULT_MARKETS_PER_SOCKET
  ) {
    this.marketsPerSocket = marketsPerSocket;
  }

  async subscribeToMarkets(assetIds: string[]): Promise<void> {
    // First call — do full pool build
    if (this.clients.length === 0) {
      await this.buildPool(assetIds);
      return;
    }

    const newIdSet = new Set(assetIds);

    // Phase 1: Remove ALL closed markets from every socket
    let totalRemoved = 0;
    for (const [client, assets] of this.clientAssets) {
      const closedOnSocket = [...assets].filter(id => !newIdSet.has(id));
      if (closedOnSocket.length > 0) {
        for (const id of closedOnSocket) assets.delete(id);
        totalRemoved += closedOnSocket.length;
        // Re-subscribe with cleaned list (frees up slots)
        client.subscribeToMarkets([...assets]);
      }
    }

    if (totalRemoved > 0) {
      logger.info({ totalRemoved }, 'Removed closed markets from sockets');
    }

    // Phase 2: Find genuinely new markets (not yet subscribed on any socket)
    const currentIds = new Set<string>();
    for (const assets of this.clientAssets.values()) {
      for (const id of assets) currentIds.add(id);
    }
    const added = assetIds.filter(id => !currentIds.has(id));

    if (added.length === 0 && totalRemoved === 0) {
      logger.info({ markets: assetIds.length }, 'No subscription changes needed');
      return;
    }

    logger.info({
      total: assetIds.length,
      newMarkets: added.length,
      removedClosed: totalRemoved,
      socketsBefore: this.clients.length,
    }, 'Incremental pool update');

    // Phase 3: Add new markets to sockets with spare capacity
    let remaining = [...added];

    for (const [client, assets] of this.clientAssets) {
      if (remaining.length === 0) break;
      const room = this.marketsPerSocket - assets.size;
      if (room > 0) {
        const batch = remaining.splice(0, room);
        for (const id of batch) assets.add(id);
        client.subscribeToMarkets([...assets]);
      }
    }

    // Create new sockets for anything that still didn't fit
    if (remaining.length > 0) {
      const chunks: string[][] = [];
      for (let i = 0; i < remaining.length; i += this.marketsPerSocket) {
        chunks.push(remaining.slice(i, i + this.marketsPerSocket));
      }

      for (const chunk of chunks) {
        const socketIndex = this.clients.length;
        const client = new PolymarketWebSocketClient(this.config, socketIndex);
        this.clients.push(client);
        this.clientAssets.set(client, new Set(chunk));

        try {
          await client.connect();
          client.subscribeToMarkets(chunk);
          logger.info({ socketIndex, markets: chunk.length }, 'Added new socket for new markets');
        } catch (err) {
          logger.error({ err, socketIndex }, 'Failed to connect new socket');
        }
      }
    }

    logger.info({
      socketsAfter: this.clients.length,
      totalTrackedAssets: [...this.clientAssets.values()].reduce((sum, s) => sum + s.size, 0),
    }, 'Incremental pool update complete');
  }

  private async buildPool(assetIds: string[]): Promise<void> {
    const chunks: string[][] = [];
    for (let i = 0; i < assetIds.length; i += this.marketsPerSocket) {
      chunks.push(assetIds.slice(i, i + this.marketsPerSocket));
    }

    logger.info({
      totalMarkets: assetIds.length,
      sockets: chunks.length,
      marketsPerSocket: this.marketsPerSocket,
    }, 'Creating WebSocket pool');

    for (let i = 0; i < chunks.length; i++) {
      const client = new PolymarketWebSocketClient(this.config, i);
      this.clients.push(client);
      this.clientAssets.set(client, new Set(chunks[i]));
    }

    const connectPromises = this.clients.map((client, index) => {
      return new Promise<void>((resolve) => {
        setTimeout(async () => {
          try {
            await client.connect();
            const chunk = chunks[index];
            if (chunk) {
              client.subscribeToMarkets(chunk);
            }
            resolve();
          } catch (err) {
            logger.error({ err, socketIndex: index }, 'Failed to connect socket');
            resolve();
          }
        }, index * 100);
      });
    });

    await Promise.all(connectPromises);
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

      let totalTrackedAssets = 0;
      for (const assets of this.clientAssets.values()) {
        totalTrackedAssets += assets.size;
      }

      logger.info({
        totalSockets: this.clients.length,
        connectedSockets: connectedCount,
        totalMessages,
        totalTrackedAssets,
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
    this.clientAssets = new Map();
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
