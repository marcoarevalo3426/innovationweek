import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { testDatabase } from './pg-helpers.js';
import { isLocalAuthEnabled } from '../server/auth-mode.js';

test('local authentication bypass is limited to development on loopback',()=>{
  assert.equal(isLocalAuthEnabled({}),true);
  assert.equal(isLocalAuthEnabled({NODE_ENV:'development',HOST:'localhost'}),true);
  assert.equal(isLocalAuthEnabled({NODE_ENV:'development',HOST:'::1'}),true);
  for(const env of [
    {NODE_ENV:'production',LOCAL_AUTH_BYPASS:'true'},
    {NODE_ENV:'test',LOCAL_AUTH_BYPASS:'true'},
    {NODE_ENV:'staging',LOCAL_AUTH_BYPASS:'true'},
    {HOST:'0.0.0.0',LOCAL_AUTH_BYPASS:'true'},
    {HOST:'example.com',LOCAL_AUTH_BYPASS:'true'},
    {LOCAL_AUTH_BYPASS:'false'},
  ]) assert.equal(isLocalAuthEnabled(env),false,JSON.stringify(env));
});

async function start(t,dataDir,overrides={}){
  const server=spawn(process.execPath,['server/index.js'],{env:{...process.env,...t.database.env,DATA_DIR:dataDir,PORT:'0',HOST:'127.0.0.1',NODE_ENV:'development',LOCAL_AUTH_BYPASS:'true',MAIL_MODE:'smtp',SMTP_HOST:'',SMTP_USER:'',SMTP_PASS:'',MAIL_FROM:'',ADMIN_EMAILS:'admin@nepgroup.com',...overrides},stdio:['ignore','pipe','pipe']});
  const stop=async()=>{if(server.exitCode===null&&server.signalCode===null){const exited=once(server,'exit');server.kill('SIGTERM');await exited;}};
  t.after(stop);
  let stdout='',stderr='';server.stderr.on('data',d=>stderr+=d);
  const base=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('Startup timed out: '+stderr)),10000);
    server.stdout.on('data',d=>{stdout+=d;const match=stdout.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timeout);resolve(match[0]);}});
    server.once('exit',code=>{clearTimeout(timeout);reject(Error('Server exited '+code+': '+stderr));});
  });
  const request=async(path,{method='GET',body}={})=>{
    const response=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json','X-Requested-With':'InnovationWeek'},body:body?JSON.stringify(body):undefined});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')};
  };
  return {base,request,stop,output:()=>stdout};
}

test('local access skips email and sessions, and production still requires authentication',async t=>{
  t.database=await testDatabase();
  t.after(()=>t.database.cleanup());
  const dir=mkdtempSync(join(tmpdir(),'nep-local-auth-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const local=await start(t,dir);
  const me=await local.request('/auth/me');
  assert.equal(me.status,200);
  assert.equal(me.data.localAuth,true);
  assert.equal(me.data.user.email,'local.admin@nepgroup.com');
  assert.equal(me.data.user.is_admin,1);
  assert.equal(me.cookie,null);
  assert.equal((await local.request('/ideas')).status,200);
  assert.equal((await local.request('/admin/settings',{method:'PATCH',body:{mode:'open',ends_at:new Date(Date.now()+86400000).toISOString()}})).status,200);
  const body=new FormData();
  for(const [key,value] of Object.entries({full_name:'Alex Example',title:'Local idea',problem:'A problem',solution:'A solution',skills:'Engineering'}))body.set(key,value);
  // The app API uses multipart submissions; no cookie or code is needed.
  const created=await fetch(local.base+'/api/ideas',{method:'POST',headers:{'X-Requested-With':'InnovationWeek'},body});
  assert.equal(created.status,201);
  const localIdea=await created.json();assert.equal(localIdea.user_id,me.data.user.id);
  assert.equal((await local.request('/ideas/'+localIdea.id+'/vote',{method:'POST'})).status,200);
  assert.equal((await local.request('/admin/users/'+me.data.user.id+'/reset-votes',{method:'POST',body:{confirmed:true}})).status,200);
  assert.equal((await local.request('/ideas')).data.votesUsed,0);
  for(const path of ['/auth/request','/auth/verify','/auth/logout']){
    const result=await local.request(path,{method:'POST',body:{email:'person@nepgroup.com',code:'000000'}});
    assert.equal(result.status,409);
    assert.match(result.data.error,/disabled in local development/);
    assert.equal(result.cookie,null);
  }
  for (const table of ['challenges','sessions']) assert.equal(Number((await t.database.pool.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n),0);
  assert.equal((await t.database.pool.query('SELECT is_admin FROM users WHERE id=$1',[me.data.user.id])).rows[0].is_admin,0);
  assert.ok(!local.output().includes('[LOCAL EMAIL]'));
  // Polling /auth/me must not exhaust the sign-in attempt quota.
  for(let i=0;i<45;i++)assert.equal((await local.request('/auth/me')).status,200);
  await local.stop();

  const production=await start(t,dir,{NODE_ENV:'production',LOCAL_AUTH_BYPASS:'true',MAIL_MODE:'smtp',SMTP_HOST:'127.0.0.1',SMTP_PORT:'9',SMTP_USER:'test-only',SMTP_PASS:'test-only',MAIL_FROM:'innovation@nepgroup.com',SESSION_SECRET:'test-only-secret-of-at-least-32-characters',APP_ORIGIN:'https://innovation.example.com'});
  const prodMe=await production.request('/auth/me');
  assert.equal(prodMe.data.localAuth,false);
  assert.equal(prodMe.data.user,null);
  assert.equal((await production.request('/ideas')).status,401);
  assert.equal((await production.request('/admin/users')).status,401);
  await production.stop();

  const optedOut=await start(t,dir,{LOCAL_AUTH_BYPASS:'false',MAIL_MODE:'console'});
  assert.equal((await optedOut.request('/auth/me')).data.user,null);
  const code=await optedOut.request('/auth/request',{method:'POST',body:{email:'person@nepgroup.com'}});
  assert.equal(code.status,200);
  assert.match(code.data.developmentCode,/^\d{6}$/);
  await optedOut.stop();
});
