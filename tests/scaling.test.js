import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDatabase } from './pg-helpers.js';
import { migrate } from '../server/migrate.js';
import { PgRateLimitStore } from '../server/pg-rate-limit-store.js';

const sql=readFileSync(new URL('../deploy/autoscaling/rate-limit-store.sql',import.meta.url),'utf8');
test('distributed counters are atomic, reset correctly and isolate limiter namespaces',async t=>{
  const database=await testDatabase();t.after(()=>database.cleanup());
  await database.pool.query(sql);
  const a=new PgRateLimitStore(database.pool,'auth'),b=new PgRateLimitStore(database.pool,'auth'),other=new PgRateLimitStore(database.pool,'other');
  for(const store of [a,b,other]){store.init({windowMs:60000});t.after(()=>store.shutdown());}
  const increments=await Promise.all(Array.from({length:20},(_,i)=>(i%2?a:b).increment('shared')));
  assert.deepEqual(increments.map(x=>x.totalHits).sort((a,b)=>a-b),Array.from({length:20},(_,i)=>i+1));
  assert.equal((await other.increment('shared')).totalHits,1);
  await database.pool.query('UPDATE api_rate_limits SET expires=0 WHERE prefix=$1',['auth']);
  assert.equal((await a.increment('shared')).totalHits,1);
  await b.decrement('shared');await b.decrement('shared');
  assert.equal((await a.increment('shared')).totalHits,1);
  await b.resetKey('shared');assert.equal((await a.increment('shared')).totalHits,1);
});

test('two API processes share email verification, sessions, limits and compressed idea responses',async t=>{
  const database=await testDatabase();t.after(()=>database.cleanup());
  await migrate(database.pool);await database.pool.query(sql);
  const root=mkdtempSync(join(tmpdir(),'nep-fleet-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const nodes=[];
  for(let n=0;n<2;n++){
    const node=spawn(process.execPath,['server/index.js'],{env:{...database.env,DATA_DIR:join(root,String(n)),PORT:'0',HOST:'127.0.0.1',NODE_ENV:'test',LOCAL_AUTH_BYPASS:'false',MAIL_MODE:'console',SESSION_SECRET:'shared-fleet-test-secret-at-least-32-characters',RATE_LIMIT_STORE:'postgres',IMAGE_STORAGE:'local',DB_AUTO_MIGRATE:'false',ADMIN_EMAILS:'admin@nepgroup.com'},stdio:['ignore','pipe','pipe']});
    t.after(async()=>{if(node.exitCode===null&&node.signalCode===null){const stopped=once(node,'exit');node.kill('SIGTERM');await stopped;}});
    let output='',errors='';node.stderr.on('data',d=>errors+=d);
    const base=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error(errors||'Startup timeout')),10000);
      node.stdout.on('data',d=>{output+=d;const found=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(found){clearTimeout(timeout);resolve(found[0]);}});
      node.once('exit',()=>{clearTimeout(timeout);reject(Error(errors));});
    });nodes.push(base);
  }
  async function request(n,path,body,cookie){return fetch(nodes[n]+'/api'+path,{method:body?'POST':'GET',headers:{'X-Requested-With':'InnovationWeek','Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});}
  const email='colleague@nepgroup.com';
  const sent=await (await request(0,'/auth/request',{email})).json();assert.match(sent.developmentCode,/^\d{6}$/);
  const signed=await request(1,'/auth/verify',{email,code:sent.developmentCode});assert.equal(signed.status,200);
  const cookie=signed.headers.get('set-cookie').split(';')[0];
  for(let n=0;n<2;n++)assert.equal((await (await request(n,'/auth/me',null,cookie)).json()).user.email,email);
  assert.equal((await request(0,'/auth/verify',{email,code:sent.developmentCode})).status,400);
  const form=new FormData();for(const [key,value] of Object.entries({title:'Shared idea',problem:'A'.repeat(3000),solution:'B'.repeat(3000),skills:'Engineering'}))form.set(key,value);
  const created=await fetch(nodes[0]+'/api/ideas',{method:'POST',headers:{'X-Requested-With':'InnovationWeek',Cookie:cookie},body:form});assert.equal(created.status,201);
  const response=await fetch(nodes[1]+'/api/ideas',{headers:{Cookie:cookie,'Accept-Encoding':'gzip'}});
  assert.equal(response.headers.get('content-encoding'),'gzip');assert.match(response.headers.get('cache-control'),/private.*no-store/);
  assert.equal((await response.json()).ideas[0].title,'Shared idea');
  for(let i=0;i<40;i++)assert.equal((await request(i%2,'/auth/verify',{email:'rate-check@nepgroup.com',code:'000000'})).status,400);
  assert.equal((await request(1,'/auth/verify',{email:'rate-check@nepgroup.com',code:'000000'})).status,429);
});
