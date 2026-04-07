# Appsmith Translation Editor — Setup Guide

## Purpose

Allow the team to manually fix/override auto-generated Chinese translations. When a translation is manually edited, the `manual_override` flag is set to `true` and the auto-translator will never overwrite it.

## Queries

### 1. `getTranslations` — List translations with search

```sql
SELECT id, source_table, source_id, field, source_text, translated_text,
  manual_override, model_used, translated_at, updated_at
FROM direct_exchanges_data.translations
WHERE language = 'zh'
  AND (
    '{{typeFilter.selectedOptionValue}}' = 'all'
    OR source_table = '{{typeFilter.selectedOptionValue}}'
  )
  AND (
    '{{searchInput.text}}' = ''
    OR source_text ILIKE '%{{searchInput.text}}%'
    OR translated_text ILIKE '%{{searchInput.text}}%'
  )
ORDER BY
  CASE WHEN '{{sortSelect.selectedOptionValue}}' = 'newest' THEN translated_at END DESC,
  CASE WHEN '{{sortSelect.selectedOptionValue}}' = 'manual' THEN manual_override END DESC,
  translated_at DESC
LIMIT 100;
```

**Filter examples:**
- Select "Event Titles" → shows only event title translations (source_table = 'events')
- Select "Outcome Names" → shows market/outcome translations (source_table = 'market_titles')
- Select "Resolution Rules" → shows rules translations (source_table = 'prediction_markets')
- Search "Newsom" → finds both event titles and outcome names containing Newsom

### 2. `updateTranslation` — Save manual edit

```sql
UPDATE direct_exchanges_data.translations
SET translated_text = '{{translationsTable.triggeredRow.translated_text}}',
    manual_override = true,
    updated_at = NOW()
WHERE id = {{translationsTable.triggeredRow.id}};
```

### 3. `resetOverride` — Remove manual override (allow auto-translator to update)

```sql
UPDATE direct_exchanges_data.translations
SET manual_override = false,
    updated_at = NOW()
WHERE id = {{translationsTable.triggeredRow.id}};
```

### 4. `getTranslationStats` — Dashboard stats

```sql
SELECT
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE manual_override) as manual_overrides,
  COUNT(*) FILTER (WHERE field = 'title') as titles,
  COUNT(*) FILTER (WHERE field = 'kalshi_title') as outcomes,
  COUNT(*) FILTER (WHERE field = 'rules_primary') as rules,
  MAX(translated_at) as last_translated
FROM direct_exchanges_data.translations
WHERE language = 'zh';
```

## Widget Setup

### Search Bar
- **Widget Name**: `searchInput`
- **Placeholder**: "Search English or Chinese text..."
- **onTextChanged**: Run `getTranslations`

### Type Filter Dropdown
- **Widget Name**: `typeFilter`
- **Options**: `[{label: "All Types", value: "all"}, {label: "Event Titles", value: "events"}, {label: "Outcome Names", value: "market_titles"}, {label: "Resolution Rules", value: "prediction_markets"}]`
- **onChange**: Run `getTranslations`

### Sort Dropdown
- **Widget Name**: `sortSelect`
- **Options**: `[{label: "Newest", value: "newest"}, {label: "Manual First", value: "manual"}]`
- **onChange**: Run `getTranslations`

### Stats Bar
- Total: `{{getTranslationStats.data[0].total}}`
- Manual Overrides: `{{getTranslationStats.data[0].manual_overrides}}`
- Last Translated: `{{getTranslationStats.data[0].last_translated}}`

### Table
- **Widget Name**: `translationsTable`
- **Table Data**: `{{getTranslations.data}}`
- **Columns**:

| Column | Editable | Notes |
|--------|----------|-------|
| source_table | No | Type: `events` = Event Title, `market_titles` = Outcome Name, `prediction_markets` = Rules |
| source_text | No | English original |
| translated_text | **Yes** | Chinese translation — inline editable |
| manual_override | No | Shows ✓ if manually edited |
| field | No | title / kalshi_title / rules_primary |
| model_used | No | gpt-4o-mini |
| source_id | No | CE-xxx (event) or CM-xxx (market) — for reference |
| id | Hidden | Used for update query |

- **onRowSave**: Run `updateTranslation`, then onSuccess run `getTranslations`

### Reset Override Button
- Add button column in table
- **Label**: "Reset"
- **onClick**: Show confirmation → Run `resetOverride` → Refresh table
- Only visible when `manual_override = true`

## Page Load Queries
- `getTranslations` ✅
- `getTranslationStats` ✅
