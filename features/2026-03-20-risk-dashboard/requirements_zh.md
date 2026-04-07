# 功能：风控与匹配管理仪表板（Appsmith）

**状态**: 新建
**优先级**: 高
**创建日期**: 2026-03-20
**负责团队**: 中国开发团队
**平台**: Appsmith（已有实例，已连接 PostgreSQL）

---

## 概述

为风控团队构建内部管理仪表板，用于监控匹配质量、修复错误匹配、手动创建缺失匹配。基于现有 Appsmith 实例，使用与 `arb_config` 面板相同的 PostgreSQL 数据源。

---

## 问题

1. **约 124 个错误匹配** —— 市场在交易所之间被错误配对，导致虚假套利信号和前端展示异常
2. **约 2,029 个缺失匹配** —— 本应配对但算法无法匹配的市场（缩写、同义词、名称变体）
3. **无可视化** —— 团队目前无法查看匹配质量或修复问题，只能运行原始 SQL
4. 当用户在网站上看到错误匹配时，无法快速找到并修复

---

## 解决方案

3 个选项卡的 Appsmith 仪表板：
- **选项卡 1**：可疑匹配 —— 自动检测的错误匹配，供审核（确认/取消匹配）
- **选项卡 2**：手动匹配 —— 配对算法遗漏的市场
- **选项卡 3**：匹配概览 —— 实时健康指标和统计数据

---

## 数据库迁移

部署仪表板前运行以下 SQL：

```sql
CREATE TABLE IF NOT EXISTS direct_exchanges_data.match_reviews (
  id BIGSERIAL PRIMARY KEY,
  canonical_market_id VARCHAR(100) NOT NULL,
  action VARCHAR(20) NOT NULL CHECK (action IN ('CONFIRMED', 'UNMATCHED', 'REJECTED')),
  reviewed_by VARCHAR(100),
  reviewed_at TIMESTAMPTZ DEFAULT NOW(),
  notes TEXT
);

CREATE INDEX idx_match_reviews_canonical ON direct_exchanges_data.match_reviews(canonical_market_id);
```

---

## 选项卡 1：可疑匹配审核

### 目的

根据两个交易所之间的实时价格偏差，自动检测可能错误的匹配对。如果两个市场确实相同，价格应接近。较大的差距（>20%）是错误匹配的强信号。

### 全局搜索栏

在选项卡顶部添加**搜索输入框**，按市场标题筛选结果。团队可以快速定位在网站上发现的错误匹配。

**使用示例**：用户在网站上看到 "Czestochowa vs Fiorentina" 价格异常 → 在搜索栏输入 "Fiorentina" → 找到可疑匹配 → 点击取消匹配。

搜索应使用 `ILIKE '%{{search}}%'` 过滤 `kalshi_title` 和 `poly_title` 两列。

### 数据源查询

```sql
WITH pairs AS (
  SELECT
    mm1.canonical_market_id,
    mm1.market_id AS kalshi_market_id,
    mm2.market_id AS poly_market_id,
    mm1.model_id,
    mm1.confidence_score,
    mm1.matched_at,
    pk.title AS kalshi_title,
    pp.title AS poly_title,
    pk.event_id AS kalshi_event_id,
    pp.event_id AS poly_event_id,
    k.reference_price AS kalshi_price,
    p.reference_price AS poly_price,
    abs(k.reference_price - p.reference_price) AS price_gap
  FROM direct_exchanges_data.market_mappings mm1
  JOIN direct_exchanges_data.market_mappings mm2
    ON mm1.canonical_market_id = mm2.canonical_market_id
    AND mm1.outcome_side = mm2.outcome_side
    AND mm1.exchange_id = 'KALSHI' AND mm2.exchange_id = 'POLYMARKET'
  LEFT JOIN direct_exchanges_data.market_latest_data k
    ON k.market_id = mm1.market_id AND k.exchange_id = 'KALSHI' AND k.outcome_side = mm1.outcome_side
  LEFT JOIN direct_exchanges_data.market_latest_data p
    ON p.market_id = mm2.market_id AND p.exchange_id = 'POLYMARKET' AND p.outcome_side = mm2.outcome_side
  LEFT JOIN direct_exchanges_data.prediction_markets pk
    ON pk.market_id = mm1.market_id AND pk.exchange_id = 'KALSHI'
  LEFT JOIN direct_exchanges_data.prediction_markets pp
    ON pp.market_id = mm2.market_id AND pp.exchange_id = 'POLYMARKET'
  WHERE mm1.outcome_side = 'YES'
    AND k.reference_price IS NOT NULL
    AND p.reference_price IS NOT NULL
    AND abs(k.reference_price - p.reference_price) > {{priceGapThreshold || 0.20}}
    AND mm1.canonical_market_id NOT IN (
      SELECT canonical_market_id FROM direct_exchanges_data.match_reviews
    )
    AND (
      '{{searchInput}}' = ''
      OR pk.title ILIKE '%{{searchInput}}%'
      OR pp.title ILIKE '%{{searchInput}}%'
    )
)
SELECT * FROM pairs
ORDER BY price_gap DESC;
```

### 界面布局

**搜索栏**在顶部：文本输入框，占位符 "按市场标题搜索..."

**表格组件**列：

| 列名 | 来源 | 格式 |
|------|------|------|
| Kalshi 标题 | `kalshi_title` | 文本，截断60字符，悬停显示完整 |
| Poly 标题 | `poly_title` | 文本，截断60字符，悬停显示完整 |
| Kalshi 价格 | `kalshi_price` | 百分比（x100），1位小数 |
| Poly 价格 | `poly_price` | 百分比（x100），1位小数 |
| 价格差距 | `price_gap` | 百分比（x100），1位小数，**>50% 标红** |
| 匹配模型 | `model_id` | 标签 |
| 匹配时间 | `matched_at` | 日期 |
| 操作 | — | 两个按钮（见下） |

### 操作按钮

1. **确认**（绿色按钮）—— 标记为已审核/有效（价格差异是真实的，非错误匹配）：
   ```sql
   INSERT INTO direct_exchanges_data.match_reviews
     (canonical_market_id, action, reviewed_by, reviewed_at)
   VALUES
     ({{currentRow.canonical_market_id}}, 'CONFIRMED', {{appsmith.user.email}}, NOW());
   ```

2. **取消匹配**（红色按钮）—— 删除错误映射并清理相关套利：
   ```sql
   -- 步骤 1：删除引用此市场的套利机会
   DELETE FROM direct_exchanges_data.arb_opportunities
   WHERE canonical_market_id = {{currentRow.canonical_market_id}};

   -- 步骤 2：删除市场映射（4行：两个交易所的 YES+NO）
   DELETE FROM direct_exchanges_data.market_mappings
   WHERE canonical_market_id = {{currentRow.canonical_market_id}};

   -- 步骤 3：记录审核操作
   INSERT INTO direct_exchanges_data.match_reviews
     (canonical_market_id, action, reviewed_by, reviewed_at)
   VALUES
     ({{currentRow.canonical_market_id}}, 'UNMATCHED', {{appsmith.user.email}}, NOW());
   ```
   **重要：** 执行前必须显示确认对话框。

### 筛选器

- **搜索**：文本输入 —— 按 Kalshi 和 Polymarket 标题筛选（ILIKE）
- **价格差距阈值**：滑块（默认 20%，范围 10%-80%）
- **匹配模型**：下拉筛选（substring-v1, algorithmic-v1, cross-event-ai-v1, gpt-5-nano, ai-verified-v1）
- **日期范围**：按 `matched_at` 筛选

### 统计栏（选项卡顶部）

```sql
SELECT
  count(DISTINCT mm1.canonical_market_id) AS total_suspicious,
  count(DISTINCT mm1.canonical_market_id) FILTER (
    WHERE abs(k.reference_price - p.reference_price) > 0.50
  ) AS critical_50pct,
  count(DISTINCT mm1.canonical_market_id) FILTER (
    WHERE mm1.model_id = 'cross-event-ai-v1'
  ) AS cross_event_matches
FROM direct_exchanges_data.market_mappings mm1
JOIN direct_exchanges_data.market_mappings mm2
  ON mm1.canonical_market_id = mm2.canonical_market_id
  AND mm1.outcome_side = mm2.outcome_side
  AND mm1.exchange_id = 'KALSHI' AND mm2.exchange_id = 'POLYMARKET'
LEFT JOIN direct_exchanges_data.market_latest_data k
  ON k.market_id = mm1.market_id AND k.exchange_id = 'KALSHI' AND k.outcome_side = mm1.outcome_side
LEFT JOIN direct_exchanges_data.market_latest_data p
  ON p.market_id = mm2.market_id AND p.exchange_id = 'POLYMARKET' AND p.outcome_side = mm2.outcome_side
WHERE mm1.outcome_side = 'YES'
  AND k.reference_price IS NOT NULL AND p.reference_price IS NOT NULL
  AND abs(k.reference_price - p.reference_price) > 0.20
  AND mm1.canonical_market_id NOT IN (
    SELECT canonical_market_id FROM direct_exchanges_data.match_reviews
  );
```

---

## 选项卡 2：手动匹配

### 目的

允许风控团队手动匹配算法无法配对的市场。范围：约 30-40 个事件，语义差距太大无法自动匹配（利率决议、日期变体、球员名缩写）。

### 步骤 1：选择事件对

**下拉/搜索**选择有未匹配市场的事件对：

```sql
WITH event_pairs AS (
  SELECT
    a.canonical_event_id,
    a.event_id AS kalshi_event_id,
    b.event_id AS poly_event_id,
    ka.title AS kalshi_title,
    ka.market_count AS kalshi_mc,
    pa.market_count AS poly_mc
  FROM direct_exchanges_data.event_mappings a
  JOIN direct_exchanges_data.event_mappings b
    ON a.canonical_event_id = b.canonical_event_id
  JOIN direct_exchanges_data.events ka
    ON a.source_id = ka.source_id AND a.exchange_id = ka.exchange_id AND a.event_id = ka.event_id
  JOIN direct_exchanges_data.events pa
    ON b.source_id = pa.source_id AND b.exchange_id = pa.exchange_id AND b.event_id = pa.event_id
  WHERE a.exchange_id = 'KALSHI' AND b.exchange_id = 'POLYMARKET'
    AND ka.status = 'Open' AND pa.status = 'Open'
),
kalshi_matched AS (
  SELECT DISTINCT mm.market_id
  FROM direct_exchanges_data.market_mappings mm
  WHERE mm.exchange_id = 'KALSHI'
),
unmatched_counts AS (
  SELECT ep.canonical_event_id, ep.kalshi_title,
    ep.kalshi_mc, ep.poly_mc, ep.kalshi_event_id, ep.poly_event_id,
    count(DISTINCT pm.market_id) FILTER (
      WHERE pm.market_id NOT IN (SELECT market_id FROM kalshi_matched)
    ) AS unmatched_kalshi
  FROM event_pairs ep
  JOIN direct_exchanges_data.prediction_markets pm
    ON pm.event_id = ep.kalshi_event_id AND pm.exchange_id = 'KALSHI' AND pm.status = 'Open'
  GROUP BY ep.canonical_event_id, ep.kalshi_title, ep.kalshi_mc, ep.poly_mc,
           ep.kalshi_event_id, ep.poly_event_id
)
SELECT * FROM unmatched_counts
WHERE unmatched_kalshi > 0
  AND (
    '{{eventSearchInput}}' = ''
    OR kalshi_title ILIKE '%{{eventSearchInput}}%'
  )
ORDER BY unmatched_kalshi DESC;
```

### 步骤 2：并排显示未匹配市场

选择事件对后，显示两个表格：

**左表 —— 未匹配的 Kalshi 市场：**
```sql
SELECT pm.market_id, pm.title, mld.reference_price
FROM direct_exchanges_data.prediction_markets pm
LEFT JOIN direct_exchanges_data.market_latest_data mld
  ON mld.market_id = pm.market_id AND mld.exchange_id = 'KALSHI' AND mld.outcome_side = 'YES'
WHERE pm.event_id = {{selectedEvent.kalshi_event_id}}
  AND pm.exchange_id = 'KALSHI'
  AND pm.status = 'Open'
  AND pm.market_id NOT IN (
    SELECT market_id FROM direct_exchanges_data.market_mappings WHERE exchange_id = 'KALSHI'
  )
ORDER BY pm.title;
```

**右表 —— 未匹配的 Polymarket 市场：**
```sql
SELECT pm.market_id, pm.title, mld.reference_price
FROM direct_exchanges_data.prediction_markets pm
LEFT JOIN direct_exchanges_data.market_latest_data mld
  ON mld.market_id = pm.market_id AND mld.exchange_id = 'POLYMARKET' AND mld.outcome_side = 'YES'
WHERE pm.event_id = {{selectedEvent.poly_event_id}}
  AND pm.exchange_id = 'POLYMARKET'
  AND pm.status = 'Open'
  AND pm.market_id NOT IN (
    SELECT market_id FROM direct_exchanges_data.market_mappings WHERE exchange_id = 'POLYMARKET'
  )
ORDER BY pm.title;
```

### 步骤 3：强制匹配操作

用户从两个表格各选择一行，点击**"强制匹配"**按钮。

**插入查询**（创建4行：每个交易所的 YES+NO）：

```sql
WITH new_id AS (
  SELECT 'CM-' || md5({{kalshiRow.market_id}} || {{polyRow.market_id}}) AS canonical_market_id
)
INSERT INTO direct_exchanges_data.market_mappings
  (source_id, exchange_id, market_id, outcome_side, canonical_market_id,
   is_active, confidence_score, matched_at, model_id, match_version)
VALUES
  ('KALSHI_DIRECT', 'KALSHI', {{kalshiRow.market_id}}, 'YES',
   (SELECT canonical_market_id FROM new_id), true, 1.0, NOW(), 'manual-v1', 1),
  ('KALSHI_DIRECT', 'KALSHI', {{kalshiRow.market_id}}, 'NO',
   (SELECT canonical_market_id FROM new_id), true, 1.0, NOW(), 'manual-v1', 1),
  ('POLYMARKET_DIRECT', 'POLYMARKET', {{polyRow.market_id}}, 'YES',
   (SELECT canonical_market_id FROM new_id), true, 1.0, NOW(), 'manual-v1', 1),
  ('POLYMARKET_DIRECT', 'POLYMARKET', {{polyRow.market_id}}, 'NO',
   (SELECT canonical_market_id FROM new_id), true, 1.0, NOW(), 'manual-v1', 1)
ON CONFLICT (source_id, exchange_id, market_id, outcome_side)
DO UPDATE SET
  canonical_market_id = EXCLUDED.canonical_market_id,
  confidence_score = EXCLUDED.confidence_score,
  matched_at = EXCLUDED.matched_at,
  model_id = EXCLUDED.model_id,
  match_version = EXCLUDED.match_version,
  updated_at = NOW();
```

**同时插入 market_titles**（用于首页展示）：
```sql
INSERT INTO direct_exchanges_data.market_titles
  (canonical_market_id, generated_title, updated_at)
VALUES
  ((SELECT 'CM-' || md5({{kalshiRow.market_id}} || {{polyRow.market_id}})),
   {{kalshiRow.title}}, NOW())
ON CONFLICT (canonical_market_id) DO UPDATE SET
  generated_title = EXCLUDED.generated_title,
  updated_at = NOW();
```

### 步骤 4：拒绝操作

用户选择一个 Kalshi 市场，点击**"拒绝/不兼容"**标记为无法匹配（另一个交易所没有对应市场）：

```sql
INSERT INTO direct_exchanges_data.match_reviews
  (canonical_market_id, action, reviewed_by, reviewed_at, notes)
VALUES
  ('REJECTED:' || {{kalshiRow.market_id}}, 'REJECTED', {{appsmith.user.email}}, NOW(),
   '标记为不兼容 - 另一交易所无对应市场');
```

---

## 选项卡 3：匹配概览（只读）

### 目的

实时仪表板，展示整体匹配健康指标。

### 汇总统计查询

```sql
SELECT
  (SELECT count(*) FROM direct_exchanges_data.market_mappings
   WHERE exchange_id = 'KALSHI') AS kalshi_mapped,
  (SELECT count(*) FROM direct_exchanges_data.prediction_markets
   WHERE exchange_id = 'KALSHI' AND status = 'Open') AS kalshi_total,
  (SELECT count(*) FROM direct_exchanges_data.market_mappings
   WHERE exchange_id = 'POLYMARKET') AS poly_mapped,
  (SELECT count(*) FROM direct_exchanges_data.prediction_markets
   WHERE exchange_id = 'POLYMARKET' AND status = 'Open') AS poly_total,
  (SELECT count(DISTINCT canonical_market_id)
   FROM direct_exchanges_data.market_mappings) AS unique_pairs,
  (SELECT count(*) FROM direct_exchanges_data.arb_opportunities
   WHERE status = 'ACTIVE') AS active_arbs;
```

### 按模型统计匹配质量

```sql
WITH pairs AS (
  SELECT mm1.model_id,
    abs(k.reference_price - p.reference_price) AS gap
  FROM direct_exchanges_data.market_mappings mm1
  JOIN direct_exchanges_data.market_mappings mm2
    ON mm1.canonical_market_id = mm2.canonical_market_id
    AND mm1.outcome_side = mm2.outcome_side
    AND mm1.exchange_id = 'KALSHI' AND mm2.exchange_id = 'POLYMARKET'
  LEFT JOIN direct_exchanges_data.market_latest_data k
    ON k.market_id = mm1.market_id AND k.exchange_id = 'KALSHI'
    AND k.outcome_side = mm1.outcome_side
  LEFT JOIN direct_exchanges_data.market_latest_data p
    ON p.market_id = mm2.market_id AND p.exchange_id = 'POLYMARKET'
    AND p.outcome_side = mm2.outcome_side
  WHERE mm1.outcome_side = 'YES'
    AND k.reference_price IS NOT NULL AND p.reference_price IS NOT NULL
)
SELECT model_id,
  count(*) AS total,
  count(*) FILTER (WHERE gap <= 0.10) AS good,
  count(*) FILTER (WHERE gap > 0.20) AS suspicious,
  round(100.0 * count(*) FILTER (WHERE gap <= 0.10) / count(*), 1) AS good_rate_pct
FROM pairs
GROUP BY model_id
ORDER BY good_rate_pct;
```

### 界面布局

- **统计组件**在顶部：总配对数、匹配率%、活跃套利、可疑数量
- **柱状图**：按模型的匹配质量（好 vs 可疑）
- **表格**：未匹配市场最多的前 20 个事件

---

## 数据安全与服务交互

### 服务是否会覆盖手动更改？

| 操作 | 安全？ | 原因 |
|------|--------|------|
| **强制匹配**（INSERT） | 是 | 事件匹配器通过 `fetchExistingMappedMarketIds()` 跳过已映射的市场。手动匹配不会被覆盖。 |
| **取消匹配**（DELETE） | 是（目前） | 市场匹配只在事件对创建时运行一次。已匹配的事件会被跳过。删除的映射不会被重新创建。 |
| **取消匹配**（如果 Phase 2 启用） | 风险 | Phase 2 跨事件匹配扫描所有未匹配市场，可能重新匹配已删除的对。**目前在生产环境中已禁用。** 如后续启用，需添加 `match_reviews` 表检查。 |

### 数据一致性检查清单

| 问题 | 已处理？ | 方式 |
|------|----------|------|
| INSERT 重复键 | 是 | 唯一键 `(source_id, exchange_id, market_id, outcome_side)` 上的 `ON CONFLICT DO UPDATE` |
| DELETE 后孤立的 arb_opportunities | 是 | 取消匹配查询先删除套利，再删除映射 |
| 强制匹配后缺少 market_titles | 是 | 在 `market_titles` 上使用 `ON CONFLICT DO UPDATE` 的 INSERT |
| 审计跟踪 | 是 | 所有操作记录在 `match_reviews` 中，包含用户邮箱和时间戳 |

---

## 实施说明

1. **Appsmith 数据源：** 使用现有 PostgreSQL 连接（与 `arb_config` 面板相同）。模式：`direct_exchanges_data`。
2. **权限：** 仪表板仅对风控团队成员开放。使用 Appsmith 内置角色管理。
3. **刷新：** 每个选项卡添加"刷新"按钮重新运行查询。无需自动刷新。
4. **确认对话框：** 所有破坏性操作（取消匹配、删除）必须在执行前显示包含市场标题的确认对话框。
5. **审计跟踪：** 所有操作记录在 `match_reviews` 表中，包含用户邮箱和时间戳。
6. **model_id = 'manual-v1'：** 所有手动匹配使用此 model_id，便于查询和审计。

---

## 工作量估算

| 组件 | 工作量（含AI辅助） |
|------|-------------------|
| 选项卡 1：可疑匹配 + 搜索 | 3 小时 |
| 选项卡 2：手动匹配 | 4 小时 |
| 选项卡 3：匹配概览 | 2 小时 |
| 数据库迁移 + 测试 | 1 小时 |
| **总计** | **约 10 小时** |

---

## 验收标准

- [ ] 选项卡 1 的搜索栏可通过输入市场标题的任何部分找到匹配
- [ ] 取消匹配按钮删除映射 + 套利 + 记录到 match_reviews
- [ ] 确认按钮添加到 match_reviews 并从可疑列表中隐藏
- [ ] 强制匹配在 market_mappings 中创建 4 行，model_id 为 'manual-v1'
- [ ] 强制匹配同时创建 market_titles 条目
- [ ] 统计栏显示总可疑数、严重（>50%）和跨事件数量
- [ ] 选项卡 3 显示整体匹配率和按模型的质量
- [ ] 所有操作需要确认对话框
- [ ] 所有操作记录用户邮箱和时间戳
