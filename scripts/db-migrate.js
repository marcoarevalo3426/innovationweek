import { createPool } from '../server/pg-config.js';
import { migrate, SCHEMA_VERSION } from '../server/migrate.js';
const pool = createPool();
try {
  await migrate(pool);
  console.log(`PostgreSQL schema is ready (version ${SCHEMA_VERSION}).`);
} finally {
  await pool.end();
}
