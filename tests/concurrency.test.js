import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { testDatabase } from './pg-helpers.js';

async function fixture(t) {
  const database=await testDatabase();
  const dir=mkdtempSync(join(tmpdir(),'nep-concurrency-'));
  const server=spawn(process.execPath,['server/index.js'],{env:{...database.env,DATA_DIR:dir,PORT:'0',HOST:'127.0.0.1',NODE_ENV:'test',LOCAL_AUTH_BYPASS:'false',MAIL_MODE:'console',ADMIN_EMAILS:'admin@nepgroup.com,coadmin@nepgroup.com'},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(server.exitCode===null){const stopped=once(server,'exit');server.kill('SIGTERM');await stopped;}await database.cleanup();rmSync(dir,{recursive:true,force:true});});
  let stderr='';server.stderr.on('data',data=>stderr+=data);
  const base=await new Promise((resolve,reject)=>{
    let output='';const timeout=setTimeout(()=>reject(new Error('Startup timeout '+stderr)),10000);
    server.stdout.on('data',data=>{output+=data;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timeout);resolve(match[0]);}});
    server.once('exit',code=>{clearTimeout(timeout);reject(new Error('Server exited '+code+' '+stderr));});
  });
  async function request(path,{method='GET',body,cookie}={}) {
    const res=await fetch(base+'/api'+path,{method,headers:{'X-Requested-With':'InnovationWeek',...(body instanceof FormData?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{})},body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
    return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};
  }
  async function login(email) {
    const code=await request('/auth/request',{method:'POST',body:{email}});
    assert.equal(code.status,200);
    const signed=await request('/auth/verify',{method:'POST',body:{email,code:code.data.developmentCode}});
    assert.equal(signed.status,200);
    return signed;
  }
  function idea(title) {
    const body=new FormData();for(const [key,value] of Object.entries({full_name:'Alex Example',title,problem:'Problem',solution:'Solution',skills:'Engineering'}))body.set(key,value);return body;
  }
  return {database,dir,request,login,idea};
}

test('PostgreSQL serializes submission/vote limits, OTP consumption and final administrator removal',async t=>{
  const {database,request,login,idea}=await fixture(t);
  const alice=await login('alice@nepgroup.com'),admin=await login('admin@nepgroup.com'),coadmin=await login('coadmin@nepgroup.com');
  const submitted=await Promise.all([1,2,3].map(n=>request('/ideas',{method:'POST',body:idea('Idea '+n),cookie:alice.cookie})));
  assert.deepEqual(submitted.map(result=>result.status).sort(),[201,201,409]);
  const ideas=submitted.filter(result=>result.status===201).map(result=>result.data);
  const extra=await request('/ideas',{method:'POST',body:idea('Admin idea'),cookie:admin.cookie});
  assert.equal(extra.status,201);ideas.push(extra.data);
  await request('/admin/settings',{method:'PATCH',body:{mode:'open',ends_at:new Date(Date.now()+60000).toISOString()},cookie:admin.cookie});
  const votes=await Promise.all(ideas.map(item=>request('/ideas/'+item.id+'/vote',{method:'POST',cookie:alice.cookie})));
  assert.deepEqual(votes.map(result=>result.status).sort(),[200,200,409]);
  const gallery=await request('/ideas',{cookie:alice.cookie});
  assert.equal(gallery.data.votesUsed,2);assert.equal(typeof gallery.data.ideas[0].votes,'number');
  const email='parallel@nepgroup.com';
  const sent=await request('/auth/request',{method:'POST',body:{email}});
  const verified=await Promise.all([1,2].map(()=>request('/auth/verify',{method:'POST',body:{email,code:sent.data.developmentCode}})));
  assert.deepEqual(verified.map(result=>result.status).sort(),[200,400]);
  const attemptsEmail='attempts@nepgroup.com';
  const attemptsCode=await request('/auth/request',{method:'POST',body:{email:attemptsEmail}});
  const wrong=attemptsCode.data.developmentCode==='111111'?'222222':'111111';
  const failed=await Promise.all(Array.from({length:5},()=>request('/auth/verify',{method:'POST',body:{email:attemptsEmail,code:wrong}})));
  assert.ok(failed.every(result=>result.status===400));
  assert.equal((await request('/auth/verify',{method:'POST',body:{email:attemptsEmail,code:attemptsCode.data.developmentCode}})).status,400);
  assert.equal(Number((await database.pool.query('SELECT attempts FROM challenges WHERE email=$1',[attemptsEmail])).rows[0].attempts),5);
  const removals=await Promise.all([admin,coadmin].map(user=>request('/admin/users/'+user.data.user.id,{method:'PATCH',body:{is_admin:0},cookie:user.cookie})));
  assert.deepEqual(removals.map(result=>result.status).sort(),[200,409]);
  assert.equal(Number((await database.pool.query('SELECT COUNT(*) AS n FROM users WHERE is_admin=1')).rows[0].n),1);
});

test('rolled-back PostgreSQL changes do not append successful audit file events',async t=>{
  const database=await testDatabase();const dir=mkdtempSync(join(tmpdir(),'nep-rollback-'));
  t.after(async()=>{await database.cleanup();rmSync(dir,{recursive:true,force:true});});
  const code=`import {transaction,run,audit,db} from './server/db.js'; try {await transaction(async()=>{await run("INSERT INTO users(id,email,is_admin,created_at) VALUES($1,$2,0,$3)",'rollback','rollback@nepgroup.com','now');await audit('rollback','should.not.commit');throw Error('expected');});} catch(error){if(error.message!=='expected')throw error;} await db.close();`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{...database.env,NODE_ENV:'test',DATA_DIR:dir},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',data=>stderr+=data);const [status]=await once(child,'exit');
  assert.equal(status,0,stderr);
  assert.equal(Number((await database.pool.query('SELECT COUNT(*) AS n FROM users')).rows[0].n),0);
  assert.equal(Number((await database.pool.query('SELECT COUNT(*) AS n FROM audit')).rows[0].n),0);
  assert.ok(!existsSync(join(dir,'audit.jsonl'))||!readFileSync(join(dir,'audit.jsonl'),'utf8').includes('should.not.commit'));
});


test('nodes returning after a log clear rebuild their diagnostic copy from the shared clear boundary',async t=>{
  const database=await testDatabase(),dir=mkdtempSync(join(tmpdir(),'nep-audit-clear-'));
  t.after(async()=>{await database.cleanup();rmSync(dir,{recursive:true,force:true});});
  async function node(n,code){
    const child=spawn(process.execPath,['--input-type=module','-e',`import {audit,db} from './server/db.js';${code};await db.close();`],{env:{...database.env,NODE_ENV:'test',DATA_DIR:join(dir,String(n))},stdio:['ignore','pipe','pipe']});
    let stderr='';child.stderr.on('data',d=>stderr+=d);const [status]=await once(child,'exit');assert.equal(status,0,stderr);
  }
  await node(0,"await audit('real@nepgroup.com','before.clear')");await node(1,"await audit('real@nepgroup.com','before.clear')");
  await database.pool.query('DELETE FROM audit');
  await database.pool.query("INSERT INTO audit(at,actor,action,details) VALUES('now','admin@nepgroup.com','admin.audit_cleared','{}'),('later','real@nepgroup.com','after.clear','{}')");
  for(const n of [0,1]){
    await node(n,"await audit(' NEP.MONITOR.SYNTHETIC@NEPGROUP.COM ','ignored.monitor')");
    const contents=readFileSync(join(dir,String(n),'audit.jsonl'),'utf8');assert.ok(!contents.includes('before.clear'));assert.ok(!contents.includes('ignored.monitor'));assert.ok(contents.includes('admin.audit_cleared'));assert.ok(contents.includes('after.clear'));
  }
});


test('a delayed commit acknowledgement cannot append pre-clear history after a clear snapshot',async t=>{
  const database=await testDatabase(),dir=mkdtempSync(join(tmpdir(),'nep-audit-race-'));
  t.after(async()=>{await database.cleanup();rmSync(dir,{recursive:true,force:true});});
  const code=`import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {join} from 'node:path';import {pool,transaction,run,audit,syncAuditFile,db} from './server/db.js';
    let resume,seen;const gate=new Promise(r=>resume=r),committed=new Promise(r=>seen=r);let hold=true;
    const connect=pool.connect.bind(pool);pool.connect=async()=>{const client=await connect();const query=client.query.bind(client);client.query=(...args)=>{const result=query(...args);if(args[0]==='COMMIT'&&hold){hold=false;return result.then(async value=>{seen();await gate;return value;});}return result;};return client;};
    const writing=transaction(()=>audit('real@nepgroup.com','before.clear.delayed'));
    await committed;
    await transaction(async()=>{await run('DELETE FROM audit');await audit('admin@nepgroup.com','admin.audit_cleared');});
    await syncAuditFile();resume();await writing;
    const contents=readFileSync(join(process.env.DATA_DIR,'audit.jsonl'),'utf8');assert.ok(contents.includes('admin.audit_cleared'));assert.ok(!contents.includes('before.clear.delayed'));await db.close();`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{...database.env,NODE_ENV:'test',DATA_DIR:dir},stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',d=>stderr+=d);const [status]=await once(child,'exit');assert.equal(status,0,stderr);
});


test('concurrent administrator account deletions retain a valid administrator',async t=>{
 const {database,request,login}=await fixture(t);
 const a=await login('admin@nepgroup.com'),b=await login('coadmin@nepgroup.com');
 const result=await Promise.all([[a,b],[b,a]].map(([actor,target])=>request('/admin/users/'+target.data.user.id,{method:'DELETE',body:{confirmed:true},cookie:actor.cookie})));
 assert.equal(result.filter(r=>r.status===200).length,1);assert.ok(result.every(r=>[200,401,403,409].includes(r.status)));
 assert.equal((await database.pool.query('SELECT COUNT(*) AS n FROM users WHERE is_admin=1')).rows[0].n,1);
});
