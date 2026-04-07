# Appsmith: Translation Management Dashboard

**Status**: NEW
**Priority**: P1
**Date**: 2026-03-26

---

## IMPORTANT: Dashboard Naming Convention

All Appsmith pages/dashboards MUST be named properly. Do NOT leave default names like "Page1", "Page2".

**Required page names:**

| Page | Name |
|------|------|
| Page 1 | **Suspicious Matches** |
| Page 2 | **Manual Matching** |
| Page 3 | **Matching Overview** |
| Page 4 | **Arb Config** (if exists) |
| NEW | **Translation Management** |
| NEW | **Event Unmatch** (see separate doc) |

To rename: Click the page name in the left sidebar → right-click → Rename.

---

## Summary

A new Appsmith page for managing Chinese translations of market titles, event titles, outcome names, and resolution rules. The translation system auto-translates using GPT-5-nano, but the team needs to be able to review and manually correct translations.

## Database Table

Already created: `direct_exchanges_data.translations`

```sql
-- Schema
id              BIGSERIAL PRIMARY KEY
source_table    VARCHAR(30)    -- 'market_titles', 'events', 'prediction_markets'
source_id       VARCHAR(100)   -- canonical_market_id or event_id
field           VARCHAR(30)    -- 'title', 'outcome_name', 'rules_primary', 'description'
source_text     TEXT           -- original English text
translated_text TEXT           -- Chinese translation
language        VARCHAR(5)     -- 'zh'
manual_override BOOLEAN        -- true = human edited, auto-translator won't overwrite
model_used      VARCHAR(30)    -- 'gpt-5-nano' or 'manual'
translated_at   TIMESTAMPTZ
updated_at      TIMESTAMPTZ
UNIQUE(source_table, source_id, field, language)
```

---

## Queries to Create

### Query 1: `getTranslations`

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

### Query 2: `getTranslationCount`

```sql
SELECT COUNT(*) as total,
  COUNT(*) FILTER (WHERE manual_override = true) as manual_count,
  COUNT(*) FILTER (WHERE manual_override = false) as auto_count
FROM direct_exchanges_data.translations
WHERE language = 'zh'
```

### Query 3: `updateTranslation`

```sql
UPDATE direct_exchanges_data.translations
SET translated_text = '{{translationsTable.updatedRow.translated_text}}',
    manual_override = true,
    model_used = 'manual',
    updated_at = NOW()
WHERE id = {{translationsTable.updatedRow.id}}
```

### Query 4: `resetToAuto`

Reset a manual override back to auto-translation (will be re-translated on next cron cycle):

```sql
DELETE FROM direct_exchanges_data.translations
WHERE id = {{translationsTable.triggeredRow.id}}
```

### Query 5: `getMissingTranslations`

Find content that hasn't been translated yet:

```sql
SELECT mt.canonical_market_id as source_id, mt.generated_title as source_text, 'market_titles' as source_table
FROM direct_exchanges_data.market_titles mt
LEFT JOIN direct_exchanges_data.translations t
  ON t.source_table = 'market_titles' AND t.source_id = mt.canonical_market_id AND t.field = 'title' AND t.language = 'zh'
WHERE t.id IS NULL
LIMIT 50
```

---

## UI Layout

### Filters Row (top of page)

| Widget | Name | Type | Options |
|--------|------|------|---------|
| Search | `searchInput` | Text Input | Placeholder: "Search English or Chinese text..." |
| Source Table | `filterTable` | Select | all, market_titles, events, prediction_markets |
| Override Filter | `filterOverride` | Select | all, true (manual only), false (auto only) |
| Sort | `sortBy` | Select | recent, alpha |

All filter widgets → onChange: Run `getTranslations`

### Stats Bar

Three stat boxes showing:
- Total translations: `{{getTranslationCount.data[0].total}}`
- Manual overrides: `{{getTranslationCount.data[0].manual_count}}`
- Auto-translated: `{{getTranslationCount.data[0].auto_count}}`

### Main Table

**Widget Name**: `translationsTable`
**Table Data**: `{{getTranslations.data}}`
**Enable server-side pagination**: Yes
**Enable inline editing**: Yes (on `translated_text` column only)

| Column | Display Name | Editable | Notes |
|--------|-------------|----------|-------|
| source_text | English | No | Show full text, wrap enabled |
| translated_text | Chinese Translation | **Yes** | Inline edit, wrap enabled |
| source_table | Source | No | Tag/badge style |
| field | Field | No | |
| manual_override | Manual | No | Checkbox icon (green if true) |
| model_used | Model | No | |
| updated_at | Updated | No | Date format |
| id | — | No | Hidden |

### Row Actions

**Save Edit** (on row save):
- Run `updateTranslation`
- onSuccess: Show Alert "Translation updated" + Run `getTranslations`

**Reset Button** (custom column, button type):
- Label: "Reset"
- Color: Orange
- onClick: Show confirmation "Reset to auto-translation? The current manual translation will be deleted and re-translated automatically."
- On confirm: Run `resetToAuto`
- onSuccess: Run `getTranslations` + Show Alert "Reset to auto-translation"

### Missing Translations Panel

Below the main table, add a collapsible section:

**Title**: "Missing Translations (not yet translated)"
**Table Data**: `{{getMissingTranslations.data}}`
**Purpose**: Shows content that the auto-translator hasn't processed yet. Useful for monitoring.

---

## Settings

### Run on Page Load
- `getTranslations` ✅
- `getTranslationCount` ✅
- `getMissingTranslations` ✅

### Do NOT run on page load
- `updateTranslation` ❌
- `resetToAuto` ❌

### Widget Naming (CRITICAL)

| Widget | Must be named |
|--------|--------------|
| Search box | `searchInput` |
| Source table filter | `filterTable` |
| Override filter | `filterOverride` |
| Sort dropdown | `sortBy` |
| Main table | `translationsTable` |

---

## Workflow

1. Auto-translator runs every minute, populating new translations
2. Team opens this page to review translations
3. If a translation is wrong, click the cell → edit → save
4. `manual_override` is automatically set to `true`
5. Auto-translator will never overwrite manual translations
6. If the manual edit was wrong, click "Reset" → auto-translator will re-translate on next cycle
