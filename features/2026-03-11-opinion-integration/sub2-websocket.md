# Sub-Feature 2: WebSocket Listener

**Depends on**: Sub-feature 1 (market sync provides market IDs + token cache)

---

## Scope

Implement WebSocket connection pool that subscribes to all active Opinion markets and handles three message types: orderbook depth diffs, last price updates, and trade events.

---

## Opinion WebSocket Protocol

| Aspect | Detail |
|--------|--------|
| URL | `wss://ws.opinion.trade?apikey={API_KEY}` |
| Protocol | Plain WebSocket (NOT Socket.IO) |
| Heartbeat | `{"action":"HEARTBEAT"}` every 30s |
| Subscribe | `{"action":"SUBSCRIBE","channel":"...","marketId":N}` |
| Unsubscribe | `{"action":"UNSUBSCRIBE","channel":"...","marketId":N}` |
| Channels | `market.depth.diff`, `market.last.price`, `market.last.trade` |
| Binary markets | Subscribe with `marketId` |
| Categorical markets | Subscribe with `rootMarketId` |

---

## Step 1: WebSocket client

### File: `src/websocket/client.ts`

Single WebSocket connection that manages subscriptions for a chunk of markets.

**Responsibilities:**
- Connect to `wss://ws.opinion.trade?apikey={key}`
- Send heartbeat every 25s (before 30s timeout)
- Subscribe to all 3 channels per market
- Auto-reconnect with exponential backoff (1s, 2s, 4s, 8s, max 30s)
- Route messages to handler by `msgType`

**Key logic:**

```typescript
class OpinionWebSocketClient {
  private ws: WebSocket | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private marketIds: number[] = [];
  private rootMarketIds: number[] = [];

  constructor(
    private url: string,
    private apiKey: string,
    private onMessage: (msg: unknown) => void,
  ) {}

  async connect(): Promise<void> {
    this.ws = new WebSocket(`${this.url}?apikey=${this.apiKey}`);

    this.ws.on('open', () => {
      this.startHeartbeat();
      this.subscribeAll();
    });

    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      this.onMessage(msg);
    });

    this.ws.on('close', () => this.scheduleReconnect());
    this.ws.on('error', (err) => logger.error({ err }, 'WS error'));
  }

  subscribe(marketIds: number[], rootMarketIds: number[]): void {
    this.marketIds = marketIds;
    this.rootMarketIds = rootMarketIds;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.subscribeAll();
    }
  }

  private subscribeAll(): void {
    const channels = ['market.depth.diff', 'market.last.price', 'market.last.trade'];

    for (const channel of channels) {
      for (const marketId of this.marketIds) {
        this.send({ action: 'SUBSCRIBE', channel, marketId });
      }
      for (const rootMarketId of this.rootMarketIds) {
        this.send({ action: 'SUBSCRIBE', channel, rootMarketId });
      }
    }
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.send({ action: 'HEARTBEAT' });
    }, 25_000);
  }
}
```

**Subscription count per connection:**

Each market needs 3 subscriptions (3 channels). If WS limit is unknown, start conservative at 200 markets/socket (= 600 subscriptions). Tune after testing.

---

## Step 2: WebSocket pool

### File: `src/websocket/pool.ts`

Follow Polymarket pool pattern: chunk markets across multiple connections.

```typescript
class OpinionWebSocketPool {
  private clients: OpinionWebSocketClient[] = [];

  constructor(
    private wsUrl: string,
    private apiKey: string,
    private marketsPerSocket: number,
    private onMessage: (msg: unknown) => void,
  ) {}

  async subscribeToMarkets(
    marketIds: number[],
    rootMarketIds: number[],
  ): Promise<void> {
    // Close existing connections
    await this.closeAll();

    // Chunk binary market IDs
    const chunks = chunkArray(marketIds, this.marketsPerSocket);

    // Distribute categorical rootMarketIds across chunks
    // (each rootMarketId covers all child markets, so counts as ~N subscriptions)
    // For simplicity, add rootMarketIds to the first chunk that has room

    for (let i = 0; i < chunks.length; i++) {
      const client = new OpinionWebSocketClient(this.wsUrl, this.apiKey, this.onMessage);
      const rootChunk = i === 0 ? rootMarketIds : [];
      await client.connect();
      client.subscribe(chunks[i], rootChunk);
      this.clients.push(client);
      await sleep(500); // stagger connections
    }
  }

  async closeAll(): Promise<void> {
    for (const client of this.clients) {
      client.close();
    }
    this.clients = [];
  }
}
```

---

## Step 3: Message handlers

### File: `src/websocket/handlers.ts`

Three handlers, each writing to the appropriate DB table via BatchWriter.

**BatchWriter instances:**

```typescript
const orderBookWriter = new BatchWriter<OrderBook>({
  maxSize: config.batchSize,
  maxWaitMs: config.batchIntervalMs,
  writeFn: insertOrderBooksBatch,
});

const marketDataWriter = new BatchWriter<MarketLatestData>({
  maxSize: config.batchSize,
  maxWaitMs: config.batchIntervalMs,
  writeFn: upsertMarketLatestDataBatch,
});

const tradeWriter = new BatchWriter<Trade>({
  maxSize: config.batchSize,
  maxWaitMs: config.batchIntervalMs,
  writeFn: insertTradesBatch,
});
```

### Handler 3a: `market.depth.diff` → OrderBook + MarketLatestData

This is the most complex handler. Opinion sends **individual level changes** (like Kalshi), not full snapshots.

```typescript
function handleDepthDiff(msg: OpinionWsDepthDiff): void {
  const marketId = String(msg.marketId);
  const outcomeSide = msg.outcomeSide === 1 ? 'YES' : 'NO';
  const side = msg.side; // "bids" or "asks"
  const price = parseFloat(msg.price);
  const size = parseFloat(msg.size);

  // Apply delta to in-memory orderbook (Sub-feature 3)
  orderBookManager.applyDelta(marketId, outcomeSide, side, price, size);

  // Get full accumulated state
  const fullBook = orderBookManager.getOrderBook(marketId, outcomeSide);
  if (!fullBook) return;

  // Write orderbook snapshot to DB
  orderBookWriter.add({
    source_id: SOURCE_ID,
    exchange_id: EXCHANGE_ID,
    market_id: marketId,
    outcome_side: outcomeSide,
    bids: fullBook.bids,
    asks: fullBook.asks,
    entry_time: new Date(),
  });

  // Calculate band metrics
  const metrics = calculateBandMetrics(fullBook.bids, fullBook.asks);

  marketDataWriter.add({
    source_id: SOURCE_ID,
    exchange_id: EXCHANGE_ID,
    market_id: marketId,
    outcome_side: outcomeSide,
    reference_price: metrics.referencePrice,
    band_liquidity_qty_bid: metrics.bandLiquidityQtyBid,
    band_liquidity_qty_ask: metrics.bandLiquidityQtyAsk,
    band_vwap_bid: metrics.bandVwapBid,
    band_vwap_ask: metrics.bandVwapAsk,
    band_delta_used: metrics.bandDeltaUsed,
    entry_time: new Date(),
  });
}
```

### Handler 3b: `market.last.price` → MarketLatestData

```typescript
function handleLastPrice(msg: OpinionWsLastPrice): void {
  const marketId = String(msg.marketId);
  const outcomeSide = msg.outcomeSide === 1 ? 'YES' : 'NO';
  const price = parseFloat(msg.price);

  marketDataWriter.add({
    source_id: SOURCE_ID,
    exchange_id: EXCHANGE_ID,
    market_id: marketId,
    outcome_side: outcomeSide,
    price_close: price,
    entry_time: new Date(),
  });
}
```

### Handler 3c: `market.last.trade` → Trade

```typescript
function handleLastTrade(msg: OpinionWsLastTrade): void {
  const marketId = String(msg.marketId);
  const outcomeSide = msg.outcomeSide === 1 ? 'YES' : 'NO';

  tradeWriter.add({
    source_id: SOURCE_ID,
    exchange_id: EXCHANGE_ID,
    market_id: marketId,
    trade_id: null, // Opinion doesn't provide trade_id in WS
    price: parseFloat(msg.price),
    quantity: parseFloat(msg.shares),
    side: msg.side === 'Buy' ? 'Buy' : 'Sell',
    outcome: outcomeSide,
    entry_time: new Date(),
  });
}
```

### Message router

```typescript
function handleMessage(msg: Record<string, unknown>): void {
  const msgType = msg.msgType as string;

  switch (msgType) {
    case 'market.depth.diff':
      handleDepthDiff(msg as OpinionWsDepthDiff);
      break;
    case 'market.last.price':
      handleLastPrice(msg as OpinionWsLastPrice);
      break;
    case 'market.last.trade':
      handleLastTrade(msg as OpinionWsLastTrade);
      break;
    default:
      // Ignore unknown message types (heartbeat responses, etc.)
      break;
  }
}
```

---

## Step 4: Wire into entry point

Update `src/index.ts` to start WS pool after market sync:

```typescript
async function main() {
  const config = loadConfig();
  await verifyDatabaseConnection();

  // Initial market sync
  const { marketIds, rootMarketIds } = await refreshMarkets(config);

  // Start WS pool
  const pool = new OpinionWebSocketPool(
    config.wsUrl,
    config.apiKey,
    config.marketsPerSocket,
    handleMessage,
  );
  await pool.subscribeToMarkets(marketIds, rootMarketIds);

  // Periodic refresh: re-sync markets + re-subscribe
  setInterval(async () => {
    const updated = await refreshMarkets(config);
    await pool.subscribeToMarkets(updated.marketIds, updated.rootMarketIds);
  }, config.marketRefreshIntervalMs);
}
```

---

## Verification

```sql
-- Orderbooks flowing
SELECT COUNT(*), MAX(entry_time), MIN(entry_time)
FROM direct_exchanges_data.order_books
WHERE exchange_id = 'OPINIONTRADE'
  AND entry_time > NOW() - INTERVAL '5 minutes';

-- Market latest data with band metrics
SELECT market_id, outcome_side, reference_price,
       band_vwap_bid, band_vwap_ask,
       band_liquidity_qty_bid, band_liquidity_qty_ask
FROM direct_exchanges_data.market_latest_data
WHERE exchange_id = 'OPINIONTRADE'
  AND reference_price IS NOT NULL
LIMIT 10;

-- Trades flowing
SELECT COUNT(*), MAX(entry_time)
FROM direct_exchanges_data.trades
WHERE exchange_id = 'OPINIONTRADE'
  AND entry_time > NOW() - INTERVAL '5 minutes';
```
