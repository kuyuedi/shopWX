# Usage: Arb Scanner REST Orderbook Fallback

## Deployment

1. Run DB migration to add config keys:
```sql
INSERT INTO direct_exchanges_data.arb_config (config_key, config_value) VALUES
  ('rest_fallback_enabled', 'true'),
  ('rest_refresh_cooldown_sec', '60'),
  ('rest_concurrency', '10'),
  ('rest_timeout_ms', '5000')
ON CONFLICT (config_key) DO NOTHING;
```

2. Ensure `.env` has the required variables:
```bash
KALSHI_API_KEY=<your-key>
KALSHI_REST_URL=https://api.elections.kalshi.com/trade-api/v2
POLYMARKET_CLOB_URL=https://clob.polymarket.com
```

3. Deploy homepage-api:
```bash
./deploy.sh  # or deploy-homepage-api.sh
```

## Monitoring

### Check REST refresh activity in logs
```bash
ssh root@8.216.43.26 "docker compose -f /opt/prediction-market-ingestion/docker-compose.yml logs --tail 100 homepage-api | grep -i 'refresh\|stale'"
```

### Verify coverage improvement
```sql
-- Kalshi freshness should jump from ~35% to >90%
SELECT exchange_id,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE updated_at > NOW() - INTERVAL '900 seconds') AS fresh,
  ROUND(100.0 * COUNT(*) FILTER (WHERE updated_at > NOW() - INTERVAL '900 seconds') / COUNT(*), 1) AS fresh_pct
FROM direct_exchanges_data.market_latest_data
WHERE market_id IN (
  SELECT market_id FROM direct_exchanges_data.market_mappings WHERE confidence_score >= 0.95
)
GROUP BY exchange_id;
```

### Check active arb count
```sql
SELECT COUNT(*) FROM direct_exchanges_data.arb_opportunities WHERE status = 'ACTIVE';
```

## Configuration Tuning

All config is in the `arb_config` DB table — changes take effect within ~5 minutes (next config reload cycle).

```sql
-- Disable REST fallback (kill switch)
UPDATE direct_exchanges_data.arb_config SET config_value = 'false' WHERE config_key = 'rest_fallback_enabled';

-- Re-enable
UPDATE direct_exchanges_data.arb_config SET config_value = 'true' WHERE config_key = 'rest_fallback_enabled';

-- Reduce concurrency if hitting rate limits
UPDATE direct_exchanges_data.arb_config SET config_value = '5' WHERE config_key = 'rest_concurrency';

-- Increase cooldown to reduce API load
UPDATE direct_exchanges_data.arb_config SET config_value = '120' WHERE config_key = 'rest_refresh_cooldown_sec';
```

## Troubleshooting

### No REST fetches happening
- Check `rest_fallback_enabled` is `'true'` in `arb_config`
- Check that `KALSHI_API_KEY` and `KALSHI_PRIVATE_KEY_PATH` env vars are set
- Check logs for initialization errors

### Rate limiting (429s)
- Increase `rest_refresh_cooldown_sec` to reduce request volume
- Decrease `rest_concurrency` to avoid burst traffic
- REST fetches are skipped for the remainder of a cycle after a 429

### Stale legs not being refreshed
- Verify the leg's exchange is supported (currently Kalshi and Polymarket)
- Check cooldown — a leg won't be re-fetched within `rest_refresh_cooldown_sec`
- For Polymarket: verify `source_specific_data->>'token_id'` exists in `prediction_markets` table
