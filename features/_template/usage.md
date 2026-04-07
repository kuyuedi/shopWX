# Usage: [Feature Name]

How to use and verify this feature.

---

## Database Table

**Table:** `schema.table_name`

### Columns

| Column | Type | Description |
|--------|------|-------------|
| column_name | TYPE | What it stores |

---

## Verification Queries

### 1. Verify feature is active

```sql
-- Query to check the feature is working
SELECT COUNT(*)
FROM schema.table_name
WHERE updated_at > NOW() - INTERVAL '5 minutes';
```

**Expected:** Non-zero count.

### 2. View sample data

```sql
SELECT *
FROM schema.table_name
WHERE updated_at > NOW() - INTERVAL '5 minutes'
LIMIT 10;
```

---

## Statistics Queries

### Summary statistics

```sql
SELECT
    group_column,
    COUNT(*) as count,
    AVG(metric_column) as avg_metric
FROM schema.table_name
WHERE updated_at > NOW() - INTERVAL '1 hour'
GROUP BY group_column
ORDER BY count DESC;
```

---

## Example Output

### Sample row

```
column_1    | value_1
column_2    | value_2
column_3    | value_3
```

### Interpretation

- **column_1 = value_1**: What this means
- **column_2 = value_2**: What this means

---

## Troubleshooting

### Common Issue 1

Symptom and solution.

### Common Issue 2

Symptom and solution.
