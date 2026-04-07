import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const tables = ['prediction_markets', 'market_latest_data', 'order_books', 'quotes', 'trades'];
const schema = process.env.DB_SCHEMA || 'direct_exchanges_data';

const counts = {};
for (const table of tables) {
  const result = await pool.query(`SELECT COUNT(*) as count FROM ${schema}.${table}`);
  counts[table] = parseInt(result.rows[0].count);
  console.log(`${table}: ${counts[table]}`);
}
await pool.end();
