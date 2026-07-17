import pg from 'pg';
const { Pool } = pg;

export type DatabasePool = pg.Pool;
export type DatabaseClient = pg.PoolClient;
export type Queryable = Pick<pg.Pool, 'query'>;

export function createPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) throw new Error('DATABASE_URL is required.');
  return new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: process.env.ECHO_SERVICE_NAME ?? 'echo-foundation'
  });
}

export async function withTransaction<T>(pool: DatabasePool, work: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
