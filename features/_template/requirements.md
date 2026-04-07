# Feature: [Feature Name]

**Status**: NEW
**Priority**: High / Medium / Low
**Created**: YYYY-MM-DD

---

## Summary

One sentence describing what this feature does.

---

## Problem

Why do we need this? What problem does it solve?

---

## Solution

High-level description of how it should work.

---

## Algorithm / Logic

Step-by-step instructions or formulas:

```
1. Get data from [source]
2. Filter by [condition]
3. Calculate: result = formula
4. Store in [table]
```

If there are formulas, write them clearly:
```
reference_price = (best_bid + best_ask) / 2
band_vwap = sum(price * quantity) / sum(quantity)
```

---

## Configuration

Parameters that should be configurable:

| Parameter | Description | Default |
|-----------|-------------|---------|
| param_name | What it controls | value |

---

## Input Data

Where does the data come from?

| Source | Table/API | Fields Used |
|--------|-----------|-------------|
| | | |

---

## Output Data

What gets stored/produced?

| Table | Field | Type | Description |
|-------|-------|------|-------------|
| | | | |

---

## Edge Cases

How to handle unusual situations:

| Scenario | Expected Behavior |
|----------|-------------------|
| Empty data | Return NULL |
| Invalid values | Skip and log warning |
| Missing fields | Use default or NULL |

---

## Acceptance Criteria

Checklist for completion:

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

---

## Examples

### Example 1: Normal Case

**Input:**
```json
{
  "field": "value"
}
```

**Expected Output:**
```json
{
  "result": "value"
}
```

### Example 2: Edge Case

**Input:**
```json
{
  "field": null
}
```

**Expected Output:**
```json
{
  "result": null,
  "reason": "Field was null"
}
```

---

## Notes

Any additional context, links to docs, or related features.
