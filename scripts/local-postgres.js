import EmbeddedPostgres from 'embedded-postgres';
import { resolve } from 'node:path';

if (process.env.NODE_ENV === 'production') throw new Error('db:local is a development tool. Use a managed database in production.');
if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.PGHOST || '127.0.0.1')) throw new Error('db:local only runs a loopback PostgreSQL server.');
const server = new EmbeddedPostgres({
  databaseDir: resolve(process.env.LOCAL_PG_DIR || './data/postgres'),
  user: process.env.PGUSER || 'innovation',
  password: process.env.PGPASSWORD || 'innovation_local_only',
  port: Number(process.env.PGPORT || 5432),
  persistent: true,
  authMethod: 'scram-sha-256',
  postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.stop();
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
await server.initialise();
await server.start();
try { await server.createDatabase(process.env.PGDATABASE || 'innovation_week'); }
catch (error) { if (error.code !== '42P04') throw error; }
console.log('Local PostgreSQL ready. Keep this terminal open; run npm run db:migrate in another terminal.');
