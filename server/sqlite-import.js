import { DEFAULT_FOOTER } from '../shared/footer-settings.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, copyFileSync, existsSync, chmodSync, unlinkSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { checkSchema } from './migrate.js';

const columns = {
  users: ['id','email','is_admin','created_at'],
  ideas: ['id','user_id','title','problem','solution','skills','image','created_at','updated_at'],
  settings: ['id','mode','starts_at','ends_at','max_votes','round','show_timer','top_votes','top_likes','innovation_award','peoples_award','submission_mode','submission_ends_at','show_welcome','voting_started_at','footer_text','footer_link_text','footer_url','max_ideas'],
  likes: ['user_id','idea_id'],
  votes: ['user_id','idea_id','round'],
  audit: ['id','at','actor','action','details'],
};
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const canonical = (table, rows) => rows.map(row => JSON.stringify(columns[table].map(key => row[key] ?? null))).sort();

export async function importSQLite({ source, pool, targetDir, dryRun = false }) {
  if (!source || !existsSync(source)) throw new Error('Provide an existing SQLite file with --source /absolute/path/innovation.sqlite.');
  if (!targetDir) throw new Error('DATA_DIR is required for uploaded images and the audit file.');
  source = resolve(source);
  targetDir = resolve(targetDir);
  const legacy = new DatabaseSync(source, { readOnly: true });
  const rows = {};
  try {
    if (legacy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Source SQLite integrity check failed.');
    if (legacy.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Source SQLite contains broken foreign keys.');
    legacy.exec('BEGIN');
    for (const table of Object.keys(columns)) rows[table] = legacy.prepare(`SELECT * FROM ${table}`).all();
    legacy.exec('COMMIT');
  } finally { legacy.close(); }
  if (rows.settings.length !== 1 || rows.settings[0].id !== 1) throw new Error('Source must have exactly one settings row with id=1.');
  const old = rows.settings[0];
  old.submission_mode ??= 'open';
  old.submission_ends_at ??= null;
  old.show_welcome ??= 1;
  old.max_ideas ??= 2;
  for (const [key, value] of Object.entries(DEFAULT_FOOTER)) old[key] ??= value;
  if (!Object.hasOwn(old, 'voting_started_at')) {
    const started = old.mode === 'open' || Date.parse(old.starts_at) <= Date.now() || Date.parse(old.ends_at) <= Date.now() || rows.votes.some(vote => vote.round === old.round);
    old.voting_started_at = started ? (Date.parse(old.starts_at) <= Date.now() ? old.starts_at : new Date().toISOString()) : null;
  }
  const images = [...new Set(rows.ideas.map(idea => idea.image).filter(Boolean))];
  for (const name of images) {
    if (!/^[a-f0-9-]+\.webp$/.test(name) || !existsSync(resolve(dirname(source),'uploads',name))) throw new Error(`Missing or invalid source image: ${name}`);
    const destination = resolve(targetDir,'uploads',name);
    if (existsSync(destination) && digest(destination) !== digest(resolve(dirname(source),'uploads',name))) throw new Error(`Target image conflicts with source: ${name}`);
  }
  for (const row of rows.audit) JSON.parse(row.details);
  await checkSchema(pool);
  const client = await pool.connect();
  const copied = [];
  let committed = false;
  let commitAttempted = false;
  const counts = Object.fromEntries(Object.entries(rows).map(([table, values]) => [table, values.length]));
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(731901,1)');
    // The importer runs during downtime. Refuse all existing application rows,
    // including audit-only/local-admin activity and previously imported data.
    for (const table of ['users','ideas','likes','votes','audit','challenges','sessions','data_imports']) {
      const result = await client.query(`SELECT COUNT(*) AS n FROM ${table}`);
      if (Number(result.rows[0].n)) throw new Error(`Target is not empty (${table}). Import refused; no rows were replaced.`);
    }
    const pristine = {id:1,mode:'closed',starts_at:null,ends_at:null,max_votes:2,round:1,show_timer:1,top_votes:0,top_likes:0,innovation_award:0,peoples_award:0,submission_mode:'open',submission_ends_at:null,show_welcome:1,voting_started_at:null,max_ideas:2,...DEFAULT_FOOTER};
    const currentSettings = (await client.query('SELECT * FROM settings WHERE id=1')).rows[0];
    if (!currentSettings || Object.keys(pristine).some(key => currentSettings[key] !== pristine[key])) throw new Error('Target settings have been changed. Import refused; use a fresh target.');
    if (dryRun) {
      await client.query('ROLLBACK');
      return { dryRun: true, counts, images: images.length, sessionsImported: 0, challengesImported: 0 };
    }
    // Copy files before committing records. Existing identical files are kept.
    mkdirSync(resolve(targetDir,'uploads'), { recursive: true, mode: 0o750 });
    for (const name of images) {
      const destination = resolve(targetDir,'uploads',name);
      if (!existsSync(destination)) {
        copyFileSync(resolve(dirname(source),'uploads',name), destination);
        copied.push(destination);
        chmodSync(destination, 0o600);
      }
    }
    await client.query('DELETE FROM settings WHERE id=1');
    for (const table of Object.keys(columns)) {
      const keys = columns[table];
      for (const row of rows[table]) {
        await client.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,index) => '$'+(index+1)).join(',')})`,keys.map(key => row[key] ?? null));
      }
      const imported = (await client.query(`SELECT ${keys.join(',')} FROM ${table}`)).rows;
      if (JSON.stringify(canonical(table, imported)) !== JSON.stringify(canonical(table, rows[table]))) throw new Error(`Validation mismatch for ${table}; transaction rolled back.`);
    }
    await client.query("SELECT setval(pg_get_serial_sequence('audit','id'), COALESCE((SELECT MAX(id) FROM audit),1), EXISTS(SELECT 1 FROM audit))");
    const fingerprint = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(columns).map(table => [table,canonical(table,rows[table])])))).digest('hex');
    await client.query('INSERT INTO data_imports(id,source_fingerprint,imported_at) VALUES(1,$1,$2)',[fingerprint,new Date().toISOString()]);
    commitAttempted = true;
    await client.query('COMMIT');
    committed = true;
    // Rebuild the historical file from the authoritative imported audit rows.
    // Do not merge an unrelated target file into the history.
    const log = resolve(targetDir,'audit.jsonl');
    if (!existsSync(log)) {
      for (const row of [...rows.audit].sort((a,b) => a.id-b.id)) appendFileSync(log,JSON.stringify({at:row.at,actor:row.actor,action:row.action,details:JSON.parse(row.details)})+'\n',{mode:0o600});
    }
    return { dryRun: false, counts, images: images.length, sessionsImported: 0, challengesImported: 0 };
  } catch (error) {
    if (!committed) {
      await client.query('ROLLBACK');
      if (!commitAttempted) for (const path of copied) try { unlinkSync(path); } catch {}
    }
    if (commitAttempted && !committed) throw new Error('Commit outcome is uncertain. Copied images were preserved. Check target rows before retrying import.', { cause: error });
    if (committed) throw new Error('Rows were imported successfully, but writing the file log failed. Do not rerun import; inspect the target and restore the file log separately.', { cause: error });
    throw error;
  } finally { client.release(); }
}
