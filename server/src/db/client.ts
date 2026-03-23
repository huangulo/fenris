import pg from 'pg';
import { Config } from '../types.js';

let pool: pg.Pool | null = null;

export function initDatabase(config: Config['server']): void {
  pool = new pg.Pool({
    connectionString: config.database_url,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });
}

export async function query(text: string, params?: any[]): Promise<any> {
  if (!pool) {
    throw new Error('Database not initialized');
  }
  
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log('Executed query', { text, duration, rows: res.rowCount });
    return res;
  } catch (error) {
    console.error('Database query error', { text, error });
    throw error;
  }
}

export async function getClient(): Promise<pg.PoolClient> {
  if (!pool) {
    throw new Error('Database not initialized');
  }
  
  const client = await pool.connect();
  return client;
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// Initialize tables on startup
export async function initializeTables(): Promise<void> {
  const client = await getClient();
  try {
    const schema = await import('./schema.js', { assert: { type: 'json' } });
    const sql = schema.default;
    
    // Execute schema
    await client.query(sql);
    console.log('Database tables initialized');
  } finally {
    client.release();
  }
}
