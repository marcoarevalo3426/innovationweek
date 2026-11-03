import { recordDbError } from './monitor-telemetry.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, appendFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPool } from './pg-config.js';
import { migrate, checkSchema } from './migrate.js';
import { getVotingStatus, getSubmissionStatus } from '../shared/event-state.js';

export const dataDir = resolve(process.env.DATA_DIR || './data');
mkdirSync(dataDir, { recursive: true });
export const pool = createPool();
pool.on('error', error => console.error('PostgreSQL idle connection error:', error.code || error.message));
try {
  if (process.env.DB_AUTO_MIGRATE === 'true' || (process.env.NODE_ENV !== 'production' && process.env.DB_AUTO_MIGRATE !== 'false')) await migrate(pool);
  await checkSchema(pool);
} catch (error) {
  await pool.end();
  throw new Error('PostgreSQL startup failed. Check connection settings and run npm run db:migrate. No SQLite fallback was used.', { cause: error });
}
const context = new AsyncLocalStorage();
export const query = (sql, args = []) => (context.getStore()?.client || pool).query(sql, args).catch(error => { if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) recordDbError(); throw error; });
export const get = async (sql, ...args) => (await query(sql, args)).rows[0];
export const all = async (sql, ...args) => (await query(sql, args)).rows;
export const run = async (sql, ...args) => query(sql, args);

export async function transaction(fn) {
  if (context.getStore()) return fn();
  const client = await pool.connect();
  const state = { client, afterCommit: [] };
  try {
    await client.query('BEGIN');
    // Match the old single-writer guarantees for this modest event. All app
    // mutations take the same database-scoped lock before checking limits.
    await client.query('SELECT pg_advisory_xact_lock(731901,1)');
    const result = await context.run(state, fn);
    await client.query('COMMIT');
    for (const action of state.afterCommit) action();
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export const SYNTHETIC_ACTOR = 'nep.monitor.synthetic@nepgroup.com';
export async function audit(actor, action, details = {}) {
  if (typeof actor === 'string' && actor.trim().toLowerCase() === SYNTHETIC_ACTOR) return;
  if (!context.getStore()) return transaction(() => audit(actor, action, details));
  const at = new Date().toISOString();
  const inserted = await get('INSERT INTO audit(at,actor,action,details) VALUES($1,$2,$3,$4) RETURNING id', at, actor, action, JSON.stringify(details));
  context.getStore().afterCommit.push(() => {
    if (inserted.id <= auditFileSnapshotId) return;
    try { appendFileSync(resolve(dataDir, 'audit.jsonl'), JSON.stringify({ at, actor, action, details }) + '\n', { mode: 0o600 }); }
    catch (error) { console.error('Audit file write failed:', error.code); }
  });
}
export const settings = () => get('SELECT * FROM settings WHERE id=1');
export const votingState = async (s, now = Date.now()) => getVotingStatus(s || await settings(), now);
export const submissionState = async (s, now = Date.now()) => getSubmissionStatus(s || await settings(), now);
// PostgreSQL is authoritative. Propagate confirmed clears to each node's local
// diagnostic copy, including nodes that were offline when the clear happened.
let lastAuditClearId = 0, auditFileSnapshotId = 0, auditSyncPromise;
export function syncAuditFile() {
  if (auditSyncPromise) return auditSyncPromise;
  auditSyncPromise = transaction(async () => {
    const marker = await get("SELECT id FROM audit WHERE action='admin.audit_cleared' ORDER BY id DESC LIMIT 1");
    if (!marker || marker.id <= lastAuditClearId) return;
    const rows = await all('SELECT id,at,actor,action,details FROM audit WHERE id >= $1 AND LOWER(BTRIM(actor)) <> $2 ORDER BY id', marker.id, SYNTHETIC_ACTOR);
    const temporary = resolve(dataDir, 'audit.jsonl.clear.tmp');
    writeFileSync(temporary, rows.map(({id, ...row}) => JSON.stringify({...row, details: JSON.parse(row.details)}) + '\n').join(''), {mode:0o600});
    renameSync(temporary, resolve(dataDir, 'audit.jsonl'));
    auditFileSnapshotId = rows.at(-1)?.id || marker.id;
    lastAuditClearId = marker.id;
  }).catch(error => console.error('Audit copy synchronization failed:', error.code || error.name)).finally(() => { auditSyncPromise = undefined; });
  return auditSyncPromise;
}
await syncAuditFile();
const auditSyncTimer = setInterval(() => syncAuditFile(), 30000);
auditSyncTimer.unref();
export const db = { close: () => { clearInterval(auditSyncTimer); return pool.end(); } };
