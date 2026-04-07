import pg from 'pg';
import { createLogger } from '../utils/logger.js';

const { Pool } = pg;

const logger = createLogger('db-client');

let pool: pg.Pool | null = null;

export interface DbConfig {
  connectionString: string;
  schema: string;
  maxConnections?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

export function getConfig(): DbConfig {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  return {
    connectionString,
    schema: process.env.DB_SCHEMA || 'direct_exchanges_data',
    maxConnections: parseInt(process.env.DB_MAX_CONNECTIONS || '10', 10),
    idleTimeoutMs: parseInt(process.env.DB_IDLE_TIMEOUT_MS || '30000', 10),
    connectionTimeoutMs: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '10000', 10),
  };
}

export function getPool(): pg.Pool {
  if (!pool) {
    const config = getConfig();

    // Determine SSL settings
    // DB_SSL=true for SSL with certificate verification disabled
    // DB_SSL=false (default) for no SSL
    const sslEnabled = process.env.DB_SSL === 'true';

    pool = new Pool({
      connectionString: config.connectionString,
      max: config.maxConnections,
      idleTimeoutMillis: config.idleTimeoutMs,
      connectionTimeoutMillis: config.connectionTimeoutMs,
      ssl: sslEnabled ? { rejectUnauthorized: false } : false,
    });

    pool.on('connect', (client) => {
      client.query(`SET search_path TO ${config.schema}, public`);
      logger.debug('New client connected to pool');
    });

    pool.on('error', (err) => {
      logger.error({ err }, 'Unexpected error on idle client');
      // Don't crash - the pool will automatically remove bad clients
    });

    logger.info({
      schema: config.schema,
      maxConnections: config.maxConnections
    }, 'Database pool initialized');
  }

  return pool;
}

// Check if an error is a transient network error that can be retried
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  const errorCode = (err as { code?: string }).code;
  const transientCodes = [
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
    'ENOTFOUND',
    'ENETUNREACH',
    'EAI_AGAIN',
    '57P01', // admin_shutdown
    '57P02', // crash_shutdown
    '57P03', // cannot_connect_now
    '08006', // connection_failure
    '08001', // sqlclient_unable_to_establish_sqlconnection
    '08004', // sqlserver_rejected_establishment_of_sqlconnection
  ];

  if (errorCode && transientCodes.includes(errorCode)) {
    return true;
  }

  // Check error message for common network error patterns
  const message = err.message.toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('connection') ||
    message.includes('etimedout') ||
    message.includes('econnreset') ||
    message.includes('network')
  );
}

// Track if pool is being reset to avoid race conditions
let isResetting = false;

// Reset the pool on connection errors
export async function resetPool(): Promise<void> {
  if (isResetting) {
    logger.debug('Pool reset already in progress, skipping');
    return;
  }

  if (pool) {
    isResetting = true;
    const oldPool = pool;
    pool = null; // Clear reference first so new queries get a new pool

    logger.info('Resetting database pool');

    // End old pool in background - don't wait for it
    // This allows in-flight queries to complete
    oldPool.end().catch((err) => {
      logger.warn({ err }, 'Error ending old pool during reset');
    }).finally(() => {
      isResetting = false;
    });

    // Small delay to let the new pool be created
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  // Next call to getPool() will create a new pool
}

export async function query<T extends pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  const pool = getPool();

  try {
    const result = await pool.query<T>(text, params);
    const duration = Date.now() - start;

    logger.debug({
      query: text.substring(0, 100),
      duration,
      rows: result.rowCount
    }, 'Query executed');

    return result;
  } catch (err) {
    logger.error({ err, query: text.substring(0, 100) }, 'Query failed');
    throw err;
  }
}

export async function transaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export function createPool(opts?: { maxConnections?: number; label?: string }): pg.Pool {
  const config = getConfig();
  const sslEnabled = process.env.DB_SSL === 'true';
  const max = opts?.maxConnections ?? config.maxConnections;
  const label = opts?.label ?? 'custom';

  const newPool = new Pool({
    connectionString: config.connectionString,
    max: max,
    idleTimeoutMillis: config.idleTimeoutMs,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    ssl: sslEnabled ? { rejectUnauthorized: false } : false,
  });

  newPool.on('connect', (client) => {
    client.query(`SET search_path TO ${config.schema}, public`);
  });

  newPool.on('error', (err) => {
    logger.error({ err, pool: label }, 'Unexpected error on idle client');
  });

  logger.info({ pool: label, maxConnections: max }, 'Custom pool initialized');
  return newPool;
}

export async function queryWithPool<T extends pg.QueryResultRow>(
  pool: pg.Pool,
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  try {
    const result = await pool.query<T>(text, params);
    logger.debug({ query: text.substring(0, 100), duration: Date.now() - start, rows: result.rowCount }, 'Query executed (pool)');
    return result;
  } catch (err) {
    logger.error({ err, query: text.substring(0, 100) }, 'Query failed (pool)');
    throw err;
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('Database pool closed');
  }
}

export async function healthCheck(maxRetries = 30, initialDelayMs = 3000): Promise<boolean> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await query('SELECT 1 as health');
      if (result.rows.length === 1) {
        if (attempt > 1) {
          logger.info({ attempt }, 'Health check succeeded after retries');
        }
        return true;
      }
    } catch (err) {
      lastError = err;
      const isRecoveryError = err instanceof Error && (
        err.message.includes('recovery mode') ||
        err.message.includes('not yet accepting connections')
      );

      if (attempt < maxRetries) {
        // Use linear backoff with jitter to avoid overwhelming the server while still retrying frequently
        const delay = Math.min(initialDelayMs + (attempt * 1000), 10000) + Math.random() * 1000;
        logger.warn({
          attempt,
          maxRetries,
          delayMs: Math.round(delay),
          isRecoveryError
        }, 'Health check failed, retrying...');

        // Reset pool on transient errors
        if (isTransientError(err)) {
          await resetPool();
        }

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  logger.error({ err: lastError, maxRetries }, 'Health check failed after all retries');
  return false;
}
