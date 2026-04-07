# 配置指南

预测市场数据采集系统的运行时可配置参数。这些参数通过数据库表管理，无需重新部署即可生效。

---

## 套利扫描器配置

**数据表：** `direct_exchanges_data.arb_config`

**表结构：**

| 列名 | 类型 | 说明 |
|------|------|------|
| `config_key` | VARCHAR(100) | 主键 — 参数名称 |
| `config_value` | VARCHAR(255) | 参数值（以字符串形式存储，运行时解析） |
| `description` | TEXT | 人类可读的描述 |
| `updated_at` | TIMESTAMPTZ | 最后修改时间戳 |

**重载行为：** 套利扫描器每 30 个扫描周期（约 5 分钟）读取一次该表。更改无需重启服务即可生效。

---

### 参数说明

#### 数据质量过滤器

| 键名 | 类型 | 当前值 | 说明 |
|------|------|--------|------|
| `max_staleness_sec` | 整数（秒） | `900` | 订单簿数据的最大允许过期时间，超过此时间的市场端将被排除在套利检测之外。只有订单簿更新（而非仅价格更新）才会刷新时间戳。交易不活跃的市场可能 10-30 分钟才有一次订单簿更新。**降低此值会显著减少符合条件的市场对数量。** |
| `min_confidence` | 小数（0-1） | `0.95` | 市场匹配算法的最低置信度分数。低于此分数的匹配市场将被排除。匹配管道产生的分数范围为 0.85-1.0；大多数生产环境匹配在 0.95 以上。 |

#### 机会阈值

| 键名 | 类型 | 当前值 | 说明 |
|------|------|--------|------|
| `min_arb_pct` | 小数（0-1） | `0.01` | 被认定为套利机会的最低毛利差百分比。`0.01` 表示 1%。跨交易所的实际价差通常为 1-3%。设置过低会产生噪音；设置过高会遗漏真实机会。 |
| `min_executable_qty` | 整数（合约数） | `5` | 两端可执行的最少合约数量。取两端可用流动性的较小值。过滤掉扣除手续费后利润过小的套利机会。 |
| `min_liquidity_usd` | 小数（美元） | `2` | 最低毛利润（美元）（价差 × 可执行数量）。过滤掉绝对美元利润过小、不值得执行的机会。 |

#### 扫描器定时

| 键名 | 类型 | 当前值 | 说明 |
|------|------|--------|------|
| `scan_interval_sec` | 整数（秒） | `10` | 扫描器运行检测周期的频率。每个周期查询所有已匹配市场、计算价差、更新机会并使过期机会失效。**降低此值会增加数据库负载。** |

#### 过期逻辑

扫描器使用两个宽限期来管理活跃套利何时被标记为过期：

| 键名 | 类型 | 当前值 | 说明 |
|------|------|--------|------|
| `expire_grace_sec` | 整数（秒） | `902` | 适用于底层市场**在当前扫描周期中已被评估**（两端数据均为最新）的套利宽限期。如果某个套利的最后更新时间超过此秒数，但其市场仍在扫描范围内，则将其标记为过期。**必须 >= `max_staleness_sec`**，以避免套利在每个扫描周期中在 ACTIVE 和 EXPIRED 之间反复振荡。 |
| `expire_long_grace_sec` | 整数（秒） | `600` | 适用于底层市场**在当前周期中无法被评估**（一端或两端数据已过期）的套利宽限期。当问题仅是数据暂时过期而非机会真正消失时，保持套利活跃更长时间。 |

#### 手续费率

手续费率为未来净利润计算（v2）而存储。目前**未在**套利检测或过滤中使用。

| 键名 | 类型 | 当前值 | 说明 |
|------|------|--------|------|
| `kalshi_fee_rate` | 小数（0-1） | `0.07` | Kalshi 按**利润**收取手续费（非交易金额）。每份合约利润的 7%。 |
| `polymarket_fee_rate` | 小数（0-1） | `0.02` | Polymarket 按交易金额收取吃单手续费。交易金额的 2%。 |
| `default_fee_rate` | 小数（0-1） | `0.01` | 未明确配置的交易所的默认手续费率。 |

---

### 如何修改

#### 通过 SQL（直接修改）

```sql
-- 更新单个参数
UPDATE direct_exchanges_data.arb_config
SET config_value = '0.02', updated_at = NOW()
WHERE config_key = 'min_arb_pct';

-- 查看所有当前值
SELECT config_key, config_value, description, updated_at
FROM direct_exchanges_data.arb_config
ORDER BY config_key;
```

#### 通过 Appsmith 管理面板

连接到 `arb_config` 表，使用简单的 CRUD 界面：
- **数据源：** PostgreSQL（使用相同的 RDS 连接）
- **Schema：** `direct_exchanges_data`
- **数据表：** `arb_config`
- **主键：** `config_key`
- **可编辑列：** `config_value`
- **只读列：** `config_key`、`description`、`updated_at`

建议的 UI：使用表格组件，支持对 `config_value` 进行行内编辑，外加一个"保存"按钮，执行 UPDATE 查询并设置 `updated_at = NOW()`。

---

### 参数依赖关系

```
max_staleness_sec ──► expire_grace_sec（必须 >=）
                  ──► expire_long_grace_sec（应保持成比例）

min_arb_pct ────────► 直接影响活跃套利数量
min_executable_qty ─► 在价差计算后过滤
min_liquidity_usd ──► 在数量计算后过滤
```

**关键约束：** `expire_grace_sec` 必须 >= `max_staleness_sec`。如果宽限期短于过期时间，套利将在每个扫描周期中在 ACTIVE 和 EXPIRED 之间反复振荡。

---

### 调优影响

| 变更 | 效果 | 风险 |
|------|------|------|
| 降低 `max_staleness_sec` | 符合条件的市场更少（两端都必须是最新的） | 可能导致活跃套利降至接近零 |
| 提高 `max_staleness_sec` | 更多市场符合条件，但价格可能已过时 | 实际市场中已不存在的过期套利 |
| 降低 `min_arb_pct` | 检测到更多套利，包括更小的价差 | 更多噪音，扣除手续费后可能无利可图 |
| 提高 `min_arb_pct` | 只标记大价差 | 可能遗漏真实机会 |
| 降低 `min_executable_qty` | 包含更小的套利 | 更大比例的套利因规模太小无法盈利执行 |
| 降低 `min_liquidity_usd` | 包含更低利润的套利 | 风险与上述类似 |

---

## 环境变量配置

这些参数需要重新部署才能生效（在 `docker-compose.yml` 或 `.env` 中设置）。

### 监听器服务

| 变量名 | 服务 | 默认值 | 说明 |
|--------|------|--------|------|
| `MARKETS_PER_SOCKET` | polymarket-listener | `500` | 每个 WebSocket 连接的最大资产数 |
| `KALSHI_MARKETS_PER_SOCKET` | kalshi-listener | `2000` | 每个 WebSocket 连接的最大订阅数 |
| `OPINION_MARKETS_PER_SOCKET` | opinion-listener | `200` | 每个 WebSocket 连接的最大市场数 |
| `PREDICT_MARKETS_PER_SOCKET` | predict-listener | `500` | 每个 WebSocket 连接的最大市场数 |
| `PREDICT_REST_URL` | predict-listener | `https://api.predict.fun` | Predict.fun REST API 地址 |
| `PREDICT_WS_URL` | predict-listener | `wss://ws.predict.fun/ws` | Predict.fun WebSocket 地址 |
| `PREDICT_API_KEY` | predict-listener | （可选） | Predict.fun API 密钥 |
| `ENABLE_CROSS_MAPPING` | predict-listener | `true` | 启用从 Predict API 链接进行跨交易所市场映射 |
| `ENABLE_QUOTE_WRITES` | 所有监听器 | `false` | 启用向 quotes 表写入数据（已禁用以节省存储空间） |

### 事件匹配器

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `OPENAI_API_KEY` | （必需） | OpenAI API 密钥，用于语义匹配 |
| `OPENAI_MODEL` | `gpt-5-nano` | 用于事件/市场比较的模型 |
| `MATCHER_CONCURRENCY` | `20` | 并发 AI 工作线程数 |
| `MATCHER_INTERVAL_MS` | `300000` | 周期间隔（5 分钟） |
| `MATCHER_CONFIDENCE_THRESHOLD` | `0.85` | 接受匹配的最低置信度 |
| `MATCHER_RECHECK_INTERVAL_MS` | `86400000` | 24 小时后重新检查未匹配事件 |
| `MARKET_MATCH_THRESHOLD` | `0.85` | Jaccard 自动接受阈值 |
| `MARKET_MATCH_AI_THRESHOLD` | `0.3` | 触发 AI 验证的最低 Jaccard 值 |
| `ENABLE_PHASE2` | `true`（生产环境：`false`） | 启用第二阶段跨事件市场匹配 |
| `MATCHER_PHASE2_CONCURRENCY` | `100` | 第二阶段的并发工作线程数 |
| `MATCHER_CANDIDATES_PER_BATCH` | `10` | 每次 AI 事件比较的最大候选数 |
| `MATCHER_MIN_EVENT_VOLUME` | `0` | 纳入事件匹配考虑的最低总交易量 |

### 健康检查

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `TELEGRAM_BOT_TOKEN` | （必需） | 用于告警的 Telegram 机器人令牌 |
| `TELEGRAM_CHAT_ID` | （必需） | 接收告警消息的聊天 ID |
| `HEALTHCHECK_INTERVAL_MS` | `60000` | 检查间隔（1 分钟） |
| `DISK_WARNING_THRESHOLD` | `70` | 磁盘使用率警告阈值（百分比） |
| `DISK_CRITICAL_THRESHOLD` | `85` | 磁盘使用率严重告警阈值（百分比） |
| `ALERT_COOLDOWN_MS` | `300000` | 重复告警之间的冷却时间（5 分钟） |
