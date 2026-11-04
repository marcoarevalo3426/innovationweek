import { createPool } from '../server/pg-config.js';
import { checkSchema } from '../server/migrate.js';
const pool = createPool();
try {
  await checkSchema(pool);
  const { rows } = await pool.query('SELECT current_database() AS database, current_user AS username, current_schema() AS schema');
  const counts = {};
  for (const table of ['users','ideas','likes','votes','settings','audit','challenges','sessions','data_imports','feedback']) counts[table] = Number((await pool.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
  console.log(JSON.stringify({ok:true,backend:'postgres',...rows[0],counts},null,2));
} finally { await pool.end(); }
