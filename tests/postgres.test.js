import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, checkSchema } from '../server/migrate.js';
import { poolConfig } from '../server/pg-config.js';
import { importSQLite } from '../server/sqlite-import.js';
import { testDatabase } from './pg-helpers.js';

function fixture(dir) {
  const db = new DatabaseSync(join(dir,'innovation.sqlite'));
  db.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,is_admin INTEGER,created_at TEXT);
    CREATE TABLE ideas(id TEXT PRIMARY KEY,user_id TEXT,title TEXT,problem TEXT,solution TEXT,skills TEXT,image TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE likes(user_id TEXT,idea_id TEXT);
    CREATE TABLE votes(user_id TEXT,idea_id TEXT,round INTEGER);
    CREATE TABLE settings(id INTEGER PRIMARY KEY,mode TEXT,starts_at TEXT,ends_at TEXT,max_votes INTEGER,round INTEGER,show_timer INTEGER,top_votes INTEGER,top_likes INTEGER,innovation_award INTEGER,peoples_award INTEGER);
    CREATE TABLE audit(id INTEGER PRIMARY KEY,at TEXT,actor TEXT,action TEXT,details TEXT);
    INSERT INTO users VALUES('person','person@nepgroup.com',1,'2026-10-01T00:00:00.000Z');
    INSERT INTO ideas VALUES('idea','person','Café & broadcast','A problem','A solution','Design','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.webp','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z');
    INSERT INTO likes VALUES('person','idea');
    INSERT INTO votes VALUES('person','idea',1),('person','idea',4);
    INSERT INTO settings VALUES(1,'open',NULL,NULL,7,4,1,1,0,1,0);
    INSERT INTO audit VALUES(42,'2026-10-01T00:00:00.000Z','person@nepgroup.com','idea.created','{"id":"idea"}');
  `);
  db.close();
  mkdirSync(join(dir,'uploads'));
  writeFileSync(join(dir,'uploads','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.webp'),'fixture image bytes');
  return join(dir,'innovation.sqlite');
}

test('PostgreSQL schema migration is repeatable and preserves settings',async t=>{
  const database=await testDatabase();t.after(()=>database.cleanup());
  await migrate(database.pool);
  await database.pool.query('UPDATE settings SET max_votes=7,round=4,show_welcome=0 WHERE id=1');
  await migrate(database.pool);await checkSchema(database.pool);
  assert.deepEqual((await database.pool.query('SELECT max_votes,round,show_welcome FROM settings')).rows[0],{max_votes:7,round:4,show_welcome:0});
});

test('SQLite import validates full rows, preserves history/files, drops sessions and refuses repetition',async t=>{
  const database=await testDatabase();t.after(()=>database.cleanup());
  const sourceDir=mkdtempSync(join(tmpdir(),'nep-source-')), targetDir=mkdtempSync(join(tmpdir(),'nep-target-'));
  t.after(()=>{rmSync(sourceDir,{recursive:true,force:true});rmSync(targetDir,{recursive:true,force:true});});
  const source=fixture(sourceDir);const before=readFileSync(source);
  await migrate(database.pool);
  const preview=await importSQLite({source,pool:database.pool,targetDir,dryRun:true});
  assert.equal(preview.dryRun,true);assert.equal(preview.counts.votes,2);
  assert.equal(Number((await database.pool.query('SELECT COUNT(*) AS n FROM users')).rows[0].n),0);
  assert.equal(existsSync(join(targetDir,'uploads')),false);
  const report=await importSQLite({source,pool:database.pool,targetDir});
  assert.equal(report.images,1);
  const settings=(await database.pool.query('SELECT * FROM settings')).rows[0];
  assert.equal(settings.round,4);assert.equal(settings.max_votes,7);assert.equal(settings.show_welcome,1);assert.equal(settings.submission_mode,'open');assert.ok(settings.voting_started_at);
  assert.equal((await database.pool.query('SELECT title FROM ideas')).rows[0].title,'Café & broadcast');
  for(const table of ['sessions','challenges'])assert.equal(Number((await database.pool.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n),0);
  assert.equal((await database.pool.query("INSERT INTO audit(at,actor,action,details) VALUES('now','test','test','{}') RETURNING id")).rows[0].id,43);
  assert.equal(readFileSync(join(targetDir,'uploads','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.webp'),'utf8'),'fixture image bytes');
  assert.match(readFileSync(join(targetDir,'audit.jsonl'),'utf8'),/idea.created/);
  assert.deepEqual(readFileSync(source),before);
  await assert.rejects(importSQLite({source,pool:database.pool,targetDir}),/not empty/);
});

test('SQLite import failure rolls back records and copied images',async t=>{
  const database=await testDatabase();t.after(()=>database.cleanup());
  const sourceDir=mkdtempSync(join(tmpdir(),'nep-bad-source-')),targetDir=mkdtempSync(join(tmpdir(),'nep-bad-target-'));
  t.after(()=>{rmSync(sourceDir,{recursive:true,force:true});rmSync(targetDir,{recursive:true,force:true});});
  const source=fixture(sourceDir);const sqlite=new DatabaseSync(source);sqlite.exec("UPDATE ideas SET user_id='missing'");sqlite.close();
  await migrate(database.pool);
  await assert.rejects(importSQLite({source,pool:database.pool,targetDir}));
  assert.equal(Number((await database.pool.query('SELECT COUNT(*) AS n FROM users')).rows[0].n),0);
  assert.equal(existsSync(join(targetDir,'uploads','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.webp')),false);
});

test('remote PostgreSQL requires verified TLS and never accepts a SQLite backend',()=>{
  assert.throws(()=>poolConfig({DB_CLIENT:'sqlite'}),/must be postgres/);
  assert.throws(()=>poolConfig({PGHOST:'db.example.com',PGSSLMODE:'disable'}),/verify-full/);
  assert.throws(()=>poolConfig({PGHOST:'db.example.com'}),/PGSSLROOTCERT/);
  assert.throws(()=>poolConfig({NODE_ENV:'production'}),/Production requires/);
  assert.equal(poolConfig({}).ssl,false);
});

test('an empty legacy import cannot be repeated, and changed target settings are protected',async t=>{
  const database=await testDatabase();t.after(()=>database.cleanup());
  const sourceDir=mkdtempSync(join(tmpdir(),'nep-empty-source-')),targetDir=mkdtempSync(join(tmpdir(),'nep-empty-target-'));
  t.after(()=>{rmSync(sourceDir,{recursive:true,force:true});rmSync(targetDir,{recursive:true,force:true});});
  const source=fixture(sourceDir);const sqlite=new DatabaseSync(source);
  sqlite.exec("DELETE FROM users;DELETE FROM ideas;DELETE FROM votes;DELETE FROM likes;DELETE FROM audit;UPDATE settings SET mode='closed',max_votes=2,round=1,top_votes=0,innovation_award=0");sqlite.close();
  await migrate(database.pool);
  await database.pool.query('UPDATE settings SET max_votes=9 WHERE id=1');
  await assert.rejects(importSQLite({source,pool:database.pool,targetDir}),/settings have been changed/);
  await database.pool.query('UPDATE settings SET max_votes=2 WHERE id=1');
  const report=await importSQLite({source,pool:database.pool,targetDir});assert.equal(report.counts.users,0);
  await assert.rejects(importSQLite({source,pool:database.pool,targetDir}),/not empty/);
});
