-- Seed exchanges table with Kalshi and Polymarket
-- Run this script against your PostgreSQL database to initialize exchange metadata

-- Ensure we're in the correct schema
SET search_path TO direct_exchanges_data, public;

-- Insert Kalshi exchange
INSERT INTO exchanges (exchange_id, name, settlement_type, is_active)
VALUES ('KALSHI', 'Kalshi', 'BINARY', true)
ON CONFLICT (exchange_id) DO UPDATE SET
    name = EXCLUDED.name,
    settlement_type = EXCLUDED.settlement_type,
    is_active = EXCLUDED.is_active;

-- Insert Polymarket exchange
INSERT INTO exchanges (exchange_id, name, settlement_type, is_active)
VALUES ('POLYMARKET', 'Polymarket', 'BINARY', true)
ON CONFLICT (exchange_id) DO UPDATE SET
    name = EXCLUDED.name,
    settlement_type = EXCLUDED.settlement_type,
    is_active = EXCLUDED.is_active;

-- Insert data sources
INSERT INTO data_sources (source_id, source_type, name, refresh_method, refresh_interval_sec, is_active)
VALUES ('KALSHI_DIRECT', 'WEBSOCKET', 'Kalshi Direct WebSocket', 'REALTIME', 0, true)
ON CONFLICT (source_id) DO UPDATE SET
    source_type = EXCLUDED.source_type,
    name = EXCLUDED.name,
    refresh_method = EXCLUDED.refresh_method,
    is_active = EXCLUDED.is_active;

INSERT INTO data_sources (source_id, source_type, name, refresh_method, refresh_interval_sec, is_active)
VALUES ('POLYMARKET_DIRECT', 'WEBSOCKET', 'Polymarket Direct WebSocket', 'REALTIME', 0, true)
ON CONFLICT (source_id) DO UPDATE SET
    source_type = EXCLUDED.source_type,
    name = EXCLUDED.name,
    refresh_method = EXCLUDED.refresh_method,
    is_active = EXCLUDED.is_active;

-- Verify insertions
SELECT 'Exchanges:' as info;
SELECT * FROM exchanges WHERE exchange_id IN ('KALSHI', 'POLYMARKET');

SELECT 'Data Sources:' as info;
SELECT * FROM data_sources WHERE source_id IN ('KALSHI_DIRECT', 'POLYMARKET_DIRECT');
