import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPool } from './index.js';

const pool = createPool();
const migrationsDir = resolve(process.cwd(), 'migrations');
await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
for (const name of (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort()) {
  const exists = await pool.query('select 1 from schema_migrations where name = $1', [name]);
  if (exists.rowCount) continue;
  const sql = await readFile(resolve(migrationsDir, name), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query('insert into schema_migrations(name) values ($1)', [name]);
    await client.query('commit');
    console.log(`Applied ${name}`);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
await pool.end();
