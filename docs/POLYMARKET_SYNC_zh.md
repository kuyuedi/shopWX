# Polymarket 数据同步流程 — 完整技术文档

## 概述

Polymarket Listener 是一个实时数据采集服务，从 Polymarket 交易所获取预测市场数据并写入 PostgreSQL 数据库。它使用两种数据通道：

1. **REST API（Gamma API）** — 每分钟定期同步市场和事件元数据
2. **WebSocket** — 实时接收订单簿更新、价格变动和成交记录

**重要：Polymarket 的所有 API 都是公开的，不需要任何 API Key、账号或密码。**

---

## 系统架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                     POLYMARKET LISTENER                              │
│                                                                      │
│  ┌────────────────────┐          ┌──────────────────────────────┐   │
│  │   Gamma REST API   │          │      WebSocket 连接池         │   │
│  │  (市场/事件同步)    │          │   (实时订单簿/成交数据)       │   │
│  │                    │          │                              │   │
│  │ 每1分钟执行一次    │          │  Socket 1: 500个资产          │   │
│  │ GET /events        │          │  Socket 2: 500个资产          │   │
│  │   ?active=true     │          │  Socket 3: 500个资产          │   │
│  │   &closed=false    │          │  ...                         │   │
│  └────────┬───────────┘          │  Socket N: 剩余资产          │   │
│           │                      └──────────┬───────────────────┘   │
│           │                                 │                       │
│           ▼                                 ▼                       │
│  ┌────────────────────┐          ┌──────────────────────────────┐   │
│  │  数据转换 & 缓存    │          │        消息处理器             │   │
│  │                    │          │                              │   │
│  │ • 规范化市场数据    │          │  book → 订单簿快照            │   │
│  │ • 构建内存缓存:     │          │  price_change → 增量更新     │   │
│  │   - outcomeSide    │          │  last_trade_price → 成交     │   │
│  │   - gammaMarketId  │          │  tick_size_change → 忽略     │   │
│  │   - eventId        │          │                              │   │
│  │   - matchedMarkets │          └──────────┬───────────────────┘   │
│  └────────┬───────────┘                     │                       │
│           │                                 │                       │
│           ▼                                 ▼                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    OrderBookManager                           │   │
│  │              （内存中的订单簿增量累积）                         │   │
│  │                                                              │   │
│  │  applySnapshot() — 接收完整快照，替换整个订单簿状态            │   │
│  │  applyDelta()    — 接收单个价格层级变动，更新状态             │   │
│  │  getOrderBook()  — 返回当前完整订单簿（用于写入数据库）        │   │
│  └──────────────────────────┬───────────────────────────────────┘   │
│                             │                                       │
│                             ▼                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                 BatchWriter（批量写入器）                      │   │
│  │                                                              │   │
│  │  • 缓冲区大小: 100条记录                                      │   │
│  │  • 刷新间隔: 100ms                                           │   │
│  │  • 自动重试: 5次，指数退避                                    │   │
│  │  • 4个独立写入器:                                             │   │
│  │    - orderBookWriter  → order_books 表                       │   │
│  │    - tradeWriter      → trades 表                            │   │
│  │    - marketDataWriter → market_latest_data 表                │   │
│  │    - quoteWriter      → quotes 表 (已禁用)                   │   │
│  └──────────────────────────┬───────────────────────────────────┘   │
│                             │                                       │
└─────────────────────────────┼───────────────────────────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │   PostgreSQL     │
                    │   数据库         │
                    │                  │
                    │ Schema:          │
                    │ direct_exchanges │
                    │ _data            │
                    └──────────────────┘
```

---

## 代码文件位置

所有代码都在仓库的 `packages/polymarket-listener/` 目录下：

| 文件 | 用途 |
|------|------|
| `src/index.ts` | **主入口** — 启动服务、编排市场同步和 WebSocket 连接池 |
| `src/services/gammaApi.ts` | **Gamma API 客户端** — REST 请求获取事件和市场数据 |
| `src/websocket/pool.ts` | **WebSocket 连接池** — 管理多个 WebSocket 连接 |
| `src/websocket/client.ts` | **单个 WebSocket 连接** — 连接、重连、订阅逻辑 |
| `src/websocket/handlers.ts` | **消息处理器** — 处理 book、price_change、last_trade_price 消息 |
| `src/websocket/subscriptions.ts` | **订阅消息类型** — WebSocket 订阅消息格式定义 |
| `src/state/orderBookManager.ts` | **订单簿管理器** — 内存中维护完整订单簿状态（增量累积） |
| `src/transformers/normalize.ts` | **数据规范化** — 将 Polymarket API 格式转换为统一内部格式 |
| `Dockerfile` | **Docker 构建文件** — 多阶段构建，node:20-alpine 基础镜像 |

共享代码（被所有 listener 使用）在 `packages/shared/` 下：

| 文件 | 用途 |
|------|------|
| `src/db/queries.ts` | 所有数据库查询和 upsert 函数 |
| `src/db/types.ts` | TypeScript 接口定义（表结构类型） |
| `src/utils/batchWriter.ts` | 通用批量写入器（缓冲 + 自动刷新 + 重试） |
| `src/utils/bandMetrics.ts` | 执行带指标计算（VWAP、流动性等） |

---

## 详细数据流

### 第一步：服务启动（index.ts）

```
启动顺序:
1. 检查数据库连接 → healthCheck()
2. 首次市场同步 → refreshMarkets()
3. 创建 WebSocket 连接池 → wsPool.subscribeToMarkets(assetIds)
4. 设置定时器:
   - 市场同步: 每 1 分钟 (MARKET_REFRESH_INTERVAL_MS)
   - 清理过期市场: 每 1 小时 (CLEANUP_INTERVAL_MS)
5. 设置优雅关闭处理 (SIGTERM/SIGINT)
```

### 第二步：REST 市场同步（每分钟执行）

**API 端点：** `GET https://gamma-api.polymarket.com/events?active=true&closed=false`

**无需认证** — 这是公开 API。

**执行流程：**

```
refreshMarkets()
│
├─ 1. fetchEventsWithMarkets(gammaUrl)
│     │
│     ├─ 分页请求 /events 端点（每页100条）
│     │   URL: https://gamma-api.polymarket.com/events
│     │   参数: active=true, closed=false, limit=100, offset=0,100,200...
│     │
│     ├─ 从每个事件中提取:
│     │   ├─ 事件数据 → events[] (写入 events 表)
│     │   ├─ 嵌套的市场数据 → markets[] (写入 prediction_markets 表)
│     │   └─ 映射关系:
│     │       ├─ eventIdMap: clobTokenId → event.id
│     │       ├─ seriesIdMap: clobTokenId → series ticker
│     │       └─ categoryMap: clobTokenId → category tag
│     │
│     └─ 只保留二元市场（outcomes 必须同时包含 "Yes" 和 "No"）
│
├─ 2. syncMarkets(markets, eventMapping)
│     │
│     ├─ 规范化每个市场 → normalizeMarket()
│     │   每个市场生成2条记录: YES 方和 NO 方
│     │
│     ├─ 查询最近24小时成交次数 → getTradeCounts24h()
│     │
│     ├─ 构建内存缓存:
│     │   ├─ outcomeSideMap: clobTokenId → 'YES' | 'NO'
│     │   └─ conditionIdMap: conditionId → Gamma market ID
│     │
│     ├─ 批量写入 prediction_markets 表（每批100条）
│     │
│     ├─ 批量写入 market_latest_data 表（含交易量和价格）
│     │
│     └─ markStaleMarketsAsClosed() — 标记未更新的市场为 'Closed'
│
├─ 3. upsertEventsBatch(events) — 批量写入 events 表
│
├─ 4. markStaleEventsAsClosed() — 标记过期事件
│
├─ 5. fetchMatchedMarketIds() → setMatchedMarketIds()
│     加载已匹配的市场ID列表，用于过滤 WebSocket 数据库写入
│     （只为匹配的市场写入订单簿数据，减少数据库压力）
│
└─ 6. 返回所有 assetIds → 更新 WebSocket 订阅
```

**写入的数据库表：**

| 表 | 写入方式 | 说明 |
|---|---------|------|
| `prediction_markets` | 批量 UPSERT（100条/批） | 市场元数据，每个市场2行（YES+NO） |
| `market_latest_data` | 批量 UPSERT（100条/批） | 当前价格和24h交易量 |
| `events` | 批量 UPSERT（100条/批） | 事件级别数据 |

---

### 第三步：WebSocket 连接池

**连接地址：** `wss://ws-subscriptions-clob.polymarket.com/ws/market`

**无需认证** — 这是公开 WebSocket。

**Polymarket 限制：每个 WebSocket 连接最多订阅 500 个资产。** 因此需要连接池。

**连接池工作方式：**

```
首次启动 — buildPool():
  总资产数 ÷ 500 = 需要的 Socket 数量
  例: 19,000 个资产 → 38 个 WebSocket 连接
  每个连接间隔 100ms 建立（避免突发连接）

定期更新 — subscribeToMarkets() (每分钟):
  1. 阶段1: 从所有 Socket 中移除已关闭的市场
  2. 阶段2: 找出新增的市场（不在任何 Socket 上）
  3. 阶段3: 将新市场分配到有空余容量的 Socket
  4. 如果所有 Socket 已满: 创建新的 Socket

统计信息: 每30秒输出日志
  - 总 Socket 数
  - 已连接 Socket 数
  - 总消息数
  - 跟踪的资产数
```

---

### 第四步：WebSocket 消息处理

收到消息后由 `handlers.ts` 中的处理器处理：

#### 4.1 `book` 消息 — 完整订单簿快照

```
触发时机: 首次订阅时发送，偶尔在成交后发送
频率: 较低（主要在订阅时）

处理流程:
1. 从缓存查找 outcomeSide (YES/NO) — 缓存未命中则跳过
2. 从缓存查找 Gamma market ID
3. 存入 OrderBookManager → applySnapshot()
4. 写入 order_books 表
5. 计算执行带指标 → calculateBandMetrics()
6. 写入 market_latest_data 表（band metrics 列）
7. 如果启用: 写入 quotes 表（默认禁用）
```

#### 4.2 `price_change` 消息 — 订单簿增量更新

```
触发时机: 订单簿有任何变动时
频率: 非常高（稳定运行时 99%+ 的消息都是此类型）

新格式 (2025年9月15日之后):
{
  "event_type": "price_change",
  "asset_id": "0x1234...",
  "market": "0xcondition...",    // conditionId
  "changes": [
    { "price": "0.55", "side": "BUY", "size": "100.5" },
    { "price": "0.60", "side": "SELL", "size": "0" }    // size=0 表示删除该价格层
  ]
}

处理流程:
1. 从缓存查找 outcomeSide 和 Gamma market ID
2. 对每个 change: orderBookManager.applyDelta(assetId, side, price, size)
   - 如果该 assetId 没有快照 → 丢弃增量（记录日志）
   - 如果有快照 → 更新内存中的订单簿状态
3. 检查是否为已匹配市场 → isMatchedMarket(marketId)
   - 未匹配的市场: 不写入数据库（节省资源）
   - 已匹配的市场: 继续步骤4
4. 获取完整累积订单簿 → orderBookManager.getOrderBook()
5. 写入 order_books 表
6. 计算执行带指标 → calculateBandMetrics()
7. 写入 market_latest_data 表
```

**关键设计：为什么需要增量累积？**

Polymarket 只在订阅时发送一次完整快照（`book` 消息），之后只发送变动部分（`price_change` 消息）。如果不在内存中维护完整状态，订单簿数据在初始快照过期后就会变得不可用。OrderBookManager 通过将每次增量更新应用到内存状态，始终维护最新的完整订单簿。

#### 4.3 `last_trade_price` 消息 — 成交记录

```
触发时机: 有成交发生时
消息格式:
{
  "event_type": "last_trade_price",
  "asset_id": "0x1234...",
  "market": "0xcondition...",
  "price": "0.55",
  "size": "100",
  "side": "BUY",
  "transaction_hash": "0xabc...",
  "timestamp": "1711900000"
}

处理流程:
1. 解析价格、数量、方向
2. 使用 transaction_hash 作为 trade_id（保证唯一性）
3. 从缓存查找 outcomeSide
4. 写入 trades 表
```

---

### 第五步：OrderBookManager — 增量累积

**代码位置：** `src/state/orderBookManager.ts`

这是一个单例（singleton）实例，在内存中为每个资产维护完整的订单簿状态。

**数据结构：**
```
books: Map<assetId, {
  bids: Map<price, quantity>,   // 买方深度
  asks: Map<price, quantity>,   // 卖方深度
  lastUpdate: Date              // 最后更新时间
}>
```

**核心方法：**

| 方法 | 说明 |
|------|------|
| `applySnapshot(assetId, bids, asks)` | 替换整个订单簿（收到 `book` 消息时调用） |
| `applyDelta(assetId, side, price, size)` | 更新单个价格层级（收到 `price_change` 时调用）。size=0 删除层级。如果没有快照返回 false |
| `getOrderBook(assetId)` | 返回当前完整订单簿，用于写入数据库 |
| `clearAll()` | 清除所有状态（WebSocket 断开时调用，防止使用过期增量） |

---

### 第六步：BatchWriter — 批量写入

**代码位置：** `packages/shared/src/utils/batchWriter.ts`

所有数据库写入通过 BatchWriter 缓冲，避免频繁小批量写入：

```
配置:
  maxSize: 100          — 缓冲区满100条时自动刷新
  maxWaitMs: 100ms      — 最长等待100ms后自动刷新
  重试: 5次, 指数退避    — 处理临时性错误（死锁、超时）

Polymarket Listener 中的4个 BatchWriter:
  orderBookWriter  → insertOrderBooksBatch()     → order_books 表
  tradeWriter      → insertTradesBatch()         → trades 表
  marketDataWriter → upsertMarketLatestDataBatch() → market_latest_data 表
  quoteWriter      → insertQuotesBatch()         → quotes 表 (禁用)
```

---

## 数据库写入详情

### 写入的表和频率

| 表 | 触发源 | 频率 | 冲突处理 |
|---|--------|------|---------|
| `prediction_markets` | REST 同步 | 每1分钟 | UPSERT — 全字段覆盖 |
| `events` | REST 同步 | 每1分钟 | UPSERT — 全字段覆盖 |
| `market_latest_data` | REST 同步 + WebSocket | REST: 每1分钟; WS: 每次订单簿变动 | UPSERT — 条件合并（价格取最大/最小值） |
| `order_books` | WebSocket (book + price_change) | 实时（仅已匹配市场） | INSERT — 重复跳过 |
| `trades` | WebSocket (last_trade_price) | 实时 | INSERT — 重复跳过 |
| `quotes` | WebSocket (book) | **已禁用**（`ENABLE_QUOTE_WRITES=false`） | INSERT — 重复跳过 |

### 数据标识

所有 Polymarket 数据使用以下标识：
```
source_id   = 'POLYMARKET_DIRECT'
exchange_id = 'POLYMARKET'
market_id   = Gamma market ID（从 conditionId 映射而来）
outcome_side = 'YES' 或 'NO'
```

### 价格格式

**Polymarket 的所有价格都是 0-1 的小数**，不需要任何转换。例如：
- 55 美分 = `0.55`
- 买入 YES 合约价格 70 美分 = `0.70`

---

## 内存缓存系统

市场同步时构建多个内存缓存，供 WebSocket 处理器使用：

| 缓存 | 键 → 值 | 用途 |
|------|---------|------|
| outcomeSideCache | clobTokenId → 'YES' \| 'NO' | 识别每个 token 代表买方还是卖方 |
| gammaMarketIdCache | conditionId → Gamma market ID | 将 WebSocket 中的 conditionId 转换为数据库使用的 market_id |
| eventIdMap | clobTokenId → event ID | 关联市场到事件 |
| matchedMarketIds | market_id Set | 判断是否为已匹配市场（只为匹配的市场写入订单簿） |

**缓存未命中处理：** 如果 outcomeSide 缓存未命中，该消息会被跳过（不会写入 UNKNOWN 数据）。

---

## API 访问信息

### Gamma REST API

```
基础 URL: https://gamma-api.polymarket.com
认证方式: 无（公开 API）

主要端点:
  GET /events?active=true&closed=false&limit=100&offset=0
    → 返回事件列表，每个事件嵌套市场数据
    → 分页请求，每页100条

  GET /markets/{conditionId}
    → 获取单个市场详情
```

### WebSocket

```
连接地址: wss://ws-subscriptions-clob.polymarket.com/ws/market
认证方式: 无（公开 WebSocket）
每连接限制: 最多500个资产

订阅消息格式:
{
  "type": "subscribe",
  "assets_ids": ["0x1234...", "0x5678...", ...],
  "channels": ["book", "price_change", "last_trade_price"]
}

接收的消息类型:
  book              — 完整订单簿快照
  price_change      — 订单簿增量更新（稳定运行时占99%+的消息）
  last_trade_price  — 成交记录
  tick_size_change  — 价格最小变动单位（我们忽略此消息）
```

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `POLYMARKET_WS_URL` | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | WebSocket 连接地址 |
| `POLYMARKET_GAMMA_URL` | `https://gamma-api.polymarket.com` | Gamma API 基础 URL |
| `MARKETS_PER_SOCKET` | `500` | 每个 WebSocket 连接的最大资产数 |
| `MARKET_REFRESH_INTERVAL_MS` | `60000` | 市场同步间隔（1分钟） |
| `CLEANUP_INTERVAL_MS` | `3600000` | 过期市场清理间隔（1小时） |
| `CLEANUP_RETENTION_MS` | `86400000` | 关闭市场保留时长（24小时） |
| `ENABLE_QUOTE_WRITES` | `false` | 是否写入 quotes 表（默认禁用，因为曾增长到37GB） |
| `BATCH_SIZE` | `100` | 批量写入缓冲区大小 |
| `BATCH_INTERVAL_MS` | `100` | 批量写入最大等待时间(ms) |
| `DATABASE_URL` | （必填） | PostgreSQL 连接字符串 |
| `DB_SCHEMA` | `direct_exchanges_data` | 数据库 schema |

---

## 部署信息

### Docker 构建

```bash
# Dockerfile 位置: packages/polymarket-listener/Dockerfile
# 多阶段构建: node:20-alpine → 构建 → 精简生产镜像
# 入口命令: node packages/polymarket-listener/dist/index.js
```

### 部署脚本

```bash
# 部署到生产服务器
./deploy.sh

# 脚本执行流程:
# 1. 运行单元测试
# 2. SSH 到日本服务器 (8.216.43.26)
# 3. 从 GitHub 拉取最新代码 (origin/main)
# 4. 构建 Docker 镜像
# 5. 重启容器
# 6. 运行冒烟测试
```

### 手动操作

```bash
# 查看日志
ssh root@8.216.43.26 "docker compose -f /opt/prediction-market-ingestion/docker-compose.yml logs --tail 50 polymarket-listener"

# 重启服务
ssh root@8.216.43.26 "docker compose -f /opt/prediction-market-ingestion/docker-compose.yml restart polymarket-listener"

# 检查运行状态
ssh root@8.216.43.26 "docker compose -f /opt/prediction-market-ingestion/docker-compose.yml ps polymarket-listener"
```

---

## 优雅关闭

当收到 SIGTERM 或 SIGINT 信号时：

```
1. 停止市场同步定时器
2. 停止清理定时器
3. 关闭所有 WebSocket 连接 → wsPool.closeAll()
4. 刷新所有待写入数据 → shutdownWriters()
   (确保缓冲区中的数据全部写入数据库)
5. 关闭数据库连接池 → closePool()
6. 退出进程
```

---

## 错误处理

| 错误类型 | 处理方式 |
|---------|---------|
| 数据库写入失败 | BatchWriter 自动重试5次，指数退避 |
| WebSocket 断开 | 自动重连，指数退避 |
| Gamma API 请求失败 | 抛出错误，等待下次定时同步 |
| outcomeSide 缓存未命中 | 跳过该消息（不写入数据库） |
| 增量更新无快照 | 跳过（等待下次 book 快照消息） |
| 临时性错误（死锁、超时） | 自动重置数据库连接池，继续运行 |
| 严重错误 | 记录日志，优雅关闭 |

---

## 数据完整性保证

1. **唯一约束** — 所有表都有唯一约束防止重复数据
2. **幂等写入** — UPSERT 保证重复写入安全
3. **批量排序** — 写入前按 market_id 排序，防止死锁
4. **过期清理** — 定期清理关闭的市场和事件
5. **匹配过滤** — 只为已匹配市场写入高频订单簿数据，减少存储压力

---

## 常用诊断 SQL

```sql
-- 查看 Polymarket 市场总数
SELECT status, COUNT(*)
FROM direct_exchanges_data.prediction_markets
WHERE exchange_id = 'POLYMARKET'
GROUP BY status;

-- 查看最近更新的市场
SELECT market_id, title, price, status, updated_at
FROM direct_exchanges_data.prediction_markets
WHERE exchange_id = 'POLYMARKET' AND status = 'Open'
ORDER BY updated_at DESC
LIMIT 20;

-- 查看订单簿写入频率（最近1小时）
SELECT COUNT(*), MIN(created_at), MAX(created_at)
FROM direct_exchanges_data.order_books
WHERE exchange_id = 'POLYMARKET'
  AND created_at > NOW() - INTERVAL '1 hour';

-- 查看最近成交
SELECT market_id, price, quantity, side, outcome, created_at
FROM direct_exchanges_data.trades
WHERE exchange_id = 'POLYMARKET'
ORDER BY created_at DESC
LIMIT 20;

-- 查看 market_latest_data 中的执行带指标
SELECT market_id, outcome_side, reference_price,
       band_liquidity_qty_bid, band_liquidity_qty_ask,
       band_vwap_bid, band_vwap_ask, updated_at
FROM direct_exchanges_data.market_latest_data
WHERE exchange_id = 'POLYMARKET'
  AND band_delta_used IS NOT NULL
ORDER BY updated_at DESC
LIMIT 20;
```
