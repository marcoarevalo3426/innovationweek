import EmbeddedPostgres from 'embedded-postgres';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

if (process.env.NODE_ENV === 'production') throw new Error('db:local is a development tool. Use a managed database in production.');
if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.PGHOST || '127.0.0.1')) throw new Error('db:local only runs a loopback PostgreSQL server.');
const directory = resolve(process.env.LOCAL_PG_DIR || resolve(process.env.DATA_DIR || './data', 'postgres'));
const server = new EmbeddedPostgres({
  databaseDir: directory,
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
  process.exitCode = 0;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
if (!existsSync(resolve(directory, 'PG_VERSION'))) await server.initialise();
await server.start();
const client = server.getPgClient('postgres', '127.0.0.1');
try {
  await client.connect();
  const name = process.env.PGDATABASE || 'innovation_week';
  if (!(await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount) {
    await client.query('CREATE DATABASE ' + client.escapeIdentifier(name));
  }
} catch (error) {
  await server.stop();
  throw error;
} finally {
  await client.end();
}
console.log('Local PostgreSQL ready. Keep this terminal open; run npm run db:migrate in another terminal.');
