# 预测市场数据采集 - 架构文档

## 概述

实时预测市场数据采集系统，通过 WebSocket API 连接 **Kalshi**、**Polymarket**、**Predict.fun** 和 **Opinion.trade** 交易所，将市场数据、交易记录和订单簿更新写入 PostgreSQL 数据库。包含跨交易所**事件匹配**、**市场匹配**和**套利检测**功能。

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      PREDICTION MARKET INGESTION                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌────────┐  ┌──────────┐  ┌─────────┐  ┌─────────┐  ┌────────────┐  │
│  │ Kalshi │  │Polymarket│  │ Predict │  │ Opinion │  │ PostgreSQL │  │
│  │Exchange│  │ Exchange │  │  .fun   │  │ .trade  │  │  Database  │  │
│  └───┬────┘  └────┬─────┘  └───┬─────┘  └───┬─────┘  └─────▲──────┘  │
│      │            │            │            │               │          │
│  ┌───▼────┐  ┌────▼─────┐  ┌───▼─────┐  ┌───▼─────┐       │          │
│  │ Kalshi │  │Polymarket│  │ Predict │  │ Opinion │       │          │
│  │Listener│  │ Listener │  │Listener │  │Listener │       │          │
│  └───┬────┘  └────┬─────┘  └───┬─────┘  └───┬─────┘       │          │
│      │            │            │            │               │          │
│      └────────────┼────────────┼────────────┘               │          │
│                   │            │                             │          │
│            ┌──────▼──────┐    │                             │          │
│            │   Shared    ├────┘─────────────────────────────┘          │
│            └──────┬──────┘                                             │
│                   │                                                     │
│      ┌────────────┼────────────┐                                       │
│  ┌───▼────────┐ ┌─▼─────────┐ ┌▼────────────┐                        │
│  │   Event    │ │  Homepage  │ │ Healthcheck │                        │
│  │  Matcher   │ │    API     │ │   Service   │                        │
│  │  (OpenAI)  │ │ (Arb Scan) │ │ (Telegram)  │                        │
│  └────────────┘ └────────────┘ └─────────────┘                        │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 包结构

```
prediction-market-ingestion/
├── packages/
│   ├── shared/                    # 共享工具库和数据库
│   │   ├── src/
│   │   │   ├── db/               # 数据库客户端和查询
│   │   │   ├── types/            # TypeScript 接口
│   │   │   └── utils/            # 日志、批量写入、重试、缓存、Band 指标
│   │   └── package.json
│   │
│   ├── kalshi-listener/           # Kalshi 交易所监听器
│   │   ├── src/
│   │   │   ├── websocket/        # WS 连接池、处理器（ticker、orderbook、trade）
│   │   │   ├── services/         # 市场同步服务
│   │   │   ├── state/            # OrderBookManager（增量累积）
│   │   │   ├── transformers/     # 数据标准化
│   │   │   └── index.ts          # 入口文件
│   │   └── Dockerfile
│   │
│   ├── polymarket-listener/       # Polymarket 交易所监听器
│   │   ├── src/
│   │   │   ├── websocket/        # WS 连接池、客户端、处理器
│   │   │   ├── services/         # Gamma API 服务
│   │   │   ├── state/            # OrderBookManager（增量累积）
│   │   │   └── transformers/     # 数据标准化
│   │   └── Dockerfile
│   │
│   ├── opinion-listener/          # Opinion.trade 交易所监听器
│   │   ├── src/
│   │   │   ├── websocket/        # WS 连接池、处理器
│   │   │   ├── services/         # 市场同步服务
│   │   │   ├── state/            # OpinionOrderBookManager
│   │   │   └── index.ts
│   │   └── Dockerfile
│   │
│   ├── predict-listener/           # Predict.fun 交易所监听器 + 跨交易所映射
│   │   ├── src/
│   │   │   ├── websocket/        # WS 连接池、客户端、处理器
│   │   │   ├── services/         # 市场同步、跨交易所映射
│   │   │   ├── state/            # OrderBookManager（增量累积）
│   │   │   ├── transformers/     # 数据标准化
│   │   │   ├── types/            # Predict API 类型
│   │   │   └── index.ts
│   │   └── Dockerfile
│   │
│   ├── event-matcher/             # 跨交易所事件和市场匹配
│   │   ├── src/
│   │   │   ├── services/         # OpenAI 匹配、关键词预过滤
│   │   │   └── index.ts
│   │   └── Dockerfile
│   │
│   ├── homepage-api/              # REST API + 套利扫描器
│   │   ├── src/
│   │   │   ├── routes/           # API 端点
│   │   │   ├── services/         # 套利扫描服务
│   │   │   └── index.ts
│   │   └── Dockerfile
│   │
│   └── healthcheck/               # 系统监控 + Telegram 告警
│       ├── src/
│       │   ├── checks/           # 磁盘、容器、数据库、数据流检查
│       │   └── alerting/         # Telegram 集成
│       └── Dockerfile
│
├── docs/                          # 文档
├── features/                      # 功能规格说明
├── scripts/                       # 回填和种子脚本
├── migrations/                    # 数据库迁移
├── docker-compose.yml
├── deploy.sh                      # 部署 Polymarket 监听器
├── deploy-kalshi.sh               # 部署 Kalshi 监听器
├── deploy-opinion.sh              # 部署 Opinion 监听器
├── deploy-predict.sh              # 部署 Predict 监听器
├── deploy-event-matcher.sh        # 部署事件匹配器
├── deploy-homepage-api.sh         # 部署主页 API
└── deploy-healthcheck.sh          # 部署健康检查
```

---

## 数据流

### Kalshi 数据流

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Kalshi REST    │     │ Kalshi WebSocket│     │   PostgreSQL    │
│  /events API    │     │   Real-time     │     │   Database      │
└────────┬────────┘     └────────┬────────┘     └────────▲────────┘
         │                       │                       │
         │ Market List           │ ticker, orderbook,    │
         │ + OHLC Data           │ trade messages        │
         ▼                       ▼                       │
┌────────────────────────────────────────────────────────┤
│                  KALSHI LISTENER                       │
├────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ Market Sync  │  │  Handlers    │  │ Batch Writer │ │
│  │   Service    │  │              │  │              │─┼─►
│  └──────────────┘  └──────────────┘  └──────────────┘ │
└────────────────────────────────────────────────────────┘
```

### Polymarket 数据流

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Gamma API     │     │ Polymarket WS   │     │   PostgreSQL    │
│   /events       │     │ Pool (N sockets)│     │   Database      │
└────────┬────────┘     └────────┬────────┘     └────────▲────────┘
         │                       │                       │
         │ Market List           │ book, trade,          │
         │ + Outcome Cache       │ price_change          │
         ▼                       ▼                       │
┌────────────────────────────────────────────────────────┤
│               POLYMARKET LISTENER                      │
├────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ Gamma API    │  │  Handlers    │  │ Batch Writer │ │
│  │   Service    │  │ + WS Pool    │  │              │─┼─►
│  └──────────────┘  └──────────────┘  └──────────────┘ │
└────────────────────────────────────────────────────────┘
```

### Predict 数据流

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Predict REST   │     │  Predict WS     │     │   PostgreSQL    │
│  /v1/categories │     │  Real-time      │     │   Database      │
└────────┬────────┘     └────────┬────────┘     └────────▲────────┘
         │                       │                       │
         │ Categories            │ orderbook, trade      │
         │ (events + markets)    │ messages              │
         ▼                       ▼                       │
┌────────────────────────────────────────────────────────┤
│                 PREDICT LISTENER                       │
├────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ Market Sync  │  │  Handlers    │  │Cross-Mapping │ │
│  │  + Events    │  │ + WS Pool    │  │(Kalshi/Poly) │─┼─►
│  └──────────────┘  └──────────────┘  └──────────────┘ │
└────────────────────────────────────────────────────────┘
```

**Predict.fun 独有功能 — API 提供的跨交易所链接：**
- 每个 Predict 市场包含 `kalshiMarketTicker` 和 `polymarketConditionIds` 字段
- 跨映射服务（`crossMapping.ts`）在每次同步时读取这些字段
- 在数据库中查找对应的 Kalshi/Polymarket 市场
- 创建 `market_mappings` 条目，`model_id = 'predict-api-link-v1'`，`confidence_score = 1.0`
- 使用 `CM-<hash>` 格式的规范 ID，与 event-matcher 格式一致
- 通过 `findExistingCanonicalMarketId()` 检查现有规范分组，实现传递性分组

### Band 指标数据流

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   order_books   │     │ market_mappings │     │ market_prices   │
│    (JSONB)      │     │    (bridge)     │     │    _latest      │
└────────┬────────┘     └────────┬────────┘     └────────▲────────┘
         │                       │                       │
         │ bids/asks             │ market_id →           │ reference_price
         │                       │ canonical_market_id   │ band_liquidity
         ▼                       ▼                       │ band_vwap
┌────────────────────────────────────────────────────────┤
│              BAND METRICS CALCULATOR                   │
├────────────────────────────────────────────────────────┤
│  1. Dust filter       → Remove orders < min_qty       │
│  2. Reference check   → Validate spread < max         │
│  3. Reference price   → (best_bid + best_ask) / 2     │
│  4. Band filter       → Orders within delta of ref    │
│  5. Liquidity sum     → Aggregate qty (capped)        │
│  6. VWAP calculation  → Weighted price average        │
└────────────────────────────────────────────────────────┘
```

---

## 数据库模式

所有表位于阿里云 RDS PostgreSQL 的 **`direct_exchanges_data`** schema 中。不使用 ORM，所有查询通过 `pg`（node-postgres）驱动使用原始 SQL。

### 表概览

| 表 | 用途 | 写入量 | 保留策略 |
|---|------|--------|---------|
| `prediction_markets` | 市场元数据（每个市场每个结果方向一行） | 每 5 分钟批量 upsert | 已关闭市场 24 小时后清理 |
| `market_latest_data` | 当前 OHLC 价格 + 执行带流动性指标 | 每次 tick 和 orderbook 事件 | 随父市场一起清理 |
| `order_books` | 时间序列订单簿快照 | 每条 orderbook 消息 | 4 小时（按小时分区） |
| `trades` | 单笔交易记录 | 每条交易消息 | 48 小时（按天分区） |
| `quotes` | 最优买卖价快照（**写入已禁用**） | 已禁用（`ENABLE_QUOTE_WRITES=false`） | 不适用（曾达 37GB） |
| `exchanges` | 交易所注册表 | 仅种子数据 | 永久保留 |
| `data_sources` | 数据源注册表 | 仅种子数据 | 永久保留 |
| `market_mappings` | 跨交易所市场 ID 映射（由 event-matcher 填充） | 每个匹配周期批量 upsert | 永久保留 |

---

### 表：`prediction_markets`

市场元数据 — 每个市场每个结果方向（YES/NO）一行。由 REST API 同步每 5 分钟从 Kalshi `/events` 和 Polymarket Gamma `/markets` 端点填充。

**唯一约束：** `(source_id, exchange_id, market_id, outcome_side)`
**冲突处理：** `DO UPDATE SET`（全量 upsert — 所有字段覆盖）

| 列 | 类型 | 描述 |
|----|------|------|
| `source_id` | VARCHAR | `KALSHI_DIRECT` 或 `POLYMARKET_DIRECT` |
| `exchange_id` | VARCHAR | `KALSHI` 或 `POLYMARKET` |
| `market_id` | VARCHAR(255) | Kalshi：ticker 字符串；Polymarket：Gamma 市场数字 ID |
| `outcome_side` | VARCHAR | `'YES'` 或 `'NO'` |
| `outcome_name` | VARCHAR | 可读标签：`"Yes"`、`"No"` 或具体选项名称 |
| `outcome_type` | VARCHAR | `'Binary'`、`'Scalar'` 或 `'MultipleChoice'` |
| `title` | VARCHAR(512) | 市场名称（截断）；Kalshi 格式：`"title — yes_sub_title"` |
| `sub_title` | TEXT | 可选副标题/分组项标题 |
| `event_id` | VARCHAR(255) | 父事件分组（Kalshi：`event_ticker`；Polymarket：Gamma 事件 ID） |
| `series_id` | VARCHAR(255) | 系列 ticker（Kalshi：`series_ticker`；Polymarket：来自 events API） |
| `rules_primary` | TEXT | 主要结算规则 |
| `rules_secondary` | TEXT | 次要结算规则（仅 Kalshi） |
| `category` | VARCHAR(255) | 市场分类 |
| `price` | NUMERIC | 最新价格，标准化为 0-1 小数 |
| `expires_at` | TIMESTAMP | 市场到期/关闭时间 |
| `status` | VARCHAR | `'Open'`、`'Closed'`、`'Resolved'` 或 `'Cancelled'` |
| `source_specific_data` | JSONB | 交易所特定数据（如 `token_id`、`condition_id`、`open_interest`、`volume_24h`） |
| `created_at` | TIMESTAMP | 插入时设为 `NOW()` |
| `updated_at` | TIMESTAMP | 每次 upsert 时更新为 `NOW()` |

**索引：**
- `idx_prediction_markets_series_id` — 在 `(series_id)` 上，`WHERE series_id IS NOT NULL`
- `idx_prediction_markets_cleanup` — 在 `(source_id, exchange_id, status, updated_at)` 上，WHERE status IN (`'Closed'`, `'Resolved'`, `'Cancelled'`)
- `idx_prediction_markets_stale_check` — 在 `(source_id, exchange_id, updated_at)` 上，`WHERE status = 'Open'`

**数据来源：**
- **Kalshi**：`GET /events?with_nested_markets=true&status=open`（分页，每页 100 个事件）。过滤掉体育组合市场。`event_ticker` 和 `series_ticker` 从事件级别传递。
- **Polymarket**：`GET https://gamma-api.polymarket.com/events?active=true&closed=false`（分页）。市场从嵌套事件数据中统一提取。

**生命周期：** `markStaleMarketsAsClosed()` 在每次同步后运行 — 任何 `status='Open'` 且 `updated_at < syncStartTime` 的市场将被设为 `'Closed'`。`deleteClosedMarkets()` 每小时运行，删除关闭超过 24 小时的市场。

---

### 表：`market_latest_data`

每个市场每个结果方向一行，存储当前 OHLC 价格、成交量和执行带流动性指标。在每个 ticker 事件（价格）和每个订单簿事件（Band 指标）时更新。

**唯一约束：** `(source_id, exchange_id, market_id, outcome_side)`
**冲突处理：** `DO UPDATE SET`，带合并逻辑（非全量替换）：
- `price_open` / `price_close` / `volume_traded` / `trades_count` — 仅在传入值非零时更新
- `price_high` — `GREATEST(existing, incoming)`
- `price_low` — `LEAST(existing, incoming)`
- Band 指标列 — 仅在 `band_delta_used IS NOT NULL` 时更新（即由订单簿事件触发）

| 列 | 类型 | 描述 |
|----|------|------|
| `source_id` | VARCHAR | 数据源 ID |
| `exchange_id` | VARCHAR | 交易所 ID |
| `market_id` | VARCHAR | 市场标识符 |
| `outcome_side` | VARCHAR | `'YES'`、`'NO'` 或 `'UNKNOWN'` |
| `time_period_start` | TIMESTAMP | OHLC 周期开始时间 |
| `time_period_end` | TIMESTAMP | OHLC 周期结束时间 |
| `time_open` | TIMESTAMP | 开盘价时间 |
| `time_close` | TIMESTAMP | 收盘价时间 |
| `price_open` | NUMERIC | 开盘价（小数 0-1） |
| `price_high` | NUMERIC | 周期最高价 |
| `price_low` | NUMERIC | 周期最低价 |
| `price_close` | NUMERIC | 收盘/最新价（小数 0-1） |
| `volume_traded` | BIGINT | 总成交量（NOT NULL，默认 0） |
| `trades_count` | INTEGER | 交易笔数（NOT NULL，默认 0） |
| `reference_price` | NUMERIC(10,4) | 经灰尘过滤后最优买卖价的中间价 |
| `band_liquidity_qty_ask` | NUMERIC(12,2) | 执行带内总卖单数量 |
| `band_liquidity_qty_bid` | NUMERIC(12,2) | 执行带内总买单数量 |
| `band_vwap_ask` | NUMERIC(10,4) | 执行带内成交量加权平均卖价 |
| `band_vwap_bid` | NUMERIC(10,4) | 执行带内成交量加权平均买价 |
| `band_delta_used` | NUMERIC(6,4) | 使用的执行带宽度（默认 0.01 = 1%） |
| `created_at` | TIMESTAMP | 行创建时间 |
| `updated_at` | TIMESTAMP | 最后更新时间 |

**数据来源：**
- **市场同步（每 5 分钟）**：Kalshi OHLC 来自 `GET /markets/candlesticks`；Polymarket 价格和成交量来自 Gamma API。每个市场写入两侧（YES/NO）。
- **WebSocket ticker 事件**：`price_close` 通过 Kalshi `ticker` 消息和 Polymarket `price_change` 消息实时更新。
- **WebSocket orderbook 事件**：每次订单簿快照/增量更新后通过 `calculateBandMetrics()` 重新计算 Band 指标。

---

### 表：`order_books`

时间序列订单簿快照。写入量大 — 按时间分区（小时分区，保留 4 小时）。服务器定时任务删除超过 3-4 小时的数据行。

**唯一约束：** `(source_id, exchange_id, market_id, outcome_side, time_exchange)`
**冲突处理：** `DO NOTHING`

| 列 | 类型 | 描述 |
|----|------|------|
| `source_id` | VARCHAR | 数据源 ID |
| `exchange_id` | VARCHAR | 交易所 ID |
| `market_id` | VARCHAR | 市场标识符 |
| `outcome_side` | VARCHAR | `'YES'` 或 `'NO'` |
| `bids` | JSONB | `{price, quantity}` 对象数组 |
| `asks` | JSONB | `{price, quantity}` 对象数组 |
| `time_exchange` | TIMESTAMP | 交易所 WebSocket 消息的时间戳 |
| `time_coinapi` | TIMESTAMP | 接收时间戳（数据库写入时设为 `NOW()`） |
| `created_at` | TIMESTAMP | 行创建时间 |
| `updated_at` | TIMESTAMP | 最后更新时间 |

**JSONB 中的价格格式：**
- **Kalshi**：价格以美分（0-100）存储；仅在 Band 指标计算时标准化为小数
- **Polymarket**：价格以小数（0-1）存储

**数据来源：**
- **Kalshi**：`orderbook_snapshot` 和 `orderbook_delta` 消息由 `OrderBookManager` 累积，然后写入两行（YES + NO）。
- **Polymarket**：`book` 消息直接提供完整快照，每个资产/结果一行。

---

### 表：`trades`

单笔交易记录。按时间分区（日分区，保留 48 小时）。

**唯一约束：** `(source_id, exchange_id, trade_id, timestamp)`
**冲突处理：** `DO NOTHING`

| 列 | 类型 | 描述 |
|----|------|------|
| `source_id` | VARCHAR | 数据源 ID |
| `exchange_id` | VARCHAR | 交易所 ID |
| `market_id` | VARCHAR | 市场标识符 |
| `trade_id` | VARCHAR | 交易所交易 ID（未提供时为空字符串） |
| `price` | NUMERIC | 成交价格，小数 0-1 |
| `quantity` | NUMERIC | 成交量 |
| `side` | VARCHAR | `'Buy'` 或 `'Sell'` |
| `outcome` | VARCHAR | `'YES'` 或 `'NO'` |
| `timestamp` | TIMESTAMP | 交易执行时间戳 |
| `created_at` | TIMESTAMP | 数据库插入时间 |
| `updated_at` | TIMESTAMP | 最后更新时间 |

**数据来源：**
- **Kalshi**：`trade` WebSocket 消息。`taker_side='yes'` 映射为 `side='Buy'`，`'no'` 映射为 `side='Sell'`。新版 API 使用 `yes_price_dollars`（字符串，小数）和 `count_fp`（字符串，如 `"808.00"`）。处理器回退到旧版 `yes_price`（美分）和 `count`（数字）字段。
- **Polymarket**：`last_trade_price` WebSocket 消息。`transaction_hash` 作为 `trade_id`。

---

### 表：`quotes`

最优买卖价快照。**默认禁用写入**，通过 `ENABLE_QUOTE_WRITES=false` 设置，因为该表曾增长到 37GB。

**唯一约束：** `(source_id, exchange_id, market_id, entry_time)`
**冲突处理：** `DO NOTHING`

| 列 | 类型 | 描述 |
|----|------|------|
| `source_id` | VARCHAR | 数据源 ID |
| `exchange_id` | VARCHAR | 交易所 ID |
| `market_id` | VARCHAR | 市场标识符 |
| `outcome_side` | VARCHAR | `'YES'`、`'NO'` 或 `'UNKNOWN'` |
| `bid` | NUMERIC | 最优买价 |
| `bid_volume` | NUMERIC | 买单量 |
| `ask` | NUMERIC | 最优卖价 |
| `ask_volume` | NUMERIC | 卖单量 |
| `entry_time` | TIMESTAMP | 报价时间戳 |
| `recv_time` | TIMESTAMP | 接收时间戳 |
| `created_at` | TIMESTAMP | 行创建时间 |
| `updated_at` | TIMESTAMP | 最后更新时间 |

**数据来源：** Kalshi `ticker` WebSocket 消息（当 `ENABLE_QUOTE_WRITES=true` 时）。

---

### 表：`exchanges`

交易所注册元数据。通过种子脚本一次性填充。

**主键：** `exchange_id`
**冲突处理：** `DO UPDATE SET`

| 列 | 类型 | 描述 |
|----|------|------|
| `exchange_id` | VARCHAR | `'KALSHI'`、`'POLYMARKET'` 或 `'OPINION'` |
| `name` | VARCHAR | 可读名称 |
| `settlement_type` | VARCHAR | `'BINARY'` |
| `is_active` | BOOLEAN | 交易所是否活跃 |

**数据来源：** `scripts/seed-exchanges.sql`

---

### 表：`data_sources`

数据源注册元数据。通过种子脚本一次性填充。

**主键：** `source_id`
**冲突处理：** `DO UPDATE SET`

| 列 | 类型 | 描述 |
|----|------|------|
| `source_id` | VARCHAR | `'KALSHI_DIRECT'`、`'POLYMARKET_DIRECT'` 或 `'OPINION_DIRECT'` |
| `source_type` | VARCHAR | `'WEBSOCKET'` |
| `name` | VARCHAR | 可读名称 |
| `refresh_method` | VARCHAR | `'REALTIME'` |
| `refresh_interval_sec` | INTEGER | `0`（实时） |
| `is_active` | BOOLEAN | 数据源是否活跃 |

**数据来源：** `scripts/seed-exchanges.sql`

---

### 表：`market_mappings`

桥接表，将交易所特定市场 ID 映射到规范市场 ID，用于跨交易所套利。由 event-matcher 服务填充（每个匹配 4 行：YES+NO x 2 个交易所）。

**主键：** `(source_id, exchange_id, market_id, outcome_side)`

| 列 | 类型 | 描述 |
|----|------|------|
| `source_id` | VARCHAR(50) | 数据源标识符 |
| `exchange_id` | VARCHAR(50) | 交易所标识符 |
| `market_id` | VARCHAR(255) | 交易所特定市场 ID |
| `outcome_side` | VARCHAR(10) | 市场的 YES/NO 方向 |
| `canonical_market_id` | VARCHAR(255) | 统一市场标识符 |
| `confidence_score` | NUMERIC(5,4) | 匹配置信度（0-1） |
| `model_id` | VARCHAR(50) | 匹配方法（`algorithmic-v1`、`substring-v1`、`ai-verified-v1`） |
| `created_at` | TIMESTAMP | 行创建时间 |

---

### 表：`arb_opportunities`

检测到的跨交易所套利机会。由套利扫描服务写入（在 homepage-api 中每 10 秒运行）。

**唯一键：** `(canonical_market_id, arb_type, leg1_exchange_id, leg2_exchange_id)`
**冲突处理：** `DO UPDATE SET`（刷新利差、数量、利润、时间戳）

| 列 | 类型 | 描述 |
|----|------|------|
| `arb_id` | BIGINT | 自增主键 |
| `canonical_market_id` | VARCHAR(50) | 链接到 market_mappings |
| `canonical_event_id` | VARCHAR(50) | 用于 UI 中的事件分组 |
| `arb_type` | VARCHAR(20) | `'DIRECT'` 或 `'COMPLEMENT'` |
| `arb_subtype` | VARCHAR(20) | `'LIQUIDITY_GAP'`、`'TIME_DECAY'` 或 `'CROSS_PLATFORM'` |
| `leg1_exchange_id` | VARCHAR(50) | 买入方交易所 |
| `leg1_market_id` | VARCHAR(255) | 买入方市场 |
| `leg1_side` | VARCHAR(3) | `'YES'` 或 `'NO'` |
| `leg1_action` | VARCHAR(4) | `'BUY'` |
| `leg1_vwap` | NUMERIC | 使用的 VWAP 价格 |
| `leg1_liquidity_qty` | NUMERIC | 可用数量 |
| `leg2_exchange_id` | VARCHAR(50) | 卖出/第二买入方交易所 |
| `leg2_market_id` | VARCHAR(255) | 卖出/第二买入方市场 |
| `leg2_side` | VARCHAR(3) | `'YES'` 或 `'NO'` |
| `leg2_action` | VARCHAR(4) | `'SELL'` 或 `'BUY'` |
| `leg2_vwap` | NUMERIC | 使用的 VWAP 价格 |
| `leg2_liquidity_qty` | NUMERIC | 可用数量 |
| `gross_spread` | NUMERIC | 原始价差 |
| `gross_spread_pct` | NUMERIC | 价差百分比 |
| `prev_gross_spread_pct` | NUMERIC | 前次价差（用于趋势分析） |
| `executable_qty` | NUMERIC | 两腿流动性的最小值 |
| `gross_profit` | NUMERIC | 价差 x 可执行数量 |
| `status` | VARCHAR(20) | `'ACTIVE'` / `'EXPIRED'` |
| `detected_at` | TIMESTAMPTZ | 首次检测时间 |
| `updated_at` | TIMESTAMPTZ | 最后刷新时间 |
| `last_checked_at` | TIMESTAMPTZ | 最后扫描评估时间 |
| `expired_at` | TIMESTAMPTZ | 机会过期时间 |

---

### 表：`arb_config`

套利扫描器的运行时可配置参数。每约 5 分钟从数据库读取。

**主键：** `config_key`

| 键 | 生产环境值 | 描述 |
|----|-----------|------|
| `max_staleness_sec` | `900` | 排除某腿前订单簿数据的最大有效期（15 分钟） |
| `min_arb_pct` | `0.01` | 标记的最小毛利差百分比（1%） |
| `min_executable_qty` | `5` | 两腿最小合约数 |
| `min_liquidity_usd` | `2` | 最小毛利润（美元） |
| `min_confidence` | `0.95` | 最小 market_mappings 置信度 |
| `scan_interval_sec` | `10` | 扫描器循环间隔 |
| `expire_grace_sec` | `902` | 已评估套利的宽限期 |
| `expire_long_grace_sec` | `600` | 未评估套利（陈旧腿）的宽限期 |
| `kalshi_fee_rate` | `0.07` | Kalshi 费率（基于利润） |
| `polymarket_fee_rate` | `0.02` | Polymarket taker 费率 |
| `default_fee_rate` | `0.01` | 未知交易所的默认费率 |

---

### 表关系与冲突处理总结

| 表 | 唯一键 | 冲突处理 |
|----|-------|---------|
| `prediction_markets` | `(source_id, exchange_id, market_id, outcome_side)` | 全量 upsert |
| `market_latest_data` | `(source_id, exchange_id, market_id, outcome_side)` | 合并（条件更新） |
| `order_books` | `(source_id, exchange_id, market_id, outcome_side, time_exchange)` | 跳过重复 |
| `trades` | `(source_id, exchange_id, trade_id, timestamp)` | 跳过重复 |
| `quotes` | `(source_id, exchange_id, market_id, entry_time)` | 跳过重复 |
| `exchanges` | `exchange_id` | 全量 upsert |
| `data_sources` | `source_id` | 全量 upsert |
| `market_mappings` | `(source_id, exchange_id, market_id, outcome_side)` | 全量 upsert |
| `arb_opportunities` | `(canonical_market_id, arb_type, leg1_exchange_id, leg2_exchange_id)` | 更新利差/数量/利润 |
| `arb_config` | `config_key` | 全量 upsert |

所有表共享 `(source_id, exchange_id, ...)` 的组合键模式以支持多源数据采集。`market_id` + `outcome_side` 的组合在整个系统中唯一标识一个市场头寸。

---

## 核心组件

### 1. 批量写入器
通用数据库批量写入工具：
- 累积项目直到达到 `BATCH_SIZE`（默认：100）
- 超过 `BATCH_INTERVAL_MS`（默认：100ms）后自动刷新
- 指数退避重试（5 次尝试）
- 处理瞬态错误（死锁、超时）

### 2. WebSocket 客户端

| 特性 | Kalshi | Polymarket | Predict.fun | Opinion.trade |
|------|--------|------------|-------------|---------------|
| 认证 | API Key + RSA-PSS | 无 | API Key（可选） | 无 |
| 频道 | ticker, orderbook, trade | book, price_change, trade | orderbook, trade | market.depth, market.trade |
| 重连 | 指数退避 | 指数退避 | 指数退避 | 指数退避 |
| 连接池 | 池化（约 2000/socket） | 池化（500 assets/socket） | 池化（约 500/socket） | 池化（约 200/socket） |
| 订单簿处理 | 增量累积 | 增量累积（快照 + price_change 增量） | 增量累积 | 增量累积 |
| 交易格式 | `count_fp`（字符串），`yes_price_dollars`（字符串） | `size`（字符串），`price`（字符串） | 每条 WS 消息 | `quantity`（字符串），`price`（字符串） |
| 特殊功能 | — | — | 通过 API 链接进行跨交易所映射 | — |

### 3. 结果方向缓存
内存缓存，映射 `asset_id → outcome_side`，用于 Polymarket：
- 在市场同步时从 Gamma API 填充
- 处理器插入数据时使用
- **缓存未命中行为**：如果无法解析 outcome_side，记录将被跳过（不写入）

**交易所特定处理：**
- **Kalshi**：每次订单簿更新发出两条记录（一条 YES，一条 NO），因为每个市场代表两个方向
- **Polymarket**：每个 token/资产代表单个结果；缓存未命中导致记录被跳过

**数据库唯一约束包含 outcome_side：**
- `market_latest_data`：`(source_id, exchange_id, market_id, outcome_side)`
- `order_books`：`(source_id, exchange_id, market_id, outcome_side, time_exchange)`

### 4. 订单簿管理器
四个交易所都使用增量累积 — 在内存中维护订单簿状态并应用增量更新。

| 交易所 | 路径 | 键格式 | 价格格式 |
|--------|------|--------|---------|
| Kalshi | `packages/kalshi-listener/src/state/orderBookManager.ts` | `marketId` | 美分（0-100） |
| Polymarket | `packages/polymarket-listener/src/state/orderBookManager.ts` | `assetId` | 小数（0-1） |
| Predict | `packages/predict-listener/src/state/orderBookManager.ts` | `marketId` | 小数（0-1） |
| Opinion | `packages/opinion-listener/src/state/orderBookManager.ts` | `${marketId}:${outcomeSide}` | 小数（0-1） |

**操作：** `applySnapshot()`（替换整本订单簿）、`applyDelta()`（更新单个价格档位）、`getOrderBook()`（返回累积状态用于数据库写入）
**清理：** 定期移除陈旧市场（可配置最大存活时间）

### 5. 事件匹配器
跨交易所事件和市场匹配服务（`packages/event-matcher/`）。每 5 分钟运行一次匹配管道：

```
Phase 1: 事件级匹配（Kalshi↔Polymarket，通过 OpenAI）
    └─► 为新匹配的事件对进行内联市场匹配（四级）
Phase 2: 跨事件市场匹配（通过 ENABLE_PHASE2=false 禁用）
```

**Phase 1 — 事件匹配：**
1. 从两个交易所获取开放事件，跳过已匹配或最近检查过的
2. 并发工作线程（默认 20 个）选取未匹配的 Kalshi 事件
3. 通过关键词重叠 + 实体匹配预过滤 Polymarket 候选项
4. 发送到 OpenAI 进行语义比较（置信度 >= 0.85）
5. 匹配成功：写入 `event_mappings`，立即运行市场匹配

**事件内市场匹配（四级）：**
1. 二元（1:1） — 如果每侧恰好 1 个市场则自动匹配
2. 子字符串 — 从 Kalshi 标题中提取 " — " 后的实体，与 Polymarket 匹配
3. Jaccard >= 0.85 — 自动接受
4. Jaccard 0.3-0.85 — AI 验证

**Phase 2 — 跨事件（已禁用）：**
选取未匹配的 Kalshi 市场，按实体名称搜索 Polymarket，AI 验证候选项。

**关键文件：**
- `services/matchingCycle.ts` — 协调所有阶段
- `services/aiComparer.ts` — OpenAI 调用与速率限制
- `services/preFilter.ts` — 关键词提取、同义词标准化、重音符号剥离
- `services/marketMatcher.ts` — 四级市场匹配
- `services/crossEventMatcher.ts` — Phase 2 跨事件匹配

### 6. 套利扫描器
套利机会检测服务，在 `homepage-api` 中以 10 秒循环运行。

```
┌────────────────────────────────────────────────────────────┐
│                      ARB SCANNER CYCLE                      │
├────────────────────────────────────────────────────────────┤
│  1. Fetch matched market legs (market_mappings + band      │
│     metrics from market_latest_data)                        │
│  2. Filter by staleness (max_staleness_sec = 900)          │
│  3. For each canonical market, compute spread between      │
│     exchanges using VWAP prices within execution band       │
│  4. Apply filters: min_arb_pct, min_executable_qty,        │
│     min_liquidity_usd                                       │
│  5. Upsert to arb_opportunities table                      │
│  6. Expire stale arbs (grace periods)                      │
│  7. Reload config from arb_config table every 30 cycles    │
└────────────────────────────────────────────────────────────┘
```

**工作原理：**
- 将 `market_mappings` 与 `market_latest_data` 关联以获取两个交易所的 Band 指标
- 计算毛利差：`leg1_vwap_ask - leg2_vwap_bid`（及反向）
- DIRECT 套利：在一个交易所买入 YES，在另一个交易所卖出 YES
- COMPLEMENT 套利：在一个交易所买入 YES，在另一个交易所买入 NO（合计成本 < 1.0）
- 仅考虑订单簿数据新鲜的腿（`updated_at` 在 `max_staleness_sec` 以内）

**过期逻辑：** 两个宽限期防止振荡：
- `expire_grace_sec`（902 秒）：用于本轮已评估的套利
- `expire_long_grace_sec`（600 秒）：用于腿数据陈旧的套利

**关键文件：**
- `packages/homepage-api/src/services/arbScanner.ts`
- `packages/shared/src/db/queries.ts`（`fetchMatchedMarketLegs`、`upsertArbOpportunities`、`expireEvaluatedArbs`）

### 7. Predict 跨交易所映射
predict-listener 利用 Predict.fun API 提供的 Kalshi 和 Polymarket 链接自动创建 `market_mappings` 条目。

- 每个 Predict 市场包含 `kalshiMarketTicker` 和 `polymarketConditionIds`
- 创建成对映射：Predict↔Kalshi 和 Predict↔Polymarket
- 使用 `findExistingCanonicalMarketId()` 进行传递性分组（复用现有规范 ID）
- `model_id = 'predict-api-link-v1'`，`confidence_score = 1.0`
- 基于哈希的规范 ID（`CM-<hash>`），与 event-matcher 格式一致

**关键文件：** `packages/predict-listener/src/services/crossMapping.ts`

---

## 配置

### 环境变量

```bash
# 数据库
DATABASE_URL=postgresql://user:pass@host:5432/db
DB_SCHEMA=direct_exchanges_data
DB_MAX_CONNECTIONS=5

# Kalshi
KALSHI_API_KEY=<key>
KALSHI_WS_URL=wss://api.elections.kalshi.com/trade-api/ws/v2
KALSHI_REST_URL=https://api.elections.kalshi.com/trade-api/v2

# Polymarket
POLYMARKET_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
POLYMARKET_GAMMA_URL=https://gamma-api.polymarket.com
MARKETS_PER_SOCKET=500

# Predict
PREDICT_REST_URL=https://api.predict.fun
PREDICT_WS_URL=wss://ws.predict.fun/ws
PREDICT_API_KEY=<key>  # 可选
PREDICT_MARKETS_PER_SOCKET=500
ENABLE_CROSS_MAPPING=true

# 批量写入
BATCH_SIZE=100
BATCH_INTERVAL_MS=100

# 通用
LOG_LEVEL=info
MARKET_REFRESH_INTERVAL_MS=300000
```

---

## 部署

### Docker Compose

```bash
# 启动所有服务
docker compose up -d polymarket-listener

# 查看日志
docker compose logs -f polymarket-listener

# 部署到服务器
./deploy.sh
```

### 服务器详情
- **主机**：8.216.43.26（日本）
- **路径**：/opt/prediction-market-ingestion
- **数据库**：阿里云 RDS PostgreSQL

---

## 错误处理与弹性

### 重试机制
1. **数据库写入**：5 次重试，指数退避
2. **WebSocket 重连**：自动重连，带退避
3. **API 调用**：带抖动的重试

### 优雅关闭
- 监听 SIGTERM/SIGINT 信号
- 刷新所有待处理的批量写入器
- 关闭 WebSocket 连接
- 关闭数据库连接池

---

## 数据保留

### 分区管理
服务器端定时任务（`/opt/manage-partitions.sh`）每 5 分钟创建和删除分区：
- **order_books**：小时分区，保留 4 小时
- **trades**：日分区，保留 48 小时

### 已关闭市场清理
每个监听器定期运行清理，在可配置的保留期（默认 24 小时）后删除已关闭的市场和事件。

---

## 数据源与交易所 ID

| 交易所 | 数据源 ID | 交易所 ID |
|--------|-----------|-----------|
| Kalshi | `KALSHI_DIRECT` | `KALSHI` |
| Polymarket | `POLYMARKET_DIRECT` | `POLYMARKET` |
| Predict.fun | `PREDICT_DIRECT` | `PREDICT` |
| Opinion.trade | `OPINION_DIRECT` | `OPINION` |

---

## 性能

- **批量大小**：每次写入 100 项
- **刷新间隔**：最大延迟 100ms
- **连接池**：每个监听器 5 个连接
- **Polymarket 限制**：每个 WebSocket 500 个资产

---

## 开发

```bash
# 安装依赖
pnpm install

# 构建所有包
pnpm build

# 以开发模式运行
pnpm dev:polymarket
pnpm dev:kalshi

# 类型检查
pnpm typecheck
```
