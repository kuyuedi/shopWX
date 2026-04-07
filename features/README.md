# Feature Requests

This folder contains feature specifications for the development team.

## Folder Structure

Each feature has its own folder with three documentation files:

```
features/
├── README.md                      # This file
├── _template/                     # Template folder (copy for new features)
│   ├── requirements.md
│   ├── usage.md
│   └── technical.md
└── YYYY-MM-DD-feature-name/       # Date-prefixed feature folders
    ├── requirements.md            # PO requirements and acceptance criteria
    ├── usage.md                   # How to use and verify the feature
    └── technical.md               # Technical implementation details
```

### Naming Convention

- Format: `YYYY-MM-DD-feature-name/`
- Date is when feature was first created/requested
- Examples:
  - `2026-02-04-band-metrics/`
  - `2026-02-10-market-alerts/`
  - `2026-03-01-historical-snapshots/`

## How to Request a Feature

1. **Copy the template folder**: `cp -r _template/ YYYY-MM-DD-feature-name/`
2. **Fill in requirements.md**: Define the problem, solution, and acceptance criteria
3. **Leave usage.md and technical.md** for the developer to complete
4. **Notify the developer**: They will review and implement

## Documentation Files

| File | Owner | Purpose |
|------|-------|---------|
| `requirements.md` | PO | What the feature should do |
| `usage.md` | Developer | How to use and verify it works |
| `technical.md` | Developer | Implementation details |

## Status

Add status at the top of `requirements.md`:
- `Status: NEW` - Just created, not yet reviewed
- `Status: IN PROGRESS` - Being implemented
- `Status: COMPLETED` - Done and deployed
- `Status: ON HOLD` - Waiting for clarification

## Tips for Good Specs

1. **Be specific** - Include exact formulas and logic
2. **Give examples** - Show input -> expected output
3. **Define edge cases** - What happens with bad data?
4. **Set priority** - Is this urgent or nice-to-have?

## Current Features

| Folder | Status | Description |
|--------|--------|-------------|
| `2026-02-04-band-metrics/` | COMPLETED | Best price, band liquidity & VWAP calculation |
| `2026-02-18-gamma-market-id/` | COMPLETED | Use Gamma numeric market ID instead of clobTokenId for Polymarket |
