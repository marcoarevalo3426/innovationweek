import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { createPool } from '../server/pg-config.js';
import { importSQLite } from '../server/sqlite-import.js';
const { values } = parseArgs({options:{source:{type:'string'},'dry-run':{type:'boolean',default:false}}});
if (!values.source) throw new Error('Usage: npm run db:import:sqlite -- --source /path/to/innovation.sqlite [--dry-run]. Stop the old and new apps first.');
const pool = createPool();
try {
  console.log(JSON.stringify(await importSQLite({ source: values.source, pool, targetDir: resolve(process.env.DATA_DIR || './data'), dryRun: values['dry-run'] }),null,2));
} finally { await pool.end(); }
