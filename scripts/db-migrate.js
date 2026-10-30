import { createPool } from '../server/pg-config.js';
import { migrate } from '../server/migrate.js';
const pool = createPool();
try {
  await migrate(pool);
  console.log('PostgreSQL schema is ready (version 1).');
} finally {
  await pool.end();
}
