# Appsmith: 翻译管理仪表板

**状态**: 新功能
**优先级**: P1
**日期**: 2026-03-26

---

## 重要：仪表板命名规范

所有 Appsmith 页面/仪表板**必须**正确命名。**不要**使用默认名称如 "Page1"、"Page2"。

**要求的页面名称：**

| 页面 | 名称 |
|------|------|
| 页面 1 | **Suspicious Matches**（可疑匹配） |
| 页面 2 | **Manual Matching**（手动匹配） |
| 页面 3 | **Matching Overview**（匹配概览） |
| 页面 4 | **Arb Config**（套利配置，如已有） |
| 新页面 | **Translation Management**（翻译管理） |
| 新页面 | **Event Unmatch**（事件取消匹配，见单独文档） |

重命名方法：在左侧边栏点击页面名称 → 右键 → 重命名

---

## 概述

新建一个 Appsmith 页面，用于管理市场标题、事件标题、结果名称和结算规则的中文翻译。翻译系统使用 GPT-5-nano 自动翻译，但团队需要能够审核和手动修正翻译。

## 数据库表

已创建：`direct_exchanges_data.translations`

```sql
-- 表结构
id              BIGSERIAL PRIMARY KEY
source_table    VARCHAR(30)    -- 'market_titles'（市场标题）, 'events'（事件）, 'prediction_markets'（预测市场）
source_id       VARCHAR(100)   -- canonical_market_id 或 event_id
field           VARCHAR(30)    -- 'title'（标题）, 'outcome_name'（结果名称）, 'rules_primary'（结算规则）
source_text     TEXT           -- 原始英文文本
translated_text TEXT           -- 中文翻译
language        VARCHAR(5)     -- 'zh'
manual_override BOOLEAN        -- true = 人工编辑过，自动翻译器不会覆盖
model_used      VARCHAR(30)    -- 'gpt-5-nano' 或 'manual'
translated_at   TIMESTAMPTZ
updated_at      TIMESTAMPTZ
UNIQUE(source_table, source_id, field, language)
```

---

## 需要创建的查询

### 查询 1: `getTranslations`

```sql
SELECT id, source_table, source_id, field, source_text, translated_text,
       manual_override, model_used, translated_at, updated_at
FROM direct_exchanges_data.translations
WHERE language = 'zh'
  AND (
    '{{searchInput.text}}' = ''
    OR source_text ILIKE '%{{searchInput.text}}%'
    OR translated_text ILIKE '%{{searchInput.text}}%'
  )
  AND (
    '{{filterTable.selectedOptionValue}}' = 'all'
    OR source_table = '{{filterTable.selectedOptionValue}}'
  )
  AND (
    '{{filterOverride.selectedOptionValue}}' = 'all'
    OR (manual_override = ('{{filterOverride.selectedOptionValue}}' = 'true'))
  )
ORDER BY
  CASE WHEN '{{sortBy.selectedOptionValue}}' = 'recent' THEN updated_at END DESC,
  CASE WHEN '{{sortBy.selectedOptionValue}}' = 'alpha' THEN source_text END ASC,
  updated_at DESC
LIMIT 100
OFFSET {{(translationsTable.pageNo - 1) * 100}}
```

### 查询 2: `getTranslationCount`

```sql
SELECT COUNT(*) as total,
  COUNT(*) FILTER (WHERE manual_override = true) as manual_count,
  COUNT(*) FILTER (WHERE manual_override = false) as auto_count
FROM direct_exchanges_data.translations
WHERE language = 'zh'
```

### 查询 3: `updateTranslation`

```sql
UPDATE direct_exchanges_data.translations
SET translated_text = '{{translationsTable.updatedRow.translated_text}}',
    manual_override = true,
    model_used = 'manual',
    updated_at = NOW()
WHERE id = {{translationsTable.updatedRow.id}}
```

### 查询 4: `resetToAuto`

将手动修改的翻译重置为自动翻译（下一个 cron 周期会重新翻译）：

```sql
DELETE FROM direct_exchanges_data.translations
WHERE id = {{translationsTable.triggeredRow.id}}
```

### 查询 5: `getMissingTranslations`

查找还没有翻译的内容：

```sql
SELECT mt.canonical_market_id as source_id, mt.generated_title as source_text, 'market_titles' as source_table
FROM direct_exchanges_data.market_titles mt
LEFT JOIN direct_exchanges_data.translations t
  ON t.source_table = 'market_titles' AND t.source_id = mt.canonical_market_id AND t.field = 'title' AND t.language = 'zh'
WHERE t.id IS NULL
LIMIT 50
```

---

## UI 布局

### 筛选行（页面顶部）

| 组件 | Widget 名称 | 类型 | 选项 |
|------|------------|------|------|
| 搜索 | `searchInput` | 文本输入 | 占位符: "搜索英文或中文文本..." |
| 来源表 | `filterTable` | 下拉选择 | all（全部）, market_titles, events, prediction_markets |
| 修改筛选 | `filterOverride` | 下拉选择 | all（全部）, true（仅手动）, false（仅自动） |
| 排序 | `sortBy` | 下拉选择 | recent（最近）, alpha（字母顺序） |

所有筛选组件 → onChange: 执行 `getTranslations`

### 统计栏

三个统计框：
- 翻译总数: `{{getTranslationCount.data[0].total}}`
- 手动修改: `{{getTranslationCount.data[0].manual_count}}`
- 自动翻译: `{{getTranslationCount.data[0].auto_count}}`

### 主表格

**Widget 名称**: `translationsTable`
**表格数据**: `{{getTranslations.data}}`
**启用服务端分页**: 是
**启用行内编辑**: 是（仅 `translated_text` 列）

| 列名 | 显示名称 | 可编辑 | 备注 |
|------|---------|--------|------|
| source_text | 英文原文 | 否 | 显示完整文本，启用换行 |
| translated_text | 中文翻译 | **是** | 行内编辑，启用换行 |
| source_table | 来源 | 否 | 标签样式显示 |
| field | 字段 | 否 | |
| manual_override | 手动 | 否 | 勾选图标（绿色=是） |
| model_used | 模型 | 否 | |
| updated_at | 更新时间 | 否 | 日期格式 |
| id | — | 否 | 隐藏 |

### 行操作

**保存编辑**（保存行时）:
- 执行 `updateTranslation`
- onSuccess: 显示提示 "翻译已更新" + 执行 `getTranslations`

**重置按钮**（自定义列，按钮类型）:
- 标签: "重置"
- 颜色: 橙色
- onClick: 显示确认对话框 "确定要重置为自动翻译吗？当前的手动翻译将被删除，系统会自动重新翻译。"
- 确认后: 执行 `resetToAuto`
- onSuccess: 执行 `getTranslations` + 显示提示 "已重置为自动翻译"

### 缺失翻译面板

在主表格下方，添加一个可折叠区域：

**标题**: "缺失翻译（尚未翻译的内容）"
**表格数据**: `{{getMissingTranslations.data}}`
**用途**: 显示自动翻译器还没有处理的内容，方便监控进度。

---

## 设置

### 页面加载时自动运行
- `getTranslations` ✅
- `getTranslationCount` ✅
- `getMissingTranslations` ✅

### 不要自动运行
- `updateTranslation` ❌
- `resetToAuto` ❌

### Widget 命名（重要！）

| 组件 | 必须命名为 |
|------|-----------|
| 搜索框 | `searchInput` |
| 来源表筛选 | `filterTable` |
| 修改筛选 | `filterOverride` |
| 排序下拉 | `sortBy` |
| 主表格 | `translationsTable` |

> **重要**: 如果 widget 名称不对，查询中的 `{{widgetName.xxx}}` 引用会报错！

---

## 工作流程

1. 自动翻译器每分钟运行一次，填充新翻译
2. 团队打开此页面审核翻译
3. 如果翻译有误，点击单元格 → 编辑 → 保存
4. `manual_override` 会自动设为 `true`
5. 自动翻译器永远不会覆盖手动翻译
6. 如果手动修改也不对，点击"重置" → 自动翻译器会在下一个周期重新翻译
