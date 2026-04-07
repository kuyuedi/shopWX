# Documentation

## Overview

Real-time prediction market data ingestion system that connects to **Kalshi**, **Polymarket**, and **Opinion.trade** exchanges via WebSocket APIs. Ingests market data, trades, and order book updates into a PostgreSQL database. Includes cross-exchange event matching, market matching, and arbitrage detection.

**Key capabilities:**
- Real-time WebSocket connections to prediction market exchanges
- Order book, trade, and price data ingestion
- Batch writing for high-throughput database operations
- Automatic reconnection with exponential backoff
- Cross-exchange event & market matching via OpenAI (event-matcher)
- Arbitrage opportunity detection (homepage-api arb scanner)
- System health monitoring with Telegram alerts (healthcheck)

## Contents

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System architecture, data flow, components |
| [CONFIGURATION.md](./CONFIGURATION.md) | Runtime configuration: DB tables, parameters, tuning guide |
| [WORKFLOW.md](./WORKFLOW.md) | Development workflow for PO and Developer |

## Feature Requests

Located in `features/`:

| File | Description |
|------|-------------|
| `_TEMPLATE.md` | Template for new feature specs |
| `README.md` | Instructions for creating features |

To request a new feature:
1. Copy `features/_TEMPLATE.md`
2. Fill in all sections
3. Save as `features/your-feature-name.md`

## Quick Links

- **Repository**: https://github.com/kuyuedi/prediction
- **Issues**: https://github.com/kuyuedi/prediction/issues
- **Server**: 8.216.43.26 (Japan)
