import { getPool, createLogger } from '@prediction-market/shared';
import type { CheckResult, Config } from '../types.js';

const logger = createLogger('database-check');

interface DataFlowRow {
  exchange_id: string;
  count: string;
  latest: Date;
}

export async function checkDatabaseConnection(): Promise<CheckResult> {
  try {
    const pool = getPool();
    const result = await pool.query('SELECT 1 as health');

    if (result.rows.length === 1) {
      logger.debug('Database connection healthy');
      return {
        name: 'database:connection',
        healthy: true,
        message: 'Database connection successful',
      };
    }

    return {
      name: 'database:connection',
      healthy: false,
      level: 'critical',
      message: 'Database query returned unexpected result',
    };
  } catch (err) {
    logger.error({ err }, 'Database connection failed');
    return {
      name: 'database:connection',
      healthy: false,
      level: 'critical',
      message: `Database unreachable: ${err instanceof Error ? err.message : 'Unknown error'}`,
      details: {
        Error: err instanceof Error ? err.message : 'Unknown',
      },
    };
  }
}

export async function checkDataFlow(config: Config): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  try {
    const pool = getPool();
    const query = `
      SELECT
        exchange_id,
        COUNT(*) as count,
        MAX(created_at) as latest
      FROM order_books
      WHERE created_at > NOW() - INTERVAL '${config.dataFlowCheckMinutes} minutes'
      GROUP BY exchange_id
    `;

    const result = await pool.query<DataFlowRow>(query);

    if (result.rows.length === 0) {
      // No data at all - both exchanges stopped
      results.push({
        name: 'dataflow:all',
        healthy: false,
        level: 'critical',
        message: `No order book data received in the last ${config.dataFlowCheckMinutes} minutes`,
        details: {
          'Check Period': `${config.dataFlowCheckMinutes} minutes`,
          'Records Found': 0,
        },
      });
      return results;
    }

    const exchangeData = new Map<string, { count: number; latest: Date }>();
    for (const row of result.rows) {
      exchangeData.set(row.exchange_id, {
        count: parseInt(row.count, 10),
        latest: row.latest,
      });
    }

    // Check each expected exchange (uppercase to match database values)
    const expectedExchanges = ['KALSHI', 'POLYMARKET'];

    for (const exchange of expectedExchanges) {
      const data = exchangeData.get(exchange);

      if (!data) {
        results.push({
          name: `dataflow:${exchange}`,
          healthy: false,
          level: 'critical',
          message: `No data from ${exchange} in last ${config.dataFlowCheckMinutes} minutes`,
          details: {
            Exchange: exchange,
            'Records Found': 0,
            Action: 'Check WebSocket connection and listener service',
          },
        });
        continue;
      }

      if (data.count < config.dataFlowMinRecords) {
        results.push({
          name: `dataflow:${exchange}`,
          healthy: false,
          level: 'warning',
          message: `Low data flow from ${exchange}: ${data.count} records in ${config.dataFlowCheckMinutes} min`,
          details: {
            Exchange: exchange,
            'Records Found': data.count,
            'Minimum Expected': config.dataFlowMinRecords,
            'Latest Record': data.latest.toISOString(),
          },
        });
        continue;
      }

      logger.debug({ exchange, count: data.count }, 'Data flow healthy');
      results.push({
        name: `dataflow:${exchange}`,
        healthy: true,
        message: `${exchange} data flow healthy: ${data.count} records in ${config.dataFlowCheckMinutes} min`,
      });
    }

    return results;
  } catch (err) {
    logger.error({ err }, 'Failed to check data flow');
    return [
      {
        name: 'dataflow:all',
        healthy: false,
        level: 'critical',
        message: `Failed to check data flow: ${err instanceof Error ? err.message : 'Unknown error'}`,
      },
    ];
  }
}
