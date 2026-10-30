import { readFileSync } from 'node:fs';

export const SCHEMA_VERSION = 1;
export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(731901,0)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const { rows } = await client.query('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
    if ((rows[0]?.version || 0) > SCHEMA_VERSION) throw new Error('Database schema is newer than this application.');
    if (!rows.length) {
      await client.query(readFileSync(new URL('./migrations/001-postgresql.sql', import.meta.url), 'utf8'));
      await client.query('INSERT INTO schema_migrations(version,applied_at) VALUES($1,$2)', [SCHEMA_VERSION, new Date().toISOString()]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function checkSchema(pool) {
  const { rows } = await pool.query('SELECT MAX(version) AS version FROM schema_migrations');
  if (rows[0]?.version !== SCHEMA_VERSION) throw new Error('Run npm run db:migrate using the migration owner before starting this release.');
}
