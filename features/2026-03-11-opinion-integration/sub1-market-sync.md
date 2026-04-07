# Sub-Feature 1: Package Scaffold + Market Sync

**Depends on**: None
**Estimated files**: ~10 new files

---

## Scope

Create the `opinion-listener` package and implement REST-based market/event sync to populate `prediction_markets` and `events` tables.

---

## New Package Structure

```
packages/opinion-listener/
├── package.json
├── tsconfig.json
├── Dockerfile
├── src/
│   ├── index.ts                    # Entry point
│   ├── config.ts                   # Environment config loader
│   ├── services/
│   │   └── marketSync.ts           # REST market + event sync
│   ├── transformers/
│   │   └── normalize.ts            # Opinion API → NormalizedMarket
│   ├── websocket/                  # (Sub-feature 2)
│   │   ├── pool.ts
│   │   ├── client.ts
│   │   └── handlers.ts
│   ├── state/                      # (Sub-feature 3)
│   │   └── orderBookManager.ts
│   └── types/
│       └── api.ts                  # Opinion API response types
```

---

## Step 1: Package scaffold

### 1a. `packages/opinion-listener/package.json`

```json
{
  "name": "@prediction-market/opinion-listener",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@prediction-market/shared": "workspace:*",
    "ws": "^8.18.0",
    "dotenv": "^16.4.5"
  },
  "devDependencies": {
    "@types/ws": "^8.5.12",
    "vitest": "^2.1.0"
  }
}
```

### 1b. `packages/opinion-listener/tsconfig.json`

Extend from root `tsconfig.base.json` (same as other listeners).

### 1c. Add to `pnpm-workspace.yaml`

Already covered by `packages/*` glob — no change needed.

### 1d. Add dev script to root `package.json`

```json
"dev:opinion": "pnpm --filter @prediction-market/opinion-listener dev"
```

---

## Step 2: API types

### File: `src/types/api.ts`

Define TypeScript interfaces matching Opinion REST API responses:

```typescript
// GET /market response
export interface OpinionMarketData {
  marketId: number;
  marketTitle: string;
  status: number;          // 1=Created, 2=Activated, 3=Resolving, 4=Resolved, 5=Failed, 6=Deleted
  statusEnum: string;
  marketType: number;      // 0=Binary, 1=Categorical
  childMarkets?: OpinionChildMarketData[];
  yesLabel: string;
  noLabel: string;
  rules: string;
  yesTokenId: string;
  noTokenId: string;
  conditionId: string;
  resultTokenId: string;
  volume: string;
  volume24h: string;
  volume7d: string;
  quoteToken: string;
  chainId: string;
  questionId: string;
  collection?: OpinionCollectionData | null;
  createdAt: number;       // ms timestamp
  cutoffAt: number;        // ms timestamp
  resolvedAt: number;      // ms timestamp
}

export interface OpinionChildMarketData {
  marketId: number;
  marketTitle: string;
  status: number;
  statusEnum: string;
  yesLabel: string;
  noLabel: string;
  yesTokenId: string;
  noTokenId: string;
  conditionId: string;
  volume: string;
  quoteToken: string;
  chainId: string;
  createdAt: number;
  cutoffAt: number;
  resolvedAt: number;
}

export interface OpinionCollectionData {
  title: string;
  symbol: string;
  frequency: string;
}

// GET /token/orderbook response
export interface OpinionOrderbookResponse {
  market: string;          // conditionId
  tokenId: string;
  timestamp: number;       // ms
  bids: OpinionOrderbookLevel[];
  asks: OpinionOrderbookLevel[];
}

export interface OpinionOrderbookLevel {
  price: string;
  size: string;
}

// GET /token/latest-price response
export interface OpinionLatestPriceResponse {
  tokenId: string;
  price: string;
  side: string;            // BUY/SELL
  size: string;
  timestamp: number;       // ms
}

// API wrapper
export interface OpinionApiResponse<T> {
  code: number;
  msg: string;
  result: T;
}

export interface OpinionMarketListResult {
  total: number;
  list: OpinionMarketData[];
}

// WebSocket messages (used in sub-feature 2)
export interface OpinionWsDepthDiff {
  marketId: number;
  rootMarketId?: number;
  tokenId: string;
  outcomeSide: number;     // 1=YES, 2=NO
  side: string;            // "bids" or "asks"
  price: string;
  size: string;
  msgType: 'market.depth.diff';
}

export interface OpinionWsLastPrice {
  marketId: number;
  rootMarketId?: number;
  tokenId: string;
  price: string;
  outcomeSide: number;
  msgType: 'market.last.price';
}

export interface OpinionWsLastTrade {
  marketId: number;
  rootMarketId?: number;
  tokenId: string;
  side: string;            // "Buy", "Sell", "Split", "Merge"
  outcomeSide: number;
  price: string;
  shares: string;
  amount: string;
  msgType: 'market.last.trade';
}
```

---

## Step 3: Config loader

### File: `src/config.ts`

```typescript
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
}

export function loadConfig(): OpinionConfig {
  return {
    restUrl: process.env.OPINION_REST_URL || 'https://openapi.opinion.trade/openapi',
    wsUrl: process.env.OPINION_WS_URL || 'wss://ws.opinion.trade',
    apiKey: process.env.OPINION_API_KEY || '',
    sourceId: 'OPINION_DIRECT',
    exchangeId: 'OPINIONTRADE',
    marketRefreshIntervalMs: parseInt(process.env.MARKET_REFRESH_INTERVAL_MS || '300000', 10),
    marketsPerSocket: parseInt(process.env.OPINION_MARKETS_PER_SOCKET || '500', 10),
    batchSize: parseInt(process.env.BATCH_SIZE || '100', 10),
    batchIntervalMs: parseInt(process.env.BATCH_INTERVAL_MS || '1000', 10),
  };
}
```

---

## Step 4: Market sync service

### File: `src/services/marketSync.ts`

**Logic:**

1. **Fetch all active markets** via paginated `GET /market?status=activated&limit=20&page=N`
   - Max 20 per page (API limit)
   - Loop until `total` reached or empty page
   - Rate limit: stay under 15 req/s (add 100ms delay between pages)

2. **Separate binary vs categorical markets**
   - Binary (`marketType=0`): one event per market
   - Categorical (`marketType=1`): one event per root market, child markets are outcomes

3. **Normalize to our schema** via `normalizeMarket()`

4. **Upsert markets** via `upsertPredictionMarketsBatch()`

5. **Upsert events** via `upsertEventsBatch()`

6. **Mark stale** — markets not refreshed this cycle get status `"Closed"`

7. **Return market IDs** for WebSocket subscription

**Pagination pattern:**

```typescript
async function fetchAllActiveMarkets(restUrl: string, apiKey: string): Promise<OpinionMarketData[]> {
  const allMarkets: OpinionMarketData[] = [];
  let page = 1;

  while (true) {
    const url = `${restUrl}/market?status=activated&marketType=2&limit=20&page=${page}`;
    const res = await fetch(url, { headers: { apikey: apiKey } });
    const data: OpinionApiResponse<OpinionMarketListResult> = await res.json();

    if (data.code !== 0 || data.result.list.length === 0) break;
    allMarkets.push(...data.result.list);

    if (allMarkets.length >= data.result.total) break;
    page++;
    await sleep(100); // rate limit safety
  }

  return allMarkets;
}
```

**Market ID collection for WS:**

For WebSocket subscriptions, we need `marketId` values (not tokenIds). Binary markets subscribe directly. Categorical markets subscribe via `rootMarketId`.

```typescript
function collectSubscriptionIds(markets: OpinionMarketData[]): {
  marketIds: number[];
  rootMarketIds: number[];
} {
  const marketIds: number[] = [];
  const rootMarketIds: number[] = [];

  for (const m of markets) {
    if (m.marketType === 0) {
      marketIds.push(m.marketId);
    } else if (m.marketType === 1 && m.childMarkets?.length) {
      rootMarketIds.push(m.marketId); // categorical root
      for (const child of m.childMarkets) {
        marketIds.push(child.marketId); // still track child IDs for DB
      }
    }
  }

  return { marketIds, rootMarketIds };
}
```

---

## Step 5: Market normalizer

### File: `src/transformers/normalize.ts`

**Binary market** → 2 records (YES + NO):

```typescript
function normalizeBinaryMarket(m: OpinionMarketData, sourceId: string, exchangeId: string): PredictionMarket[] {
  const expiresAt = m.cutoffAt ? new Date(m.cutoffAt) : null;

  return [
    {
      source_id: sourceId,
      exchange_id: exchangeId,
      market_id: String(m.marketId),
      outcome_side: 'YES',
      outcome_name: m.yesLabel || 'Yes',
      market_name: m.marketTitle,
      price: null,  // filled by WS
      status: mapStatus(m.statusEnum),
      expires_at: expiresAt,
      event_id: String(m.marketId),  // binary: market IS the event
      source_specific_data: {
        tokenId: m.yesTokenId,
        conditionId: m.conditionId,
        chainId: m.chainId,
        volume: m.volume,
      },
    },
    {
      source_id: sourceId,
      exchange_id: exchangeId,
      market_id: String(m.marketId),
      outcome_side: 'NO',
      outcome_name: m.noLabel || 'No',
      market_name: m.marketTitle,
      price: null,
      status: mapStatus(m.statusEnum),
      expires_at: expiresAt,
      event_id: String(m.marketId),
      source_specific_data: {
        tokenId: m.noTokenId,
        conditionId: m.conditionId,
        chainId: m.chainId,
      },
    },
  ];
}
```

**Categorical market** → 2 records per child market:

```typescript
function normalizeCategoricalMarket(m: OpinionMarketData, sourceId: string, exchangeId: string): PredictionMarket[] {
  const results: PredictionMarket[] = [];
  const rootEventId = String(m.marketId);

  for (const child of m.childMarkets ?? []) {
    const expiresAt = child.cutoffAt ? new Date(child.cutoffAt) : null;

    results.push(
      {
        source_id: sourceId,
        exchange_id: exchangeId,
        market_id: String(child.marketId),
        outcome_side: 'YES',
        outcome_name: child.yesLabel || 'Yes',
        market_name: `${m.marketTitle} — ${child.marketTitle}`,
        price: null,
        status: mapStatus(child.statusEnum),
        expires_at: expiresAt,
        event_id: rootEventId,
        source_specific_data: { tokenId: child.yesTokenId, conditionId: child.conditionId },
      },
      {
        source_id: sourceId,
        exchange_id: exchangeId,
        market_id: String(child.marketId),
        outcome_side: 'NO',
        outcome_name: child.noLabel || 'No',
        market_name: `${m.marketTitle} — ${child.marketTitle}`,
        price: null,
        status: mapStatus(child.statusEnum),
        expires_at: expiresAt,
        event_id: rootEventId,
        source_specific_data: { tokenId: child.noTokenId, conditionId: child.conditionId },
      },
    );
  }

  return results;
}
```

**Event normalization:**

```typescript
function normalizeEvents(markets: OpinionMarketData[], sourceId: string, exchangeId: string): ExchangeEvent[] {
  const events: ExchangeEvent[] = [];

  for (const m of markets) {
    if (m.marketType === 0) {
      // Binary: market = event (1 child market)
      events.push({
        source_id: sourceId,
        exchange_id: exchangeId,
        event_id: String(m.marketId),
        title: m.marketTitle,
        category: m.collection?.title || null,
        status: mapStatus(m.statusEnum),
        end_date: m.cutoffAt ? new Date(m.cutoffAt) : null,
        market_count: 1,
        mutually_exclusive: true,
      });
    } else if (m.marketType === 1) {
      // Categorical: root = event, children = markets
      events.push({
        source_id: sourceId,
        exchange_id: exchangeId,
        event_id: String(m.marketId),
        title: m.marketTitle,
        category: m.collection?.title || null,
        status: mapStatus(m.statusEnum),
        end_date: m.cutoffAt ? new Date(m.cutoffAt) : null,
        market_count: m.childMarkets?.length || 0,
        mutually_exclusive: true,
      });
    }
  }

  return events;
}
```

**Status mapping:**

```typescript
function mapStatus(statusEnum: string): string {
  switch (statusEnum) {
    case 'Activated': return 'Open';
    case 'Created': return 'Open';
    case 'Resolving': return 'Open';
    case 'Resolved': return 'Closed';
    case 'Failed': return 'Closed';
    case 'Deleted': return 'Closed';
    default: return 'Open';
  }
}
```

---

## Step 6: Token-to-outcome cache

### Purpose

WebSocket messages include `tokenId` and `outcomeSide` (1 or 2), so we don't need a Polymarket-style cache that maps token→side. However, we DO need a cache mapping `tokenId → marketId` because some WS messages only include `tokenId`.

We also need `marketId → { yesTokenId, noTokenId }` for constructing the opposite side when we receive a depth.diff for one side.

```typescript
// Build during market sync
const tokenToMarket = new Map<string, { marketId: string; outcomeSide: 'YES' | 'NO' }>();
const marketTokens = new Map<string, { yesTokenId: string; noTokenId: string }>();

function buildTokenCache(markets: OpinionMarketData[]): void {
  for (const m of markets) {
    const id = String(m.marketId);
    tokenToMarket.set(m.yesTokenId, { marketId: id, outcomeSide: 'YES' });
    tokenToMarket.set(m.noTokenId, { marketId: id, outcomeSide: 'NO' });
    marketTokens.set(id, { yesTokenId: m.yesTokenId, noTokenId: m.noTokenId });

    for (const child of m.childMarkets ?? []) {
      const childId = String(child.marketId);
      tokenToMarket.set(child.yesTokenId, { marketId: childId, outcomeSide: 'YES' });
      tokenToMarket.set(child.noTokenId, { marketId: childId, outcomeSide: 'NO' });
      marketTokens.set(childId, { yesTokenId: child.yesTokenId, noTokenId: child.noTokenId });
    }
  }
}
```

---

## Step 7: Entry point (minimal, market sync only)

### File: `src/index.ts`

For sub-feature 1, the entry point only does market sync (WS added in sub-feature 2):

```typescript
import 'dotenv/config';
import { createLogger, verifyDatabaseConnection } from '@prediction-market/shared';
import { loadConfig } from './config.js';
import { refreshMarkets } from './services/marketSync.js';

const logger = createLogger('opinion-listener');

async function main() {
  const config = loadConfig();
  logger.info({ restUrl: config.restUrl }, 'Starting opinion-listener');

  await verifyDatabaseConnection();

  // Initial sync
  await refreshMarkets(config);

  // Periodic sync
  setInterval(() => refreshMarkets(config), config.marketRefreshIntervalMs);

  logger.info({ intervalMs: config.marketRefreshIntervalMs }, 'Market sync scheduler started');
}

main().catch(err => {
  logger.fatal({ err }, 'Failed to start opinion-listener');
  process.exit(1);
});
```

---

## Verification

After deploying sub-feature 1:

```sql
-- Markets synced
SELECT exchange_id, outcome_side, COUNT(*), COUNT(DISTINCT market_id) as unique_markets
FROM direct_exchanges_data.prediction_markets
WHERE exchange_id = 'OPINIONTRADE'
GROUP BY exchange_id, outcome_side;

-- Events synced
SELECT exchange_id, status, COUNT(*), AVG(market_count)::int
FROM direct_exchanges_data.events
WHERE exchange_id = 'OPINIONTRADE'
GROUP BY exchange_id, status;

-- Expect: YES + NO rows for each market, events grouping categoricals
```
