# Appsmith 风险仪表板 — 分步搭建教程

**预计时间**: 8-10 小时
**前提条件**: Appsmith 已运行，PostgreSQL 数据源已连接
**数据库**: `direct_exchanges` / Schema: `direct_exchanges_data`
**不需要后端代码** — 所有操作都是 Appsmith 直接查询 PostgreSQL

---

## 目录

1. [创建应用和页面](#1-创建应用和页面)
2. [创建所有查询](#2-创建所有查询)
3. [搭建 Tab 1：可疑匹配](#3-搭建-tab-1可疑匹配)
4. [搭建 Tab 2：手动匹配](#4-搭建-tab-2手动匹配)
5. [搭建 Tab 3：匹配概览](#5-搭建-tab-3匹配概览)
6. [测试](#6-测试)
7. [Appsmith 常用技巧](#7-appsmith-常用技巧)

---

## 1. 创建应用和页面

1. 登录 Appsmith
2. 点击左上角 **"New"** → **"Application"**
3. 命名为 **"Risk & Matching Dashboard"**
4. 你会看到一个空白画布页面

---

## 2. 创建所有查询

> 在左侧栏找到 **"Queries"** 部分，点击旁边的 **"+"** 按钮创建新查询。
> 每次创建时，选择已有的 **PostgreSQL 数据源**。

### 2.1 Tab 1 查询

#### 查询 1: `getSuspiciousMatches`

**名称**: `getSuspiciousMatches`
**类型**: SELECT

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
    AND abs(k.reference_price - p.reference_price) > {{priceGapSlider.value / 100 || 0.20}}
    AND mm1.canonical_market_id NOT IN (
      SELECT canonical_market_id FROM direct_exchanges_data.match_reviews
    )
    AND (
      '{{searchInput.text}}' = ''
      OR pk.title ILIKE '%{{searchInput.text}}%'
      OR pp.title ILIKE '%{{searchInput.text}}%'
    )
)
SELECT * FROM pairs
ORDER BY price_gap DESC;
```

> **说明**: `{{searchInput.text}}` 引用搜索框的值，`{{priceGapSlider.value}}` 引用滑块的值。这些 widget 我们会在后面创建。

---

#### 查询 2: `getSuspiciousStats`

**名称**: `getSuspiciousStats`
**类型**: SELECT

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

#### 查询 3: `confirmMatch`

**名称**: `confirmMatch`
**类型**: INSERT

```sql
INSERT INTO direct_exchanges_data.match_reviews
  (canonical_market_id, action, reviewed_by, reviewed_at)
VALUES
  ('{{suspiciousTable.selectedRow.canonical_market_id}}', 'CONFIRMED', '{{appsmith.user.email}}', NOW());
```

> **说明**: `suspiciousTable` 是我们后面要创建的表格 widget 名称。

---

#### 查询 4: `unmatchMarket`

**名称**: `unmatchMarket`
**类型**: DELETE + INSERT (多条语句)

```sql
-- 第1步: 删除相关套利机会
DELETE FROM direct_exchanges_data.arb_opportunities
WHERE canonical_market_id = '{{suspiciousTable.selectedRow.canonical_market_id}}';

-- 第2步: 删除市场映射 (4行: 两个交易所各YES+NO)
DELETE FROM direct_exchanges_data.market_mappings
WHERE canonical_market_id = '{{suspiciousTable.selectedRow.canonical_market_id}}';

-- 第3步: 记录操作日志
INSERT INTO direct_exchanges_data.match_reviews
  (canonical_market_id, action, reviewed_by, reviewed_at)
VALUES
  ('{{suspiciousTable.selectedRow.canonical_market_id}}', 'UNMATCHED', '{{appsmith.user.email}}', NOW());
```

> **重要**: 这个查询会删除数据！一定要在按钮上加确认对话框。

---

### 2.2 Tab 2 查询

#### 查询 5: `getUnmatchedEvents`

**名称**: `getUnmatchedEvents`

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
    '{{eventSearchInput.text}}' = ''
    OR kalshi_title ILIKE '%{{eventSearchInput.text}}%'
  )
ORDER BY unmatched_kalshi DESC;
```

---

#### 查询 6: `getUnmatchedKalshi`

**名称**: `getUnmatchedKalshi`

```sql
SELECT pm.market_id, pm.title, mld.reference_price
FROM direct_exchanges_data.prediction_markets pm
LEFT JOIN direct_exchanges_data.market_latest_data mld
  ON mld.market_id = pm.market_id AND mld.exchange_id = 'KALSHI' AND mld.outcome_side = 'YES'
WHERE pm.event_id = '{{eventsTable.selectedRow.kalshi_event_id}}'
  AND pm.exchange_id = 'KALSHI'
  AND pm.status = 'Open'
  AND pm.market_id NOT IN (
    SELECT market_id FROM direct_exchanges_data.market_mappings WHERE exchange_id = 'KALSHI'
  )
ORDER BY pm.title;
```

---

#### 查询 7: `getUnmatchedPoly`

**名称**: `getUnmatchedPoly`

```sql
SELECT pm.market_id, pm.title, mld.reference_price
FROM direct_exchanges_data.prediction_markets pm
LEFT JOIN direct_exchanges_data.market_latest_data mld
  ON mld.market_id = pm.market_id AND mld.exchange_id = 'POLYMARKET' AND mld.outcome_side = 'YES'
WHERE pm.event_id = '{{eventsTable.selectedRow.poly_event_id}}'
  AND pm.exchange_id = 'POLYMARKET'
  AND pm.status = 'Open'
  AND pm.market_id NOT IN (
    SELECT market_id FROM direct_exchanges_data.market_mappings WHERE exchange_id = 'POLYMARKET'
  )
ORDER BY pm.title;
```

---

#### 查询 8: `forceMatch`

**名称**: `forceMatch`

```sql
WITH new_id AS (
  SELECT 'CM-' || md5('{{kalshiTable.selectedRow.market_id}}' || '{{polyTable.selectedRow.market_id}}') AS canonical_market_id
)
INSERT INTO direct_exchanges_data.market_mappings
  (source_id, exchange_id, market_id, outcome_side, canonical_market_id,
   is_active, confidence_score, matched_at, model_id, match_version)
VALUES
  ('KALSHI_DIRECT', 'KALSHI', '{{kalshiTable.selectedRow.market_id}}', 'YES',
   (SELECT canonical_market_id FROM new_id), true, 1.0, NOW(), 'manual-v1', 1),
  ('KALSHI_DIRECT', 'KALSHI', '{{kalshiTable.selectedRow.market_id}}', 'NO',
   (SELECT canonical_market_id FROM new_id), true, 1.0, NOW(), 'manual-v1', 1),
  ('POLYMARKET_DIRECT', 'POLYMARKET', '{{polyTable.selectedRow.market_id}}', 'YES',
   (SELECT canonical_market_id FROM new_id), true, 1.0, NOW(), 'manual-v1', 1),
  ('POLYMARKET_DIRECT', 'POLYMARKET', '{{polyTable.selectedRow.market_id}}', 'NO',
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

---

#### 查询 9: `forceMatchTitle`

**名称**: `forceMatchTitle`

```sql
INSERT INTO direct_exchanges_data.market_titles
  (canonical_market_id, generated_title, updated_at)
VALUES
  ('CM-' || md5('{{kalshiTable.selectedRow.market_id}}' || '{{polyTable.selectedRow.market_id}}'),
   '{{kalshiTable.selectedRow.title}}', NOW())
ON CONFLICT (canonical_market_id) DO UPDATE SET
  generated_title = EXCLUDED.generated_title,
  updated_at = NOW();
```

---

#### 查询 10: `rejectMarket`

**名称**: `rejectMarket`

```sql
INSERT INTO direct_exchanges_data.match_reviews
  (canonical_market_id, action, reviewed_by, reviewed_at, notes)
VALUES
  ('REJECTED:' || '{{kalshiTable.selectedRow.market_id}}', 'REJECTED', '{{appsmith.user.email}}', NOW(),
   'Marked as incompatible - no matching market on other exchange');
```

---

### 2.3 Tab 3 查询

#### 查询 11: `getOverviewStats`

**名称**: `getOverviewStats`

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

---

#### 查询 12: `getModelQuality`

**名称**: `getModelQuality`

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

---

#### 查询 13: `getTopUnmatchedEvents`

**名称**: `getTopUnmatchedEvents`

```sql
WITH kalshi_matched AS (
  SELECT DISTINCT market_id FROM direct_exchanges_data.market_mappings WHERE exchange_id = 'KALSHI'
)
SELECT
  e.title,
  e.event_id,
  e.market_count AS total_markets,
  count(pm.market_id) FILTER (WHERE pm.market_id NOT IN (SELECT market_id FROM kalshi_matched)) AS unmatched
FROM direct_exchanges_data.events e
JOIN direct_exchanges_data.prediction_markets pm
  ON pm.event_id = e.event_id AND pm.exchange_id = e.exchange_id
WHERE e.exchange_id = 'KALSHI' AND e.status = 'Open' AND pm.status = 'Open'
GROUP BY e.title, e.event_id, e.market_count
HAVING count(pm.market_id) FILTER (WHERE pm.market_id NOT IN (SELECT market_id FROM kalshi_matched)) > 0
ORDER BY unmatched DESC
LIMIT 20;
```

---

## 3. 搭建 Tab 1：可疑匹配

### 3.1 添加 Tabs Widget

1. 在右侧 widget 面板中，找到 **"Tabs"**
2. 拖拽到画布上，铺满整个页面
3. 你会看到默认有 Tab 1 和 Tab 2
4. 点击 Tab 1，在右侧属性面板中把名称改为 **"可疑匹配"**
5. 点击 Tab 2，改名为 **"手动匹配"**
6. 点击 "+" 添加第三个 Tab，命名为 **"匹配概览"**

### 3.2 在"可疑匹配"Tab 中添加组件

#### 搜索框

1. 确保你在 **"可疑匹配"** Tab 中
2. 从 widget 面板拖拽一个 **"Input"** 组件到页面顶部
3. 在右侧属性面板中设置：
   - **Widget Name**: `searchInput`
   - **Placeholder**: `搜索市场标题...`
   - **Data Type**: Text
4. 在 **事件(Events)** 部分：
   - **onTextChanged**: 选择 **"Execute a query"** → 选 `getSuspiciousMatches`

#### 价格差距滑块

1. 拖拽一个 **"Slider"** (或 "Number Slider") 到搜索框右侧
2. 属性设置：
   - **Widget Name**: `priceGapSlider`
   - **Min**: `10`
   - **Max**: `80`
   - **Default Value**: `20`
   - **Step Size**: `5`
   - **Label**: `价格差距阈值 (%)`
3. 事件：
   - **onChange**: 执行 `getSuspiciousMatches`

#### 统计栏

1. 拖拽 3 个 **"Stat Box"** (或 **"Text"**) 组件到搜索框下方，排成一行
2. 设置内容：
   - 第1个: `总可疑: {{getSuspiciousStats.data[0].total_suspicious}}`
   - 第2个: `严重 (>50%): {{getSuspiciousStats.data[0].critical_50pct}}`
   - 第3个: `跨事件匹配: {{getSuspiciousStats.data[0].cross_event_matches}}`

> **提示**: `getSuspiciousStats.data` 返回一个数组，`[0]` 取第一行。

#### 数据表格

1. 拖拽一个 **"Table"** 组件到统计栏下方，占满剩余空间
2. 属性设置：
   - **Widget Name**: `suspiciousTable`
   - **Table Data**: `{{getSuspiciousMatches.data}}`
3. 点击表格，进入 **列设置(Columns)**：

| 列名 | 显示名称 | 类型 | 备注 |
|------|---------|------|------|
| kalshi_title | Kalshi 标题 | Text | 截断60字符 |
| poly_title | Poly 标题 | Text | 截断60字符 |
| kalshi_price | Kalshi 价格 | Number | 格式: `{{currentRow.kalshi_price ? (currentRow.kalshi_price * 100).toFixed(1) + '%' : '-'}}` |
| poly_price | Poly 价格 | Number | 格式: 同上 |
| price_gap | 价格差距 | Number | 格式: `{{(currentRow.price_gap * 100).toFixed(1) + '%'}}` |
| model_id | 模型 | Text | — |
| matched_at | 匹配时间 | Date | — |
| canonical_market_id | — | — | **隐藏此列** (供按钮查询使用) |

4. 隐藏不需要的列: `kalshi_market_id`, `poly_market_id`, `kalshi_event_id`, `poly_event_id`, `confidence_score`

#### 添加操作按钮

**方法**: 在 Table 的列设置中，添加一个 **"Button"** 类型的自定义列。

**确认按钮 (Confirm)**:

1. 在表格列设置中，点击 **"+ Add Column"**
2. 列类型选择 **"Button"**
3. 设置:
   - **Label**: `确认`
   - **Button Color**: 绿色 (Green / Success)
   - **onClick**:
     1. 选择 **"Show Alert"** → 先显示确认提示
     2. 或者更好的方式: 选择 **"Show Modal"** → 创建一个确认 Modal

   **简单方式 (直接执行)**:
   - onClick → Execute a query → `confirmMatch`
   - onSuccess → Execute a query → `getSuspiciousMatches` (刷新表格)
   - onSuccess → Show Alert → `已确认!`

**取消匹配按钮 (Unmatch)**:

1. 再添加一个 Button 列
2. 设置:
   - **Label**: `取消匹配`
   - **Button Color**: 红色 (Red / Danger)
   - **onClick**: Show Modal → `confirmUnmatchModal`

3. 创建确认 Modal:
   - 拖拽一个 **"Modal"** 组件到画布
   - **Widget Name**: `confirmUnmatchModal`
   - Modal 内容:
     - Text: `确定要取消此匹配吗？这将删除市场映射和相关套利数据。`
     - Text: `Kalshi: {{suspiciousTable.selectedRow.kalshi_title}}`
     - Text: `Poly: {{suspiciousTable.selectedRow.poly_title}}`
   - **确定按钮**:
     - onClick → Execute a query → `unmatchMarket`
     - onSuccess → Close Modal → `confirmUnmatchModal`
     - onSuccess → Execute a query → `getSuspiciousMatches`
     - onSuccess → Show Alert → `已取消匹配!`
   - **取消按钮**:
     - onClick → Close Modal → `confirmUnmatchModal`

#### 刷新按钮

1. 在页面右上角添加一个 **"Button"**
2. Label: `刷新`
3. onClick → 执行 `getSuspiciousMatches` 和 `getSuspiciousStats`

---

## 4. 搭建 Tab 2：手动匹配

### 4.1 切换到"手动匹配"Tab

点击 Tabs 组件中的第二个 Tab。

### 4.2 事件搜索框

1. 拖拽 **"Input"** 到顶部
2. 属性:
   - **Widget Name**: `eventSearchInput`
   - **Placeholder**: `搜索事件名称...`
3. 事件:
   - **onTextChanged**: 执行 `getUnmatchedEvents`

### 4.3 事件列表表格

1. 拖拽 **"Table"** 到搜索框下方 (占页面上半部分)
2. 属性:
   - **Widget Name**: `eventsTable`
   - **Table Data**: `{{getUnmatchedEvents.data}}`
3. 列设置:

| 列名 | 显示名称 | 备注 |
|------|---------|------|
| kalshi_title | 事件名称 | — |
| kalshi_mc | Kalshi 市场数 | — |
| poly_mc | Poly 市场数 | — |
| unmatched_kalshi | 未匹配数 | 红色高亮 |

4. 隐藏: `canonical_event_id`, `kalshi_event_id`, `poly_event_id`

5. **重要**: 事件 → **onRowSelected**:
   - 执行 `getUnmatchedKalshi`
   - 执行 `getUnmatchedPoly`

> **如何同时执行两个查询**: 在 onRowSelected 中选择 "Execute a query" → `getUnmatchedKalshi`，然后在 onSuccess 中再执行 `getUnmatchedPoly`。或者使用 JS Object (见第7节)。

### 4.4 左右两个表格 (并排)

**左表 — Kalshi 未匹配市场**:

1. 拖拽 **"Table"** 到页面左下半部分
2. 属性:
   - **Widget Name**: `kalshiTable`
   - **Table Data**: `{{getUnmatchedKalshi.data}}`
3. 列: `title` (标题), `reference_price` (价格，格式同上)

**右表 — Polymarket 未匹配市场**:

1. 拖拽另一个 **"Table"** 到页面右下半部分
2. 属性:
   - **Widget Name**: `polyTable`
   - **Table Data**: `{{getUnmatchedPoly.data}}`
3. 列: `title` (标题), `reference_price` (价格)

### 4.5 操作按钮

**强制匹配按钮**:

1. 在两个表格之间或下方，添加 **"Button"**
2. 属性:
   - **Label**: `强制匹配`
   - **Button Color**: 绿色
   - **Disabled**: `{{!kalshiTable.selectedRow || !polyTable.selectedRow}}`
     (如果两边都没选中行，按钮灰色不可点)
3. onClick → Show Modal → `confirmForceMatchModal`
4. 创建 Modal:
   - Text: `确定要匹配以下市场吗？`
   - Text: `Kalshi: {{kalshiTable.selectedRow.title}}`
   - Text: `Poly: {{polyTable.selectedRow.title}}`
   - 确定按钮:
     - onClick → 执行 `forceMatch`
     - onSuccess → 执行 `forceMatchTitle`
     - onSuccess → Close Modal
     - onSuccess → 执行 `getUnmatchedKalshi` (刷新)
     - onSuccess → Show Alert → `匹配成功!`

**拒绝/不兼容按钮**:

1. 添加 **"Button"**
2. 属性:
   - **Label**: `拒绝/不兼容`
   - **Button Color**: 灰色
   - **Disabled**: `{{!kalshiTable.selectedRow}}`
3. onClick → 执行 `rejectMarket`
4. onSuccess → Show Alert → `已标记为不兼容`

---

## 5. 搭建 Tab 3：匹配概览

### 5.1 切换到"匹配概览"Tab

### 5.2 统计卡片

拖拽 4 个 **"Stat Box"** (或 **"Text"**) 组件到顶部，排成一行:

| 卡片 | 内容 |
|------|------|
| 总配对数 | `{{getOverviewStats.data[0].unique_pairs}}` |
| Kalshi 匹配率 | `{{(getOverviewStats.data[0].kalshi_mapped / getOverviewStats.data[0].kalshi_total * 100).toFixed(1)}}%` |
| Poly 匹配率 | `{{(getOverviewStats.data[0].poly_mapped / getOverviewStats.data[0].poly_total * 100).toFixed(1)}}%` |
| 活跃套利 | `{{getOverviewStats.data[0].active_arbs}}` |

### 5.3 模型质量图表

1. 拖拽一个 **"Chart"** 组件
2. 属性:
   - **Chart Type**: Bar Chart (柱状图)
   - **Chart Data**:
   ```
   {{getModelQuality.data.map(row => ({
     x: row.model_id,
     y: Number(row.good_rate_pct)
   }))}}
   ```
   - **Title**: `模型匹配质量 (准确率 %)`

### 5.4 未匹配事件排行

1. 拖拽 **"Table"** 到图表下方
2. 属性:
   - **Table Data**: `{{getTopUnmatchedEvents.data}}`
3. 列: `title` (事件名称), `total_markets` (总市场数), `unmatched` (未匹配数)

### 5.5 刷新按钮

添加 Button → 执行 `getOverviewStats`, `getModelQuality`, `getTopUnmatchedEvents`

---

## 6. 测试

### 6.1 Tab 1 测试

1. 打开 Tab 1，确认表格显示了可疑匹配数据
2. 在搜索框输入一个已知的错误匹配名称 (如 "Fiorentina")
3. 确认搜索结果正确过滤
4. 调整滑块，确认表格数据随之变化
5. 选择一行，点击 **确认** → 检查 `match_reviews` 表是否有新记录:
   ```sql
   SELECT * FROM direct_exchanges_data.match_reviews ORDER BY reviewed_at DESC LIMIT 5;
   ```
6. 选择一行，点击 **取消匹配** → 确认 Modal 出现 → 点击确定 → 检查:
   - `market_mappings` 中该 canonical_market_id 的行已删除
   - `match_reviews` 中有 UNMATCHED 记录

### 6.2 Tab 2 测试

1. 打开 Tab 2，搜索一个事件
2. 选择事件 → 确认左右两个表格显示未匹配市场
3. 分别选择左右各一行 → 点击 **强制匹配** → 确认:
   - `market_mappings` 中有4条新记录 (model_id = 'manual-v1')
   - `market_titles` 中有新记录

### 6.3 Tab 3 测试

1. 打开 Tab 3，确认统计数字正确
2. 确认图表显示

---

## 7. Appsmith 常用技巧

### 引用 Widget 值

```javascript
// 输入框的值
{{searchInput.text}}

// 表格选中行的某列
{{Table1.selectedRow.column_name}}

// 表格所有数据
{{Table1.tableData}}

// 查询返回的数据
{{queryName.data}}        // 数组
{{queryName.data[0]}}     // 第一行
{{queryName.data[0].col}} // 第一行某列
```

### 链式执行查询

在查询的 **Settings** 中:
- **onSuccess**: 选择另一个查询
- 这样第一个查询成功后会自动执行第二个

或者创建 **JS Object**:

1. 左侧栏 → **"JS Objects"** → **"+"**
2. 写一个函数:
```javascript
export default {
  async refreshAll() {
    await getSuspiciousMatches.run();
    await getSuspiciousStats.run();
    showAlert('刷新完成!', 'success');
  },

  async onEventSelected() {
    await getUnmatchedKalshi.run();
    await getUnmatchedPoly.run();
  },

  async doForceMatch() {
    await forceMatch.run();
    await forceMatchTitle.run();
    await getUnmatchedKalshi.run();
    await getUnmatchedPoly.run();
    showAlert('匹配成功!', 'success');
    closeModal('confirmForceMatchModal');
  }
}
```

### 确认对话框

**方式1 — Modal (推荐)**:
- 创建 Modal widget
- 按钮 onClick → Show Modal
- Modal 中的确认按钮执行实际查询

**方式2 — 内置确认**:
在按钮的 onClick 事件中，选择 JS:
```javascript
showAlert('确定要执行此操作吗?').then(() => {
  unmatchMarket.run();
});
```

### 格式化表格列

在表格列设置中，选择列的 **"Computed Value"**:
```javascript
// 价格格式 (0.25 → 25.0%)
{{currentRow.price ? (currentRow.price * 100).toFixed(1) + '%' : '-'}}

// 条件颜色 (在 Style 中)
{{currentRow.price_gap > 0.5 ? '#FF0000' : '#333333'}}

// 截断文本
{{currentRow.title ? currentRow.title.substring(0, 60) + (currentRow.title.length > 60 ? '...' : '') : ''}}
```

### 页面加载时自动运行查询

在查询的 **Settings** 中:
- 勾选 **"Run on Page Load"** ✅
- 需要页面加载时自动运行的查询:
  - `getSuspiciousMatches` ✅
  - `getSuspiciousStats` ✅
  - `getUnmatchedEvents` ✅
  - `getOverviewStats` ✅
  - `getModelQuality` ✅
  - `getTopUnmatchedEvents` ✅
- 不需要自动运行的查询:
  - `confirmMatch` ❌
  - `unmatchMarket` ❌
  - `forceMatch` ❌
  - `forceMatchTitle` ❌
  - `rejectMarket` ❌
  - `getUnmatchedKalshi` ❌ (需要先选择事件)
  - `getUnmatchedPoly` ❌ (需要先选择事件)

### Widget 命名规范

请务必按照本文档中的名称命名 widget，因为 SQL 查询中引用了这些名称:

| Widget | 名称 | 用在查询中 |
|--------|------|-----------|
| 搜索框 (Tab 1) | `searchInput` | `getSuspiciousMatches` |
| 滑块 (Tab 1) | `priceGapSlider` | `getSuspiciousMatches` |
| 表格 (Tab 1) | `suspiciousTable` | `confirmMatch`, `unmatchMarket` |
| 搜索框 (Tab 2) | `eventSearchInput` | `getUnmatchedEvents` |
| 事件表格 (Tab 2) | `eventsTable` | `getUnmatchedKalshi`, `getUnmatchedPoly` |
| Kalshi 表格 (Tab 2) | `kalshiTable` | `forceMatch`, `forceMatchTitle`, `rejectMarket` |
| Poly 表格 (Tab 2) | `polyTable` | `forceMatch`, `forceMatchTitle` |

> **重要**: 如果 widget 名称不对，查询中的 `{{widgetName.xxx}}` 引用会报错!

---

## 常见问题

**Q: 查询报错 "widget not found"**
A: 检查 widget 名称是否和查询中引用的完全一致。

**Q: 表格没数据**
A: 检查查询是否设置了 "Run on Page Load"，或手动点击查询右上角的 ▶ 按钮运行一次。

**Q: 按钮点了没反应**
A: 检查按钮的 onClick 事件是否正确绑定了查询。

**Q: Modal 不出现**
A: 确保 Modal widget 存在且名称正确。Modal 默认是隐藏的，只有通过 "Show Modal" 事件才会显示。
