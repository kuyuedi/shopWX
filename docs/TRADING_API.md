# 交易接口文档

Base URL: `http://localhost:3100`

所有接口均返回 JSON，错误时返回 `{ "error": "错误信息" }`。

---

## Kalshi 交易接口

### 查询账户余额

```
GET /api/v1/kalshi/balance
```

**响应示例：**
```json
{
  "balance": 24800
}
```

> `balance` 单位为美分（cents），除以 100 得到美元金额。例如 `24800` = $248.00

---

### 下单

```
POST /api/v1/kalshi/orders
Content-Type: application/json
```

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| ticker | string | ✅ | 市场 ticker，例如 `KXNBAGAME-26APR03UTAHOU-UTA` |
| side | string | ✅ | 方向：`yes` 或 `no` |
| action | string | ✅ | 操作：`buy`（买入）或 `sell`（卖出）|
| type | string | ✅ | 订单类型：`limit`（限价）或 `market`（市价）|
| count | integer | ✅ | 合约数量，最小为 1 |
| yes_price | integer | 限价单必填 | 限价，单位美分（1-99），例如 `14` = 14 美分 |
| expiration_ts | integer | ❌ | 订单过期时间（Unix 秒） |
| client_order_id | string | ❌ | 客户端幂等 ID，防止重复下单 |

**请求示例：**
```json
{
  "ticker": "KXNBAGAME-26APR03UTAHOU-UTA",
  "side": "yes",
  "action": "buy",
  "type": "limit",
  "count": 1,
  "yes_price": 14
}
```

**响应示例：**
```json
{
  "order_id": "74ec04c7-5976-4dea-afe6-131af385d124",
  "ticker": "KXNBAGAME-26APR03UTAHOU-UTA",
  "side": "yes",
  "action": "buy",
  "type": "limit",
  "status": "executed",
  "yes_price": 14,
  "count": 1,
  "filled_count": 1,
  "remaining_count": 0,
  "created_time": "2026-04-02T10:40:35Z"
}
```

> `status` 说明：
> - `resting`：挂单中，等待成交
> - `executed`：已完全成交
> - `canceled`：已取消
> - `pending`：处理中

---

### 查询单个订单

```
GET /api/v1/kalshi/orders/:orderId
```

**路径参数：**
- `orderId`：订单 ID

**响应示例：**
```json
{
  "order_id": "74ec04c7-5976-4dea-afe6-131af385d124",
  "ticker": "KXNBAGAME-26APR03UTAHOU-UTA",
  "side": "yes",
  "status": "executed",
  "yes_price": 14,
  "count": 1,
  "filled_count": 1,
  "avg_fill_price": 14,
  "created_time": "2026-04-02T10:40:35Z"
}
```

---

### 查询订单列表

```
GET /api/v1/kalshi/orders?status=resting
```

**查询参数：**

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| status | string | `resting` | 订单状态：`resting`（挂单）/ `executed`（已成交）/ `canceled`（已取消）|

**响应示例：**
```json
{
  "orders": [
    {
      "order_id": "1b3334e3-...",
      "ticker": "KXNBAGAME-26APR03UTAHOU-UTA",
      "side": "yes",
      "status": "resting",
      "yes_price": 12,
      "count": 1,
      "remaining_count": 1
    }
  ]
}
```

---

### 查询持仓列表

```
GET /api/v1/kalshi/positions?settlement_status=all
```

**查询参数：**

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| settlement_status | string | `all` | 结算状态：`all`（全部）/ `settled`（已结算）/ `unsettled`（未结算）|

**响应示例：**
```json
{
  "positions": [
    {
      "ticker": "KXNBAGAME-26APR03UTAHOU-UTA",
      "position_fp": "1.00",
      "market_exposure_dollars": "0.130000",
      "realized_pnl_dollars": "0.000000",
      "fees_paid_dollars": "0.010000",
      "total_traded_dollars": "0.130000"
    }
  ]
}
```

---

## Polymarket 交易接口

> **注意：** Polymarket 价格单位为 0-1 的小数（如 `0.65` = 65 美分），与 Kalshi 的整数美分不同。

---

### 查询账户余额

```
GET /api/v1/polymarket/balance
```

**响应示例：**
```json
{
  "balance": "2000000",
  "allowances": {
    "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E": "115792...",
    "0xC5d563A36AE78145C45a50134d48A1215220f80a": "115792...",
    "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296": "115792..."
  }
}
```

> `balance` 单位为 USDC 的最小单位（6位小数），除以 1,000,000 得到 USDC 金额。例如 `2000000` = 2 USDC

---

### 下单

```
POST /api/v1/polymarket/orders
Content-Type: application/json
```

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| token_id | string | ✅ | 市场的 token ID（YES token 或 NO token），从市场数据接口获取 |
| side | string | ✅ | 方向：`BUY`（买入）或 `SELL`（卖出）|
| price | number | ✅ | 价格，0-1 之间的小数，例如 `0.65` = 65 美分 |
| size | number | ✅ | 数量（份数），最小约 $1 等值 |
| order_type | string | ❌ | 订单类型：`GTC`（默认，挂单直到成交）或 `FOK`（立即全部成交或取消）|

**请求示例（买入日本赢世界杯 YES）：**
```json
{
  "token_id": "19159976531313550247579355752030367100657092033093647047491459813592996250034",
  "side": "BUY",
  "price": 0.026,
  "size": 10
}
```

**响应示例：**
```json
{
  "errorMsg": "",
  "orderID": "0xcbd7801f15b094bd38b0bc3015ed2d97cd18721189ac57520ebe430ae30634c0",
  "takingAmount": "10",
  "makingAmount": "0.26",
  "status": "matched",
  "transactionsHashes": ["0x48b5b4e7dc8861e32aba15ff9d4b2e3bd209ca3cb8f0332c722a71afd07b6b4d"],
  "success": true
}
```

> `status` 说明：
> - `matched`：已成交
> - `live`：挂单中

---

### 查询挂单列表

```
GET /api/v1/polymarket/orders?market=<condition_id>
```

**查询参数：**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| market | string | ❌ | 按市场 condition_id 过滤，不传则返回所有挂单 |

**响应示例：**
```json
{
  "orders": [
    {
      "id": "0x432633f5...",
      "market": "0x0189df05...",
      "asset_id": "19159976...",
      "side": "SELL",
      "size": "10",
      "price": "0.026",
      "status": "live"
    }
  ]
}
```

---

### 查询单个订单

```
GET /api/v1/polymarket/orders/:orderId
```

**路径参数：**
- `orderId`：订单 ID（0x 开头的哈希）

---

### 取消订单

```
DELETE /api/v1/polymarket/orders/:orderId
```

**路径参数：**
- `orderId`：要取消的订单 ID

**响应示例：**
```json
{
  "canceled": ["0x432633f5..."],
  "not_canceled": {}
}
```

---

### 查询成交记录

```
GET /api/v1/polymarket/trades?market=<condition_id>
```

**查询参数：**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| market | string | ❌ | 按市场 condition_id 过滤 |

**响应示例：**
```json
{
  "trades": [
    {
      "id": "d10961a4-638c-4138-aaa7-8e46fa76ae83",
      "market": "0x0189df05...",
      "asset_id": "19159976...",
      "side": "BUY",
      "size": "10",
      "price": "0.026",
      "status": "CONFIRMED",
      "outcome": "Yes",
      "transaction_hash": "0x48b5b4e7...",
      "match_time": "1775392325",
      "trader_side": "TAKER"
    }
  ]
}
```

---

## 错误码说明

| HTTP 状态码 | 说明 |
|---|---|
| 200 / 201 | 成功 |
| 400 | 请求参数错误（如价格超出范围、余额不足）|
| 401 | 认证失败（API Key 无效）|
| 403 | 权限不足 |
| 404 | 订单不存在 |
| 429 | 请求频率超限 |
| 500 / 502 | 服务器错误 |

---

## 获取市场 Token ID

Polymarket 下单需要 `token_id`，可通过以下方式获取：

```
GET https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=10
```

响应中每个市场的 `tokens` 数组包含 YES 和 NO 两个 token，取对应的 `token_id`。

Kalshi 下单使用 `ticker`，可通过以下方式获取：

```
GET https://api.elections.kalshi.com/trade-api/v2/markets?status=open&limit=10
```


---

## Kalshi × Polymarket 套利接口

### 扫描套利机会

```
GET /api/v1/arb/kalshi-polymarket
```

扫描 Kalshi 和 Polymarket 两平台共有市场，识别价差套利机会。

**查询参数：**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| min_spread_pct | number | ❌ | 最小价差百分比过滤（如 `0.05` 表示 5%）|
| arb_type | string | ❌ | 套利类型过滤：`DIRECT`（同侧价差）或 `COMPLEMENT`（互补价差）|

**响应示例：**
```json
{
  "opportunities": [
    {
      "arbId": "b114a929-c9f8-4e4a-943a-173c814b179d",
      "canonicalMarketId": "CM-52a77c687fbd83ef",
      "marketTitle": "Will Kim Kardashian pass the Bar Exam before 2027?",
      "arbType": "COMPLEMENT",
      "leg1": {
        "platform": "POLYMARKET",
        "marketId": "675435",
        "marketTitle": "Will Kim Kardashian pass the bar exam by May 3?",
        "expiresAt": "2026-05-03T00:00:00.000Z",
        "side": "YES",
        "action": "BUY",
        "normalizedPrice": 0.10,
        "qty": 93
      },
      "leg2": {
        "platform": "KALSHI",
        "marketId": "KXKIMKBAREXAM-27",
        "marketTitle": "Will Kim Kardashian pass the Bar Exam before 2027?",
        "expiresAt": "2027-01-01T00:00:00.000Z",
        "side": "NO",
        "action": "BUY",
        "normalizedPrice": 0.64,
        "qty": 93
      },
      "grossSpread": 0.26,
      "grossSpreadPct": 0.3514,
      "executableQty": 93,
      "grossProfit": 24.25,
      "daysToExpiry": 26,
      "apy": 4.98,
      "leg1DataAt": "2026-04-07T05:30:00.000Z",
      "leg2DataAt": "2026-04-07T05:28:00.000Z",
      "scannedAt": "2026-04-07T05:31:00.000Z",
      "expiresAt": "2026-04-07T05:32:00.000Z"
    }
  ],
  "scanned_at": "2026-04-07T05:31:00.000Z",
  "opportunity_ttl_sec": 60,
  "count": 1
}
```

**套利类型说明：**

| 类型 | 逻辑 | 说明 |
|---|---|---|
| DIRECT | 同侧价差 | 一个平台买入、另一个平台卖出同一方向（YES 或 NO），赚取价差 |
| COMPLEMENT | 互补价差 | 一个平台买 YES、另一个平台买 NO，总成本 < $1，到期必然获利 |

**ArbLeg 字段说明：**

| 字段 | 类型 | 说明 |
|---|---|---|
| platform | string | 平台：`KALSHI` 或 `POLYMARKET` |
| marketId | string | 市场标识符（Kalshi: ticker，Polymarket: token_id）|
| marketTitle | string | 该平台的市场标题 |
| expiresAt | string | 该平台市场的到期时间（ISO 8601）|
| side | string | 方向：`YES` 或 `NO` |
| action | string | 操作：`BUY` 或 `SELL` |
| normalizedPrice | number | 归一化价格（0-1 小数）|
| qty | number | 可执行数量 |

> **注意：** 套利机会有 TTL（默认 60 秒），过期后执行接口会返回 410。

---

### 执行套利下单

```
POST /api/v1/arb/kalshi-polymarket/:arbId/execute
Content-Type: application/json
```

对指定套利机会执行双腿下单（同时向 Kalshi 和 Polymarket 下单）。

**路径参数：**
- `arbId`：套利机会 UUID（从扫描接口获取）

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| qty | number | ❌ | 执行数量，不填则使用 executableQty |

**请求示例：**
```json
{
  "qty": 50
}
```

**响应示例（双腿成功）：**
```json
{
  "arb_id": "b114a929-c9f8-4e4a-943a-173c814b179d",
  "kalshi_order_id": "74ec04c7-5976-4dea-afe6-131af385d124",
  "polymarket_order_id": "0xcbd7801f15b094bd38b0bc3015ed2d97cd18721189ac57520ebe430ae30634c0",
  "executed_qty": 50,
  "kalshi_success": true,
  "polymarket_success": true,
  "kalshi_error": null,
  "polymarket_error": null
}
```

**响应示例（部分失败）：**
```json
{
  "arb_id": "b114a929-...",
  "kalshi_order_id": "74ec04c7-...",
  "polymarket_order_id": null,
  "executed_qty": 50,
  "kalshi_success": true,
  "polymarket_success": false,
  "kalshi_error": null,
  "polymarket_error": "Insufficient balance"
}
```

**特殊状态码：**

| HTTP 状态码 | 说明 |
|---|---|
| 200 | 下单完成（可能部分失败，检查 `kalshi_success` 和 `polymarket_success`）|
| 400 | 执行数量超过可执行上限 |
| 402 | 余额不足（返回具体平台和金额信息）|
| 404 | 套利机会不存在，需重新扫描 |
| 410 | 套利机会已过期，需重新扫描 |
| 422 | 价格数据已过期（超过 60 秒），需重新扫描 |

> **重要：** 双腿下单是并发执行的，可能出现一腿成功一腿失败的情况。HTTP 200 不代表双腿都成功，需检查 `kalshi_success` 和 `polymarket_success` 字段。
